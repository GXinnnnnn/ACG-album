'use strict';
/* CSS samples the real DOM backdrop. WebGL refracts a deliberately incomplete,
   low-resolution scene proxy (theme + decoded pictures, not text/controls).
   No capturePage, DOM screenshot, fetch, continuous RAF or per-card GL context. */
((scope, factory) => {
  const kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  else scope.albumLiquidGlass = kit.mount(scope);
})(typeof window === 'undefined' ? null : window, () => {
  const surfaces =
    '.sidebar-shell,.topbar > .brand,.topbar > .navigation,.topbar > .search-wrap,.topbar > .header-actions,.toolbar-right,.back-to-top,.context-menu,.album-select-list,.progress-panel,.toast,.modal:not(.viewer)';
  const vertex = `#version 300 es
  precision highp float;
  out vec2 uv;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;
  const fragment = `#version 300 es
  precision highp float;
  uniform sampler2D scene;
  uniform vec2 size;
  uniform vec2 origin;
  uniform vec2 viewport;
  uniform vec2 light;
  uniform float radius;
  uniform float dark;
  uniform float strength;
  uniform vec4 material;
  uniform vec4 frost;
  in vec2 uv;
  out vec4 color;
  float shape(vec2 p) {
    vec2 q = abs(p) - size * 0.5 + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }
  void main() {
    vec2 p = (uv - 0.5) * size;
    float d = shape(p);
    float mask = 1.0 - smoothstep(-0.7, 0.7, d);
    if (mask < 0.001) discard;
    vec2 gradient = vec2(shape(p + vec2(0.5,0)) - shape(p - vec2(0.5,0)),
                         shape(p + vec2(0,0.5)) - shape(p - vec2(0,0.5)));
    vec2 normal = normalize(gradient + vec2(0.00001));
    float bevel = 1.0 - smoothstep(0.0, material.x, -d);
    float shoulder = 1.0 - smoothstep(0.0, material.y, -d);
    float fresnel = pow(bevel, 2.4);
    vec2 lens = p / max(size * 0.5, vec2(1.0));
    vec3 bodyNormal = normalize(vec3(lens * 0.22, 1.0));
    float sheen = pow(max(dot(bodyNormal, normalize(vec3(light * 0.35, 1.0))), 0.0), 10.0);
    vec2 base = (origin + uv * size) / viewport;
    vec2 bend = (normal * (10.0 * bevel + 3.0 * shoulder) + lens * 2.5) * strength / viewport;
    vec2 aberration = normal * 1.3 * bevel / viewport;
    vec3 refracted = vec3(texture(scene, clamp(base + bend + aberration, 0.0, 1.0)).r,
                          texture(scene, clamp(base + bend, 0.0, 1.0)).g,
                          texture(scene, clamp(base + bend - aberration, 0.0, 1.0)).b);
    float specular = pow(max(dot(normal, normalize(light + vec2(0.0001))), 0.0), 5.0) * fresnel;
    vec3 tint = mix(vec3(0.90,0.92,1.0), vec3(0.24,0.25,0.34), dark);
    vec3 optical = mix(refracted, tint, 0.22) + specular * mix(0.55,0.35,dark) + sheen * 0.035;
    // A nonzero body floor keeps the whole surface optical, not just its rim.
    // Wide shoulders blend the stronger lens edge into this frosted interior.
    float alpha = mask * (material.z + shoulder * 0.08 + fresnel * 0.32 + specular * 0.22 + sheen * material.w);
    // One rounded content rectangle, independent of individual settings rows.
    // Suppress the scene proxy toward its frosted center from all four sides.
    if (frost.z > 0.0) {
      vec2 point = vec2(uv.x * size.x, (1.0 - uv.y) * size.y);
      vec2 q = abs(point - frost.xy) - frost.zw + vec2(18.0);
      float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 18.0;
      alpha *= mix(0.12, 1.0, smoothstep(-6.0, 24.0, distance));
    }
    color = vec4(optical, alpha);
  }`;
  function dialogFrostBounds(rect, textRects) {
    const inset = 12;
    const visible = textRects.map((r) => intersectRect(rect, r)).filter(Boolean);
    const left = visible.length ? Math.min(...visible.map((r) => r.left)) - rect.left - 8 : 24;
    const top = visible.length ? Math.min(...visible.map((r) => r.top)) - rect.top - 8 : 24;
    const right = visible.length
      ? Math.max(...visible.map((r) => r.right)) - rect.left + 8
      : rect.width - 24;
    const bottom = visible.length
      ? Math.max(...visible.map((r) => r.bottom)) - rect.top + 8
      : rect.height - 24;
    const x = Math.max(inset, Math.min(left, rect.width - inset * 2));
    const y = Math.max(inset, Math.min(top, rect.height - inset * 2));
    return {
      x,
      y,
      width: Math.max(1, Math.min(rect.width - inset, right) - x),
      height: Math.max(1, Math.min(rect.height - inset, bottom) - y)
    };
  }
  function frostMask(rect, frost, dark = false) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${rect.width} ${rect.height}"><defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs><rect x="${frost.x}" y="${frost.y}" width="${frost.width}" height="${frost.height}" rx="18" fill="${dark ? '#1a1825' : '#faf8ff'}" fill-opacity="${dark ? 0.86 : 0.82}" filter="url(#f)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  function materialProfile(width, height) {
    const halfSpan = Math.max(1, Math.min(width, height) * 0.5);
    return {
      edgeWidth: Math.min(14, halfSpan * 0.7),
      shoulderWidth: Math.min(180, Math.max(24, halfSpan * 0.9)),
      bodyAlpha: 0.14,
      sheenAlpha: 0.06
    };
  }
  function budget(width, height, dpr = 1) {
    const scale = Math.min(
      1.5,
      Math.max(0.5, dpr),
      Math.sqrt(180000 / Math.max(1, width * height)),
      1024 / Math.max(1, width, height)
    );
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  function scheduler(win, draw, enabled) {
    let frame = 0,
      timer = null,
      last = -Infinity;
    const cancel = () => {
      if (frame) win.cancelAnimationFrame(frame);
      if (timer !== null) win.clearTimeout(timer);
      frame = 0;
      timer = null;
    };
    const run = () => {
      frame = 0;
      if (!enabled()) return;
      last = win.performance.now();
      draw();
    };
    const request = () => {
      if (!enabled() || frame || timer !== null) return;
      const wait = Math.max(0, 34 - (win.performance.now() - last));
      if (wait)
        timer = win.setTimeout(() => {
          timer = null;
          if (enabled()) frame = win.requestAnimationFrame(run);
        }, wait);
      else frame = win.requestAnimationFrame(run);
    };
    return { request, cancel, pending: () => Number(!!frame) + Number(timer !== null) };
  }
  function createRenderer(canvas, changed, now = () => performance.now()) {
    let gl,
      program,
      texture,
      vao,
      lost = false,
      failed = false,
      pending = [],
      timerExt;
    const stats = {
      status: 'uninitialized',
      draws: 0,
      uploads: 0,
      contextLosses: 0,
      restores: 0,
      gpuMs: [],
      cpuSubmitMs: [],
      coldInit: null,
      initSamples: [],
      renderer: '',
      error: ''
    };
    const uniforms = {};
    let initTiming;
    function compile(type, source) {
      const submittedAt = now();
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      initTiming.compileSubmitMs += now() - submittedAt;
      const waitAt = now();
      const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      initTiming.compileStatusWaitMs += now() - waitAt;
      if (!compiled) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message || 'Shader compilation failed');
      }
      return shader;
    }
    function init() {
      const began = now();
      initTiming = {
        contextMs: 0,
        compileSubmitMs: 0,
        compileStatusWaitMs: 0,
        linkSubmitMs: 0,
        linkStatusWaitMs: 0,
        totalMs: 0
      };
      try {
        // Stable shared backing avoids reallocating a drawing buffer per surface.
        // Only a <=180k pixel scissored viewport is shaded/copied per draw.
        canvas.width = 1024;
        canvas.height = 1024;
        const contextAt = now();
        gl = canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: false,
          powerPreference: 'low-power'
        });
        initTiming.contextMs = now() - contextAt;
        if (!gl) throw new Error('WebGL2 unavailable');
        const vs = compile(gl.VERTEX_SHADER, vertex),
          fs = compile(gl.FRAGMENT_SHADER, fragment);
        const linkAt = now();
        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        initTiming.linkSubmitMs = now() - linkAt;
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        const linkWaitAt = now();
        const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
        initTiming.linkStatusWaitMs = now() - linkWaitAt;
        if (!linked) throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
        gl.useProgram(program);
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        for (const name of [
          'scene',
          'size',
          'origin',
          'viewport',
          'light',
          'radius',
          'dark',
          'strength',
          'material',
          'frost'
        ])
          uniforms[name] = gl.getUniformLocation(program, name);
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(uniforms.scene, 0);
        timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        stats.renderer = String(
          gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
        );
        failed = false;
        lost = false;
        stats.status = 'webgl2';
        stats.error = '';
      } catch (error) {
        failed = true;
        stats.status = 'css-fallback';
        stats.error = String(error.message);
      }
      initTiming.totalMs = now() - began;
      stats.coldInit ||= { ...initTiming };
      stats.initSamples.push({ ...initTiming });
      if (stats.initSamples.length > 8) stats.initSamples.shift();
      changed?.(stats.status);
    }
    const loss = (event) => {
      event.preventDefault();
      lost = true;
      stats.status = 'context-lost';
      stats.contextLosses++;
      pending = [];
      changed?.(stats.status);
    };
    const restore = () => {
      stats.restores++;
      init();
    };
    canvas.addEventListener('webglcontextlost', loss);
    canvas.addEventListener('webglcontextrestored', restore);
    init();
    return {
      ready: () => !lost && !failed && stats.status === 'webgl2',
      upload(source) {
        if (lost || failed) return false;
        try {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          stats.uploads++;
          return true;
        } catch (error) {
          stats.error = 'Scene upload failed: ' + error.message;
          return false;
        }
      },
      begin() {
        if (!timerExt || lost || failed || pending.length >= 4) return null;
        const query = gl.createQuery();
        gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
        return query;
      },
      end(query) {
        if (query && !lost) {
          gl.endQuery(timerExt.TIME_ELAPSED_EXT);
          pending.push(query);
        }
      },
      render(target, rect, view, options) {
        if (lost || failed) return;
        const start = now(),
          pixels = budget(rect.width, rect.height, options.dpr);
        gl.viewport(0, 0, pixels.width, pixels.height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, pixels.width, pixels.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform2f(uniforms.size, rect.width, rect.height);
        gl.uniform2f(uniforms.origin, rect.left, view.height - rect.bottom);
        gl.uniform2f(uniforms.viewport, view.width, view.height);
        gl.uniform2f(uniforms.light, options.light[0], options.light[1]);
        gl.uniform1f(uniforms.radius, options.radius);
        gl.uniform1f(uniforms.dark, Number(options.dark));
        gl.uniform1f(uniforms.strength, options.strength);
        const material = materialProfile(rect.width, rect.height);
        gl.uniform4f(
          uniforms.material,
          material.edgeWidth,
          material.shoulderWidth,
          material.bodyAlpha,
          material.sheenAlpha
        );
        const frost = options.frost;
        gl.uniform4f(
          uniforms.frost,
          frost ? frost.x + frost.width / 2 : 0,
          frost ? frost.y + frost.height / 2 : 0,
          frost ? frost.width / 2 : 0,
          frost ? frost.height / 2 : 0
        );
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (target.width !== pixels.width) target.width = pixels.width;
        if (target.height !== pixels.height) target.height = pixels.height;
        const ctx = target.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(
          canvas,
          0,
          canvas.height - pixels.height,
          pixels.width,
          pixels.height,
          0,
          0,
          pixels.width,
          pixels.height
        );
        stats.draws++;
        stats.cpuSubmitMs.push(now() - start);
        if (stats.cpuSubmitMs.length > 120) stats.cpuSubmitMs.shift();
      },
      stats() {
        if (!lost && !failed && timerExt) {
          const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
          pending = pending.filter((query) => {
            if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true;
            if (!disjoint) {
              stats.gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
              if (stats.gpuMs.length > 120) stats.gpuMs.shift();
            }
            gl.deleteQuery(query);
            return false;
          });
        }
        return {
          ...stats,
          cpuSubmitMs: [...stats.cpuSubmitMs],
          gpuMs: [...stats.gpuMs],
          pendingQueries: pending.length
        };
      },
      destroy() {
        canvas.removeEventListener('webglcontextlost', loss);
        canvas.removeEventListener('webglcontextrestored', restore);
        if (gl && !lost) {
          for (const q of pending) gl.deleteQuery(q);
          if (texture) gl.deleteTexture(texture);
          if (vao) gl.deleteVertexArray(vao);
          if (program) gl.deleteProgram(program);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
        pending = [];
        stats.status = 'destroyed';
      }
    };
  }
  function imageSampler(doc, metrics, now = () => performance.now()) {
    const cache = new WeakMap();
    return (img) => {
      const key = (img.currentSrc || img.src) + ':' + img.naturalWidth + ':' + img.naturalHeight;
      const old = cache.get(img);
      if (old?.key === key) return old.canvas;
      const began = now();
      const sample = doc.createElement('canvas'),
        scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
      sample.width = Math.max(1, Math.round(img.naturalWidth * scale));
      sample.height = Math.max(1, Math.round(img.naturalHeight * scale));
      let picture = null;
      try {
        const ctx = sample.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, sample.width, sample.height);
        // One security read per decoded source, never a per-frame DOM readback.
        metrics.securityChecks++;
        ctx.getImageData(0, 0, 1, 1);
        picture = sample;
      } catch {
        metrics.skippedImages++;
      }
      metrics.securityCpuMs = (metrics.securityCpuMs || 0) + now() - began;
      cache.set(img, { key, canvas: picture });
      return picture;
    };
  }
  function nativeInactive(event) {
    return event?.type === 'window' && typeof event.data?.inactive === 'boolean'
      ? event.data.inactive
      : null;
  }
  function intersectRect(a, b) {
    const left = Math.max(a.left, b.left),
      top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right),
      bottom = Math.min(a.bottom, b.bottom);
    return right - left >= 1 && bottom - top >= 1
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  }
  function paintedBounds(rect, clip, naturalWidth, naturalHeight, fit, position) {
    const ratio =
      fit === 'cover'
        ? Math.max(rect.width / naturalWidth, rect.height / naturalHeight)
        : Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    const width = fit === 'fill' ? rect.width : naturalWidth * ratio;
    const height = fit === 'fill' ? rect.height : naturalHeight * ratio;
    const [px, py] = position
      .split(' ')
      .map((value) => (value.endsWith('%') ? parseFloat(value) / 100 : 0.5));
    const left = rect.left + (rect.width - width) * (px ?? 0.5),
      top = rect.top + (rect.height - height) * (py ?? 0.5);
    return intersectRect({ left, top, right: left + width, bottom: top + height }, clip);
  }
  function syncLegibility(rows, pictures, tracked) {
    const live = new Set(rows.map((row) => row.host));
    let backed = 0,
      changes = 0;
    for (const host of tracked)
      if (!live.has(host)) {
        if (host.hasAttribute('data-glass-image-under')) {
          host.removeAttribute('data-glass-image-under');
          changes++;
        }
        tracked.delete(host);
      }
    for (const { host, rect } of rows) {
      const under = pictures.some(
        (picture) => picture.bounds && intersectRect(rect, picture.bounds)
      );
      if (under) backed++;
      if (under !== host.hasAttribute('data-glass-image-under')) {
        if (under) host.setAttribute('data-glass-image-under', 'true');
        else host.removeAttribute('data-glass-image-under');
        changes++;
      }
      tracked.add(host);
    }
    return { backed, changes };
  }
  function mount(win) {
    const doc = win.document,
      root = doc.documentElement,
      reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const hosts = new Map(),
      legibilityHosts = new Set(),
      listeners = [];
    let engine = null,
      shared = null,
      scene = null,
      dirty = true,
      layoutDirty = true,
      suspended = false,
      destroyed = false,
      inactive = false;
    let pointer = [-0.65, 0.8],
      hotHost = null,
      visible = [],
      rendered = 0;
    const uniformDirtyHosts = new Set();
    const metrics = {
      frames: 0,
      sceneBuilds: 0,
      sampledImages: 0,
      skippedImages: 0,
      securityChecks: 0,
      frameCpuMs: [],
      phaseCpuMs: [],
      coldFrame: null,
      securityCpuMs: 0,
      lastUploadMs: 0,
      lastReason: '',
      legibilityPasses: 0,
      legibilityChanges: 0,
      imageBackedSurfaces: 0,
      imageCandidates: 0,
      sampleMode: 'theme-and-decoded-images-proxy'
    };
    const readable = () => !destroyed && !suspended && !doc.hidden && !inactive;
    const enabled = () =>
      readable() && root.dataset.liquidGlass !== 'off' && (!engine || engine.ready());
    const queue = scheduler(win, paint, enabled);
    // Off/fallback still needs text contrast, without creating or polling GL.
    const legibilityQueue = scheduler(win, refreshLegibility, readable);
    const on = (node, type, fn, options) => {
      node.addEventListener(type, fn, options);
      listeners.push(() => node.removeEventListener(type, fn, options));
    };
    function removeCanvases() {
      for (const [host, canvas] of hosts) {
        resizeObserver?.unobserve(host);
        canvas.remove();
        host.removeAttribute('data-liquid-glass-host');
        host.removeAttribute('data-liquid-static');
      }
      hosts.clear();
      visible = [];
      hotHost = null;
      uniformDirtyHosts.clear();
    }
    function invalidate(reason, sceneChanged = true) {
      if (sceneChanged) {
        dirty = true;
        layoutDirty = true;
      }
      metrics.lastReason = reason;
      if (!enabled()) {
        queue.cancel();
        if (root.dataset.liquidGlass === 'off') removeCanvases();
        if (!readable()) legibilityQueue.cancel();
        else if (sceneChanged) legibilityQueue.request();
        return;
      }
      legibilityQueue.cancel();
      queue.request();
    }
    function createCanvas() {
      const canvas = doc.createElement('canvas');
      canvas.className = 'liquid-glass-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.setAttribute('role', 'presentation');
      canvas.setAttribute('inert', '');
      canvas.tabIndex = -1;
      return canvas;
    }
    function measureDialogFrost(host, rect) {
      if (!host.matches?.('.modal:not(.viewer)') || !doc.createTreeWalker) return null;
      const textRects = [];
      const walker = doc.createTreeWalker(host, 4);
      const range = doc.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (
          !node.textContent.trim() ||
          node.parentElement.closest('script,style,[hidden],.liquid-glass-canvas')
        )
          continue;
        range.selectNodeContents(node);
        for (const box of range.getClientRects()) {
          let clipped = intersectRect(rect, box);
          for (
            let parent = node.parentElement;
            clipped && parent && parent !== host;
            parent = parent.parentElement
          ) {
            const style = win.getComputedStyle(parent);
            if (style.visibility === 'hidden' || style.display === 'none') {
              clipped = null;
              break;
            }
            if (
              /(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)
            )
              clipped = intersectRect(clipped, parent.getBoundingClientRect());
          }
          if (clipped) textRects.push(clipped);
        }
      }
      for (const field of host.querySelectorAll('input,textarea,select')) {
        if (field.getClientRects().length) textRects.push(field.getBoundingClientRect());
      }
      return dialogFrostBounds(rect, textRects);
    }
    function syncFrost(rows) {
      for (const row of rows) {
        if (!row.frost) continue;
        const mask = frostMask(row.rect, row.frost, row.dark);
        if (row.host.style.getPropertyValue('--dialog-frost-image') !== mask)
          row.host.style.setProperty('--dialog-frost-image', mask);
      }
    }
    function measureSurfaces() {
      const rows = [],
        viewerOpen = !!doc.querySelector('.viewer[open]');
      // The media viewer has its own static frosted rim. Its open dialog also
      // occludes the library, so only a separate top-layer dialog can need GL.
      // All geometry/style reads precede canvas attachment/size writes.
      for (const host of doc.querySelectorAll(surfaces)) {
        if (
          host.closest('.album-card,.collection-tile,.viewer') ||
          (viewerOpen && !host.closest('dialog[open]'))
        )
          continue;
        const rect = host.getBoundingClientRect();
        if (
          rect.width < 8 ||
          rect.height < 8 ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= win.innerHeight ||
          rect.left >= win.innerWidth ||
          host.getClientRects().length === 0
        )
          continue;
        const style = win.getComputedStyle(host);
        if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        const rawRadius = parseFloat(style.borderTopLeftRadius) || 0;
        rows.push({
          host,
          rect,
          radius: Math.min(rawRadius, rect.width / 2, rect.height / 2),
          frost: measureDialogFrost(host, rect),
          dark: root.dataset.theme === 'dark',
          isStatic: style.position === 'static'
        });
        if (rows.length >= 16) break;
      }
      return rows;
    }
    function discover() {
      const rows = measureSurfaces();
      syncFrost(rows);
      const active = new Set(rows.map((row) => row.host));
      for (const [host, canvas] of hosts)
        if (!host.isConnected || !active.has(host)) {
          resizeObserver.unobserve(host);
          canvas.remove();
          host.removeAttribute('data-liquid-glass-host');
          host.removeAttribute('data-liquid-static');
          hosts.delete(host);
        }
      for (const row of rows)
        if (!hosts.has(row.host)) {
          const canvas = createCanvas();
          row.host.dataset.liquidGlassHost = '';
          if (row.isStatic) row.host.dataset.liquidStatic = '';
          row.host.append(canvas);
          hosts.set(row.host, canvas);
          resizeObserver.observe(row.host);
        }
      return rows;
    }
    const safePicture = imageSampler(doc, metrics, () => win.performance.now());
    function collectPictures() {
      const pictures = [];
      if (doc.querySelector('.viewer[open]')) return pictures;
      const screen = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
      const viewport = doc.querySelector('#viewport')?.getBoundingClientRect();
      for (const img of doc.querySelectorAll('.cover-shell img,.collection-image > img')) {
        // Exclude a floating surface's own pictures even when GL is off and
        // no canvas-host attribute exists. Video content is not an image proxy.
        if (!img.complete || !img.naturalWidth || !img.naturalHeight || img.closest(surfaces))
          continue;
        const rect = img.getBoundingClientRect();
        if (
          rect.width < 2 ||
          rect.height < 2 ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= win.innerHeight ||
          rect.left >= win.innerWidth ||
          !img.getClientRects().length
        )
          continue;
        const clip = img.parentElement.getBoundingClientRect(),
          style = win.getComputedStyle(img);
        if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        let legibleClip = intersectRect(clip, screen);
        if (legibleClip && viewport && img.closest('#viewport'))
          legibleClip = intersectRect(legibleClip, viewport);
        const bounds =
          legibleClip &&
          paintedBounds(
            rect,
            legibleClip,
            img.naturalWidth,
            img.naturalHeight,
            style.objectFit,
            style.objectPosition
          );
        pictures.push({
          img,
          rect,
          clip,
          fit: style.objectFit,
          position: style.objectPosition,
          bounds
        });
        // Geometry is cheap and independent of the existing 24-upload budget;
        // cover the wider visible 4K grid without measuring any text nodes.
        if (pictures.length >= 128) break;
      }
      return pictures;
    }
    function applyLegibility(rows, pictures) {
      const result = syncLegibility(rows, pictures, legibilityHosts);
      metrics.legibilityPasses++;
      metrics.legibilityChanges += result.changes;
      metrics.imageBackedSurfaces = result.backed;
      metrics.imageCandidates = pictures.length;
    }
    function refreshLegibility() {
      if (!readable()) return;
      applyLegibility(measureSurfaces(), collectPictures());
    }
    function buildScene() {
      const scale = Math.min(1, 640 / Math.max(win.innerWidth, win.innerHeight));
      scene ||= doc.createElement('canvas');
      scene.width = Math.max(1, Math.round(win.innerWidth * scale));
      scene.height = Math.max(1, Math.round(win.innerHeight * scale));
      const ctx = scene.getContext('2d');
      ctx.fillStyle = root.dataset.theme === 'dark' ? '#15151f' : '#e8e9f1';
      ctx.fillRect(0, 0, scene.width, scene.height);
      const pictures = collectPictures();
      applyLegibility(visible, pictures);
      let sampled = 0;
      for (const { img, rect, clip, fit, position } of pictures.slice(0, 24)) {
        const picture = safePicture(img);
        if (!picture) continue;
        const ratio =
          fit === 'cover'
            ? Math.max(rect.width / picture.width, rect.height / picture.height)
            : Math.min(rect.width / picture.width, rect.height / picture.height);
        const w = fit === 'fill' ? rect.width : picture.width * ratio,
          h = fit === 'fill' ? rect.height : picture.height * ratio;
        const [px, py] = position
          .split(' ')
          .map((value) => (value.endsWith('%') ? parseFloat(value) / 100 : 0.5));
        ctx.save();
        try {
          ctx.scale(scale, scale);
          ctx.beginPath();
          ctx.rect(clip.left, clip.top, clip.width, clip.height);
          ctx.clip();
          ctx.drawImage(
            picture,
            rect.left + (rect.width - w) * (px ?? 0.5),
            rect.top + (rect.height - h) * (py ?? 0.5),
            w,
            h
          );
          sampled++;
        } catch {
          metrics.skippedImages++;
        } finally {
          ctx.restore();
        }
      }
      metrics.sampledImages = sampled;
      metrics.sampleMode = sampled
        ? 'theme-and-decoded-images-proxy'
        : 'theme-only-no-readable-images';
      metrics.sceneBuilds++;
      const uploadAt = win.performance.now();
      const uploaded = engine.upload(scene);
      metrics.lastUploadMs = win.performance.now() - uploadAt;
      return uploaded;
    }
    function ensureEngine() {
      if (engine) return;
      shared = createCanvas();
      engine = createRenderer(
        shared,
        (status) => {
          root.dataset.liquidRenderer = status;
          if (status !== 'webgl2') {
            queue.cancel();
            for (const canvas of hosts.values()) canvas.hidden = true;
          } else {
            dirty = true;
            if (engine) invalidate('context-ready');
          }
        },
        () => win.performance.now()
      );
    }
    function paint() {
      if (!enabled()) return;
      const start = win.performance.now();
      const phase = {
        coldInit: !engine,
        ensureMs: 0,
        discoverMs: 0,
        sceneBuildInclusiveMs: 0,
        securityMs: 0,
        uploadMs: 0,
        drawBatchMs: 0,
        totalMs: 0
      };
      ensureEngine();
      phase.ensureMs = win.performance.now() - start;
      if (!engine.ready()) {
        syncFrost(measureSurfaces());
        refreshLegibility();
        return;
      }
      const fullDraw =
        dirty || layoutDirty || !['pointer', 'pointer-leave'].includes(metrics.lastReason);
      if (layoutDirty) {
        const discoverAt = win.performance.now();
        visible = discover();
        phase.discoverMs = win.performance.now() - discoverAt;
        layoutDirty = false;
      }
      if (dirty) {
        const sceneAt = win.performance.now(),
          securityBefore = metrics.securityCpuMs;
        const uploaded = buildScene();
        phase.sceneBuildInclusiveMs = win.performance.now() - sceneAt;
        phase.securityMs = metrics.securityCpuMs - securityBefore;
        phase.uploadMs = metrics.lastUploadMs;
        if (!uploaded) {
          for (const c of hosts.values()) c.hidden = true;
          root.dataset.liquidRenderer = 'css-fallback';
          return;
        }
        dirty = false;
      }
      const drawAt = win.performance.now();
      const query = engine.begin();
      try {
        for (const row of visible) {
          if (!fullDraw && !uniformDirtyHosts.has(row.host)) continue;
          const canvas = hosts.get(row.host);
          engine.render(
            canvas,
            row.rect,
            { width: win.innerWidth, height: win.innerHeight },
            {
              radius: row.radius,
              frost: row.frost,
              dark: row.dark,
              light: row.host === hotHost ? pointer : [-0.65, 0.8],
              dpr: win.devicePixelRatio || 1,
              strength: reduced.matches || root.dataset.motion === 'low' ? 0.45 : 1
            }
          );
          canvas.hidden = false;
          rendered++;
        }
      } finally {
        engine.end(query);
      }
      phase.drawBatchMs = win.performance.now() - drawAt;
      phase.totalMs = win.performance.now() - start;
      metrics.coldFrame ||= { ...phase };
      metrics.phaseCpuMs.push(phase);
      if (metrics.phaseCpuMs.length > 120) metrics.phaseCpuMs.shift();
      uniformDirtyHosts.clear();
      metrics.frames++;
      metrics.frameCpuMs.push(phase.totalMs);
      if (metrics.frameCpuMs.length > 120) metrics.frameCpuMs.shift();
      root.dataset.liquidRenderer = 'webgl2';
    }
    const resizeObserver = new win.ResizeObserver(() => invalidate('surface-resize'));
    const observer = new win.MutationObserver((records) => {
      let changed = false;
      for (const record of records) {
        if (record.target?.classList?.contains('liquid-glass-canvas')) continue;
        if (record.type === 'attributes') {
          if (
            record.target === root ||
            record.attributeName === 'hidden' ||
            record.attributeName === 'open' ||
            record.target.matches?.(surfaces)
          )
            changed = true;
        } else if (
          record.target?.parentElement?.closest('.modal:not(.viewer)') ||
          record.target?.closest?.('.modal:not(.viewer)')
        ) {
          changed = true;
        } else if (
          [...(record.addedNodes || []), ...(record.removedNodes || [])].some(
            (node) => node.nodeType === 1 && !node.classList?.contains('liquid-glass-canvas')
          )
        )
          changed = true;
      }
      if (changed) invalidate('dom');
    });
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'open', 'class']
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-motion', 'data-liquid-glass']
    });
    on(doc, 'scroll', () => invalidate('scroll'), { capture: true, passive: true });
    on(doc, 'toggle', () => invalidate('top-layer-toggle'), true);
    on(
      doc,
      'load',
      (event) => {
        if (event.target?.tagName === 'IMG') invalidate('decoded-image');
      },
      true
    );
    on(
      doc,
      'error',
      (event) => {
        if (event.target?.tagName === 'IMG') invalidate('image-error');
      },
      true
    );
    on(win, 'resize', () => invalidate('viewport-resize'), { passive: true });
    on(win, 'album-effects-change', () => invalidate('settings'));
    on(doc, 'visibilitychange', () => invalidate('visibility'));
    on(win, 'blur', () => {
      inactive = true;
      queue.cancel();
      legibilityQueue.cancel();
    });
    on(win, 'focus', () => {
      inactive = false;
      invalidate('focus');
    });
    on(reduced, 'change', () => invalidate('reduced-motion', false));
    on(
      doc,
      'pointermove',
      (event) => {
        if (
          reduced.matches ||
          root.dataset.motion === 'low' ||
          event.pointerType !== 'mouse' ||
          event.buttons ||
          !event.target.closest?.('[data-liquid-glass-host]')
        )
          return;
        const host = event.target.closest('[data-liquid-glass-host]'),
          row = visible.find((item) => item.host === host);
        if (!row) return;
        if (hotHost && hotHost !== host) uniformDirtyHosts.add(hotHost);
        hotHost = host;
        uniformDirtyHosts.add(host);
        pointer = [
          ((event.clientX - row.rect.left) / row.rect.width - 0.5) * 2,
          1 - ((event.clientY - row.rect.top) / row.rect.height) * 2
        ];
        invalidate('pointer', false);
      },
      { passive: true }
    );
    on(
      doc,
      'pointerout',
      (event) => {
        if (reduced.matches || root.dataset.motion === 'low') {
          hotHost = null;
          uniformDirtyHosts.clear();
          return;
        }
        if (!hotHost || hotHost.contains(event.relatedTarget)) return;
        if (hotHost.contains(event.target)) {
          uniformDirtyHosts.add(hotHost);
          hotHost = null;
          invalidate('pointer-leave', false);
        }
      },
      { passive: true }
    );
    let nativeUnsubscribe;
    if (win.album?.onEvent)
      nativeUnsubscribe = win.album.onEvent((event) => {
        const value = nativeInactive(event);
        if (value !== null) {
          inactive = value;
          invalidate('native-window');
        }
      });
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      queue.cancel();
      legibilityQueue.cancel();
      for (const host of legibilityHosts) host.removeAttribute('data-glass-image-under');
      legibilityHosts.clear();
      observer.disconnect();
      resizeObserver.disconnect();
      for (const remove of listeners) remove();
      if (typeof nativeUnsubscribe === 'function') nativeUnsubscribe();
      removeCanvases();
      engine?.destroy();
      scene = null;
      shared = null;
      root.dataset.liquidRenderer = 'destroyed';
    }
    on(win, 'pagehide', destroy);
    invalidate('initial');
    return Object.freeze({
      refresh(options = {}) {
        dirty = true;
        layoutDirty = true;
        if (
          options.immediate &&
          !destroyed &&
          !doc.hidden &&
          !inactive &&
          root.dataset.liquidGlass !== 'off'
        ) {
          const wasSuspended = suspended;
          suspended = false;
          queue.cancel();
          try {
            paint();
          } finally {
            suspended = wasSuspended;
            if (suspended) queue.cancel();
          }
        } else invalidate('api');
      },
      suspend(value) {
        suspended = !!value;
        if (suspended) {
          queue.cancel();
          legibilityQueue.cancel();
        } else invalidate('resume');
      },
      stats() {
        return {
          ...metrics,
          frameCpuMs: [...metrics.frameCpuMs],
          renderedSurfaces: rendered,
          visibleSurfaces: visible.length,
          hosts: hosts.size,
          pending: queue.pending() + legibilityQueue.pending(),
          legibilityPending: legibilityQueue.pending(),
          suspended,
          hidden: doc.hidden,
          inactive,
          sceneWidth: scene?.width || 0,
          sceneHeight: scene?.height || 0,
          gpu: engine?.stats() || { status: 'uninitialized' },
          sampleDescription:
            'CSS blur uses real DOM; WebGL scene proxy contains theme colors and at most 24 decoded images, excludes DOM text/controls; per-source 1px security check.'
        };
      },
      destroy
    });
  }
  return {
    budget,
    materialProfile,
    dialogFrostBounds,
    frostMask,
    scheduler,
    createRenderer,
    imageSampler,
    nativeInactive,
    intersectRect,
    paintedBounds,
    syncLegibility,
    mount,
    vertex,
    fragment,
    surfaces
  };
});
