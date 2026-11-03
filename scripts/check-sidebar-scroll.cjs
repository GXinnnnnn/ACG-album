'use strict';
// Run serially under the Lead. Only generated directories and seven tiny images are indexed.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _electron, expect } = require('@playwright/test');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = { cases: [], checks: [], errors: [], screenshots: [] };
let app, page, run, collection, collectionIdentity, deep;
const row = (id) => page.locator(`#category-nav .tree-node[data-node-id="${id}"] > .tree-row`);
async function resize(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width,
    height
  });
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function wheel(delta) {
  const rect = await page.locator('#category-nav').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, delta);
}
async function snapshot() {
  const measured = await page.evaluate(() => {
    window.__sidebarOpeningProbe.record('bottom');
    const host = $('#category-nav'),
      r = host.getBoundingClientRect(),
      text = $('#index-count').getBoundingClientRect(),
      rows = [...host.querySelectorAll('.tree-node')],
      visible = rows.filter((n) => {
        const box = n.getBoundingClientRect();
        return box.bottom > r.top && box.top < r.bottom;
      });
    let chunks = 0,
      items = 0;
    for (const p of folderTree.pages.values()) {
      chunks += p.chunks.size;
      items += p.items.length;
    }
    return {
      height: r.height,
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      indexTextGap: text.top - r.bottom,
      nodes: rows.length,
      chunks,
      cachedItems: items,
      visible: visible.map((n) => ({
        id: n.treeNode.id,
        name: n.treeNode.name,
        kind: n.treeNode.kind,
        level: n.firstElementChild.getAttribute('aria-level')
      })),
      pagers: host.querySelectorAll('.tree-pager').length,
      media: host.querySelectorAll('img,video,canvas').length,
      logicalRows: treeLayout.total,
      open: [...folderTree.open],
      openingEvents: window.__sidebarOpeningProbe.events.filter(
        (event) => event.opening === window.__sidebarOpeningProbe.sequence
      )
    };
  });
  return {
    ...measured,
    requests: await app.evaluate(() => globalThis.__sidebarTreeProbe.requests.slice())
  };
}
async function readCollectionIdentity() {
  const stat = await fs.lstat(collection, { bigint: true });
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'generated collection is a real directory'
  );
  return {
    path: path.resolve(collection),
    realPath: await fs.realpath(collection),
    dev: String(stat.dev),
    ino: String(stat.ino)
  };
}
async function readTaskBoundary() {
  return page.evaluate(async () => {
    const init = await window.album.call('init', { lightweight: true });
    return {
      worker: init.taskSnapshot,
      renderer: startupTaskSnapshot,
      workerWatchChanges: init.settings.watchChanges,
      rendererWatchChanges: S.settings.watchChanges,
      roots: init.roots.map(({ id, root, path, parent, kind, missing }) => ({
        id,
        root,
        path,
        parent,
        kind,
        missing
      })),
      scanActive,
      treeSettled:
        !treeRecovery &&
        !folderTree.loading.size &&
        !structuralTask &&
        !structuralDirty &&
        !growingTask &&
        growingTimer == null &&
        !growingDirty
    };
  });
}
async function waitForTaskIdle(phase, deadline = Date.now() + 30000, refresh = null) {
  const boundary = { phase, deadline, polls: 0, first: null, last: null };
  (report.taskBoundaries ||= []).push(boundary);
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, `${phase}: idle/admission budget expired`);
  await expect
    .poll(
      async () => {
        const state = await readTaskBoundary();
        boundary.polls++;
        boundary.first ||= state;
        boundary.last = state;
        if (refresh) {
          refresh.first ||= state;
          refresh.last = state;
        }
        return (
          state.worker?.known === true &&
          state.worker.busy === false &&
          state.worker.scan?.status === 'idle' &&
          state.renderer?.known === true &&
          state.renderer.busy === false &&
          state.renderer.scan?.status === 'idle' &&
          !state.scanActive &&
          state.treeSettled
        );
      },
      { timeout: remaining, intervals: [100] }
    )
    .toBe(true);
  assert.ok(Date.now() < deadline, `${phase}: idle/admission budget expired`);
  return boundary.last;
}
async function refreshGeneratedRoot(rootId, phase) {
  const started = Date.now(),
    deadline = started + 30000,
    refresh = { phase, rootId, deadline, submissions: 0, busyErrors: [], first: null, last: null };
  (report.refreshAttempts ||= []).push(refresh);
  try {
    assert.equal(rootId, idFor(collection), 'refresh is confined to the generated collection');
    const expectedWatch = await page.evaluate(() => S.settings.watchChanges);
    refresh.watchChanges = expectedWatch;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const state = await waitForTaskIdle(`${phase}:before-submit-${attempt}`, deadline, refresh);
      // Recheck physical and registered-root identity before every submission,
      // including the sole retry after the worker's pre-operation busy rejection.
      const identity = await readCollectionIdentity();
      assert.deepEqual(identity, collectionIdentity, 'generated collection identity is unchanged');
      assert.equal(rootId, idFor(collection));
      assert.deepEqual(
        state.roots.find((entry) => entry.id === rootId),
        {
          id: rootId,
          root: rootId,
          path: collectionIdentity.path,
          parent: null,
          kind: 'folder',
          missing: 0
        },
        'the original generated directory is still the registered root'
      );
      assert.equal(state.workerWatchChanges, expectedWatch, 'worker watchChanges is unchanged');
      assert.equal(state.rendererWatchChanges, expectedWatch, 'renderer watchChanges is unchanged');
      assert.ok(Date.now() < deadline, `${phase}: idle/admission budget expired`);
      refresh.submissions++;
      // The deadline bounds idle waits and submission, not an admitted scan's
      // original completion Promise. A busy rejection alone permits one retry.
      const result = await page.evaluate(
        async ({ rootId, deadline, expectedWatch }) => {
          if (Date.now() >= deadline) throw new Error('refresh idle/admission budget expired');
          if (S.settings.watchChanges !== expectedWatch)
            throw new Error('refresh watchChanges changed');
          try {
            return { ok: true, value: await api('refresh', { id: rootId }) };
          } catch (error) {
            if (
              error.message !==
              "Error invoking remote method 'library:refresh': Error: 已有导入或改名任务正在运行，请等待完成或先取消。"
            )
              throw error;
            return { ok: false, message: error.message, stack: error.stack };
          }
        },
        { rootId, deadline, expectedWatch }
      );
      if (result.ok) return result.value;
      refresh.busyErrors.push({ attempt, message: result.message, stack: result.stack });
      if (attempt === 2 || Date.now() >= deadline) {
        const error = new Error(result.message);
        error.stack = result.stack || error.stack;
        throw error;
      }
    }
  } catch (error) {
    refresh.error = error.stack;
    throw error;
  } finally {
    refresh.elapsedMs = Date.now() - started;
  }
}
async function checkFocusRecovery(rootId) {
  for (const next of ['ArrowUp', 'outside pointer']) {
    await page.evaluate(async (rootId) => {
      await focusTreeIndex(treeLayout.indexAt(rootId, 127));
    }, rootId);
    await expect(
      row(idFor(path.join(collection, 'Folder 0127'))).locator('.category-link')
    ).toBeFocused();
    await page.waitForFunction(() => folderTree.loading.size === 0);
    await app.evaluate((_, rootId) => {
      globalThis.__sidebarTreeProbe.boundary = {
        parent: rootId,
        offset: 128,
        captured: false,
        resultReady: false,
        canceled: false,
        release: null
      };
    }, rootId);
    await page.evaluate((rootId) => {
      folderTree.pages.get(rootId).chunks.delete(128);
    }, rootId);
    try {
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(
          () => app.evaluate(() => globalThis.__sidebarTreeProbe.boundary?.resultReady === true),
          { timeout: 30000 }
        )
        .toBe(true);
      if (next === 'ArrowUp') await page.keyboard.press('ArrowUp');
      else await page.locator('#search').click();
      const expected =
        next === 'ArrowUp'
          ? row(idFor(path.join(collection, 'Folder 0126'))).locator('.category-link')
          : page.locator('#search');
      await expect(expected).toBeFocused();
      await app.evaluate(() => globalThis.__sidebarTreeProbe.boundary.release());
      await page.waitForFunction(
        (rootId) => folderTree.pages.get(rootId)?.chunks.has(128) && folderTree.loading.size === 0,
        rootId
      );
      await expect(expected).toBeFocused();
      report.checks.push(`native delayed boundary Down respects ${next}`);
    } finally {
      await app.evaluate(() => {
        const probe = globalThis.__sidebarTreeProbe;
        if (probe.boundary) {
          probe.boundary.canceled = true;
          probe.boundary.release?.();
          probe.boundary = null;
        }
      });
    }
  }
  const focusId = idFor(path.join(collection, 'Folder 0520'));
  await page.evaluate(async (rootId) => {
    await focusTreeIndex(treeLayout.indexAt(rootId, 520));
    $('#category-nav').scrollTop = 515 * 39 + 7;
    renderFolderTree();
  }, rootId);
  await expect(row(focusId).locator('.category-link')).toBeFocused();
  const before = await page.evaluate(() => {
    const host = $('#category-nav');
    window.__treeRefreshLink = document.activeElement;
    return { top: host.scrollTop, anchor: treeLayout.at(Math.floor(host.scrollTop / 39)).node.id };
  });
  const inserted = path.join(collection, 'Folder 0255 A');
  await fs.mkdir(inserted);
  report.fixture.insertedFolder = inserted;
  report.fixture.folders++;
  await refreshGeneratedRoot(rootId, 'focus-insertion');
  await page.evaluate(async () => {
    await loadSummary();
    invalidateFolderTree();
  });
  await page.waitForFunction(() => treeRecovery === null && folderTree.loading.size === 0);
  await expect(row(focusId).locator('.category-link')).toBeFocused();
  const after = await page.evaluate(() => {
    const host = $('#category-nav');
    return {
      top: host.scrollTop,
      anchor: treeLayout.at(Math.floor(host.scrollTop / 39)).node.id,
      sameElement: document.activeElement === window.__treeRefreshLink
    };
  });
  assert.equal(after.sameElement, true, 'refresh retains the native focused DOM element');
  assert.equal(after.anchor, before.anchor);
  assert.equal(
    after.top,
    before.top + 39,
    'the same top folder keeps its seven-pixel remainder after insertion'
  );
  report.checks.push(
    'native closed-child focus and pixel anchor survive insertion before the visible page'
  );
  await screenshot('refresh-middle-page-native-focus');
}
async function checkBackgroundStability(rootId) {
  // This isolated profile watches only the seven generated images. Mutations and
  // refreshes go through the real worker; the observer never schedules a render.
  const oldWatch = await page.evaluate(() => S.settings.watchChanges);
  try {
    await page.evaluate(() => saveSetting('watchChanges', true));
    for (const position of ['middle', 'bottom']) {
      await wheel(-100000);
      await page.waitForFunction(() => $('#category-nav').scrollTop === 0);
      await wheel(position === 'middle' ? 510 * 39 : 100000);
      await page.waitForFunction((position) => {
        const host = $('#category-nav');
        return position === 'middle'
          ? host.scrollTop > 500 * 39 && host.scrollTop < 600 * 39
          : host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
      }, position);
      await page.waitForFunction(
        () =>
          !treeRecovery &&
          !folderTree.loading.size &&
          !structuralTask &&
          !structuralDirty &&
          !growingTask &&
          growingTimer == null &&
          !growingDirty
      );
      const visibleId = await page.evaluate(() => {
        const host = $('#category-nav'),
          box = host.getBoundingClientRect();
        return [...host.querySelectorAll('.tree-node')].find((group) => {
          const row = group.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }).treeNode.id;
      });
      await row(visibleId).locator('.category-link').focus();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      await page.evaluate((position) => {
        const host = $('#category-nav'),
          box = host.getBoundingClientRect(),
          baseline = [...host.querySelectorAll('.tree-node')]
            .filter((group) => {
              const row = group.getBoundingClientRect();
              return row.bottom > box.top && row.top < box.bottom;
            })
            .map((group) => ({
              id: group.treeNode.id,
              group,
              row: group.firstElementChild,
              link: group.querySelector('.category-link'),
              top: group.getBoundingClientRect().top
            })),
          focus = document.activeElement,
          probe = (window.__sidebarStabilityProbe = {
            position,
            frames: 0,
            samples: 0,
            mutations: 0,
            events: [],
            violations: [],
            baseline,
            scrollTop: host.scrollTop,
            scrollHeight: host.scrollHeight,
            logicalRows: treeLayout.total,
            focusId: focus.closest('.tree-node')?.treeNode.id,
            generation: folderTree.generation
          });
        const violation = (reason) => {
          if (probe.violations.length < 20)
            probe.violations.push({
              reason,
              at: performance.now(),
              generation: folderTree.generation
            });
        };
        const inspect = () => {
          probe.samples++;
          if (
            host.scrollTop !== probe.scrollTop ||
            host.scrollHeight !== probe.scrollHeight ||
            treeLayout.total !== probe.logicalRows
          )
            violation('scroll or logical geometry changed');
          if (document.activeElement !== focus) violation('native focus changed');
          if (host.querySelector('.tree-slot, .tree-pending'))
            violation('loading placeholder entered committed viewport');
          for (const saved of baseline) {
            if (
              !saved.group.isConnected ||
              saved.group.parentElement !== host.firstElementChild ||
              saved.group.firstElementChild !== saved.row ||
              saved.group.querySelector('.category-link') !== saved.link
            )
              violation('a visible native row was replaced or detached');
            else if (Math.abs(saved.group.getBoundingClientRect().top - saved.top) > 0.5)
              violation('a visible row moved');
          }
        };
        probe.observer = new MutationObserver((records) => {
          probe.mutations += records.length;
          inspect();
        });
        probe.observer.observe(host, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
        probe.unsubscribe = window.album.onEvent((event) => {
          if (['changed', 'progress', 'watch'].includes(event.type) && probe.events.length < 512)
            probe.events.push({
              type: event.type,
              root: event.data?.root,
              revision: event.data?.revision,
              active: event.data?.active,
              at: performance.now()
            });
        });
        const tick = () => {
          probe.frames++;
          inspect();
          probe.frame = requestAnimationFrame(tick);
        };
        probe.finish = () => {
          cancelAnimationFrame(probe.frame);
          probe.observer.disconnect();
          probe.unsubscribe();
          inspect();
          return {
            position,
            frames: probe.frames,
            samples: probe.samples,
            mutations: probe.mutations,
            violations: probe.violations,
            events: probe.events,
            scrollTop: host.scrollTop,
            scrollHeight: host.scrollHeight,
            logicalRows: treeLayout.total,
            generationBefore: probe.generation,
            generationAfter: folderTree.generation,
            visibleIds: baseline.map((saved) => saved.id),
            focusId: probe.focusId,
            watchChanges: S.settings.watchChanges,
            nodes: host.querySelectorAll('.tree-node').length,
            cachedItems: [...folderTree.pages.values()].reduce(
              (sum, page) => sum + page.items.length,
              0
            )
          };
        };
        inspect();
        probe.frame = requestAnimationFrame(tick);
      }, position);
      let measured;
      try {
        for (let round = 0; round < 3; round++) {
          const image = path.join(collection, String(round).padStart(4, '0') + '-media.png');
          assert.equal(path.resolve(path.dirname(image)), path.resolve(collection));
          // Rewrite the same valid tiny fixture, preserving the seven-image payload.
          await fs.writeFile(image, await fs.readFile(image));
          const before = await page.evaluate(
            () =>
              window.__sidebarStabilityProbe.events.filter((event) => event.type === 'changed')
                .length
          );
          await refreshGeneratedRoot(rootId, `background-${position}-round-${round + 1}`);
          await page.waitForFunction(
            (before) =>
              window.__sidebarStabilityProbe.events.filter((event) => event.type === 'changed')
                .length > before &&
              !scanActive &&
              !treeRecovery &&
              !folderTree.loading.size &&
              !structuralTask &&
              !structuralDirty &&
              !growingTask &&
              growingTimer == null &&
              !growingDirty,
            before
          );
        }
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
      } finally {
        measured = await page.evaluate(() => {
          const result = window.__sidebarStabilityProbe.finish();
          delete window.__sidebarStabilityProbe;
          return result;
        });
        (report.backgroundStability ||= []).push(measured);
      }
      assert.deepEqual(
        measured.violations,
        [],
        `${position}: every observed frame retains the committed native viewport`
      );
      assert.equal(
        measured.mutations,
        0,
        `${position}: unchanged folder rows require no tree DOM writes`
      );
      assert.ok(measured.frames > 0);
      assert.ok(measured.events.filter((event) => event.type === 'changed').length >= 3);
      assert.ok(
        measured.events.some((event) => event.type === 'progress' && event.active),
        'real indexing stayed active during observation'
      );
      assert.ok(
        measured.generationAfter > measured.generationBefore,
        'ordinary changes still revalidate the tree'
      );
      assert.equal(measured.watchChanges, true);
      assert.equal(measured.logicalRows, 641);
      assert.ok(measured.nodes <= 160 && measured.cachedItems <= 1536);
      report.checks.push(
        `${position} stopped native viewport stays connected and unchanged through three real watched image refreshes`
      );
      await screenshot(`background-stable-${position}`);
    }
  } finally {
    await page.evaluate((value) => saveSetting('watchChanges', value), oldWatch);
  }
  // The watched refresh can outlive its last renderer progress notification.
  // Drain the real worker before the following manual insertion/refresh test.
  await waitForTaskIdle('after-watched-refreshes');
}
async function prepare() {
  const stage = process.env.ACG_CHECK_STAGE
    ? path.resolve(process.env.ACG_CHECK_STAGE)
    : path.join(await fs.realpath(path.join(root, 'artifacts')), 'sidebar-scroll');
  run = path.join(
    stage,
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  );
  report.run = run;
  collection = path.join(run, 'generated-collection');
  await fs.mkdir(collection, { recursive: true });
  collectionIdentity = await readCollectionIdentity();
  const folders = Array.from({ length: 640 }, (_, i) =>
    path.join(collection, 'Folder ' + String(i).padStart(4, '0'))
  );
  // Bound filesystem concurrency as well as the fixture payload.
  for (let i = 0; i < folders.length; i += 32)
    await Promise.all(folders.slice(i, i + 32).map((dir) => fs.mkdir(dir)));
  deep = [folders.at(-1)];
  for (let i = 1; i <= 9; i++) {
    deep.push(path.join(deep.at(-1), 'Level ' + i));
    await fs.mkdir(deep.at(-1));
  }
  const image = await require('sharp')({
    create: { width: 12, height: 16, channels: 3, background: '#c6b5d1' }
  })
    .png()
    .toBuffer();
  for (let i = 0; i < 6; i++)
    await fs.writeFile(path.join(collection, String(i).padStart(4, '0') + '-media.png'), image);
  await fs.writeFile(path.join(deep.at(-1), 'leaf.png'), image);
  report.fixture = {
    collection,
    collectionIdentity,
    profile: path.join(run, 'generated-profile'),
    folders: 640,
    depth: 10,
    images: 7,
    imageBytes: image.length * 7
  };
}
async function launch() {
  const profile = path.join(run, 'generated-profile'),
    executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? [] : ['.'],
    cwd: root,
    env
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && window.albumSidebarTree
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A fresh generated profile legitimately opens the metadata setup, not the import UI.
  await expect(page.locator('#modal.settings-dialog[open]')).toBeVisible();
  await expect(page.locator('#settings-tab-metadata')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settings-panel-metadata #token-input')).toBeVisible();
  assert.equal(await page.evaluate(() => S.roots.length), 0);
  assert.equal(await page.evaluate(async () => (await api('tokenStatus')).saved), false);
  await page.evaluate(() => saveSetting('metadataOnboardingSeen', true));
  await page.locator('#modal-close').click();
  await expect(page.locator('#modal')).not.toBeVisible();
  report.checks.push('identified fresh-profile metadata onboarding is saved and closed with its X');
  await page.evaluate(async () => {
    await saveSetting('watchChanges', false);
    await saveSetting('autoMatch', false);
    await saveSetting('sidebarMode', 'expanded');
  });
  await page.evaluate(() => {
    const host = $('#category-nav'),
      original = openFolderTree,
      probe = (window.__sidebarOpeningProbe = { original, sequence: 0, active: null, events: [] });
    probe.record = (phase, detail = {}) => {
      probe.events.push({
        phase,
        at: performance.now(),
        opening: probe.active,
        width: innerWidth,
        height: innerHeight,
        scrollTop: host.scrollTop,
        generation: folderTree.generation,
        intent: treeFocusIntent,
        loading: [...folderTree.loading],
        ...detail
      });
      if (probe.events.length > 160) probe.events.shift();
    };
    openFolderTree = async function (...args) {
      const opening = ++probe.sequence;
      probe.active = opening;
      probe.record('opening', { opening });
      try {
        const result = await original.apply(this, args);
        probe.record('complete', { opening });
        return result;
      } catch (error) {
        probe.record('opening-error', { opening, error: error.message });
        throw error;
      }
    };
    probe.wheel = (event) => {
      if (host.contains(event.target))
        probe.record('wheel', { deltaY: event.deltaY, trusted: event.isTrusted });
    };
    probe.scroll = () => probe.record('scroll');
    window.addEventListener('wheel', probe.wheel, { capture: true, passive: true });
    host.addEventListener('scroll', probe.scroll, { passive: true });
  });
  await app.evaluate(({ ipcMain }) => {
    const channel = 'library:list',
      original = ipcMain._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing IPC handler ' + channel);
    const probe = (globalThis.__sidebarTreeProbe = {
      original,
      requests: [],
      boundary: null
    });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, args) => {
      const treeRequest =
        args?.filter === 'folders' && args.sort === 'name' && args.direction === 'asc';
      if (treeRequest) {
        probe.requests.push({ ...args });
        if (probe.requests.length > 512) probe.requests.shift();
      }
      const boundary = probe.boundary,
        hold =
          treeRequest &&
          boundary &&
          !boundary.captured &&
          args.parent === boundary.parent &&
          args.offset === boundary.offset;
      if (hold) boundary.captured = true;
      // Observe the actual handler result; delay only its delivery, without changing the payload.
      const result = await original(event, args);
      if (hold && !boundary.canceled) {
        await new Promise((resolve) => {
          boundary.release = resolve;
          boundary.resultReady = true;
        });
      }
      return result;
    });
  });
  await app.evaluate(({ dialog }, collection) => {
    globalThis.__treeChooser = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
  }, collection);
  try {
    await page.locator('#import-sidebar').click();
    await expect(page.locator('#import-options')).toBeVisible();
    if (await page.locator('#import-online-match').isEnabled())
      await page.locator('#import-online-match').uncheck();
    await page.locator('#import-options-confirm').click();
    await page.waitForFunction(() => !scanActive && pendingImport === null, null, {
      timeout: 90000
    });
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__treeChooser;
      delete globalThis.__treeChooser;
    });
  }
  await page.evaluate(async () => {
    await loadSummary();
    await navigate({});
  });
  await page.waitForFunction(
    ({ id, recursiveFolders }) =>
      S.roots.some((n) => n.id === id && n.folders === recursiveFolders),
    { id: idFor(collection), recursiveFolders: 640 + deep.length - 1 }
  );
  const directFolders = await page.evaluate(
    (id) =>
      api('list', {
        parent: id,
        filter: 'folders',
        sort: 'name',
        direction: 'asc',
        limit: 128,
        offset: 0
      }),
    idFor(collection)
  );
  assert.equal(directFolders.total, 640, 'the generated root has exactly 640 direct child folders');
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    profile: app.getPath('userData')
  }));
  assert.equal(path.resolve(report.runtime.profile), path.join(profile, 'chromium-profile'));
}
(async () => {
  try {
    await prepare();
    await launch();
    const rootId = idFor(collection),
      lastId = idFor(deep[0]);
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [1440, 680],
      [1440, 700]
    ]) {
      await resize(width, height);
      await page.locator('#collapse-all').click();
      await page.locator('#rail-tree').click();
      await expect(row(rootId)).toHaveAttribute('aria-expanded', 'true');
      await wheel(100000);
      await page.waitForFunction(() => $('#category-nav').scrollTop > 500 * 39);
      await expect(row(lastId)).toBeInViewport();
      const measured = await snapshot();
      if (height <= 700)
        assert.ok(measured.height >= 117, 'minimum window preserves at least three 39px tree rows');
      assert.ok(measured.nodes <= 160);
      assert.equal(measured.logicalRows, 641);
      assert.equal(measured.pagers, 0);
      assert.equal(measured.media, 0);
      assert.ok(measured.visible.every((n) => n.kind === 'folder'));
      assert.ok(
        measured.indexTextGap >= 0 && measured.indexTextGap <= 10,
        JSON.stringify(measured)
      );
      assert.ok(measured.cachedItems <= 1536);
      assert.ok(measured.requests.every((q) => q.limit === 128 && q.filter === 'folders'));
      report.cases.push({ width, viewportHeight: height, ...measured });
      await screenshot(`continuous-bottom-${width}x${height}`);
      await row(lastId).locator('.category-link').focus();
      await page.keyboard.press('Home');
      await expect(row(rootId).locator('.category-link')).toBeFocused();
      await page.keyboard.press('End');
      await expect(row(lastId).locator('.category-link')).toBeFocused();
      const before = await page.evaluate(() => {
        window.__focusedTreeLink = document.activeElement;
        return $('#category-nav').scrollTop;
      });
      await page.evaluate(() => {
        for (let i = 0; i < 100; i++) renderFolderTree();
      });
      assert.equal(
        await page.evaluate(() => document.activeElement === window.__focusedTreeLink),
        true
      );
      assert.equal(await page.locator('#category-nav').evaluate((host) => host.scrollTop), before);
      report.checks.push(`logical keyboard navigation and stable focus at ${width}x${height}`);
    }
    await checkBackgroundStability(rootId);
    await checkFocusRecovery(rootId);
    // Return to the final sibling before traversing the deep path.
    await page.evaluate(async (id) => {
      await focusTreeIndex(
        treeLayout.indexOf(id) >= 0 ? treeLayout.indexOf(id) : treeLayout.total - 1
      );
    }, lastId);
    // Use real disclosure controls to traverse all ten folder levels.
    for (const dir of deep.slice(0, -1)) {
      const id = idFor(dir);
      await row(id).scrollIntoViewIfNeeded();
      await expect(row(id)).toBeInViewport();
      await row(id).locator('.tree-toggle').click();
      const next = deep[deep.indexOf(dir) + 1];
      await expect(row(idFor(next))).toBeVisible();
    }
    await row(idFor(deep.at(-1))).scrollIntoViewIfNeeded();
    await expect(row(idFor(deep.at(-1)))).toHaveAttribute('aria-level', '11');
    assert.equal(await page.locator('#category-nav .tree-more').count(), 0);
    await screenshot('ten-level-tree');
    const openBefore = await page.evaluate(() => [...folderTree.open]);
    await page.evaluate(async () => {
      await loadSummary();
      invalidateFolderTree();
    });
    await page.waitForFunction(
      (ids) =>
        ids.every((id) => folderTree.open.has(id)) &&
        folderTree.loading.size === 0 &&
        !$('#category-nav .tree-slot'),
      openBefore
    );
    await expect(row(idFor(deep.at(-1)))).toBeVisible();
    report.checks.push('summary refresh retains the open deep path');
    // The rename modal exercises the existing app remapping contract against paged tree records.
    await page.evaluate(async (id) => renameModal(await api('get', { id })), lastId);
    await page.locator('#rename-name').fill('000 Renamed');
    await page.locator('#rename-save').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await expect(page.locator('#rename-form')).not.toBeVisible();
    await page.waitForFunction(() => !renamingNodes.size);
    const renamed = path.join(collection, '000 Renamed'),
      renamedId = idFor(renamed),
      renamedLeaf = path.join(renamed, path.relative(deep[0], deep.at(-1)));
    await page.waitForFunction(
      (id) => folderTree.open.has(id) && folderTree.positions.get(id) === 0,
      renamedId
    );
    await wheel(-100000);
    await expect(row(renamedId)).toBeInViewport();
    await expect(row(renamedId)).toHaveAttribute('aria-expanded', 'true');
    await expect(row(idFor(renamedLeaf))).toBeVisible();
    report.checks.push('rename reorders an open paged branch and remaps expanded descendants');
    await screenshot('renamed-open-branch');
    // Move only this known generated branch out of the indexed root, preserving the evidence payload.
    const detached = path.join(run, 'detached-generated-branch');
    report.fixture.detachedBranch = detached;
    assert.equal(path.resolve(path.dirname(renamed)), path.resolve(collection));
    assert.equal(path.resolve(path.dirname(detached)), path.resolve(run));
    assert.ok(path.resolve(collection).startsWith(path.resolve(run) + path.sep));
    await fs.rename(renamed, detached);
    await refreshGeneratedRoot(rootId, 'prune-generated-branch');
    await page.evaluate(async () => {
      await loadSummary();
      invalidateFolderTree();
    });
    await page.waitForFunction((id) => !folderTree.open.has(id), renamedId);
    assert.equal(await row(renamedId).count(), 0);
    report.checks.push('a missing generated branch is pruned after refresh');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (page && !page.isClosed()) {
      await page
        .evaluate(() => {
          const probe = window.__sidebarOpeningProbe;
          if (!probe) return [];
          openFolderTree = probe.original;
          window.removeEventListener('wheel', probe.wheel, { capture: true });
          $('#category-nav').removeEventListener('scroll', probe.scroll);
          delete window.__sidebarOpeningProbe;
          return probe.events;
        })
        .then((events) => {
          report.openingEvents = events;
        })
        .catch((error) => {
          report.passed = false;
          report.errors.push(error.stack);
          process.exitCode = 1;
        });
    }
    if (app) {
      await app
        .evaluate(({ ipcMain }) => {
          const probe = globalThis.__sidebarTreeProbe;
          if (!probe) return;
          if (probe.boundary) {
            probe.boundary.canceled = true;
            probe.boundary.release?.();
          }
          ipcMain.removeHandler('library:list');
          ipcMain.handle('library:list', probe.original);
          delete globalThis.__sidebarTreeProbe;
        })
        .catch((error) => {
          report.passed = false;
          report.errors.push(error.stack);
          process.exitCode = 1;
        });
      await app.close().catch(() => {});
    }
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('REPORT ' + path.join(run, 'report.json'));
    }
  }
})();
