'use strict';
// Classic script: dependencies are resolved only when the factory/methods run.
// Page numbers stay absolute (offset = page * 180), including mixed boundary pages.
// Anchor offsets are card-top pixels relative to the viewport; positions are grid-relative.
// The host owns scroll/resize scheduling. Timeline badges/headers belong to card().
function createVirtualGrid() {
  const PAGE = 180,
    MEDIA_GAP = 8,
    FOLDER_GAP = 19,
    heights = new Map(),
    loaded = new Set(),
    failed = new Set(),
    reported = new Set();
  const positions = new Map(),
    cardLayouts = new WeakMap();
  let keys = [],
    sums = [],
    stamp = '',
    dirty = true,
    pageVersion = 0,
    firstMedia = 0,
    lastPage = -1,
    mediaTop = 0,
    folderBottom = 0,
    cover = 0,
    detail = 48,
    mediaCols = 1,
    extent = 0,
    retainedExtent = 0;
  const grid = {
    items: new Map(),
    loading: new Map(),
    cards: new Map(),
    total: 0,
    folders: 0,
    args: null,
    version: 0,
    rowHeight: 370,
    width: 222,
    cols: 1,
    gap: FOLDER_GAP,
    active: false,
    reset() {
      this.version++;
      this.growing = null;
      for (const request of this.loading.values()) request.controller.abort();
      this.items.clear();
      this.loading.clear();
      this.cards.clear();
      heights.clear();
      loaded.clear();
      failed.clear();
      reported.clear();
      positions.clear();
      this.total = this.folders = 0;
      this.args = null;
      this.active = false;
      stamp = '';
      dirty = true;
      keys = [];
      sums = [];
      extent = retainedExtent = 0;
      const el = $('#virtual-grid');
      el.replaceChildren();
      el.style.height = '0px';
      el.style.overflowAnchor = 'none';
    },
    hide() {
      this.active = false;
      for (const request of this.loading.values()) request.controller.abort();
      this.loading.clear();
      $('#virtual-grid').hidden = true;
    },
    async load(args, version) {
      this.reset();
      this.args = { ...args };
      pageVersion = version;
      this.active = true;
      $('#virtual-grid').hidden = false;
      const own = this.version;
      await this.fetchPage(0);
      return own === this.version && pageVersion === S.loadVersion ? this.total : 0;
    },
    layout(render = true) {
      if (!this.active) return;
      if (render) {
        this.render();
        return;
      }
      const m = measure();
      configure(m);
      rebuild();
      m.el.style.height = extent + 'px';
    },
    render() {
      if (this.active) draw();
    },
    getPosition(index) {
      if (!this.total) return { top: 0, left: 0, height: 0, width: this.width };
      index = Math.max(0, Math.min(this.total - 1, Math.trunc(Number(index) || 0)));
      if (index < this.folders)
        return {
          top: Math.floor(index / this.cols) * this.rowHeight,
          left: (index % this.cols) * (this.width + this.gap),
          height: cover + 70,
          width: this.width
        };
      const page = Math.floor(index / PAGE),
        local = index - Math.max(this.folders, page * PAGE),
        known = positions.get(index);
      if (known)
        return {
          top: pageTop(page) + known.top,
          left: known.left,
          height: known.height,
          width: this.width
        };
      // The first media page starts beside a partial folder row. Its placeholders
      // must respect the same occupied columns as the loaded geometry.
      if (page === firstMedia && this.folders % this.cols) {
        const columns = seedColumns(page);
        let column = 0;
        for (let i = 0; i <= local; i++) {
          column = shortest(columns);
          if (i < local) columns[column] += estimatedCover() + detail + MEDIA_GAP;
        }
        return {
          top: pageTop(page) + columns[column],
          left: column * (this.width + MEDIA_GAP),
          height: estimatedCover() + detail,
          width: this.width
        };
      }
      // Untouched blocks need no per-item allocation, even for very deep jumps.
      const h = estimatedCover() + detail,
        rows = Math.ceil(count(page) / mediaCols),
        step = pageHeight(page) / Math.max(1, rows);
      return {
        top: pageTop(page) + Math.floor(local / mediaCols) * step,
        left: (local % mediaCols) * (this.width + MEDIA_GAP),
        height: Math.min(h, step - MEDIA_GAP),
        width: this.width
      };
    },
    captureAnchor(clearance = 0) {
      return this.active && this.total ? anchorAt(measure(), clearance) : null;
    },
    restoreAnchor(index, offset) {
      if (!this.active || !this.total) return;
      draw({
        index: Math.max(0, Math.min(this.total - 1, Number(index) || 0)),
        offset: Number(offset) || 0
      });
    },
    refreshVisible() {
      if (!this.active) return Promise.resolve([]);
      const pages = visiblePages(measure());
      return Promise.all(
        [...pages].map((page) => {
          failed.delete(page);
          return this.fetchPage(page, true);
        })
      );
    },
    async refreshGrowing() {
      if (!this.active || !this.args) return this.total;
      if (this.growing) return this.growing;
      const version = this.version,
        navigation = pageVersion,
        args = { ...this.args },
        current = () => this.active && version === this.version && navigation === S.loadVersion;
      const task = (async () => {
        const m = measure(),
          initial = this.total ? anchorAt(m, 0) : null,
          oldFolders = this.folders,
          pages = visiblePages(m);
        if (!pages.size) pages.add(0);
        const first = [...pages][0],
          results = new Map(),
          probe = await api('list', { ...args, offset: first * PAGE, limit: PAGE });
        if (!current()) return this.total;
        results.set(first, probe);
        const total = Math.max(0, Number(probe.total) || 0),
          folders = Math.min(total, Math.max(0, Number(probe.folders) || 0)),
          delta = folders - oldFolders;
        // New folders move the entire media boundary. Fetch its shifted window
        // as well as nearby pages so the visible ID can usually be found again.
        if (initial) {
          const shifted = Math.max(
            0,
            Math.min(total - 1, initial.index + (initial.index >= oldFolders ? delta : 0))
          );
          const page = Math.floor(shifted / PAGE);
          for (let p = page - 1; p <= page + 1; p++) if (p >= 0 && p * PAGE < total) pages.add(p);
        }
        await Promise.all(
          [...pages]
            .filter((page) => page !== first && page * PAGE < total)
            .map(async (page) =>
              results.set(page, await api('list', { ...args, offset: page * PAGE, limit: PAGE }))
            )
        );
        if (!current()) return this.total;
        // A user may scroll while those pages are in flight. Include the new
        // visible window before discarding any old offset cache.
        const scrolled = visiblePages(measure());
        await Promise.all(
          [...scrolled]
            .filter((page) => !results.has(page) && page * PAGE < total)
            .map(async (page) =>
              results.set(page, await api('list', { ...args, offset: page * PAGE, limit: PAGE }))
            )
        );
        if (!current()) return this.total;
        // Capture again after IO: scrolling while the queries run remains authoritative.
        const latest = measure(),
          anchor = this.total ? anchorAt(latest, 0) : null,
          anchorNode = anchor && this.items.get(anchor.index),
          previousCards = new Map();
        for (const [index, b] of this.cards) {
          const n = this.items.get(index);
          if (n) previousCards.set(String(n.id), { b, n });
          else b.remove();
        }
        for (const request of this.loading.values()) request.controller.abort();
        this.loading.clear();
        this.items.clear();
        this.cards.clear();
        loaded.clear();
        failed.clear();
        reported.clear();
        // Distant offsets must not remain marked loaded after arbitrary insertions.
        // Keep their height estimates only while the folder boundary stays stable.
        if (delta || total < this.total) heights.clear();
        else for (const page of results.keys()) heights.delete(page);
        this.total = total;
        this.folders = folders;
        let found = -1;
        for (const [page, result] of results) {
          if (page * PAGE >= total && page !== 0) continue;
          loaded.add(page);
          (result.items || []).slice(0, PAGE).forEach((n, i) => {
            const index = page * PAGE + i;
            if (index >= total) return;
            this.items.set(index, n);
            if (anchorNode?.id === n.id) found = index;
            const previous = previousCards.get(String(n.id));
            if (
              previous &&
              (JSON.stringify(previous.n) === JSON.stringify(n) ||
                (n.kind === 'folder' &&
                  previous.n.kind === 'folder' &&
                  typeof updateFolderCard === 'function'))
            ) {
              const b = previous.b;
              if (n.kind === 'folder' && typeof updateFolderCard === 'function')
                updateFolderCard(b, n, index);
              b.dataset.index = b.dataset.gridIndex = String(index);
              b.onclick = () =>
                attempt(() =>
                  n.kind === 'folder' ? navigate({ parent: n.id }) : openViewer(n, index)
                );
              this.cards.set(index, b);
              previousCards.delete(String(n.id));
            }
          });
        }
        for (const { b } of previousCards.values()) b.remove();
        if (anchor)
          anchor.index =
            found >= 0
              ? found
              : Math.max(
                  0,
                  Math.min(total - 1, anchor.index + (anchor.index >= oldFolders ? delta : 0))
                );
        dirty = true;
        draw(total ? anchor : null, latest);
        return total;
      })();
      this.growing = task;
      try {
        return await task;
      } finally {
        if (this.growing === task) this.growing = null;
      }
    },
    fetchPage(page, refresh = false) {
      page = Math.trunc(Number(page));
      if (
        !this.active ||
        page < 0 ||
        (!this.total && page !== 0) ||
        (this.total && page * PAGE >= this.total)
      )
        return Promise.resolve();
      const previous = this.loading.get(page);
      if (previous && !refresh) return previous.promise;
      if (previous) {
        previous.controller.abort();
        this.loading.delete(page);
      }
      if (!refresh && (loaded.has(page) || failed.has(page))) return Promise.resolve();
      const version = this.version,
        navigation = pageVersion,
        controller = new AbortController(),
        signal = controller.signal;
      const current = () =>
        !signal.aborted && this.active && version === this.version && navigation === S.loadVersion;
      const request = { controller, promise: null };
      this.loading.set(page, request);
      request.promise = (async () => {
        try {
          // The existing IPC api ignores argument three; transports supporting signals may abort physically.
          const cancelled = new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(null), { once: true })
          );
          const result = await Promise.race([
            api('list', { ...this.args, offset: page * PAGE, limit: PAGE }, { signal }),
            cancelled
          ]);
          if (!result || !current()) return;
          const m = measure(),
            anchor = this.total ? anchorAt(m, 0) : null;
          if (!this.total) {
            this.total = Math.max(0, Number(result.total) || 0);
            this.folders = Math.min(this.total, Math.max(0, Number(result.folders) || 0));
          }
          for (const [index, b] of this.cards)
            if (Math.floor(index / PAGE) === page) {
              b.remove();
              this.cards.delete(index);
            }
          for (let i = page * PAGE; i < Math.min(this.total, (page + 1) * PAGE); i++)
            this.items.delete(i);
          (result.items || []).slice(0, PAGE).forEach((n, i) => {
            if (page * PAGE + i < this.total) this.items.set(page * PAGE + i, n);
          });
          loaded.add(page);
          failed.delete(page);
          dirty = true;
          draw(anchor, m);
        } catch (error) {
          if (current()) {
            failed.add(page);
            if (!reported.has(page)) {
              reported.add(page);
              toast(error.message || String(error), true);
            }
            this.render();
          }
        } finally {
          if (this.loading.get(page) === request) this.loading.delete(page);
        }
      })();
      return request.promise;
    }
  };
  function measure() {
    const el = $('#virtual-grid'),
      vp = $('#viewport'),
      scroll = vp.scrollTop;
    const origin = el.getBoundingClientRect().top - vp.getBoundingClientRect().top + scroll;
    return {
      el,
      vp,
      scroll,
      origin,
      top: scroll - origin,
      height: vp.clientHeight,
      width: el.clientWidth || 700
    };
  }
  function count(page) {
    return Math.max(
      0,
      Math.min(grid.total, (page + 1) * PAGE) - Math.max(grid.folders, page * PAGE)
    );
  }
  function estimatedCover() {
    return Math.min(cover, grid.width);
  }
  function seedColumns(page) {
    const occupied = page === firstMedia ? grid.folders % grid.cols : 0;
    return Array.from({ length: mediaCols }, (_, column) =>
      column < occupied ? grid.rowHeight : 0
    );
  }
  function shortest(columns) {
    let column = 0;
    for (let c = 1; c < columns.length; c++) if (columns[c] < columns[column]) column = c;
    return column;
  }
  function estimatedPage(page, h = estimatedCover()) {
    // Only the transition page shares a row with folders. Untouched distant
    // blocks retain constant-space estimates without walking their predecessors.
    if (page !== firstMedia || !(grid.folders % grid.cols))
      return Math.ceil(count(page) / mediaCols) * (h + detail + MEDIA_GAP);
    const columns = seedColumns(page);
    for (let i = 0; i < count(page); i++) columns[shortest(columns)] += h + detail + MEDIA_GAP;
    return Math.max(...columns);
  }
  function estimate(page) {
    return estimatedPage(page);
  }
  function signature(m) {
    return [
      m.width,
      Number(S.settings.density) || 222,
      S.settings.ratio,
      S.settings.details !== false,
      !!(grid.folders && grid.total > grid.folders)
    ].join('/');
  }
  function configure(m) {
    const next = signature(m);
    if (stamp === next) return;
    stamp = next;
    dirty = true;
    grid.width = Math.max(1, Math.min(Number(S.settings.density) || 222, m.width));
    grid.gap = grid.folders && grid.total > grid.folders ? MEDIA_GAP : FOLDER_GAP;
    grid.cols = Math.max(1, Math.floor((m.width + grid.gap) / (grid.width + grid.gap)));
    mediaCols = Math.max(1, Math.floor((m.width + MEDIA_GAP) / (grid.width + MEDIA_GAP)));
    const ratio =
      S.settings.ratio === 'tall' ? 9 / 16 : S.settings.ratio === 'square' ? 1 : 3 / 4.12;
    cover = grid.width / ratio;
    detail = S.settings.details === false ? 0 : 48;
    grid.rowHeight = cover + 70 + grid.gap;
  }
  function pageHeight(page) {
    const metric = heights.get(page);
    if (!metric) return estimate(page);
    if (metric.stamp === stamp) return metric.height;
    return estimatedPage(page, metric.mean * grid.width);
  }
  function pageTop(page) {
    if (page <= firstMedia) return mediaTop;
    // Full untouched blocks share an estimate; only visited blocks have corrections.
    let top =
      mediaTop +
      estimate(firstMedia) +
      (page - firstMedia - 1) *
        Math.ceil(PAGE / mediaCols) *
        (estimatedCover() + detail + MEDIA_GAP);
    let lo = 0,
      hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < page) lo = mid + 1;
      else hi = mid;
    }
    return top + (lo ? sums[lo - 1] : 0);
  }
  function rebuild() {
    if (!dirty) return;
    dirty = false;
    positions.clear();
    firstMedia = Math.floor(grid.folders / PAGE);
    lastPage = Math.ceil(grid.total / PAGE) - 1;
    folderBottom = Math.ceil(grid.folders / grid.cols) * grid.rowHeight;
    mediaTop = Math.floor(grid.folders / grid.cols) * grid.rowHeight;
    for (const page of loaded) {
      if (!count(page)) continue;
      const columns = seedColumns(page);
      let units = 0;
      for (
        let index = Math.max(grid.folders, page * PAGE);
        index < Math.min(grid.total, (page + 1) * PAGE);
        index++
      ) {
        const n = grid.items.get(index);
        let h = estimatedCover();
        if (n) {
          const w = Number(n.width),
            h0 = Number(n.height);
          if (Number.isFinite(w) && Number.isFinite(h0) && w > 0 && h0 > 0)
            h = Math.max(1, (grid.width * h0) / w);
        }
        const column = shortest(columns);
        positions.set(index, {
          top: columns[column],
          left: column * (grid.width + MEDIA_GAP),
          height: h + detail,
          cover: h
        });
        columns[column] += h + detail + MEDIA_GAP;
        units += h / grid.width;
      }
      heights.set(page, { height: Math.max(...columns), mean: units / count(page), stamp });
    }
    keys = [...heights.keys()]
      .filter((page) => page >= firstMedia && page <= lastPage)
      .sort((a, b) => a - b);
    sums = [];
    let sum = 0;
    for (const page of keys) {
      sum += pageHeight(page) - estimate(page);
      sums.push(sum);
    }
    extent =
      grid.total > grid.folders
        ? pageTop(lastPage) + pageHeight(lastPage) - MEDIA_GAP
        : Math.max(0, folderBottom - grid.gap);
  }
  function pageAt(top) {
    let lo = firstMedia,
      hi = lastPage;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (pageTop(mid) + pageHeight(mid) <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function visiblePages(m) {
    const pages = new Set(),
      overscan = Math.min(360, m.height / 2),
      start = Math.max(0, m.top - overscan),
      end = m.top + m.height + overscan;
    if (start < folderBottom && grid.folders) {
      const first = Math.max(0, Math.floor(start / grid.rowHeight) * grid.cols),
        last = Math.min(grid.folders, Math.ceil(end / grid.rowHeight) * grid.cols);
      for (let page = Math.floor(first / PAGE); page * PAGE < last; page++) pages.add(page);
    }
    if (grid.total > grid.folders && end > mediaTop) {
      for (
        let page = pageAt(Math.max(mediaTop, start));
        page <= lastPage && pageTop(page) < end;
        page++
      )
        pages.add(page);
    }
    return pages;
  }
  function anchorAt(m, clearance) {
    const line = m.top + Math.max(0, Number(clearance) || 0);
    let best = null,
      distance = Infinity,
      hasData = false;
    for (const index of grid.cards.keys()) {
      const p = grid.getPosition(index),
        data = grid.items.has(index);
      if (p.top + p.height <= line || p.top >= m.top + m.height || (!data && hasData)) continue;
      const d = Math.abs(p.top - line);
      if ((data && !hasData) || d < distance) {
        best = { index, offset: p.top - m.top };
        distance = d;
        hasData = data;
      }
    }
    if (best) return best;
    let index;
    if (line < folderBottom && grid.folders)
      index = Math.floor(Math.max(0, line) / grid.rowHeight) * grid.cols;
    else if (grid.total > grid.folders) {
      const page = pageAt(line),
        row = Math.floor(
          Math.max(0, line - pageTop(page)) / (estimatedCover() + detail + MEDIA_GAP)
        );
      index = Math.max(grid.folders, page * PAGE) + Math.min(count(page) - 1, row * mediaCols);
    } else index = grid.total - 1;
    index = Math.max(0, Math.min(grid.total - 1, index));
    return { index, offset: grid.getPosition(index).top - m.top };
  }
  function draw(anchor = null, m = measure()) {
    if (!grid.active) return;
    if (!anchor && stamp && signature(m) !== stamp && grid.total) anchor = anchorAt(m, 0);
    configure(m);
    rebuild();
    if (anchor) {
      m.scroll = Math.max(0, m.origin + grid.getPosition(anchor.index).top - anchor.offset);
      m.top = m.scroll - m.origin;
    }
    // A shrinking final page may need trailing space to preserve the chosen anchor.
    // Retain only that runway; ordinary upward scrolling removes it without growing it.
    retainedExtent = anchor
      ? Math.max(extent, m.top + m.height)
      : Math.max(extent, Math.min(retainedExtent, m.top + m.height));
    const pages = visiblePages(m),
      overscan = Math.min(360, m.height / 2),
      start = Math.max(0, m.top - overscan),
      end = m.top + m.height + overscan,
      visible = [];
    if (start < folderBottom) {
      const first = Math.max(0, Math.floor(start / grid.rowHeight) * grid.cols),
        last = Math.min(grid.folders, Math.ceil(end / grid.rowHeight) * grid.cols);
      for (let i = first; i < last; i++) visible.push(i);
    }
    for (const page of pages) {
      for (
        let i = Math.max(grid.folders, page * PAGE);
        i < Math.min(grid.total, (page + 1) * PAGE);
        i++
      ) {
        const p = grid.getPosition(i);
        if (p.top + p.height > start && p.top < end) visible.push(i);
      }
    }
    const keep = new Set(visible);
    let cacheFirst = Infinity,
      cacheLast = -1;
    for (const page of pages) {
      cacheFirst = Math.min(cacheFirst, page - 3);
      cacheLast = Math.max(cacheLast, page + 3);
    }
    for (const [page, request] of grid.loading)
      if (pages.size && (page < cacheFirst || page > cacheLast)) {
        request.controller.abort();
        grid.loading.delete(page);
      }
    for (const page of loaded)
      if (pages.size && (page < cacheFirst || page > cacheLast)) {
        loaded.delete(page);
        for (let i = page * PAGE; i < (page + 1) * PAGE; i++) {
          grid.items.delete(i);
          positions.delete(i);
        }
      }
    // Geometry reads above; all DOM writes below. No thumbnail onload changes geometry.
    m.el.style.height = retainedExtent + 'px';
    m.el.style.overflowAnchor = 'none';
    if (anchor) m.vp.scrollTop = m.scroll;
    for (const [index, b] of grid.cards)
      if (!keep.has(index)) {
        b.remove();
        grid.cards.delete(index);
      }
    for (const index of visible) {
      const n = grid.items.get(index),
        page = Math.floor(index / PAGE);
      let b = grid.cards.get(index);
      if (!n && failed.has(page)) {
        b?.remove();
        grid.cards.delete(index);
        continue;
      }
      if (n && (!b || b.dataset.id !== String(n.id))) {
        b?.remove();
        b = card(n, index);
        grid.cards.set(index, b);
        m.el.append(b);
      } else if (!b) {
        b = document.createElement('div');
        b.className = 'album-card card-skeleton';
        b.setAttribute('aria-hidden', 'true');
        b.innerHTML =
          '<div class="cover-shell"></div><div class="card-info"><span class="card-title"></span></div>';
        grid.cards.set(index, b);
        m.el.append(b);
      }
      const p = grid.getPosition(index),
        media = index >= grid.folders,
        shellHeight = media ? p.height - detail : cover,
        infoHeight = media ? detail : 70;
      let previous = cardLayouts.get(b);
      if (!previous) {
        previous = { shell: b.querySelector('.cover-shell'), info: b.querySelector('.card-info') };
        cardLayouts.set(b, previous);
        b.dataset.gridIndex = String(index);
      }
      if (
        previous.width !== p.width ||
        previous.left !== p.left ||
        previous.top !== p.top ||
        previous.height !== p.height ||
        previous.shellHeight !== shellHeight ||
        previous.infoHeight !== infoHeight
      ) {
        b.style.width = p.width + 'px';
        b.style.left = p.left + 'px';
        b.style.top = p.top + 'px';
        b.style.height = p.height + 'px';
        b.style.boxSizing = 'border-box';
        if (previous.shell) {
          previous.shell.style.height = shellHeight + 'px';
          previous.shell.style.aspectRatio = 'auto';
          previous.shell.style.boxSizing = 'border-box';
        }
        if (previous.info) {
          previous.info.hidden = media && !detail;
          previous.info.style.display = media && !detail ? 'none' : '';
          previous.info.style.height = infoHeight + 'px';
          previous.info.style.boxSizing = 'border-box';
          previous.info.style.overflow = 'hidden';
        }
        Object.assign(previous, {
          width: p.width,
          left: p.left,
          top: p.top,
          height: p.height,
          shellHeight,
          infoHeight
        });
      }
    }
    for (const page of pages)
      if (!loaded.has(page) && !failed.has(page) && !grid.loading.has(page)) grid.fetchPage(page);
  }
  return grid;
}
