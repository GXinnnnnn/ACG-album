'use strict';
// Browser-owned playback and one visible video decoder. File access stays in main/worker.
const detailReads = new Map(),
  videoFailures = new Set(),
  videoRequests = new Map(),
  videoQueue = [];
let videoActive = false,
  videoScanTimer,
  mediaRefreshTimer,
  mediaDirty = false,
  lastMediaScroll = 0;
function prioritizeMediaDetails(n) {
  if (n.kind !== 'image' || n.width || detailReads.has(n.id)) return;
  detailReads.set(n.id, true);
  if (detailReads.size > 1024) detailReads.delete(detailReads.keys().next().value);
  api('mediaInfo', { id: n.id }).catch(() => {});
}
function decorateMediaCard(button, n) {
  button.removeAttribute('title');
  button.setAttribute('aria-label', (n.kind === 'video' ? '播放视频：' : '查看图片：') + n.name);
  const taken = n.taken || n.mtime,
    source = n.date_source?.startsWith('exif') ? '拍摄' : '文件';
  const hover = document.createElement('div');
  hover.className = 'media-hover';
  hover.innerHTML = `<strong>${esc(n.name)}</strong><span>${bytes(n.bytes)} · ${new Date(taken).toLocaleDateString('zh-CN')}</span>${n.place ? `<span>${esc(n.place)}</span>` : ''}`;
  button.querySelector('.cover-shell').append(hover);
  const info = button.querySelector('.card-subtitle');
  info.lastElementChild.textContent = new Date(taken).toLocaleDateString('zh-CN');
  const tag = button.querySelector('.card-bottom-overlay');
  tag.innerHTML =
    svg(n.kind === 'video' ? 'video' : 'image') +
    `<span>${n.frames > 1 ? fmt(n.frames) + ' 帧 · ' : ''}${esc(pathExt(n.name))}</span>`;
  if (n.kind === 'video') button.querySelector('.cover-placeholder').innerHTML = svg('video');
  if (S.view === 'timeline') {
    const badge = document.createElement('span');
    badge.className = 'timeline-date';
    badge.title = source + '时间：' + date(taken);
    badge.innerHTML = `${new Date(taken).toLocaleDateString('zh-CN')}<small>${source}${n.place ? ' · ' + esc(n.place) : ''}</small>`;
    button.querySelector('.cover-shell').append(badge);
  }
  prioritizeMediaDetails(n);
}
function updateMediaView() {
  const timeline = S.view === 'timeline';
  $('#timeline-controls').hidden = !timeline;
  $('#sort').disabled = $('#sort-direction').disabled = timeline;
  $$('[data-filter]').forEach((b) => {
    b.disabled = timeline;
  });
  if (timeline) {
    $('#page-title').innerHTML =
      esc(S.current ? S.current.name + ' · 时光轴' : '时光轴') +
      '<span class="heading-dot">.</span>';
    $('#eyebrow').textContent = '本地影像 · 时间与地点';
    $('#page-description').textContent = '把一次旅行、一个下午，沿着拍摄日期重新串起。';
    $('#timeline-month').value = S.timelineMonth || '';
    $('#timeline-place').value = S.timelinePlace || '';
  }
}
function albumKindModal(n) {
  openModal(
    '相册类型',
    `<p>「${esc(n.name)}」当前按${{ work: '作品', character: '角色', photo: '普通' }[n.effective_album_kind] || '普通'}相册显示。选择会向下级目录继承；下级仍可单独设置。</p><label for="album-kind-select">类型</label><select id="album-kind-select" class="field-input"><option value="auto">自动识别 / 继承上级</option><option value="photo">普通相册 · 照片与旅行</option><option value="work">作品相册 · ACG、游戏与影视</option><option value="character">角色相册 · 名称、简介与立绘</option></select><p class="field-help">自动识别查看前两层目录名称。普通相册使用本地媒体详情；作品相册可检索 Bangumi 作品；角色相册按唯一精确名称关联，也可自定义简介。</p><div class="modal-actions"><button id="album-kind-save" class="primary">保存类型</button></div>`
  );
  $('#album-kind-select').value = n.album_kind || 'auto';
  $('#album-kind-save').onclick = () =>
    attempt(async () => {
      await api('setAlbumKind', { id: n.id, kind: $('#album-kind-select').value });
      closeModal();
      await loadSummary();
      await loadPage(true);
      toast('相册类型已保存');
    });
}
async function mediaProperties(n) {
  const serial = V.serial,
    wasViewer = $('#viewer').open;
  const [node, m] = await Promise.all([api('get', { id: n.id }), api('mediaInfo', { id: n.id })]);
  if (wasViewer && (!$('#viewer').open || serial !== V.serial)) return;
  const source = m.date_source?.startsWith('exif')
    ? 'EXIF 拍摄时间' + (m.date_source === 'exif-offset' ? '（含时区）' : '（按本机时区）')
    : m.date_source === 'birth'
      ? '文件创建日期'
      : '文件修改日期';
  openModal(
    '拍摄信息与地点',
    `<dl class="property-grid"><dt>名称</dt><dd>${esc(node.name)}</dd><dt>类型 / 大小</dt><dd>${esc(pathExt(node.name))} ${node.kind === 'video' ? '视频' : '图片'} · ${bytes(node.bytes)}</dd><dt>尺寸</dt><dd>${m.width ? fmt(m.width) + ' × ' + fmt(m.height) : '暂未读取'}${m.frames > 1 ? ' · ' + fmt(m.frames) + ' 帧' : ''}</dd><dt>时间</dt><dd>${date(m.taken)}<small class="media-note">${source}</small></dd><dt>相机</dt><dd>${esc(m.camera || '未记录')}</dd><dt>色彩</dt><dd>${m.depth ? m.depth + ' 位 / 通道 · ' : ''}${esc(m.space || '未记录')}${m.has_icc ? ' · 含 ICC' : ''}<small class="media-note">${m.hdr ? '可能为高位深或宽色域，HDR 状态未确认。' : ''}原图使用 Chromium 解码；缩略图与编辑预览为 SDR，不保证 HDR 色调映射。</small></dd><dt>地址</dt><dd>${esc(node.path)}</dd>${m.error ? `<dt>解析提示</dt><dd>${esc(m.error)}</dd>` : ''}</dl><div class="media-place-fields"><label for="media-place">地点名称</label><input class="field-input" id="media-place" maxlength="120" placeholder="例如：杭州 · 西湖（手动填写）" value="${esc(m.place || '')}"><div class="coordinate-fields"><label>纬度<input id="media-latitude" type="number" min="-90" max="90" step="any" value="${m.latitude ?? ''}" placeholder="未记录"></label><label>经度<input id="media-longitude" type="number" min="-180" max="180" step="any" value="${m.longitude ?? ''}" placeholder="未记录"></label></div><p class="field-help">GPS 来自图片 EXIF 或手动录入；地点名称保存在本地资料库。不会自动联网查询地址，也不会写回原文件。清空坐标并保存可移除本地记录。</p><p class="inline-error" id="media-place-error" role="alert"></p></div><div class="modal-actions"><button id="media-prop-reveal" class="subtle-button">在资源管理器中定位</button><button id="media-place-save" class="primary">保存地点</button></div>`,
    660
  );
  $('#media-prop-reveal').onclick = () => attempt(() => api('reveal', { id: n.id }));
  $('#media-place-save').onclick = async () => {
    const b = $('#media-place-save');
    b.disabled = true;
    try {
      const lat = $('#media-latitude').value.trim(),
        lon = $('#media-longitude').value.trim();
      if ((lat === '') !== (lon === '')) throw new Error('请填写完整的一对经纬度，或同时清空。');
      await api('setPlace', {
        id: n.id,
        place: $('#media-place').value.trim(),
        latitude: lat === '' ? null : Number(lat),
        longitude: lon === '' ? null : Number(lon)
      });
      closeModal();
      mediaDirty = true;
      scheduleMediaRefresh();
      toast('地点已保存在本地资料库');
    } catch (e) {
      if ($('#media-place-error')) $('#media-place-error').textContent = e.message;
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  };
}
function videoVisible(img) {
  const card = img.closest('.album-card');
  if (!card?.isConnected) return false;
  const r = card.getBoundingClientRect(),
    vp = $('#viewport').getBoundingClientRect();
  return r.bottom > vp.top && r.top < vp.bottom;
}
function queueVideoThumbnail(n, img) {
  const revision = n.id + ':' + n.mtime + ':' + n.bytes;
  if (videoFailures.has(revision) || !videoVisible(img)) return;
  const existing = videoRequests.get(n.id);
  if (existing) {
    existing.images.add(img);
    return;
  }
  if (videoQueue.length >= 64) return;
  const request = { n, revision, images: new Set([img]) };
  videoRequests.set(n.id, request);
  videoQueue.push(request);
  void pumpVideoThumbnails();
}
async function pumpVideoThumbnails() {
  if (videoActive) return;
  videoActive = true;
  try {
    while (videoQueue.length) {
      const request = videoQueue.shift();
      if (![...request.images].some(videoVisible)) {
        videoRequests.delete(request.n.id);
        continue;
      }
      try {
        const { bytes, width, height } = await decodeVideoPoster(request.n.id);
        await api('storeVideoThumb', { id: request.n.id, bytes, width, height });
        for (const img of request.images)
          if (img.isConnected) {
            img.style.display = '';
            img.src = thumb(request.n) + '&poster=1';
          }
      } catch (e) {
        videoFailures.add(request.revision);
        if (videoFailures.size > 512) videoFailures.delete(videoFailures.values().next().value);
        for (const img of request.images)
          if (img.isConnected)
            img.closest('.album-card').title = '此编码未生成封面，可用系统播放器打开';
      } finally {
        videoRequests.delete(request.n.id);
      }
    }
  } finally {
    videoActive = false;
  }
}
function decodeVideoPoster(id) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    let finished = false,
      seeking = false;
    const timer = setTimeout(() => finish(new Error('视频封面读取超时。')), 4000);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.onloadeddata = video.onseeked = video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      error ? reject(error) : resolve(result);
    }
    async function capture() {
      if (finished) return;
      try {
        const width = video.videoWidth,
          height = video.videoHeight;
        if (!width || !height) throw new Error('未读取到视频尺寸。');
        const ratio = Math.min(1, 512 / width, 512 / height),
          canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.82));
        if (!blob) throw new Error('封面编码失败。');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        canvas.width = canvas.height = 0;
        finish(null, { bytes, width, height });
      } catch (e) {
        finish(e);
      }
    }
    video.onloadeddata = () => {
      if (seeking) return;
      seeking = true;
      if (Number.isFinite(video.duration) && video.duration > 0.15) {
        video.onseeked = capture;
        video.currentTime = Math.min(0.1, video.duration / 4);
      } else void capture();
    };
    video.onerror = () => finish(new Error('浏览器不支持此视频编码。'));
    video.src = 'acg-image://original/' + id;
    video.load();
  });
}
function scheduleVideoScan() {
  clearTimeout(videoScanTimer);
  videoScanTimer = setTimeout(() => {
    for (const [index, button] of grid.cards) {
      const n = grid.items.get(index),
        img = button.querySelector('img');
      if (n?.kind === 'video' && img?.style.display === 'none') queueVideoThumbnail(n, img);
    }
  }, 140);
}
function stopViewerVideo() {
  const video = $('#viewer-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  video.onerror = video.onloadeddata = null;
}
async function displayImage(n) {
  stopViewerVideo();
  const video = n.kind === 'video';
  $('.viewer-bottom span:last-child').textContent = video
    ? '← → 切换 · 使用原生播放控件 · Esc 关闭'
    : '← → 切换 · 滚轮缩放 · Ctrl C 复制 · Esc 关闭';
  $('#viewer-copy').hidden = $('#viewer-fit').hidden = $('#viewer-edit').hidden = video;
  if (!video) {
    await displayOriginalImage(n);
    const image = $('#viewer-image'),
      serial = V.serial;
    image.onerror = () => {
      if (serial !== V.serial) return;
      if (image.dataset.preview !== n.id) {
        image.dataset.preview = n.id;
        $('#viewer-loading').textContent = '原图编码未被浏览器支持，正在读取 SDR 预览…';
        image.src = 'acg-image://frame/' + n.id + '?index=0&size=1600';
        $('#viewer-position').textContent += ' · SDR 静态预览';
      } else $('#viewer-loading').textContent = '此编码暂无法解码，可用系统应用打开。';
    };
    delete image.dataset.preview;
    return;
  }
  V.node = n;
  V.scale = 1;
  V.native = false;
  const serial = ++V.serial,
    player = $('#viewer-video');
  const image = $('#viewer-image');
  image.hidden = true;
  image.removeAttribute('src');
  $('#viewer-stage').classList.remove('zoomed');
  $('#viewer-name').textContent = n.name;
  $('#viewer-position').textContent =
    `${fmt(V.index + 1)} / ${fmt(V.total)} · 浏览器支持的编码可直接播放`;
  $('#viewer-path').textContent = n.path;
  $('#viewer-prev').disabled = V.index <= 0;
  $('#viewer-next').disabled = V.index >= V.total - 1;
  $('#viewer-loading').hidden = false;
  $('#viewer-loading').textContent = '正在打开视频…';
  player.hidden = false;
  // Playback metadata is persisted by the thumbnail lane; no full video bytes cross IPC.
  player.onloadeddata = () => {
    if (serial === V.serial) $('#viewer-loading').hidden = true;
  };
  player.onerror = () => {
    if (serial === V.serial) {
      $('#viewer-loading').hidden = false;
      $('#viewer-loading').textContent = '浏览器不支持此视频编码，请点击「系统打开」。';
    }
  };
  player.oncontextmenu = (e) => showContext(e, n);
  player.src = 'acg-image://original/' + n.id;
  player.load();
}
function scheduleMediaRefresh() {
  clearTimeout(mediaRefreshTimer);
  if (!mediaDirty) return;
  mediaRefreshTimer = setTimeout(async () => {
    if (S.view === 'timeline') {
      $('#timeline-refresh').hidden = false;
      return;
    }
    if (
      $('#viewer').open ||
      $('#modal').open ||
      $('#media-editor')?.open ||
      Date.now() - lastMediaScroll < 300
    ) {
      scheduleMediaRefresh();
      return;
    }
    mediaDirty = false;
    if (grid.active)
      try {
        await grid.refreshVisible();
      } catch {}
  }, 700);
}
$('#viewport').addEventListener(
  'scroll',
  () => {
    lastMediaScroll = Date.now();
    scheduleVideoScan();
  },
  { passive: true }
);
$('#viewer').addEventListener('close', () => {
  stopViewerVideo();
  const image = $('#viewer-image');
  image.onload = image.onerror = null;
  image.removeAttribute('src');
  V.serial++;
  scheduleMediaRefresh();
});
$('#modal').addEventListener('close', scheduleMediaRefresh);
$('#viewer-edit').onclick = () => attempt(() => openEditor(V.node));
$('#viewer-info').onclick = () => attempt(() => mediaProperties(V.node));
$('#viewer-external').onclick = () => attempt(() => api('openMedia', { id: V.node.id }));
let placeFilterTimer;
$('#timeline-month').onchange = (e) => {
  S.timelineMonth = e.target.value;
  attempt(() => loadPage());
};
$('#timeline-place').oninput = (e) => {
  clearTimeout(placeFilterTimer);
  const value = e.target.value.trim();
  placeFilterTimer = setTimeout(() => {
    S.timelinePlace = value;
    attempt(() => loadPage());
  }, 250);
};
$('#timeline-clear').onclick = () => {
  S.timelineMonth = S.timelinePlace = '';
  attempt(() => loadPage());
};
$('#timeline-refresh').onclick = () => {
  mediaDirty = false;
  $('#timeline-refresh').hidden = true;
  attempt(() => loadPage(true));
};
window.album.onEvent((event) => {
  if (event.type === 'media') {
    if (S.view === 'timeline') {
      mediaDirty = true;
      $('#timeline-refresh').hidden = false;
    } else if ([...grid.items.values()].some((n) => n.id === event.data.id)) {
      mediaDirty = true;
      scheduleMediaRefresh();
    }
  }
});
