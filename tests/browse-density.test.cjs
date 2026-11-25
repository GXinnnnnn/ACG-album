'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const spec = require('../src/appearance-settings.cjs');
const { normalizeBrowseSortPreferences: normalize } = require('../src/browse-date.cjs');
const storeSource = fs.readFileSync(require.resolve('../src/ui/browse-sort.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../src/ui/app.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(platform = 'win32', save = async () => {}) {
  const window = { album: { platform } };
  const context = vm.createContext({ window, console, Promise });
  vm.runInContext(storeSource, context);
  const api = window.albumBrowseSort;
  const create = (extra = {}) => api.create({ save, requireHydration: true,
    validValue: (v) => v && Object.keys(v).length === 1 && spec.valid('density', v.density),
    defaultValue: () => ({}), ...extra });
  return { api, context, create, memory: create() };
}
test('directory widths are independent, canonical, restartable and rename with descendants', async () => {
  let persisted;
  const { api, memory, create } = fixture('win32', async (v) => { persisted = plain(v); });
  memory.hydrate({}, memory.beginRead());
  memory.set('library', 'C:/Albums/A', { density: 120 });
  memory.set('library', 'C:/Albums/A/Child', { density: 196 });
  memory.set('library', 'C:/Albums/B', { density: 267.5 });
  memory.set('favorites', 'C:/Albums/A', { density: 155 });
  memory.rename([{ oldPath: 'C:/Albums/A', path: 'C:/Albums/Renamed' }]);
  await memory.flush();
  const restarted = create(); restarted.hydrate(persisted, restarted.beginRead());
  assert.equal(restarted.get('library', 'c:/ALBUMS/renamed').density, 120);
  assert.equal(restarted.get('library', 'C:/Albums/Renamed/Child').density, 196);
  assert.equal(restarted.get('library', 'C:/Albums/B').density, 267.5);
  assert.equal(restarted.get('favorites', 'C:/Albums/Renamed').density, 155);
  assert.deepEqual(plain(restarted.get('library', 'C:/Albums/New')), {});
  assert.deepEqual(normalize(persisted, 'win32', true), persisted);
  for (const width of [null, 119, 361, '155', Infinity])
    assert.throws(() => normalize({ [api.scope('library', 'C:/Albums/A')]: { density: width } }, 'win32', true));
});
test('Mac keeps case and worker canonical scopes agree', () => {
  const { memory, api } = fixture('darwin');
  memory.hydrate({}, memory.beginRead());
  memory.set('library', '/Albums/A', { density: 120 });
  memory.set('library', '/Albums/a', { density: 196 });
  assert.notEqual(api.scope('library', '/Albums/A'), api.scope('library', '/Albums/a'));
  assert.equal(memory.get('library', '/Albums/A').density, 120);
  assert.equal(memory.get('library', '/Albums/a').density, 196);
  assert.deepEqual(normalize(plain(memory.snapshot()), 'darwin', true), plain(memory.snapshot()));
});
test('late startup hydration replays input and serial persistence never writes an old map last', async () => {
  const gate = deferred(), writes = [];
  const { memory, api } = fixture('win32', async (v) => { writes.push(plain(v)); if (writes.length === 1) await gate.promise; });
  const read = memory.beginRead();
  memory.set('library', 'C:/A', { density: 120 });
  assert.equal(writes.length, 0);
  memory.hydrate({ [api.scope('library', 'C:/A')]: { density: 196 }, [api.scope('library', 'C:/B')]: { density: 222 } }, read);
  await Promise.resolve(); await Promise.resolve();
  memory.set('library', 'C:/A', { density: 155 });
  memory.set('library', 'C:/B', { density: 196 });
  gate.resolve(); await memory.flush();
  assert.equal(writes.at(-1)[api.scope('library', 'C:/A')].density, 155);
  assert.equal(writes.at(-1)[api.scope('library', 'C:/B')].density, 196);
  assert.equal(writes.length, 2);
});
function navigationFixture() {
  const f = fixture();
  const S = { view: 'library', parent: 'A', current: { path: 'C:/A' }, settings: {} };
  const calls = [], reads = [];
  Object.assign(f.context, { S, cardPresets: () => spec.cardPresets(3840), toast: () => {},
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } }, applyDisplaySettings() {},
    browseSortPath: () => S.current?.path,
    api: (method, args) => { if (method === 'get') { const d = deferred(); reads.push(d); return d.promise; } calls.push(args); return Promise.resolve(); }
  });
  f.context.window.albumAppearanceSpec = spec;
  f.context.window.albumAppearanceControls = { resetDensityPreview() {}, sync() {} };
  vm.runInContext(app.slice(app.indexOf('const browseDensityMemory ='), app.indexOf('function browseSortPath()')), f.context);
  vm.runInContext('browseDensityMemory.hydrate({}, browseDensityMemory.beginRead());', f.context);
  return { ...f, S, calls, reads, run: (s) => vm.runInContext(s, f.context) };
}
test('real navigation helpers restore default medium and retain old global custom only at root', async () => {
  const { S, run } = navigationFixture();
  run('legacyBrowseDensity = 267.5; rememberBrowseDensity(120);');
  S.parent = 'B'; S.current = { path: 'C:/B' };
  run('restoreBrowseDensity()'); assert.equal(S.settings.density, 155); assert.equal(S.settings.densityConfigured, false);
  run('rememberBrowseDensity(196)');
  S.parent = 'A'; S.current = { path: 'c:/a' };
  run('restoreBrowseDensity()'); assert.equal(S.settings.density, 120);
  S.parent = null; S.current = null;
  run('restoreBrowseDensity()'); assert.equal(S.settings.density, 267.5);
  await run('flushBrowseDensity()');
});
test('same-directory summary restoration leaves the active density preview intact', () => {
  const { context, S, run } = navigationFixture();
  let resets = 0;
  context.window.albumAppearanceControls.resetDensityPreview = () => { resets++; };
  run('restoreBrowseDensity(); rememberBrowseDensity(120); restoreBrowseDensity();');
  assert.equal(resets, 1);
  assert.equal(S.settings.density, 120);
  S.parent = 'B'; S.current = { path: 'C:/B' }; run('restoreBrowseDensity()');
  assert.equal(resets, 2);
  assert.equal(S.settings.density, 155);
});
test('appearance input binds A synchronously and late flush/summary preserve B', async () => {
  const { context, S, run } = navigationFixture();
  Object.assign(context, {
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {}, CustomEvent: class {},
  });
  context.window.dispatchEvent = () => {};
  context.document.querySelectorAll = () => [];
  vm.runInContext(fs.readFileSync(require.resolve('../src/ui/appearance.js'), 'utf8'), context);
  run(`window.albumAppearanceControls = window.albumAppearance.createController({
    settings: () => S.settings, save: () => { throw Error('must not write global density'); },
    onDensity: rememberBrowseDensity, flushDensity: flushBrowseDensity
  }); window.albumAppearanceControls.set('density', 120);`);
  S.parent = 'B'; S.current = { path: 'C:/B' };
  run('restoreBrowseDensity()');
  await run('window.albumAppearanceControls.flush()');
  assert.equal(S.settings.density, 155);
  assert.deepEqual(plain(run('window.albumAppearanceControls.mergeSummary({density:120,densityConfigured:true})')), {});
  S.parent = 'A'; S.current = { path: 'C:/A' }; run('restoreBrowseDensity()');
  assert.equal(S.settings.density, 120);
});
test('unresolved A input completing in B stays in A; old path read cannot replace newer input', async () => {
  const { S, reads, run } = navigationFixture();
  S.current = null;
  run('rememberBrowseDensity(120); rememberBrowseDensity(196);');
  S.parent = 'B'; S.current = { path: 'C:/B' }; run('restoreBrowseDensity()');
  reads[1].resolve({ path: 'C:/A' }); await Promise.resolve();
  reads[0].resolve({ path: 'C:/A' }); await run('flushBrowseDensity()');
  assert.equal(S.settings.density, 155);
  S.parent = 'A'; S.current = { path: 'C:/A' }; run('restoreBrowseDensity()');
  assert.equal(S.settings.density, 196);
});
