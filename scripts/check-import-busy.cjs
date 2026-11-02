'use strict';
// Lead runs this source-only check serially. The fixture's opendir is held, not production IPC/state.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const source = path.resolve(__dirname, '..');
const stage = path.resolve(process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\import-busy');
const report = {
  passed: false,
  scope:
    'Source Electron only, isolated generated profile and 200 folders/small PNGs. Native mouse, production import/cancel IPC and worker handlers. Only directory picker selection/wait and fixture-root opendir wait are controlled. No timing/performance conclusion, personal library, deployment or HTTP.',
  checks: [],
  errors: []
};
let run, profile, collection, gate, app, page;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function check(name, fn) {
  try {
    report.checks.push({ name, passed: true, details: await fn() });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function mouse(selector) {
  const locator = page.locator(selector);
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
function bootstrap(c) {
  const electron = require('electron'),
    threads = require('node:worker_threads'),
    path = require('node:path');
  const probe = (globalThis.__importBusyMain = {
    pickers: 0,
    calls: [],
    events: [],
    blocked: [],
    releasePicker: null
  });
  const NativeWorker = threads.Worker;
  threads.Worker = class extends NativeWorker {
    constructor(entry, options = {}) {
      const wrapped =
        typeof entry === 'string' && path.resolve(entry) === c.worker && !options.eval;
      super(
        wrapped ? c.wrapper : entry,
        wrapped ? { ...options, workerData: { ...options.workerData, busyFixture: c } } : options
      );
      if (wrapped)
        this.on('message', (m) => {
          if (m.event === 'busyFixtureHTTP') probe.blocked.push(m.data);
          if (['progress', 'online', 'busyFixtureHeld'].includes(m.event))
            probe.events.push({ time: Date.now(), type: m.event, data: m.data });
        });
    }
    postMessage(message, ...args) {
      if (['scan', 'cancel'].includes(message?.method))
        probe.calls.push({ time: Date.now(), method: message.method });
      return super.postMessage(message, ...args);
    }
  };
  electron.dialog.showOpenDialog = () => {
    probe.pickers++;
    return new Promise((resolve) => {
      probe.releasePicker = () => {
        probe.releasePicker = null;
        resolve({ canceled: false, filePaths: [c.collection] });
      };
    });
  };
  const nativeFetch = electron.net.fetch.bind(electron.net);
  electron.net.fetch = (input, ...args) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:/i.test(url)) return nativeFetch(input, ...args);
    probe.blocked.push(url);
    return Promise.reject(new Error('HTTP forbidden in generated import fixture'));
  };
  electron.app.whenReady().then(() =>
    electron.session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        probe.blocked.push(details.url);
        callback({ cancel: true });
      }
    )
  );
  require(c.main);
}
function workerBootstrap() {
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs/promises'),
    path = require('node:path');
  const c = workerData.busyFixture,
    open = fs.opendir.bind(fs);
  let held = false;
  fs.opendir = async (directory, ...args) => {
    if (!held && path.resolve(directory) === c.collection) {
      held = true;
      parentPort.postMessage({
        event: 'busyFixtureHeld',
        data: { directory: c.collection, operation: 'opendir' }
      });
      const deadline = Date.now() + 30000;
      while (true) {
        try {
          await fs.stat(c.gate);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (Date.now() >= deadline) throw new Error('Generated opendir gate was not released');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return open(directory, ...args);
  };
  globalThis.fetch = async (input) => {
    parentPort.postMessage({ event: 'busyFixtureHTTP', data: String(input) });
    throw new Error('Worker HTTP forbidden');
  };
  require(c.worker);
}
async function main() {
  run = path.join(
    stage,
    'source-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
  );
  await fs.mkdir(run, { recursive: true });
  profile = path.join(run, 'generated-profile');
  collection = path.join(run, 'generated-collection');
  gate = path.join(run, 'release-opendir');
  Object.assign(report, { run, profile, collection, gate, started: new Date().toISOString() });
  await fs.mkdir(collection);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#88aacc' } })
    .png()
    .toBuffer();
  for (let index = 0; index < 200; index++) {
    const directory = path.join(collection, 'generated-' + String(index).padStart(3, '0'));
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'sample.png'), png);
  }
  const config = {
    run,
    collection,
    gate,
    worker: path.join(source, 'src/library-worker.cjs'),
    wrapper: path.join(run, 'worker.cjs'),
    main: path.join(source, 'src/main.cjs')
  };
  await fs.writeFile(config.wrapper, '(' + workerBootstrap.toString() + ')();');
  await fs.writeFile(
    path.join(run, 'main.cjs'),
    '(' + bootstrap.toString() + ')(' + JSON.stringify(config) + ');'
  );
  await fs.writeFile(
    path.join(run, 'package.json'),
    JSON.stringify({ name: 'acg-import-busy-check', version: '1.0.0', main: 'main.cjs' })
  );
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [run],
    cwd: source,
    env,
    timeout: 60000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push(error.stack || error.message));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.errors.push('Renderer HTTP ' + route.request().url());
    await route.abort();
  });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
  const runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1440, 1000);
    win.show();
    win.focus();
    return { userData: app.getPath('userData'), packaged: app.isPackaged };
  });
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  assert.equal(runtime.packaged, false);
  await rpc('settings', { key: 'autoMatch', value: false });
  await rpc('settings', { key: 'watchChanges', value: false });
  await rpc('settings', { key: 'metadataOnboardingSeen', value: true });
  await page.reload();
  await page.waitForFunction(
    () => typeof isImportBusy === 'function' && S.loadVersion > 0 && !isImportBusy()
  );
  await page.evaluate(() => {
    const add = document.querySelector('#import-sidebar'),
      cancel = document.querySelector('#cancel-import');
    const probe = (window.__busyUI = {
      states: [],
      writes: [],
      events: [],
      seenWorker: false,
      add,
      cancel
    });
    const read = () => {
      const state = {
        time: performance.now(),
        busy: isImportBusy(),
        scan: scanActive,
        workerBusy: !!latestScanProgress?.busy,
        cancelling: !!latestScanProgress?.cancelling,
        addDisabled: add.disabled,
        cancelHidden: cancel.hidden,
        cancelDisabled: cancel.disabled,
        cancelText: cancel.textContent,
        sameAdd: document.querySelector('#import-sidebar') === add,
        sameCancel: document.querySelector('#cancel-import') === cancel
      };
      if (state.scan || state.workerBusy || state.cancelling) probe.seenWorker = true;
      state.seenWorker = probe.seenWorker;
      probe.states.push(state);
      return state;
    };
    read();
    new MutationObserver((records) => {
      for (const record of records)
        if ((record.target === add || record.target === cancel) && record.type === 'attributes')
          probe.writes.push({
            id: record.target.id,
            attribute: record.attributeName,
            oldValue: record.oldValue,
            value: record.target.getAttribute(record.attributeName),
            time: performance.now()
          });
      read();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['disabled', 'hidden', 'aria-busy']
    });
    window.album.onEvent((event) => {
      if (['progress', 'online'].includes(event.type)) {
        probe.events.push(event);
        read();
      }
    });
  });
  await check('pending picker and real concurrent import RPC are exclusive', async () => {
    await mouse('#import-sidebar');
    const kindPicker = page.locator('#import-directory-kind').locator('..').getByRole('combobox');
    await kindPicker.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.locator('#import-directory-kind')).toHaveValue('photo');
    await mouse('#import-options-confirm');
    await expect.poll(() => app.evaluate(() => globalThis.__importBusyMain.pickers)).toBe(1);
    await expect(page.locator('#import-sidebar')).toBeDisabled();
    await mouse('#import-sidebar'); // Native click on the disabled target must not open another picker.
    const duplicate = await page.evaluate(async () => {
      try {
        await window.album.call('import', { onlineMatch: false, directoryKind: 'photo' });
        return { accepted: true };
      } catch (error) {
        return { accepted: false, message: error.message };
      }
    });
    assert.equal(duplicate.accepted, false);
    assert.match(duplicate.message, /导入任务|批量检索/);
    assert.equal(await app.evaluate(() => globalThis.__importBusyMain.pickers), 1);
    assert.equal(await page.evaluate(() => !!pendingImport), true);
    return { duplicate, pickers: 1 };
  });
  await check(
    'real scan cancellation is single-flight and buttons have one stable busy interval',
    async () => {
      await app.evaluate(() => globalThis.__importBusyMain.releasePicker());
      await expect
        .poll(() =>
          app.evaluate(() =>
            globalThis.__importBusyMain.events.some((event) => event.type === 'busyFixtureHeld')
          )
        )
        .toBe(true);
      await page.waitForFunction(
        () => scanActive && isImportBusy() && !document.querySelector('#cancel-import').hidden
      );
      await expect(page.locator('#import-sidebar')).toBeDisabled();
      await expect(page.locator('#cancel-import')).toBeEnabled();
      await mouse('#cancel-import');
      await mouse('#cancel-import');
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              globalThis.__importBusyMain.calls.filter((call) => call.method === 'cancel').length
          )
        )
        .toBe(1);
      await page.waitForFunction(() => latestScanProgress?.cancelling);
      const draining = await rpc('init', { lightweight: true });
      assert.equal(draining.progress.busy, true);
      assert.equal(draining.progress.cancelling, true);
      assert.equal(await page.locator('#cancel-import').isEnabled(), true);
      // Exact generated path, retained with all evidence. This releases only the controlled opendir wait.
      assert.equal(gate, path.join(run, 'release-opendir'));
      await fs.writeFile(gate, 'release generated I/O only\n', { flag: 'wx' });
      await page.waitForFunction(
        () =>
          !pendingImport &&
          !latestScanProgress?.busy &&
          !latestScanProgress?.cancelling &&
          !isImportBusy()
      );
      const ui = await page.evaluate(() => {
        const { states, writes, events } = window.__busyUI;
        return { states, writes, events };
      });
      report.ui = ui;
      const steady = ui.states.filter((state) => state.seenWorker && state.busy);
      assert.ok(steady.length > 0);
      assert.ok(
        steady.every(
          (state) =>
            state.addDisabled &&
            !state.cancelHidden &&
            !state.cancelDisabled &&
            state.sameAdd &&
            state.sameCancel
        ),
        'every scan/draining snapshot keeps stable existing controls'
      );
      const disabledWrites = ui.writes.filter(
        (write) => write.id === 'import-sidebar' && write.attribute === 'disabled'
      );
      const hiddenWrites = ui.writes.filter(
        (write) => write.id === 'cancel-import' && write.attribute === 'hidden'
      );
      assert.deepEqual(
        disabledWrites.map((write) => write.value !== null),
        [true, false],
        'add disables once and enables once after drain'
      );
      assert.deepEqual(
        hiddenWrites.map((write) => write.value !== null),
        [false, true],
        'cancel appears once and hides once after drain'
      );
      const probe = await app.evaluate(() => {
        const { calls, events, pickers, blocked } = globalThis.__importBusyMain;
        return { calls, events, pickers, blocked };
      });
      report.main = probe;
      assert.equal(probe.calls.filter((call) => call.method === 'scan').length, 1);
      assert.equal(probe.calls.filter((call) => call.method === 'cancel').length, 1);
      assert.equal(probe.pickers, 1);
      assert.deepEqual(probe.blocked, []);
      assert.equal(
        probe.events.filter(
          (event) =>
            event.type === 'online' &&
            (event.data.active || event.data.remaining > 0 || event.data.discovering)
        ).length,
        0
      );
      return {
        controlledIO: 'fixture root opendir only; no duration/performance assertion',
        steadySnapshots: steady.length,
        disabledWrites,
        hiddenWrites,
        totalWrites: ui.writes.length,
        acceptedScans: 1,
        acceptedCancels: 1
      };
    }
  );
  await page.screenshot({ path: path.join(run, 'idle-after-cancel.png') });
  assert.deepEqual(report.errors, []);
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.stack || String(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (page && !page.isClosed())
        report.finalUI = await page.evaluate(() => {
          const probe = window.__busyUI;
          return probe
            ? { states: probe.states, writes: probe.writes, events: probe.events }
            : null;
        });
    } catch {}
    try {
      if (app) await app.close();
    } catch (error) {
      report.closeError = error.stack || String(error);
      process.exitCode = 1;
      report.passed = false;
    }
    if (run) {
      report.finished = new Date().toISOString();
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('REPORT ' + path.join(run, 'report.json'));
    }
  });
