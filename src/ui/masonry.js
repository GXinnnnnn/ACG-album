'use strict';
// Classic script: dependencies are resolved only when the factory/methods run.
// Page numbers stay absolute (offset = page * 180), including mixed boundary pages.
// Anchor offsets are card-top pixels relative to the viewport; positions are grid-relative.
// The host owns scroll/resize scheduling. Timeline badges/headers belong to card().
// Overview previews use the same fixed density targets, aligned to the top-left.
// Keep the API bound explicit; a normal 4K window needs only 28–42 preview albums.
function overviewPreviewGeometry(available, preset, gap = 19) {
  const width = Math.max(1, Number(available) || 1),
    target = Math.min(width, Math.max(1, Number(preset) || 166)),
    spacing = Math.max(0, Number(gap) || 0),
    columns = Math.max(1, Math.floor((width + spacing) / (target + spacing)));
  return {
    columns,
    width: target,
    limit: Math.min(500, columns * 2)
  };
}
let overviewPreviewController;
function renderOverviewPreview(preview, parent, version) {
  overviewPreviewController ||= createOverviewPreviewController();
  return overviewPreviewController.render(preview, parent, version);
}
function createOverviewPreviewController() {
  const entries = new Map();
  let resizeObserver,
    mutationObserver,
    frame = 0;
  function releaseDetached() {
    for (const [preview, entry] of entries) {
      if (preview.isConnected) continue;
      entry.generation++;
      resizeObserver?.unobserve(preview);
      entries.delete(preview);
    }
    if (!entries.size) {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = mutationObserver = undefined;
    }
  }
  function measure(entry) {
    const preview = entry.preview,
      styles = getComputedStyle(preview),
      root = getComputedStyle(document.documentElement),
      available = Math.max(
        1,
        preview.getBoundingClientRect().width -
          (parseFloat(styles.paddingLeft) || 0) -
          (parseFloat(styles.paddingRight) || 0) -
          (parseFloat(styles.borderLeftWidth) || 0) -
          (parseFloat(styles.borderRightWidth) || 0)
      ),
      geometry = overviewPreviewGeometry(
        available,
        parseFloat(root.getPropertyValue('--card-width')) || S.settings.density,
        parseFloat(styles.columnGap) || 19
      );
    preview.dataset.previewColumns = String(geometry.columns);
    preview.dataset.previewLimit = String(geometry.limit);
    entry.geometry = geometry;
    return geometry;
  }
  function current(entry, generation = entry.generation) {
    return (
      entries.get(entry.preview) === entry &&
      entry.preview.isConnected &&
      entry.generation === generation &&
      entry.version === S.loadVersion &&
      entry.sort === S.sort &&
      entry.direction === S.direction
    );
  }
  function reconcile(entry) {
    const preview = entry.preview,
      cards = new Map(
        [...preview.querySelectorAll('.album-card')].map((el) => [el.dataset.id, el])
      ),
      active = document.activeElement;
    let cursor = preview.firstElementChild;
    for (const child of entry.items.slice(0, entry.geometry.limit)) {
      const previous = cards.get(String(child.id)),
        el = previous
          ? updateFolderCard(previous, child, 0, entry.geometry.width)
          : card(child, 0, true, entry.geometry.width);
      if (el !== cursor) {
        if (preview.moveBefore && el.parentElement === preview) preview.moveBefore(el, cursor);
        else preview.insertBefore(el, cursor);
      }
      cursor = el.nextElementSibling;
      cards.delete(String(child.id));
    }
    const lostFocus = [...cards.values()].some((el) => el.contains(active));
    for (const el of cards.values()) el.remove();
    let more = preview.querySelector('.collection-more');
    if (!more) {
      more = document.createElement('button');
      more.className = 'collection-more';
      more.innerHTML = `打开分类，查看全部内容 ${svg('chevron-right')}`;
    }
    more.onclick = () => attempt(() => navigate({ parent: entry.parent.id }));
    if (preview.lastElementChild !== more) preview.append(more);
    if (lostFocus) more.focus({ preventScroll: true });
    preview.dataset.previewCount = String(Math.min(entry.items.length, entry.geometry.limit));
    preview.dataset.previewTotal = String(entry.total);
    entry.renderedWidth = entry.geometry.width;
  }
  async function request(entry) {
    const generation = ++entry.generation,
      version = entry.version,
      sort = entry.sort,
      direction = entry.direction,
      limit = entry.geometry.limit;
    entry.requestedLimit = limit;
    entry.preview.setAttribute('aria-busy', 'true');
    try {
      const result = await api('list', {
        parent: entry.parent.id,
        filter: 'folders',
        limit,
        sort,
        direction
      });
      if (!current(entry, generation) || version !== S.loadVersion) return false;
      // A response may arrive before ResizeObserver delivers the new window width.
      if (measure(entry).limit !== limit) {
        schedule();
        return false;
      }
      entry.items = (result.items || []).slice(0, limit);
      entry.total = Number(result.total) || entry.items.length;
      if (document.documentElement.dataset?.densityPreview !== 'on') reconcile(entry);
      return true;
    } finally {
      if (entry.generation === generation) entry.preview.removeAttribute('aria-busy');
    }
  }
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      releaseDetached();
      for (const entry of entries.values()) {
        if (!current(entry)) continue;
        const geometry = measure(entry);
        if (document.documentElement.dataset?.densityPreview === 'on') continue;
        if (geometry.limit !== entry.requestedLimit) attempt(() => request(entry));
        else if (entry.items && Math.abs(geometry.width - entry.renderedWidth) > 0.01)
          reconcile(entry);
      }
    });
  }
  function observe(preview) {
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(schedule);
      mutationObserver = new MutationObserver((records) => {
        if (
          records.some((record) => record.type === 'attributes') ||
          [...entries.keys()].some((el) => !el.isConnected)
        )
          schedule();
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-card-size']
      });
      mutationObserver.observe($('#category-overview'), { childList: true, subtree: true });
    }
    resizeObserver.observe(preview);
  }
  return {
    preview() {
      for (const entry of entries.values()) if (current(entry)) measure(entry);
    },
    async refresh() {
      const tasks = [];
      for (const entry of entries.values()) {
        if (!current(entry)) continue;
        const geometry = measure(entry);
        if (geometry.limit !== entry.requestedLimit) tasks.push(request(entry));
        else if (entry.items) reconcile(entry);
      }
      await Promise.all(tasks);
    },
    render(preview, parent, version) {
      releaseDetached();
      if (!preview.isConnected || version !== S.loadVersion) return Promise.resolve(false);
      let entry = entries.get(preview);
      if (!entry) {
        entry = { preview, generation: 0, items: null, renderedWidth: 0 };
        entries.set(preview, entry);
        observe(preview);
      }
      entry.parent = parent;
      entry.version = version;
      entry.sort = S.sort;
      entry.direction = S.direction;
      measure(entry);
      // Explicit renders refresh metadata as well as sort/root/load generations.
      return request(entry);
    }
  };
}
function createVirtualGrid() {
  const PAGE = 180,
    MEDIA_GAP = 8,
    FOLDER_GAP = 19,
    FOLDER_DETAILS_INFO = 70,
    FOLDER_TITLE_INFO = 40,
    METRIC_LIMIT = 256,
    NAVIGATION_VIEWS = 2,
    NAVIGATION_CARDS = 180,
    NAVIGATION_PAGES = 7,
    navigationCache = new Map(),
    heights = new Map(),
    loaded = new Set(),
    failed = new Set(),
    reported = new Set();
  const positions = new Map(),
    cardLayouts = new WeakMap();
  let committedKey = null,
    navigationEpoch = 0,
    validatedNavigationEpoch = -1,
    restoredGeometry = false,
    keys = [],
    stamp = '',
    dirty = true,
    pageVersion = 0,
    refreshVersion = 0,
    firstMedia = 0,
    lastPage = -1,
    mediaTop = 0,
    folderBottom = 0,
    cover = 0,
    detail = 48,
    folderInfo = FOLDER_DETAILS_INFO,
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
    width: 166,
    cols: 1,
    offsetX: 0,
    gap: FOLDER_GAP,
    active: false,
    retain(key = committedKey, scroll = $('#viewport').scrollTop) {
      if (!this.active || key == null || key !== committedKey || !loaded.size) return false;
      const m = measure(),
        anchor = this.total ? anchorAt(m, 0) : null,
        center = anchor ? Math.floor(anchor.index / PAGE) : 0,
        pages = new Set(
          [...loaded]
            .sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
            .slice(0, NAVIGATION_PAGES)
        ),
        cards = new Map([...this.cards].filter(([index]) => this.items.has(index)));
      // Oversized windows use the ordinary cold path rather than retain a partial
      // screen or let a very small density grow the navigation memory budget.
      if (
        cards.size > NAVIGATION_CARDS ||
        [...cards.keys()].some((index) => !pages.has(Math.floor(index / PAGE)))
      )
        return false;
      navigationCache.delete(key);
      navigationCache.set(key, {
        args: { ...this.args },
        scroll: Math.max(0, Number(scroll) || 0),
        anchor,
        cards,
        items: new Map([...this.items].filter(([index]) => pages.has(Math.floor(index / PAGE)))),
        positions: new Map([...positions].filter(([index]) => pages.has(Math.floor(index / PAGE)))),
        heights: new Map([...heights].filter(([page]) => pages.has(page))),
        loaded: pages,
        total: this.total,
        folders: this.folders,
        stamp,
        dirty,
        firstMedia,
        lastPage,
        mediaTop,
        folderBottom,
        cover,
        detail,
        folderInfo,
        mediaCols,
        extent,
        retainedExtent,
        width: this.width,
        cols: this.cols,
        rowHeight: this.rowHeight,
        offsetX: this.offsetX,
        gap: this.gap
      });
      let count = [...navigationCache.values()].reduce((sum, view) => sum + view.cards.size, 0);
      for (const [oldKey, view] of navigationCache) {
        if (navigationCache.size <= NAVIGATION_VIEWS && count <= NAVIGATION_CARDS) break;
        count -= view.cards.size;
        navigationCache.delete(oldKey);
      }
      // IPC may finish after abort: both the route generation and active state
      // must reject that reply, including a refreshGrowing already in flight.
      this.version++;
      this.growing = null;
      this.active = false;
      for (const request of this.loading.values()) request.controller.abort();
      this.loading.clear();
      return true;
    },
    restore(key, version) {
      const saved = navigationCache.get(key);
      if (!saved || version !== S.loadVersion) return null;
      // Remove the target before retaining the departing view so eviction cannot
      // discard the requested entry or count its cards as inactive twice.
      navigationCache.delete(key);
      this.retain();
      this.reset();
      committedKey = key;
      pageVersion = version;
      this.args = { ...saved.args };
      this.total = saved.total;
      this.folders = saved.folders;
      for (const [index, n] of saved.items) this.items.set(index, n);
      for (const [index, b] of saved.cards) this.cards.set(index, b);
      for (const [index, p] of saved.positions) positions.set(index, p);
      for (const [page, metric] of saved.heights) heights.set(page, metric);
      for (const page of saved.loaded) loaded.add(page);
      ({
        stamp,
        dirty,
        firstMedia,
        lastPage,
        mediaTop,
        folderBottom,
        cover,
        detail,
        folderInfo,
        mediaCols,
        extent,
        retainedExtent
      } = saved);
      keys = [...heights.keys()].sort((a, b) => a - b);
      restoredGeometry = true;
      for (const name of ['width', 'cols', 'rowHeight', 'offsetX', 'gap']) this[name] = saved[name];
      const el = $('#virtual-grid'),
        vp = $('#viewport');
      el.hidden = false;
      el.style.height = Math.max(extent, retainedExtent) + 'px';
      vp.scrollTop = saved.scroll;
      for (const b of this.cards.values()) el.append(b);
      this.active = true;
      // draw measures the current width/settings and checks the current DPR's
      // thumbnail tier. Reuse the pixel anchor when changed geometry requires it.
      const m = measure(),
        changed = signature(m) !== stamp;
      draw(changed ? saved.anchor : null, m);
      return vp.scrollTop;
    },
    invalidateNavigationCache() {
      navigationCache.clear();
      committedKey = null;
      navigationEpoch++;
      validatedNavigationEpoch = -1;
    },
    commitNavigationKey(key, version) {
      // The host also checks its full route key, current query args and viewer.
      // A real successful refresh must postdate the latest invalidation; matching
      // only the route generation cannot reject changed events during its IO.
      if (
        key == null ||
        !this.active ||
        pageVersion !== version ||
        version !== S.loadVersion ||
        !loaded.size ||
        validatedNavigationEpoch !== navigationEpoch
      )
        return false;
      committedKey = key;
      return true;
    },
    reset() {
      committedKey = null;
      validatedNavigationEpoch = -1;
      restoredGeometry = false;
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
    async load(args, version, key = null) {
      if (key !== committedKey) this.retain();
      if (key != null) navigationCache.delete(key);
      this.reset();
      committedKey = key;
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
          left: this.offsetX + (index % this.cols) * (this.width + this.gap),
          height: cover + folderInfo,
          width: this.width
        };
      const page = Math.floor(index / PAGE),
        local = index - Math.max(this.folders, page * PAGE),
        known = positions.get(index);
      if (known) return { ...known, width: this.width };
      // Placeholders use the same incoming column frontier as loaded pages.
      // Advancing equal-height slots is logarithmic even for a deep random jump.
      const columns = seedColumns(page),
        h = pageCover(page) + detail;
      advanceColumns(columns, local, h + MEDIA_GAP);
      const column = shortest(columns);
      return {
        top: columns[column],
        left: this.offsetX + column * (this.width + MEDIA_GAP),
        height: h,
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
    async refreshVisible() {
      if (!this.active) return [];
      const pages = visiblePages(measure()),
        results = new Map(),
        version = this.version,
        navigation = pageVersion,
        refresh = ++refreshVersion;
      const values = await Promise.all(
        [...pages].map((page) => {
          failed.delete(page);
          return this.fetchPage(page, true, results);
        })
      );
      if (
        this.active &&
        version === this.version &&
        navigation === S.loadVersion &&
        refresh === refreshVersion &&
        results.size === pages.size
      )
        applyPages(results);
      return values;
    },
    async refreshGrowing() {
      if (!this.active || !this.args) return this.total;
      if (this.growing) return this.growing;
      const version = this.version,
        navigation = pageVersion,
        epoch = navigationEpoch,
        args = { ...this.args },
        current = () => this.active && version === this.version && navigation === S.loadVersion;
      const task = (async () => {
        const m = measure(),
          initial = this.total ? refreshAnchor(m) : null,
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
          anchor = this.total ? refreshAnchor(latest) : null,
          anchorNode = anchor && this.items.get(anchor.index),
          previousCards = new Map();
        for (const [index, b] of this.cards) {
          const n = this.items.get(index);
          if (n) previousCards.set(String(n.id), { b, n });
          else b.remove();
        }
        refreshVersion++;
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
              (sameCardData(previous.n, n) ||
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
        if (epoch === navigationEpoch) validatedNavigationEpoch = epoch;
        return total;
      })();
      this.growing = task;
      try {
        return await task;
      } finally {
        if (this.growing === task) this.growing = null;
      }
    },
    fetchPage(page, refresh = false, results = null) {
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
          if (results) results.set(page, result);
          else applyPages(new Map([[page, result]]));
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
  function sameCardData(previous, next) {
    const a = { ...previous },
      b = { ...next };
    if ((a.kind === 'image' || a.kind === 'video') && a.kind === b.kind) {
      // Scans update indexed and can learn fs_identity for unchanged files.
      // Neither affects media presentation; keep every content field compared.
      delete a.indexed;
      delete b.indexed;
      delete a.fs_identity;
      delete b.fs_identity;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function applyPages(results) {
    if (!results.size) return;
    const m = measure(),
      anchor = grid.total ? refreshAnchor(m) : null,
      anchorNode = anchor && grid.items.get(anchor.index),
      previousCards = new Map();
    if (!grid.total) {
      const first = results.values().next().value;
      grid.total = Math.max(0, Number(first.total) || 0);
      grid.folders = Math.min(grid.total, Math.max(0, Number(first.folders) || 0));
    }
    // Reconcile the refreshed window together so IDs moving across a page
    // boundary retain their attached card, decoded cover and keyboard focus.
    for (const [index, b] of grid.cards)
      if (results.has(Math.floor(index / PAGE))) {
        const n = grid.items.get(index);
        if (n) previousCards.set(String(n.id), { b, n, index });
        else b.remove();
        grid.cards.delete(index);
      }
    for (const page of results.keys())
      for (let i = page * PAGE; i < Math.min(grid.total, (page + 1) * PAGE); i++)
        grid.items.delete(i);
    for (const [page, result] of results) {
      (result.items || []).slice(0, PAGE).forEach((n, i) => {
        const index = page * PAGE + i;
        if (index >= grid.total) return;
        grid.items.set(index, n);
        if (anchorNode?.id === n.id) anchor.index = index;
        const previous = previousCards.get(String(n.id));
        if (!previous || !sameCardData(previous.n, n)) return;
        const b = previous.b;
        if (previous.index !== index) {
          b.dataset.index = b.dataset.gridIndex = String(index);
          b.onclick = () =>
            attempt(() =>
              n.kind === 'folder' ? navigate({ parent: n.id }) : openViewer(n, index)
            );
        }
        grid.cards.set(index, b);
        previousCards.delete(String(n.id));
      });
      loaded.add(page);
      failed.delete(page);
    }
    for (const { b } of previousCards.values()) b.remove();
    dirty = true;
    draw(anchor, m);
  }
  function measure() {
    const el = $('#virtual-grid'),
      vp = $('#viewport'),
      scroll = vp.scrollTop;
    const viewportTop = vp.getBoundingClientRect().top,
      origin = el.getBoundingClientRect().top - viewportTop + scroll;
    return {
      el,
      vp,
      scroll,
      viewportTop,
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
  function naturalMediaCover(n) {
    const w = Number(n?.width),
      h = Number(n?.height);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
      ? Math.max(1, (grid.width * h) / w)
      : estimatedCover();
  }
  function mediaCoverLimit() {
    // The entire visible media card (including details) is at most twice the
    // same-width folder card. Inter-card spacing is not part of that height.
    return 2 * (cover + folderInfo) - detail;
  }
  function initialColumns() {
    const occupied = grid.folders % grid.cols;
    return Array.from(
      { length: mediaCols },
      (_, column) => mediaTop + (column < occupied ? grid.rowHeight : 0)
    );
  }
  function shortest(columns) {
    let column = 0;
    for (let c = 1; c < columns.length; c++) if (columns[c] < columns[column]) column = c;
    return column;
  }
  function advanceColumns(columns, slots, step) {
    if (slots <= 0) return columns;
    // Each column contributes the arithmetic sequence start + k * step.
    // Count whole levels, then resolve at most one slot per column by the same
    // leftmost-shortest rule as real cards. No walk through skipped API pages.
    const base = Math.min(...columns);
    let lo = 0,
      hi = Math.ceil((Math.max(...columns) - base) / step) + Math.ceil(slots / mediaCols);
    const before = (level, start) => Math.max(0, Math.ceil((level - start) / step - 1e-9));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2),
        level = base + mid * step;
      let used = 0;
      for (const start of columns) used += before(level, start);
      if (used <= slots) lo = mid;
      else hi = mid - 1;
    }
    const level = base + lo * step;
    let used = 0;
    for (let c = 0; c < columns.length; c++) {
      const n = before(level, columns[c]);
      columns[c] += n * step;
      used += n;
    }
    for (; used < slots; used++) columns[shortest(columns)] += step;
    return columns;
  }
  function seedColumns(page) {
    let lo = 0,
      hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < page) lo = mid + 1;
      else hi = mid;
    }
    if (keys[lo] === page) return [...heights.get(page).start];
    const previous = lo ? keys[lo - 1] : firstMedia - 1,
      columns = lo ? [...heights.get(previous).end] : initialColumns(),
      first = Math.max(grid.folders, (previous + 1) * PAGE);
    return advanceColumns(
      columns,
      Math.max(0, page * PAGE - first),
      estimatedCover() + detail + MEDIA_GAP
    );
  }
  function pageCover(page) {
    const metric = heights.get(page);
    return metric ? Math.min(mediaCoverLimit(), metric.mean * grid.width) : estimatedCover();
  }
  function signature(m) {
    return [
      m.width,
      Number(S.settings.density) || 166,
      S.settings.ratio,
      S.settings.details !== false,
      // An empty resize must not cache folder geometry for the later pure-media response.
      grid.total > grid.folders ? MEDIA_GAP : FOLDER_GAP
    ].join('/');
  }
  function configure(m) {
    const next = signature(m);
    if (stamp === next) return;
    stamp = next;
    dirty = true;
    const preset = Math.max(1, Number(S.settings.density) || 166);
    grid.gap = grid.total > grid.folders ? MEDIA_GAP : FOLDER_GAP;
    // The scrollport already reserves the visible sidebar and its window-edge
    // spacing. Keep every column at that left edge; an incomplete column leaves
    // its remainder on the right without changing the requested card width.
    grid.cols = Math.max(1, Math.floor((m.width + grid.gap) / (preset + grid.gap)));
    grid.width = Math.min(m.width, preset);
    grid.offsetX = 0;
    mediaCols = grid.cols;
    const ratio =
      S.settings.ratio === 'tall' ? 9 / 16 : S.settings.ratio === 'square' ? 1 : 3 / 4.12;
    cover = grid.width / ratio;
    detail = S.settings.details === false ? 0 : 48;
    // Keep the folder title, while reclaiming the hidden subtitle row and its spacing.
    folderInfo = S.settings.details === false ? FOLDER_TITLE_INFO : FOLDER_DETAILS_INFO;
    grid.rowHeight = cover + folderInfo + grid.gap;
  }
  function pageEnd(page) {
    const metric = heights.get(page);
    return metric
      ? metric.end
      : advanceColumns(seedColumns(page), count(page), pageCover(page) + detail + MEDIA_GAP);
  }
  function pageTop(page) {
    return Math.min(...seedColumns(page));
  }
  function rebuild() {
    if (!dirty) return;
    restoredGeometry = false;
    dirty = false;
    positions.clear();
    firstMedia = Math.floor(grid.folders / PAGE);
    lastPage = Math.ceil(grid.total / PAGE) - 1;
    folderBottom = Math.ceil(grid.folders / grid.cols) * grid.rowHeight;
    mediaTop = Math.floor(grid.folders / grid.cols) * grid.rowHeight;
    // Metadata has a fixed budget as well as the existing bounded item window.
    // Evicted summaries become uniform estimates; draw() preserves its anchor.
    for (const page of heights.keys()) {
      if (heights.size <= METRIC_LIMIT) break;
      if (!loaded.has(page)) heights.delete(page);
    }
    keys = [...new Set([...heights.keys(), ...loaded])]
      .filter((page) => page >= firstMedia && page <= lastPage && count(page))
      .sort((a, b) => a - b);
    let columns = initialColumns(),
      cursor = firstMedia;
    for (const page of keys) {
      advanceColumns(
        columns,
        Math.max(0, page * PAGE - Math.max(grid.folders, cursor * PAGE)),
        estimatedCover() + detail + MEDIA_GAP
      );
      const start = [...columns],
        top = Math.min(...start),
        seed = start.map((value) => value - top),
        previous = heights.get(page);
      let mean = previous?.mean || estimatedCover() / grid.width;
      if (loaded.has(page)) {
        let units = 0;
        for (
          let index = Math.max(grid.folders, page * PAGE);
          index < Math.min(grid.total, (page + 1) * PAGE);
          index++
        ) {
          const h = Math.min(mediaCoverLimit(), naturalMediaCover(grid.items.get(index))),
            column = shortest(columns);
          positions.set(index, {
            top: columns[column],
            left: grid.offsetX + column * (grid.width + MEDIA_GAP),
            height: h + detail,
            cover: h
          });
          columns[column] += h + detail + MEDIA_GAP;
          units += h / grid.width;
        }
        mean = units / count(page);
        // Refresh insertion order for the bounded summary cache.
        heights.delete(page);
      } else if (
        previous?.stamp === stamp &&
        seed.every((value, column) => Math.abs(value - previous.seed[column]) < 0.001)
      ) {
        // Offscreen pages retain exact outgoing tails while their input matches.
        columns = previous.tail.map((value) => top + previous.advance + value);
      } else {
        advanceColumns(
          columns,
          count(page),
          Math.min(mediaCoverLimit(), mean * grid.width) + detail + MEDIA_GAP
        );
      }
      const bottom = Math.min(...columns);
      heights.set(page, {
        start,
        end: [...columns],
        seed,
        advance: bottom - top,
        tail: columns.map((value) => value - bottom),
        mean,
        stamp
      });
      cursor = page + 1;
    }
    extent =
      grid.total > grid.folders
        ? Math.max(...pageEnd(lastPage)) - MEDIA_GAP
        : Math.max(0, folderBottom - grid.gap);
  }
  function pageAt(top) {
    // A compact navigation snapshot preserves exact visible-page frontiers but
    // drops older summaries. Prefer its at-most-seven real intervals: estimates
    // before that window may no longer be monotonic with the retained positions.
    if (restoredGeometry)
      for (const page of keys) {
        const metric = heights.get(page);
        if (Math.min(...metric.start) <= top && Math.max(...metric.end) > top) return page;
      }
    let lo = firstMedia,
      hi = lastPage;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      // Pages overlap vertically: search their maximum outgoing edge, not
      // the next page's minimum start, so earlier tall cards remain visible.
      if (Math.max(...pageEnd(mid)) <= top) lo = mid + 1;
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
  function refreshAnchor(m) {
    // Match captureDisplayAnchor: preserve the card at the visible reading line,
    // below the floating toolbar, when an insertion reshuffles the columns.
    const bottom = $('#toolbar')?.getBoundingClientRect?.().bottom,
      clearance = Number.isFinite(bottom) ? Math.max(0, bottom - m.viewportTop + 12) : 0;
    return anchorAt(m, clearance);
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
    const keep = new Set(visible),
      moved = new Set();
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
        const position = grid.getPosition(index),
          inViewport = position.top + position.height > m.top && position.top < m.top + m.height;
        b = card(n, index, false, grid.previewThumbWidth || grid.width, inViewport);
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
        infoHeight = media ? detail : folderInfo;
      const clamped = String(media && naturalMediaCover(n) > mediaCoverLimit());
      if (b.dataset.mediaClamped !== clamped) b.dataset.mediaClamped = clamped;
      let previous = cardLayouts.get(b);
      if (!previous) {
        previous = {
          shell: b.querySelector('.cover-shell'),
          info: b.querySelector('.card-info'),
          image: b.querySelector('img')
        };
        cardLayouts.set(b, previous);
        b.dataset.gridIndex = String(index);
      }
      if (previous.index !== index) moved.add(b);
      previous.index = index;
      if (n && previous.image) {
        const src = thumb(n, grid.previewThumbWidth || grid.width),
          tier = /[?&]size=(\d+)/.exec(src)?.[1],
          currentTier =
            /[?&]size=(\d+)/.exec(previous.image.getAttribute('src') || '')?.[1] ||
            previous.thumbTier;
        // Revision changes alone must not restart all visible thumbnail requests.
        // Remember the tier for video fallbacks whose generated URL has no size query.
        if (currentTier && tier && currentTier !== tier) {
          previous.image.style.display = '';
          previous.image.src = src;
        }
        previous.thumbTier = tier;
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
    // Stable cards already have the right relative DOM order. Move only new or
    // reindexed cards so keyboard/reading order follows the visual item order.
    let before = null;
    for (let i = visible.length - 1; i >= 0; i--) {
      const b = grid.cards.get(visible[i]);
      if (!b) continue;
      if (moved.has(b) && b.nextElementSibling !== before) {
        if (typeof m.el.moveBefore === 'function') m.el.moveBefore(b, before);
        else {
          const focused = document.activeElement,
            restoreFocus = focused && b.contains(focused);
          m.el.insertBefore(b, before);
          if (restoreFocus && document.activeElement !== focused)
            focused.focus({ preventScroll: true });
        }
      }
      before = b;
    }
    for (const page of pages)
      if (!loaded.has(page) && !failed.has(page) && !grid.loading.has(page)) grid.fetchPage(page);
  }
  return grid;
}
