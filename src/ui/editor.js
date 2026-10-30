'use strict';

// Classic-script entry point. This editor owns its dialog and never writes files itself.
async function openEditor(n) {
  return MediaEditor.open(n);
}

const MediaEditor = (() => {
  const PREVIEW_LIMIT = 1600;
  let active = null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const message = (error) => error?.message || String(error);
  const icon = (name) => (typeof svg === 'function' ? svg(name) : '');
  const escape = (value) => esc(String(value ?? ''));

  function markup(n) {
    const cropField = (key, label) =>
      `<label>${label} (%)<input data-crop="${key}" type="number" min="0" max="100" step="any" inputmode="decimal" aria-describedby="me-crop-help me-error"></label>`;
    const colorField = (key, label, min, max) =>
      `<label class="me-slider-label" for="me-${key}"><span>${label}</span><output id="me-${key}-value" for="me-${key}">100%</output></label><div class="me-range-control"><input id="me-${key}" data-color="${key}" type="range" min="${min}" max="${max}" step="0.01" value="1"><button type="button" data-color-reset="${key}" title="恢复默认值" aria-label="${label}：恢复默认值">恢复默认</button></div>`;
    return `<div class="me-shell">
      <header class="me-header">
        <div class="me-heading"><span class="me-eyebrow">EDIT A COPY</span><h2 id="me-title">编辑副本</h2><p class="me-filename" title="${escape(n?.name)}">${escape(n?.name || '未选择图片')}</p></div>
        <button type="button" class="me-icon-button" id="me-close" aria-label="关闭编辑器" title="关闭编辑器">${icon('x')}</button>
      </header>
      <p class="me-description" id="me-description">裁剪、调色后另存副本。裁剪坐标以自动校正方向的原图为准，先裁剪，再旋转。</p>
      <p class="me-metadata" id="me-metadata">正在读取图片信息…</p>
      <p class="me-notice" id="me-notice" hidden></p>
      <form id="me-form" novalidate>
        <fieldset class="me-workspace" id="me-workspace" disabled>
          <legend class="me-sr-only">图片编辑工具</legend>
          <div class="me-previews">
            <section class="me-preview-panel" aria-labelledby="me-source-title">
              <div class="me-panel-heading"><h3 id="me-source-title">原帧 · 裁剪范围</h3><button type="button" id="me-new-crop" aria-pressed="false">新建选区</button></div>
              <div class="me-canvas-stage"><canvas id="me-source" width="1" height="1" role="img" aria-label="原帧与裁剪选区；可用下方百分比输入框调整" aria-describedby="me-crop-help"></canvas><span id="me-frame-loading" class="me-frame-loading">正在载入预览…</span></div>
              <p class="me-help" id="me-crop-help">拖动选区移动，拖动边缘手柄缩放；选区外拖动可新建。也可使用右侧四个百分比输入框。</p>
            </section>
            <section class="me-preview-panel" aria-labelledby="me-output-title">
              <div class="me-panel-heading"><h3 id="me-output-title">编辑效果</h3><button type="button" id="me-before" aria-pressed="false">查看原帧</button></div>
              <div class="me-canvas-stage me-output-stage"><canvas id="me-output" width="1" height="1" role="img" aria-label="裁剪、旋转及调色后的预览"></canvas></div>
              <p class="me-help" id="me-size">预览最长边 1600 px · 导出使用原始图像</p>
            </section>
            <section class="me-animation" id="me-animation" aria-label="动画帧控制" hidden>
              <div class="me-playback"><button type="button" id="me-prev" aria-label="上一帧" title="上一帧">${icon('chevron-left')}</button><button type="button" id="me-play" aria-pressed="false">播放</button><button type="button" id="me-next" aria-label="下一帧" title="下一帧">${icon('chevron-right')}</button><label for="me-seek" class="me-sr-only">选择动画帧</label><input id="me-seek" type="range" min="1" max="1" value="1" step="1"><label class="me-frame-number">帧<input id="me-frame-number" type="number" min="1" max="1" value="1" step="1" aria-label="当前帧编号"></label><span id="me-frame-count"></span></div>
              <p class="me-help" id="me-frame-delay">按原始帧时长播放；预览循环所选范围。</p>
            </section>
          </div>
          <div class="me-controls">
            <section class="me-control-section" aria-labelledby="me-crop-title"><h3 id="me-crop-title">裁剪</h3>
              <div class="me-presets" role="group" aria-label="裁剪比例预设"><button type="button" data-preset="full">完整原图</button><button type="button" data-preset="original">原比例</button><button type="button" data-preset="1">1:1</button><button type="button" data-preset="0.75">3:4</button><button type="button" data-preset="1.7777777777777777">16:9</button></div>
              <div class="me-crop-fields">${cropField('x', '左侧 X')}${cropField('y', '顶部 Y')}${cropField('w', '宽度')}${cropField('h', '高度')}</div>
              <p class="me-help" id="me-crop-pixels"></p>
            </section>
            <section class="me-control-section" aria-labelledby="me-transform-title"><h3 id="me-transform-title">旋转与尺寸</h3>
              <div class="me-two-fields"><label>顺时针旋转<select id="me-rotation"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label><label>导出宽度 (px)<input id="me-width" type="number" min="1" max="8192" step="1" inputmode="numeric" required aria-describedby="me-size me-error"></label></div>
            </section>
            <section class="me-control-section" aria-labelledby="me-color-title"><h3 id="me-color-title">色彩</h3>${colorField('brightness', '亮度', '.5', '1.5')}${colorField('contrast', '对比度', '.5', '1.5')}${colorField('saturation', '饱和度', '0', '2')}</section>
            <section class="me-control-section" id="me-trim" aria-labelledby="me-trim-title" hidden><h3 id="me-trim-title">动画导出</h3>
              <div class="me-two-fields"><label>起始帧 (含)<input id="me-from" type="number" min="1" step="1" value="1" required aria-describedby="me-range-help me-error"></label><label>结束帧 (含)<input id="me-to" type="number" min="1" step="1" value="1" required aria-describedby="me-range-help me-error"></label></div>
              <p class="me-help" id="me-range-help">帧编号从 1 开始，包含起始帧和结束帧。</p>
              <div class="me-two-fields"><label>统一时长 (ms)<input id="me-delay" type="number" min="0" max="65535" step="1" placeholder="保留原时长" aria-describedby="me-delay-help me-error"></label><label>循环次数<input id="me-loop" type="number" min="0" max="65535" step="1" value="0" required aria-describedby="me-delay-help me-error"></label></div>
              <p class="me-help" id="me-delay-help">时长留空保留逐帧延时；循环 0 表示无限。GIF 时长以 10 ms 为单位。</p>
            </section>
          </div>
        </fieldset>
      </form>
      <div class="me-feedback"><p id="me-error" class="me-error" role="alert" tabindex="-1" hidden></p><p id="me-status" role="status" aria-live="polite" aria-atomic="true">正在准备编辑器…</p><p id="me-result" class="me-result" hidden></p><button type="button" id="me-retry" hidden>重试载入</button></div>
      <footer class="me-footer"><button type="button" id="me-reset" disabled>${icon('refresh')}重置</button><div class="me-export-controls"><label for="me-format">另存格式</label><select id="me-format" disabled><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="gif">GIF</option></select><button type="button" id="me-export-frame" disabled hidden>当前帧 PNG</button><button type="button" class="me-primary" id="me-export" disabled>另存副本…</button></div></footer>
    </div>`;
  }

  function status(s, text) {
    if (s.alive) s.el('status').textContent = text;
  }

  function error(s, text) {
    if (!s.alive) return;
    s.el('error').textContent = text;
    s.el('error').hidden = !text;
  }

  function stop(s) {
    s.playing = false;
    s.playSerial++;
    clearTimeout(s.timer);
    s.timer = null;
    if (s.alive) {
      s.el('play').textContent = '播放';
      s.el('play').setAttribute('aria-pressed', 'false');
    }
  }

  function releaseImage(image) {
    image.onload = image.onerror = null;
    image.removeAttribute('src');
    image.src = '';
  }

  function dispose(s) {
    if (!s.alive) return;
    stop(s);
    s.alive = false;
    s.frameSerial++;
    s.pending = null;
    cancelAnimationFrame(s.paintFrame);
    s.drag = null;
    if (s.loadingImage) releaseImage(s.loadingImage);
    s.cancelDecode?.();
    s.loadingImage = null;
    s.cancelDecode = null;
    for (const image of s.cache.values()) releaseImage(image);
    s.cache.clear();
    s.image = null;
    for (const canvas of s.dialog.querySelectorAll('canvas')) canvas.width = canvas.height = 1;
    s.dialog.remove();
    if (active === s) active = null;
    if (s.returnFocus?.isConnected) s.returnFocus.focus({ preventScroll: true });
  }

  function close(s) {
    if (!s.alive) return;
    if (s.dialog.open) s.dialog.close();
    dispose(s);
  }

  function updateBusy(s) {
    if (!s.alive) return;
    s.el('workspace').disabled = !s.ready || s.saving;
    s.el('reset').disabled = !s.ready || s.saving;
    s.el('format').disabled = !s.ready || s.saving;
    const frameReady = s.image && s.displayedFrame === s.frame;
    s.el('export').disabled = !s.ready || !frameReady || s.frameLoading || s.saving;
    s.el('export-frame').disabled = !s.ready || !frameReady || s.frameLoading || s.saving;
    s.el('retry').disabled = s.saving || s.frameLoading;
    s.dialog.setAttribute('aria-busy', String(s.saving));
    if (s.ready) {
      s.el('prev').disabled = s.saving || s.frame <= 0;
      s.el('next').disabled = s.saving || s.frame >= s.frames - 1;
    }
  }

  function cropDimensions(s) {
    const width = s.width * s.edit.crop.w;
    const height = s.height * s.edit.crop.h;
    return s.edit.rotation % 180 ? { width: height, height: width } : { width, height };
  }

  function syncCrop(s) {
    for (const input of s.dialog.querySelectorAll('[data-crop]')) {
      input.value = (s.edit.crop[input.dataset.crop] * 100).toFixed(6).replace(/\.?0+$/, '') || '0';
      input.setCustomValidity('');
    }
    const c = s.edit.crop;
    s.el('crop-pixels').textContent =
      `原图坐标：${Math.round(c.x * s.width)}, ${Math.round(c.y * s.height)} · ${Math.round(c.w * s.width)} × ${Math.round(c.h * s.height)} px`;
    if (s.autoWidth) {
      s.edit.width = clamp(Math.round(cropDimensions(s).width), 1, 8192);
      s.el('width').value = s.edit.width;
    }
    queuePaint(s);
  }

  function normalizeCrop(s, crop) {
    const minW = Math.min(1, 1 / s.width),
      minH = Math.min(1, 1 / s.height);
    const w = clamp(crop.w, minW, 1),
      h = clamp(crop.h, minH, 1);
    return { x: clamp(crop.x, 0, 1 - w), y: clamp(crop.y, 0, 1 - h), w, h };
  }

  function readCrop(s, showError = true) {
    const c = {};
    for (const input of s.dialog.querySelectorAll('[data-crop]')) {
      const key = input.dataset.crop;
      input.setCustomValidity('');
      const value = input.value === '' ? NaN : Number(input.value) / 100;
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1 ||
        ((key === 'w' || key === 'h') && value <= 0)
      ) {
        input.setCustomValidity('请输入有效百分比；宽度和高度必须大于 0。');
        if (showError) error(s, '裁剪坐标需在 0–100% 之间，宽度和高度须大于 0。');
        return false;
      }
      c[key] = value;
    }
    if (c.x + c.w > 1.00001 || c.y + c.h > 1.00001) {
      if (showError)
        error(s, '裁剪范围超出原图。请减少位置或宽高，使 X + 宽度、Y + 高度均不超过 100%。');
      return false;
    }
    s.edit.crop = normalizeCrop(s, c);
    error(s, '');
    syncCrop(s);
    return true;
  }

  function queuePaint(s) {
    if (!s.alive || s.paintFrame) return;
    s.paintFrame = requestAnimationFrame(() => {
      s.paintFrame = 0;
      if (!s.alive || !s.image) return;
      try {
        paint(s);
      } catch (e) {
        error(s, `无法绘制预览：${message(e)}`);
      }
    });
  }

  function fitCanvas(canvas, width, height) {
    const scale = Math.min(1, PREVIEW_LIMIT / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境无法创建画布');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  function paint(s) {
    const image = s.image;
    const source = s.el('source');
    const ctx = fitCanvas(source, image.naturalWidth, image.naturalHeight);
    const w = source.width,
      h = source.height,
      c = s.edit.crop;
    ctx.drawImage(image, 0, 0, w, h);
    const x = c.x * w,
      y = c.y * h,
      cw = c.w * w,
      ch = c.h * h;
    ctx.fillStyle = 'rgba(10,12,22,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(x, y, cw, ch);
    ctx.fill('evenodd');
    const displayWidth = source.getBoundingClientRect().width || w;
    const factor = w / displayWidth;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * factor;
    ctx.strokeRect(x, y, cw, ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cw, ch);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 0.6 * factor;
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (cw * i) / 3, y);
      ctx.lineTo(x + (cw * i) / 3, y + ch);
      ctx.moveTo(x, y + (ch * i) / 3);
      ctx.lineTo(x + cw, y + (ch * i) / 3);
      ctx.stroke();
    }
    ctx.restore();
    const handle = 7 * factor;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.65 * factor;
    for (const [hx, hy] of [
      [x, y],
      [x + cw / 2, y],
      [x + cw, y],
      [x + cw, y + ch / 2],
      [x + cw, y + ch],
      [x + cw / 2, y + ch],
      [x, y + ch],
      [x, y + ch / 2]
    ]) {
      ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
      ctx.strokeRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }

    const output = s.el('output');
    if (s.before) {
      const out = fitCanvas(output, image.naturalWidth, image.naturalHeight);
      out.drawImage(image, 0, 0, output.width, output.height);
    } else {
      const sw = image.naturalWidth * c.w,
        sh = image.naturalHeight * c.h;
      const rotated = s.edit.rotation % 180 !== 0;
      const out = fitCanvas(output, rotated ? sh : sw, rotated ? sw : sh);
      const drawW = rotated ? output.height : output.width;
      const drawH = rotated ? output.width : output.height;
      out.save();
      out.translate(output.width / 2, output.height / 2);
      out.rotate((s.edit.rotation * Math.PI) / 180);
      out.filter = `brightness(${s.edit.brightness}) contrast(${s.edit.contrast}) saturate(${s.edit.saturation})`;
      out.drawImage(
        image,
        c.x * image.naturalWidth,
        c.y * image.naturalHeight,
        sw,
        sh,
        -drawW / 2,
        -drawH / 2,
        drawW,
        drawH
      );
      out.restore();
    }
    const dims = cropDimensions(s);
    const outHeight = Math.max(1, Math.round((s.edit.width * dims.height) / dims.width));
    s.el('size').textContent =
      `${s.before ? '正在对比原帧 · ' : ''}导出 ${s.edit.width} × ${outHeight} px · 预览最长边 1600 px`;
  }

  function point(s, event) {
    const rect = s.el('source').getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };
  }

  function hitTest(s, p) {
    const c = s.edit.crop,
      rect = s.el('source').getBoundingClientRect();
    const dx = 12 / rect.width,
      dy = 12 / rect.height;
    const handles = [
      ['nw', c.x, c.y],
      ['n', c.x + c.w / 2, c.y],
      ['ne', c.x + c.w, c.y],
      ['e', c.x + c.w, c.y + c.h / 2],
      ['se', c.x + c.w, c.y + c.h],
      ['s', c.x + c.w / 2, c.y + c.h],
      ['sw', c.x, c.y + c.h],
      ['w', c.x, c.y + c.h / 2]
    ];
    let best = null,
      distance = Infinity;
    for (const [name, x, y] of handles) {
      const d = ((p.x - x) / dx) ** 2 + ((p.y - y) / dy) ** 2;
      if (d <= 1 && d < distance) {
        best = name;
        distance = d;
      }
    }
    if (best) return best;
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return 'move';
    return 'new';
  }

  function bindCrop(s) {
    const canvas = s.el('source');
    canvas.addEventListener('pointerdown', (event) => {
      if (
        !s.ready ||
        s.saving ||
        s.frameLoading ||
        !s.image ||
        event.button !== 0 ||
        !event.isPrimary
      )
        return;
      event.preventDefault();
      stop(s);
      const p = point(s, event);
      s.drag = {
        id: event.pointerId,
        start: p,
        crop: { ...s.edit.crop },
        mode: s.newCrop || event.shiftKey ? 'new' : hitTest(s, p)
      };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!s.ready || !s.image) return;
      const p = point(s, event);
      if (!s.drag) {
        const mode = s.newCrop ? 'new' : hitTest(s, p);
        canvas.style.cursor =
          mode === 'new' ? 'crosshair' : mode === 'move' ? 'move' : `${mode}-resize`;
        return;
      }
      const d = s.drag;
      if (event.pointerId !== d.id) return;
      event.preventDefault();
      const c = d.crop,
        mode = d.mode;
      let next;
      if (mode === 'move') {
        next = { ...c, x: c.x + p.x - d.start.x, y: c.y + p.y - d.start.y };
      } else if (mode === 'new') {
        next = {
          x: Math.min(p.x, d.start.x),
          y: Math.min(p.y, d.start.y),
          w: Math.abs(p.x - d.start.x),
          h: Math.abs(p.y - d.start.y)
        };
      } else {
        let left = c.x,
          right = c.x + c.w,
          top = c.y,
          bottom = c.y + c.h;
        if (mode.includes('w')) left = clamp(p.x, 0, right - 1 / s.width);
        if (mode.includes('e')) right = clamp(p.x, left + 1 / s.width, 1);
        if (mode.includes('n')) top = clamp(p.y, 0, bottom - 1 / s.height);
        if (mode.includes('s')) bottom = clamp(p.y, top + 1 / s.height, 1);
        next = { x: left, y: top, w: right - left, h: bottom - top };
      }
      s.edit.crop = normalizeCrop(s, next);
      error(s, '');
      syncCrop(s);
    });
    const release = (event) => {
      if (!s.drag || event.pointerId !== s.drag.id) return;
      s.drag = null;
      s.newCrop = false;
      s.el('new-crop').setAttribute('aria-pressed', 'false');
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', () => {
      s.drag = null;
    });
    s.el('new-crop').onclick = () => {
      s.newCrop = !s.newCrop;
      s.el('new-crop').setAttribute('aria-pressed', String(s.newCrop));
      canvas.style.cursor = s.newCrop ? 'crosshair' : 'default';
      status(
        s,
        s.newCrop ? '请在原帧上拖动新建选区；也可直接编辑裁剪百分比。' : '已退出新建选区。'
      );
    };
    for (const input of s.dialog.querySelectorAll('[data-crop]'))
      input.onchange = () => readCrop(s);
    for (const button of s.dialog.querySelectorAll('[data-preset]'))
      button.onclick = () => {
        const preset = button.dataset.preset;
        if (preset === 'full') s.edit.crop = { x: 0, y: 0, w: 1, h: 1 };
        else {
          const ratio = preset === 'original' ? s.width / s.height : Number(preset);
          const c = s.edit.crop;
          const availableW = c.w * s.width,
            availableH = c.h * s.height;
          const width = Math.min(availableW, availableH * ratio),
            height = width / ratio;
          s.edit.crop = normalizeCrop(s, {
            x: c.x + (c.w - width / s.width) / 2,
            y: c.y + (c.h - height / s.height) / 2,
            w: width / s.width,
            h: height / s.height
          });
        }
        error(s, '');
        syncCrop(s);
      };
  }

  function delayFor(s, index) {
    const override = s.el('delay').value.trim();
    if (
      override !== '' &&
      Number.isInteger(Number(override)) &&
      Number(override) >= 0 &&
      Number(override) <= 65535
    )
      return Number(override);
    const delay = Number(s.info.delays?.[index]);
    return Number.isFinite(delay) && delay >= 0 ? delay : 100;
  }

  function showFrameNumber(s) {
    s.el('seek').value = s.frame + 1;
    s.el('frame-number').value = s.frame + 1;
    s.el('frame-count').textContent = `/ ${s.frames}`;
    s.el('frame-delay').textContent =
      `第 ${s.frame + 1} 帧 · ${delayFor(s, s.frame)} ms · 预览循环所选范围`;
    updateBusy(s);
  }

  // Keep at most the displayed image plus one pending/cached frame. Decode serially.
  function discardSpareFrame(s) {
    for (const [index, image] of s.cache) {
      if (image === s.image) continue;
      releaseImage(image);
      s.cache.delete(index);
    }
  }

  function decodeFrame(s, index) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      s.loadingImage = image;
      let settled = false;
      const finish = (failure, cancelled = false) => {
        if (settled) return;
        settled = true;
        image.onload = image.onerror = null;
        s.loadingImage = null;
        s.cancelDecode = null;
        if (failure || cancelled) releaseImage(image);
        if (failure) reject(failure);
        else resolve(cancelled ? null : image);
      };
      s.cancelDecode = () => finish(null, true);
      image.decoding = 'async';
      image.onload = () => finish(null);
      image.onerror = () =>
        finish(new Error(`第 ${index + 1} 帧预览加载失败。请重试，或确认文件仍然存在。`));
      image.src = `acg-image://frame/${encodeURIComponent(s.node.id)}?index=${index}&size=${PREVIEW_LIMIT}`;
    });
  }

  async function drainFrames(s) {
    while (s.alive && s.pending) {
      const job = s.pending;
      s.pending = null;
      try {
        let image = s.cache.get(job.index);
        if (!image) {
          discardSpareFrame(s);
          image = await decodeFrame(s, job.index);
          if (!s.alive || !image) return;
          s.cache.set(job.index, image);
        }
        if (job.serial !== s.frameSerial) continue;
        s.image = image;
        s.displayedFrame = job.index;
        s.frameLoading = false;
        s.el('frame-loading').hidden = true;
        s.el('retry').hidden = true;
        error(s, '');
        status(s, s.playing ? '正在播放所选范围。' : '预览已就绪，可另存副本。');
        queuePaint(s);
      } catch (e) {
        if (!s.alive || job.serial !== s.frameSerial) continue;
        s.frameLoading = false;
        stop(s);
        s.el('frame-loading').hidden = true;
        s.el('retry').hidden = false;
        error(s, message(e));
        status(s, '预览未就绪，请重试载入。');
      }
      updateBusy(s);
    }
  }

  function requestFrame(s, index) {
    if (!s.alive) return Promise.resolve();
    s.frame = clamp(Math.round(index), 0, s.frames - 1);
    s.pending = { index: s.frame, serial: ++s.frameSerial };
    s.frameLoading = true;
    s.el('frame-loading').hidden = false;
    showFrameNumber(s);
    if (!s.pump) {
      s.pump = drainFrames(s).finally(() => {
        s.pump = null;
      });
    }
    return s.pump;
  }

  function range(s) {
    const from = Number(s.el('from').value),
      to = Number(s.el('to').value);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to > s.frames ||
      from > to
    ) {
      throw new Error(`帧范围无效。请输入 1–${s.frames}，且起始帧不能大于结束帧。`);
    }
    return { from: from - 1, to: to - 1 };
  }

  async function play(s) {
    if (s.playing) {
      stop(s);
      status(s, '播放已暂停。');
      return;
    }
    let trim;
    try {
      trim = range(s);
    } catch (e) {
      error(s, message(e));
      return;
    }
    error(s, '');
    s.playing = true;
    const serial = ++s.playSerial;
    s.el('play').textContent = '暂停';
    s.el('play').setAttribute('aria-pressed', 'true');
    const startFrame = s.frame < trim.from || s.frame > trim.to ? trim.from : s.frame;
    await requestFrame(s, startFrame);
    const schedule = () => {
      if (!s.alive || !s.playing || serial !== s.playSerial || s.frameLoading) return;
      s.timer = setTimeout(
        async () => {
          if (!s.alive || !s.playing || serial !== s.playSerial) return;
          const next = s.frame >= trim.to ? trim.from : s.frame + 1;
          await requestFrame(s, next);
          schedule();
        },
        delayFor(s, s.frame)
      );
    };
    schedule();
  }

  function reset(s, announce = true) {
    stop(s);
    s.autoWidth = true;
    s.before = false;
    s.newCrop = false;
    s.edit = {
      crop: { x: 0, y: 0, w: 1, h: 1 },
      rotation: 0,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      width: Math.min(s.width, 8192)
    };
    s.el('rotation').value = '0';
    s.el('before').setAttribute('aria-pressed', 'false');
    s.el('before').textContent = '查看原帧';
    s.el('output-title').textContent = '编辑效果';
    s.el('new-crop').setAttribute('aria-pressed', 'false');
    s.el('width').value = s.edit.width;
    s.el('width').setCustomValidity('');
    for (const key of ['brightness', 'contrast', 'saturation']) {
      s.el(key).value = '1';
      s.el(`${key}-value`).textContent = '100%';
    }
    s.el('from').value = '1';
    s.el('to').value = s.frames;
    s.el('delay').value = '';
    s.el('loop').value = clamp(Math.round(number(s.info.loop, 0)), 0, 65535);
    s.el('format').value = s.animated
      ? 'gif'
      : ['png', 'jpeg', 'webp', 'gif'].includes(s.format)
        ? s.format
        : 'png';
    s.el('result').hidden = true;
    error(s, '');
    syncCrop(s);
    formatChanged(s);
    if (announce) {
      status(s, '编辑参数已重置。');
      requestFrame(s, 0);
    }
  }

  function formatChanged(s) {
    const gif = s.el('format').value === 'gif';
    s.el('export').textContent = s.saving
      ? '正在另存…'
      : s.animated && gif
        ? '另存所选动画…'
        : s.animated
          ? '另存当前帧…'
          : '另存副本…';
    s.el('range-help').textContent = gif
      ? '帧编号从 1 开始，GIF 导出包含起始帧和结束帧。'
      : '当前格式另存当前帧；选择 GIF 可导出所选动画范围。';
  }

  async function exportCopy(s, currentPng = false) {
    if (s.saving || !s.ready || s.frameLoading || !s.image || s.displayedFrame !== s.frame) return;
    stop(s);
    error(s, '');
    s.el('result').hidden = true;
    try {
      if (!readCrop(s)) {
        s.el('error').focus();
        return;
      }
      const width = Number(s.el('width').value);
      if (!Number.isInteger(width) || width < 1 || width > 8192)
        throw new Error('导出宽度必须是 1–8192 之间的整数。');
      const format = currentPng ? 'png' : s.el('format').value;
      const selected = s.animated && format === 'gif' ? range(s) : { from: s.frame, to: s.frame };
      const edit = {
        ...s.edit,
        crop: { ...s.edit.crop },
        width,
        ...selected,
        loop: clamp(Math.round(number(s.info.loop, 0)), 0, 65535)
      };
      if (s.animated && format === 'gif') {
        const loop = Number(s.el('loop').value);
        if (s.el('loop').value === '' || !Number.isInteger(loop) || loop < 0 || loop > 65535)
          throw new Error('循环次数必须是 0–65535 之间的整数，0 表示无限。');
        edit.loop = loop;
        const rawDelay = s.el('delay').value.trim();
        if (rawDelay !== '') {
          const delay = Number(rawDelay);
          if (!Number.isInteger(delay) || delay < 0 || delay > 65535)
            throw new Error('统一时长需为 0–65535 ms 的整数；留空可保留原始逐帧时长。');
          // The backend contract is `delay`, never `delayMs`.
          edit.delay = delay;
        }
      }
      s.saving = true;
      updateBusy(s);
      formatChanged(s);
      status(s, '请选择另存位置，随后将使用原始图像导出副本…');
      const result = await api('exportMedia', { id: s.node.id, edit, format });
      if (!s.alive) return;
      if (result?.cancelled) {
        status(s, '已取消另存，编辑参数已保留，可继续编辑。');
      } else if (result?.path) {
        const dimensions =
          result.width && result.height ? ` · ${result.width} × ${result.height} px` : '';
        const frames = result.frames > 1 ? ` · ${result.frames} 帧` : '';
        status(s, `副本已保存${dimensions}${frames}。`);
        s.el('result').textContent = result.path;
        s.el('result').hidden = false;
      } else {
        throw new Error('导出接口未返回保存路径，请重试另存。');
      }
    } catch (e) {
      error(s, `无法另存：${message(e)}`);
      status(s, '编辑参数已保留，可修正后重试。');
    } finally {
      s.saving = false;
      if (s.alive) {
        updateBusy(s);
        formatChanged(s);
      }
    }
  }

  function bind(s) {
    s.el('close').onclick = () => close(s);
    s.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(s);
    });
    s.dialog.addEventListener('close', () => dispose(s));
    // Prevent the underlying viewer's document shortcuts without swallowing native editing keys.
    s.dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close(s);
      }
    });
    s.dialog.addEventListener('keyup', (event) => event.stopPropagation());
    s.el('form').onsubmit = (event) => event.preventDefault();
    s.el('reset').onclick = () => reset(s);
    s.el('retry').onclick = () => (s.ready ? requestFrame(s, s.frame) : load(s));
    s.el('export').onclick = () => exportCopy(s);
    s.el('export-frame').onclick = () => exportCopy(s, true);
    s.el('format').onchange = () => formatChanged(s);
    s.el('rotation').onchange = (event) => {
      s.edit.rotation = Number(event.target.value);
      syncCrop(s);
    };
    s.el('width').oninput = (event) => {
      s.autoWidth = false;
      const width = Number(event.target.value);
      if (event.target.value !== '' && Number.isInteger(width) && width >= 1 && width <= 8192) {
        s.edit.width = width;
        queuePaint(s);
      }
    };
    for (const input of s.dialog.querySelectorAll('[data-color]'))
      input.oninput = () => {
        s.edit[input.dataset.color] = Number(input.value);
        s.el(`${input.dataset.color}-value`).textContent =
          `${Math.round(Number(input.value) * 100)}%`;
        queuePaint(s);
      };
    for (const button of s.dialog.querySelectorAll('[data-color-reset]'))
      button.onclick = () => {
        const input = s.el(button.dataset.colorReset);
        input.value = '1';
        input.oninput();
      };
    s.el('before').onclick = () => {
      s.before = !s.before;
      s.el('before').setAttribute('aria-pressed', String(s.before));
      s.el('before').textContent = s.before ? '返回编辑效果' : '查看原帧';
      s.el('output-title').textContent = s.before ? '对比 · 原帧' : '编辑效果';
      s.el('output').setAttribute(
        'aria-label',
        s.before ? '未经编辑的原帧预览' : '裁剪、旋转及调色后的预览'
      );
      queuePaint(s);
    };
    const seek = (index) => {
      stop(s);
      requestFrame(s, index);
    };
    s.el('prev').onclick = () => seek(s.frame - 1);
    s.el('next').onclick = () => seek(s.frame + 1);
    s.el('seek').oninput = (event) => seek(Number(event.target.value) - 1);
    s.el('frame-number').onchange = (event) => {
      const value = Number(event.target.value);
      if (!Number.isInteger(value) || value < 1 || value > s.frames) {
        error(s, `帧编号必须是 1–${s.frames} 的整数。`);
        return;
      }
      seek(value - 1);
    };
    s.el('play').onclick = () => play(s);
    for (const key of ['from', 'to', 'delay'])
      s.el(key).onchange = () => {
        stop(s);
        try {
          range(s);
          error(s, '');
        } catch (e) {
          error(s, message(e));
        }
        showFrameNumber(s);
      };
    bindCrop(s);
  }

  async function load(s) {
    if (!s.alive || s.metadataLoading) return;
    s.metadataLoading = true;
    s.el('retry').hidden = true;
    s.el('retry').disabled = true;
    error(s, '');
    status(s, '正在读取图片信息…');
    try {
      if (!s.node || s.node.kind !== 'image' || !s.node.id)
        throw new Error('请选择图片节点后打开编辑器。');
      const info = await api('mediaInfo', { id: s.node.id });
      if (!s.alive) return;
      if (
        !Number.isFinite(info?.width) ||
        !Number.isFinite(info?.height) ||
        info.width <= 0 ||
        info.height <= 0
      )
        throw new Error('无法读取有效图片尺寸，请确认格式受支持且原图仍然存在。');
      s.info = info;
      s.width = Math.round(info.width);
      s.height = Math.round(info.height);
      s.frames = Math.max(1, Math.floor(number(info.frames, 1)));
      s.format = String(info.format || '')
        .toLowerCase()
        .replace(/^jpg$/, 'jpeg');
      s.animated = s.frames > 1 && ['gif', 'webp'].includes(s.format);
      // Unsupported multi-page formats remain single-frame editors.
      if (!s.animated) s.frames = 1;
      s.ready = true;
      s.el('animation').hidden = !s.animated;
      s.el('trim').hidden = !s.animated;
      s.el('export-frame').hidden = !s.animated;
      for (const key of ['seek', 'frame-number', 'from', 'to']) s.el(key).max = s.frames;
      s.el('metadata').textContent =
        `${s.width} × ${s.height} px · ${s.format.toUpperCase() || '图片'}${s.animated ? ` · ${s.frames} 帧` : ''} · 编辑副本`;
      const notices = [];
      if (/\.apng$/i.test(s.node.name || '') && s.frames === 1) notices.push('APNG 仅静态帧编辑');
      if (info.hdr || Number(info.depth) > 8 || ['ushort', 'float', 'double'].includes(info.depth))
        notices.push('预览为 sRGB / SDR；颜色与 HDR、高位深原图可能不同。');
      notices.push('色彩预览仅供参考，实际导出由图像引擎处理。JPEG 的透明区域将使用导出引擎背景。');
      s.el('notice').textContent = notices.join(' ');
      s.el('notice').hidden = false;
      reset(s, false);
      updateBusy(s);
      await requestFrame(s, 0);
    } catch (e) {
      if (!s.alive) return;
      error(s, `无法打开编辑器：${message(e)}`);
      s.el('metadata').textContent = '图片信息暂不可用';
      s.el('frame-loading').hidden = true;
      s.el('retry').hidden = false;
      status(s, '请重试载入，或关闭后重新选择图片。');
    } finally {
      s.metadataLoading = false;
      if (s.alive) {
        s.el('retry').disabled = false;
        updateBusy(s);
      }
    }
  }

  async function open(n) {
    if (active?.saving) {
      status(active, '当前副本正在另存，请完成保存对话框后再打开其他图片。');
      active.el('close').focus();
      return;
    }
    if (active) close(active);
    const dialog = document.createElement('dialog');
    dialog.id = 'media-editor';
    dialog.setAttribute('aria-labelledby', 'me-title');
    dialog.setAttribute('aria-describedby', 'me-description');
    dialog.innerHTML = markup(n);
    const s = {
      dialog,
      node: n,
      alive: true,
      ready: false,
      saving: false,
      frame: 0,
      frames: 1,
      frameSerial: 0,
      frameLoading: false,
      playSerial: 0,
      playing: false,
      cache: new Map(),
      pending: null,
      pump: null,
      image: null,
      paintFrame: 0,
      returnFocus: document.activeElement
    };
    s.el = (name) => dialog.querySelector(`#me-${name}`);
    active = s;
    document.body.append(dialog);
    bind(s);
    dialog.showModal();
    s.el('close').focus({ preventScroll: true });
    await load(s);
  }

  return { open };
})();
