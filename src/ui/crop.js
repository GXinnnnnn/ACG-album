'use strict';
function applyCoverCrop(image, node) {
  const x = node.crop_x ?? 50,
    y = node.crop_y ?? 50,
    zoom = node.crop_zoom ?? 1;
  image.style.objectPosition = `${x}% ${y}%`;
  image.style.transformOrigin = `${x}% ${y}%`;
  image.style.setProperty('--crop-zoom', zoom);
}
function cropModal(n) {
  let x = n.crop_x ?? 50,
    y = n.crop_y ?? 50,
    zoom = n.crop_zoom ?? 1,
    drag = null;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  openModal(
    '调整封面位置',
    `<div class="crop-container"><div class="crop-preview" id="crop-preview" tabindex="0" role="img" aria-label="封面预览，按住鼠标拖动，滚轮缩放"><img id="crop-image" draggable="false" alt=""><span class="crop-gesture-hint">按住拖动 · 滚轮缩放</span></div><div class="crop-controls"><p>按住图片拖动位置，滚轮缩放画面。右侧滑条可精确调整，保存仅影响相册封面。</p><label for="crop-zoom">缩放 <span id="crop-zoom-value"></span></label><div class="crop-range-control"><input id="crop-zoom" type="range" min="100" max="400" step="1"><button type="button" data-crop-reset="zoom" class="subtle-button" title="恢复默认值" aria-label="缩放：恢复默认值">恢复默认</button></div><label for="crop-x">水平位置 <span id="crop-x-value"></span></label><div class="crop-range-control"><input id="crop-x" type="range" min="0" max="100" step="0.1"><button type="button" data-crop-reset="x" class="subtle-button" title="恢复默认值" aria-label="水平位置：恢复默认值">恢复默认</button></div><label for="crop-y">垂直位置 <span id="crop-y-value"></span></label><div class="crop-range-control"><input id="crop-y" type="range" min="0" max="100" step="0.1"><button type="button" data-crop-reset="y" class="subtle-button" title="恢复默认值" aria-label="垂直位置：恢复默认值">恢复默认</button></div><button id="crop-center" class="text-button">恢复居中 · 100%</button></div></div><div class="modal-actions"><button id="crop-cancel" class="subtle-button">取消</button><button id="crop-save" class="primary">保存位置</button></div>`,
    720
  );
  const preview = $('#crop-preview'),
    image = $('#crop-image'),
    generation = modalGeneration;
  const update = () => {
    $('#crop-x').value = x;
    $('#crop-y').value = y;
    $('#crop-zoom').value = Math.round(zoom * 100);
    $('#crop-x-value').textContent = `${Math.round(x)}%`;
    $('#crop-y-value').textContent = `${Math.round(y)}%`;
    $('#crop-zoom-value').textContent = `${Math.round(zoom * 100)}%`;
    applyCoverCrop(image, { crop_x: x, crop_y: y, crop_zoom: zoom });
  };
  const dimensions = (z) => {
    const width = preview.clientWidth,
      height = preview.clientHeight,
      scale = Math.max(
        width / (image.naturalWidth || width),
        height / (image.naturalHeight || height)
      );
    return {
      x: Math.max(0, (image.naturalWidth || width) * scale * z - width),
      y: Math.max(0, (image.naturalHeight || height) * scale * z - height)
    };
  };
  image.src = thumb(n);
  image.ondragstart = (e) => e.preventDefault();
  preview.addEventListener('dragstart', (e) => e.preventDefault());
  preview.addEventListener('selectstart', (e) => e.preventDefault());
  for (const axis of ['x', 'y'])
    $('#crop-' + axis).oninput = (e) => {
      if (axis === 'x') x = Number(e.target.value);
      else y = Number(e.target.value);
      update();
    };
  $('#crop-zoom').oninput = (e) => {
    zoom = Number(e.target.value) / 100;
    update();
  };
  preview.onpointerdown = (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    getSelection()?.removeAllRanges();
    preview.focus({ preventScroll: true });
    drag = { id: e.pointerId, px: e.clientX, py: e.clientY };
    preview.setPointerCapture(e.pointerId);
    preview.classList.add('dragging');
  };
  preview.onpointermove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const overflow = dimensions(zoom);
    if (overflow.x > 0.5) x = clamp(x - ((e.clientX - drag.px) / overflow.x) * 100, 0, 100);
    if (overflow.y > 0.5) y = clamp(y - ((e.clientY - drag.py) / overflow.y) * 100, 0, 100);
    drag.px = e.clientX;
    drag.py = e.clientY;
    update();
  };
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    preview.classList.remove('dragging');
    if (preview.hasPointerCapture(e.pointerId)) preview.releasePointerCapture(e.pointerId);
  };
  preview.onpointerup = release;
  preview.onpointercancel = release;
  preview.onlostpointercapture = () => {
    drag = null;
    preview.classList.remove('dragging');
  };
  preview.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!image.naturalWidth) return;
      const delta =
          e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? preview.clientHeight : 1),
        next = clamp(zoom * Math.exp(-delta * 0.0015), 1, 4);
      if (next === zoom) return;
      const old = dimensions(zoom),
        fresh = dimensions(next),
        r = preview.getBoundingClientRect(),
        px = clamp(e.clientX - r.left, 0, preview.clientWidth),
        py = clamp(e.clientY - r.top, 0, preview.clientHeight),
        ratio = next / zoom;
      x =
        fresh.x > 0.5
          ? clamp((((px + (x / 100) * old.x) * ratio - px) / fresh.x) * 100, 0, 100)
          : 50;
      y =
        fresh.y > 0.5
          ? clamp((((py + (y / 100) * old.y) * ratio - py) / fresh.y) * 100, 0, 100)
          : 50;
      zoom = next;
      update();
    },
    { passive: false }
  );
  preview.onkeydown = (e) => {
    const d = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft') x = clamp(x - d, 0, 100);
    else if (e.key === 'ArrowRight') x = clamp(x + d, 0, 100);
    else if (e.key === 'ArrowUp') y = clamp(y - d, 0, 100);
    else if (e.key === 'ArrowDown') y = clamp(y + d, 0, 100);
    else if (e.key === '+' || e.key === '=') zoom = clamp(zoom + 0.05, 1, 4);
    else if (e.key === '-') zoom = clamp(zoom - 0.05, 1, 4);
    else return;
    e.preventDefault();
    update();
  };
  for (const button of $$('#modal [data-crop-reset]'))
    button.onclick = () => {
      const key = button.dataset.cropReset;
      if (key === 'zoom') zoom = 1;
      else if (key === 'x') x = 50;
      else y = 50;
      update();
    };
  $('#crop-center').onclick = () => {
    x = y = 50;
    zoom = 1;
    update();
  };
  $('#crop-cancel').onclick = closeModal;
  $('#crop-save').onclick = () =>
    attempt(async () => {
      const button = $('#crop-save');
      button.disabled = true;
      try {
        const updated = await api('patch', {
          id: n.id,
          changes: { crop_x: x, crop_y: y, crop_zoom: zoom, confirmed: 1 }
        });
        if (generation === modalGeneration) closeModal();
        updateCoverNode(updated);
        toast('封面位置与缩放已保存');
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  update();
}
