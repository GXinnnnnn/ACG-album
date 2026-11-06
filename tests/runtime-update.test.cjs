'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  REQUIRED_RUNTIME_FILES,
  STANDARD_IDENTITY,
  FONT_WEIGHTS,
  sameIdentity,
  safeRuntimePath,
  validateRuntimeManifest,
  bundledIndexIdentity,
  prepareFontOverlay,
  OWNERSHIP_PATH,
  makeRuntimeOwnership,
  validateRuntimeOwnership,
  assertRuntimeOwnership
} = require('../src/runtime-update.cjs');
const {
  runtimeTransactionScript,
  editionTransactionScript,
  installationPlan,
  preflightScript,
  preflightInstallation,
  launchInstaller
} = require('../src/update-install.cjs');
const { releaseAssets } = require('../src/update-release.cjs');
const { createUpdater } = require('../src/update-service.cjs');
const {
  assertPublicAsar,
  runtimeInventory,
  runtimePayloadInventory
} = require('../scripts/build-runtime-update.cjs');
async function writeOwnership(directory, version = '1.2.1') {
  const value = makeRuntimeOwnership({ version, files: await runtimeInventory(directory) });
  await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
  await fs.writeFile(path.join(directory, OWNERSHIP_PATH), JSON.stringify(value));
  return value;
}
function runtimeEntries(value) {
  const text = JSON.stringify(makeRuntimeOwnership({ version: value.version, files: value.files }));
  const row = value.files.find((file) => file.path === OWNERSHIP_PATH);
  row.bytes = Buffer.byteLength(text);
  row.sha256 = hash(text);
  return value.files.map((file) => ({
    path: file.path,
    ...(file.path === OWNERSHIP_PATH ? { data: text } : {})
  }));
}
const repository = 'fixture-owner/fixture-repo';
const version = '1.2.2';
const tag = 'release/1.2.2';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from('synthetic ZIP transport fixture, never an executable');
// Names observed read-only in the 2026-11-06 unpacked build; all fixture bytes
// below are synthetic and no test reads or changes that build or original images.
const unicodeRuntimePaths = [
  'resources/demo/幻想与游戏（示例）/01 云海来信/00 封面.jpg',
  'resources/demo/幻想与游戏（示例）/01 云海来信/设定集/02 透明人物/透明角色.png',
  'resources/demo/动画与映画（示例）/01 银河慢行/设定集/01 场景与建筑/远景.jpg',
  'resources/demo/日本語/ひらがな・カタカナ/笑顔😀🎨.jpg',
  'resources/demo/絵と光/笑顔👍🏽☀️.jpg'
];
const validUnicodeParts = [
  ...new Set(unicodeRuntimePaths.flatMap((name) => name.split('/'))),
  "合法 ＃＆$#!~%=;,'{}.jpg",
  'éとe\u0301',
  '图'.repeat(200)
];
const invalidUnicodeParts = [
  '',
  '.',
  '..',
  '尾点.',
  '尾空格 ',
  'CON',
  'prn.jpg',
  'AUX',
  'nul',
  'COM1.txt',
  'lpt9',
  ...['COM', 'LPT'].flatMap((prefix) =>
    ['¹', '²', '³'].flatMap((digit) => [prefix + digit, prefix + digit + '.jpg'])
  ),
  'nul .jpg',
  'CONIN$',
  'CONIN$.jpg',
  'CONOUT$',
  'CONOUT$.txt',
  ...[...'<>:"\\|?*'].map((character) => '图' + character + '.jpg'),
  ...Array.from({ length: 32 }, (_, code) => '图' + String.fromCharCode(code) + '.jpg'),
  ...Array.from({ length: 33 }, (_, code) => '图' + String.fromCharCode(code + 127) + '.jpg'),
  ...[
    '\u00ad',
    '\u061c',
    '\u200b',
    '\u200d',
    '\u202e',
    '\u2066',
    '\ufeff',
    '\u{e0001}',
    '\u{e0020}',
    '\ud800',
    '\udfff',
    '\ud800\ud800',
    '\udfff\ud800',
    '\ud800中',
    '中\udfff'
  ].map((character) => '图' + character + '.jpg')
];
function manifest(identity = STANDARD_IDENTITY) {
  const files = [
    ...REQUIRED_RUNTIME_FILES,
    'resources/app.asar.unpacked/native/test.node',
    'resources/demo/test.jpg',
    'resources/codecs/test.dll'
  ];
  return {
    schemaVersion: 1,
    kind: 'runtime',
    repository,
    tag,
    version,
    platform: 'win32',
    arch: 'x64',
    localIndexes: [{ ...identity }],
    payload: {
      name: `ACG-album-Runtime-${version}-win32-x64.zip`,
      bytes: payload.length,
      sha256: hash(payload)
    },
    files: files.map((name) => ({ path: name, bytes: 3, sha256: hash('NEW') }))
  };
}
test('large valid runtime plans keep registry preflight bounded and installer payload on disk', async () => {
  const value = manifest();
  while (value.files.length < 1500) {
    value.files.push({
      path: `resources/demo/file-${value.files.length}.bin`,
      bytes: 3,
      sha256: hash('NEW')
    });
  }
  validateRuntimeManifest(value, { repository, tag, version });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 256 * 1024);
  const plan = installationPlan({
    executable: 'C:\\Apps\\ACG-album\\ACG-album.exe',
    dataDirectory: 'C:\\Profiles\\Data',
    userData: 'C:\\Profiles\\User',
    installer: 'C:\\Cache\\runtime.zip',
    sha256: value.payload.sha256,
    parentPid: 123,
    edition: 'standard',
    version,
    mode: 'runtime',
    runtimeManifest: value,
    indexIdentity: STANDARD_IDENTITY,
    platform: 'win32',
    packaged: true,
    testMode: false
  });
  const script = preflightScript(plan);
  const encodedPlan = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encodedPlan, 'base64').toString()), {
    directory: plan.directory,
    appGuid: plan.appGuid
  });
  await preflightInstallation(plan, {
    spawnProcess: (executable, args) => {
      assert.ok([executable, ...args].map((part) => JSON.stringify(part)).join(' ').length < 16000);
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), script);
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }
  });
  let diskScript;
  await launchInstaller(plan, {
    writeFile: async (file, source) => {
      assert.match(file, /install\.ps1$/);
      diskScript = source;
    },
    spawnProcess: (executable, args) => {
      assert.ok(args.includes('-File'));
      assert.ok(!args.includes('-EncodedCommand'));
      assert.ok([executable, ...args].join(' ').length < 1024);
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  assert.ok(diskScript.length > 32767);
  const diskPlan = diskScript.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(
    JSON.parse(Buffer.from(diskPlan, 'base64').toString()).runtimeManifest.files.length,
    1500
  );
  if (process.platform === 'win32') {
    // Production registry reader is read-only; this GUID deliberately has no installation.
    await preflightInstallation({ ...plan, appGuid: '00000000-0000-0000-0000-000000000000' });
  }
});

function release(value) {
  const json = JSON.stringify(value);
  const asset = (name, size, sha256) => ({
    name,
    size,
    digest: sha256 && 'sha256:' + sha256,
    browser_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`
  });
  const raw = {
    tag_name: tag,
    assets: [
      asset(value.payload.name.replace(/\.zip$/, '.manifest.json'), Buffer.byteLength(json)),
      asset(value.payload.name, value.payload.bytes, value.payload.sha256),
      ...['Standard', 'Lite', 'Full'].map((edition) =>
        asset(`ACG-album-Setup-${version}-${edition}.exe`, payload.length, hash(payload))
      )
    ]
  };
  return {
    repository,
    latestVersion: version,
    status: 'available',
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    assets: releaseAssets(raw, repository, version)
  };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'album-runtime-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeIndex(directory, variant = 'lite') {
  await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.from('NOT A DATABASE, bundled index identity fixture');
  const identity = {
    variant,
    dataVersion: '2026-10-20',
    readerSchemaVersion: 1,
    bytes: bytes.length,
    sha256: hash(bytes)
  };
  await fs.writeFile(path.join(directory, 'subjects.sqlite'), bytes);
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ ...identity, database: 'subjects.sqlite' })
  );
  return identity;
}
async function serviceFixture(t, options = {}) {
  const root = await temporary(t);
  const exe = path.join(root, 'application', 'ACG-album.exe');
  const data = path.join(root, 'personal-data');
  const userData = path.join(root, 'profile');
  for (const directory of [path.dirname(exe), data, userData])
    await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(exe, 'OLD');
  await writeOwnership(path.dirname(exe));
  await fs.writeFile(path.join(data, 'sentinel'), 'token and roots remain');
  const launches = [];
  const app = {
    isPackaged: true,
    getPath: (name) => ({ exe, userData })[name],
    quit() {},
    getAppPath: () => path.join(path.dirname(exe), 'resources', 'app.asar')
  };
  let transport = async () => new Response(payload);
  const service = createUpdater({
    app,
    getLibrary: async () => ({
      dataDir: data,
      settings: { githubRepository: repository },
      roots: []
    }),
    platform: 'win32',
    arch: 'x64',
    testMode: false,
    tempDirectory: root,
    preflight: async () => {},
    launch: async (plan) => launches.push(plan),
    fetch: (...args) => transport(...args),
    ...options
  });
  const offer = async (value = manifest()) => {
    transport = async (url) =>
      new Response(url.endsWith('.manifest.json') ? JSON.stringify(value) : payload);
    return service.setRelease(release(value));
  };
  return {
    root,
    exe,
    data,
    userData,
    service,
    launches,
    offer,
    setTransport: (value) => {
      transport = value;
    }
  };
}

test('runtime identity compares every field and paths reject Windows aliases and protected trees', () => {
  assert.equal(sameIdentity(STANDARD_IDENTITY, { ...STANDARD_IDENTITY }), true);
  const lite = {
    variant: 'lite',
    dataVersion: '2026-10-20',
    readerSchemaVersion: 1,
    bytes: 10,
    sha256: 'a'.repeat(64)
  };
  for (const patch of [
    { variant: 'full' },
    { dataVersion: 'older' },
    { readerSchemaVersion: 2 },
    { bytes: 11 },
    { sha256: 'b'.repeat(64) },
    { unknown: true }
  ])
    assert.equal(sameIdentity(lite, { ...lite, ...patch }), false);
  for (const name of [
    '../bad',
    '/bad',
    'C:/bad',
    'resources\\bad',
    'resources/local-index/subjects.sqlite',
    'RESOURCES/LOCAL-INDEX/db',
    'resources/fonts/x.ttf',
    'fonts/x.ttf',
    'aux.txt',
    'x/nul',
    'x./file',
    'x /file',
    'a//b',
    'file:stream'
  ])
    assert.equal(safeRuntimePath(name), false, name);
});

test('Windows Unicode runtime paths accept observed Chinese names and scalar emoji without weakening exclusions', () => {
  for (const name of [...unicodeRuntimePaths, ...validUnicodeParts])
    assert.equal(safeRuntimePath(name), true, JSON.stringify(name));
  for (const name of [
    ...invalidUnicodeParts,
    'resources/demo/' + '图'.repeat(201 - 'resources/demo/'.length),
    '/中文.jpg',
    '//server/中文.jpg',
    'C:/中文.jpg',
    '中文\\图片.jpg',
    './中文.jpg',
    '../中文.jpg',
    '中文/./图片.jpg',
    '中文/../图片.jpg',
    '中文//图片.jpg',
    '中文/',
    'RESOURCES/LOCAL-INDEX/中文.sqlite',
    'resources/FONTS/中文.ttf',
    'FONTS/中文.ttf'
  ])
    assert.equal(safeRuntimePath(name), false, JSON.stringify(name));
  const boundary = 'resources/demo/' + '图'.repeat(200 - 'resources/demo/'.length);
  assert.equal(boundary.length, 200);
  assert.equal(safeRuntimePath(boundary), true);
});

test('Unicode manifest and ownership inventories preserve paths but reject case aliases and invalid scalars', () => {
  const value = manifest();
  for (const name of unicodeRuntimePaths)
    value.files.push({ path: name, bytes: 3, sha256: hash('NEW') });
  validateRuntimeManifest(value, { repository, tag, version });
  const owner = makeRuntimeOwnership({ version, files: value.files });
  assert.deepEqual(validateRuntimeOwnership(JSON.parse(JSON.stringify(owner))), owner);
  for (const name of [...invalidUnicodeParts, 'resources/demo/日本語', '图'.repeat(201)]) {
    const bad = structuredClone(value);
    bad.files.push({ path: name, bytes: 3, sha256: hash('NEW') });
    assert.throws(
      () => validateRuntimeManifest(bad, { repository, tag, version }),
      /清单/,
      JSON.stringify(name)
    );
    assert.throws(
      () => makeRuntimeOwnership({ version, files: bad.files }),
      /清单/,
      JSON.stringify(name)
    );
  }
  const aliases = structuredClone(value);
  for (const name of ['resources/demo/日本語/Éclair.jpg', 'resources/demo/日本語/éclair.jpg'])
    aliases.files.push({ path: name, bytes: 3, sha256: hash('NEW') });
  assert.throws(() => validateRuntimeManifest(aliases, { repository, tag, version }), /清单/);
  assert.throws(() => makeRuntimeOwnership({ version, files: aliases.files }), /清单/);
});

test('publisher inventory and ownership round-trip the observed Chinese resource tree in a temporary fixture', async (t) => {
  const root = await temporary(t),
    value = manifest();
  for (const name of unicodeRuntimePaths)
    value.files.push({ path: name, bytes: 3, sha256: hash('NEW') });
  for (const row of value.files.filter((row) => row.path !== OWNERSHIP_PATH)) {
    await fs.mkdir(path.dirname(path.join(root, row.path)), { recursive: true });
    await fs.writeFile(path.join(root, row.path), 'NEW');
  }
  const built = await runtimePayloadInventory(root, version);
  validateRuntimeManifest({ ...value, files: built.files }, { repository, tag, version });
  for (const name of unicodeRuntimePaths) {
    assert.ok(built.ownership.files.some((row) => row.path === name && row.sha256 === hash('NEW')));
    assert.ok(built.files.some((row) => row.path === name));
  }
  await fs.writeFile(path.join(root, OWNERSHIP_PATH), built.ownershipText);
  assert.deepEqual((await assertRuntimeOwnership(root)).ownership, built.ownership);
});

test(
  'actual PowerShell path predicate agrees on Unicode scalars, every C0/C1 control and unpaired UTF-16 units',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await temporary(t);
    const rows = [
      ...validUnicodeParts.map((part) => ({ part, allowed: true })),
      ...invalidUnicodeParts.map((part) => ({ part, allowed: false }))
    ].map(({ part, allowed }) => ({
      units: part.split('').map((unit) => unit.charCodeAt(0)),
      allowed
    }));
    const source = `${runtimeTransactionScript()}\n$rows=${decode(rows)}
    $rowIndex = 0
    foreach ($row in $rows) {
      $part = -join @($row.units | ForEach-Object { [char]$_ })
      if ((Test-AlbumRuntimePathPart $part) -ne $row.allowed) { throw ('Unicode path parity failed at row ' + $rowIndex) }
      $rowIndex++
    }
    Write-Output ('UNICODE_ROWS=' + $rowIndex)`;
    const result = await runPowershell(root, source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp('UNICODE_ROWS=' + rows.length));
  }
);

test('runtime manifest requires complete runtime inventory, exact metadata and distinct safe files', () => {
  const good = manifest();
  assert.equal(
    validateRuntimeManifest(good, { repository, tag, version }).files.length,
    good.files.length
  );
  for (const mutate of [
    (m) => {
      m.kind = 'installer';
    },
    (m) => {
      m.platform = 'linux';
    },
    (m) => {
      m.arch = 'arm64';
    },
    (m) => {
      m.repository = 'other/repo';
    },
    (m) => {
      m.tag = 'other';
    },
    (m) => {
      m.version = '9.0.0';
    },
    (m) => {
      m.localIndexes[0].readerSchemaVersion = 2;
    },
    (m) => {
      m.extra = true;
    },
    (m) => {
      m.payload.name = 'other.zip';
    },
    (m) => {
      m.payload.bytes = 9 * 1024 ** 3;
    },
    (m) => {
      m.files.pop();
    },
    (m) => {
      m.files.push({ ...m.files[0], path: 'acg-ALBUM.exe' });
    },
    (m) => {
      m.files.push({ ...m.files[0], path: 'resources/local-index/subjects.sqlite' });
    },
    (m) => {
      m.files.push({ ...m.files[0], path: '../escape' });
    },
    (m) => {
      m.files.push({ ...m.files[0], path: 'locales' });
    },
    (m) => {
      m.files[0].bytes = 9 * 1024 ** 3;
    }
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => validateRuntimeManifest(bad, { repository, tag, version }), /清单/);
  }
});

test('bundled identity validates original manifest and actual SQLite bytes without opening a database', async (t) => {
  const root = await temporary(t);
  assert.deepEqual(await bundledIndexIdentity(root), STANDARD_IDENTITY);
  const directory = path.join(root, 'local-index');
  const identity = await writeIndex(directory);
  assert.deepEqual(await bundledIndexIdentity(root), identity);
  await fs.writeFile(path.join(directory, 'subjects.sqlite'), 'changed');
  await assert.rejects(bundledIndexIdentity(root), /SHA-256/);
  await writeIndex(directory);
  const file = path.join(directory, 'manifest.json');
  const invalid = JSON.parse(await fs.readFile(file, 'utf8'));
  delete invalid.dataVersion;
  await fs.writeFile(file, JSON.stringify(invalid));
  await assert.rejects(bundledIndexIdentity(root), /身份/);
});

test('runtime offer is enabled only for exact original index and explicit edition changes use full installers', async (t) => {
  const h = await serviceFixture(t);
  const identity = await writeIndex(path.join(path.dirname(h.exe), 'resources', 'local-index'));
  const result = await h.offer(manifest(identity));
  assert.equal(result.runtime.edition, 'lite');
  assert.equal(result.assets.length, 3);
  assert.equal((await h.service.download({ edition: 'lite' })).mode, 'runtime');
  assert.equal(h.launches.length, 0);
  await h.service.install({ confirm: true, repository, version, edition: 'lite', mode: 'runtime' });
  assert.equal(h.launches[0].mode, 'runtime');
  assert.deepEqual(h.launches[0].indexIdentity, identity);
  assert.equal((await h.service.download({ edition: 'full' })).mode, 'full');
  assert.equal((await h.service.download({ edition: 'lite', mode: 'full' })).mode, 'full');
  assert.equal(await fs.readFile(path.join(h.data, 'sentinel'), 'utf8'), 'token and roots remain');
});

test('mismatched schema, variant, dataVersion, size and SHA fail closed to full mode with a reason', async (t) => {
  for (const patch of [
    { variant: 'full' },
    { dataVersion: 'different' },
    { readerSchemaVersion: 2 },
    { bytes: 99 },
    { sha256: 'a'.repeat(64) }
  ]) {
    const h = await serviceFixture(t);
    const identity = await writeIndex(path.join(path.dirname(h.exe), 'resources', 'local-index'));
    const value = manifest({ ...identity, ...patch });
    const result = await h.offer(value);
    assert.equal(result.runtime, null);
    assert.match(result.runtimeReason, /完整安装包/);
    assert.equal((await h.service.download({ edition: 'lite' })).mode, 'full');
    await assert.rejects(h.service.download({ edition: 'lite', mode: 'runtime' }), /不兼容/);
  }
});

test('metadata failure and index tampering cannot install runtime; the full fallback stays available', async (t) => {
  const h = await serviceFixture(t);
  const identity = await writeIndex(path.join(path.dirname(h.exe), 'resources', 'local-index'));
  const value = manifest(identity);
  await h.offer(value);
  await h.service.download({ edition: 'lite' });
  await fs.writeFile(
    path.join(path.dirname(h.exe), 'resources', 'local-index', 'subjects.sqlite'),
    'changed'
  );
  await assert.rejects(
    h.service.install({ confirm: true, repository, version, edition: 'lite' }),
    /SHA-256|改变/
  );
  assert.equal(h.launches.length, 0);
  h.setTransport(async () => {
    throw new TypeError('network offline');
  });
  const result = await h.service.setRelease(release(value));
  assert.equal(result.runtime, null);
  assert.match(result.runtimeReason, /network offline/);
});

test('timeouts remain retryable errors, network failures and manual cancellation have distinct states', async (t) => {
  const h = await serviceFixture(t, { timeouts: { idle: 10, headers: 10 } });
  await h.offer();
  h.setTransport(
    async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          }
        })
      )
  );
  await assert.rejects(h.service.download({ edition: 'standard' }), /无响应/);
  assert.equal(h.service.snapshot().phase, 'error');
  assert.equal(h.service.snapshot().errorKind, 'timeout');
  assert.ok(h.service.snapshot().releaseUrl);
  h.setTransport(async () => {
    throw new TypeError('network offline');
  });
  await assert.rejects(h.service.download({ edition: 'standard' }), /offline/);
  assert.equal(h.service.snapshot().errorKind, 'network');
  h.setTransport(
    async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
  );
  await assert.rejects(h.service.download({ edition: 'standard' }), /连接下载服务超时/);
  assert.equal(h.service.snapshot().errorKind, 'timeout');
  await h.offer();
  assert.equal((await h.service.download({ edition: 'standard' })).phase, 'ready');
});

test('five exact local font weights are SHA-bound, preserve retries, and reject partial or changed overlays', async (t) => {
  const root = await temporary(t);
  const app = path.join(root, 'app.asar');
  const cache = path.join(root, 'cache');
  assert.deepEqual(await prepareFontOverlay(app, cache), []);
  const folder = path.join(app, 'src', 'assets', 'fonts', 'founder-lanting-yuan');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'regular.ttf'), 'regular font fixture');
  await assert.rejects(prepareFontOverlay(app, cache), /不完整/);
  for (const weight of FONT_WEIGHTS)
    await fs.writeFile(path.join(folder, weight + '.ttf'), weight + ' font fixture');
  const overlay = await prepareFontOverlay(app, cache);
  assert.equal(overlay.length, 5);
  for (const entry of overlay) assert.equal(hash(await fs.readFile(entry.source)), entry.sha256);
  assert.deepEqual(await prepareFontOverlay(app, cache), overlay);
  await fs.writeFile(overlay[0].source, 'tampered overlay');
  await assert.rejects(prepareFontOverlay(app, cache), /已改变/);
});

test('publisher inventory excludes local index and local fonts; embedded proprietary fonts are rejected', async (t) => {
  const root = await temporary(t);
  for (const file of [
    'resources/local-index/subjects.sqlite',
    'resources/fonts/private.ttf',
    'fonts/private.ttf',
    'resources/demo/test.jpg'
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'fixture');
  }
  assert.deepEqual(
    (await runtimeInventory(root)).map((row) => row.path),
    ['resources/demo/test.jpg']
  );
  const archive = path.join(root, 'app.asar');
  function fakeAsar(files) {
    const json = Buffer.from(JSON.stringify({ files }));
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(json.length, 12);
    return Buffer.concat([prefix, json]);
  }
  await fs.writeFile(archive, fakeAsar({ 'public.js': { size: 0 } }));
  await assertPublicAsar(archive);
  await fs.writeFile(
    archive,
    fakeAsar({ 'founder-lanting-yuan': { files: { 'regular.ttf': { size: 0 } } } })
  );
  await assert.rejects(assertPublicAsar(archive), /proprietary/);
});

test('ownership metadata is explicit, verifies bytes and rejects missing lists or modified owned files', async (t) => {
  const root = await temporary(t),
    directory = path.join(root, 'application');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'ACG-album.exe'), 'OLD');
  await assert.rejects(assertRuntimeOwnership(directory), { code: 'UPDATE_OWNERSHIP' });
  const value = await writeOwnership(directory);
  validateRuntimeOwnership(value);
  assert.throws(() =>
    validateRuntimeOwnership({
      ...value,
      files: [...value.files, { path: OWNERSHIP_PATH, bytes: 0, sha256: hash('') }]
    })
  );
  await assertRuntimeOwnership(directory);
  await fs.writeFile(path.join(directory, 'ACG-album.exe'), 'USER MODIFIED');
  await assert.rejects(assertRuntimeOwnership(directory), { code: 'UPDATE_OWNERSHIP' });
});

test('publisher regenerates ownership without inheriting old ownership, private fonts or bundled index', async (t) => {
  const directory = await temporary(t);
  await fs.mkdir(path.join(directory, 'resources', 'local-index'), { recursive: true });
  await fs.mkdir(path.join(directory, 'resources', 'fonts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'ACG-album.exe'), 'PUBLIC');
  await fs.writeFile(path.join(directory, OWNERSHIP_PATH), 'UNTRUSTED OLD LIST');
  await fs.writeFile(path.join(directory, 'resources', 'fonts', 'private.ttf'), 'PRIVATE');
  await fs.writeFile(path.join(directory, 'resources', 'local-index', 'subjects.sqlite'), 'INDEX');
  const { ownership, ownershipText, files } = await runtimePayloadInventory(directory, version);
  assert.deepEqual(
    ownership.files.map((row) => row.path),
    ['ACG-album.exe']
  );
  assert.equal(ownership.version, version);
  assert.deepEqual(JSON.parse(ownershipText), ownership);
  assert.equal(files.find((row) => row.path === OWNERSHIP_PATH).sha256, hash(ownershipText));
  assert.equal(files.length, 2);
});

for (const mode of ['runtime', 'full']) {
  for (const name of [
    'notes.txt',
    'resources/user-photos/photo.bin',
    '备忘录（用户）.txt',
    'resources/demo/幻想与游戏（示例）/01 云海来信/个人照片.png'
  ]) {
    test(
      `unknown ${name} is untouched before service and PowerShell ${mode} installation`,
      { skip: process.platform !== 'win32' },
      async (t) => {
        const fixture = await serviceFixture(t);
        const ownedChinese = path.join(path.dirname(fixture.exe), unicodeRuntimePaths[0]);
        await fs.mkdir(path.dirname(ownedChinese), { recursive: true });
        await fs.writeFile(ownedChinese, 'OWNED OLD CHINESE');
        await writeOwnership(path.dirname(fixture.exe));
        const ownedBefore = await fs.stat(ownedChinese, { bigint: true });
        await fixture.offer();
        await fixture.service.download({ edition: 'standard', mode });
        const directory = path.dirname(fixture.exe),
          unknown = path.join(directory, name);
        await fs.mkdir(path.dirname(unknown), { recursive: true });
        await fs.writeFile(unknown, 'UNKNOWN USER CONTENT');
        const before = await fs.stat(unknown, { bigint: true });
        const exeBefore = await fs.stat(fixture.exe, { bigint: true });
        await assert.rejects(
          fixture.service.install({
            confirm: true,
            repository,
            version,
            edition: 'standard',
            mode
          }),
          (error) =>
            error.code === 'UPDATE_OWNERSHIP' &&
            error.message.includes(
              name === 'resources/user-photos/photo.bin' ? path.dirname(unknown) : unknown
            )
        );
        assert.equal(fixture.launches.length, 0);
        assert.equal(fixture.service.snapshot().errorKind, 'ownership');
        const source = `$p=${decode({ mode, directory, executable: fixture.exe, indexIdentity: STANDARD_IDENTITY, installer: 'NEVER_EXECUTE', edition: 'standard' })}\n${runtimeTransactionScript()}\n${editionTransactionScript()}\nfunction Invoke-AlbumInstaller($mode) { throw 'Installer must not run' }\n${mode === 'runtime' ? 'Install-AlbumRuntime' : "Install-AlbumEdition 'currentuser'"}`;
        const result = await runPowershell(fixture.root, source);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Unknown runtime path/);
        assert.equal(await fs.readFile(unknown, 'utf8'), 'UNKNOWN USER CONTENT');
        assert.equal((await fs.stat(unknown, { bigint: true })).ino, before.ino);
        assert.equal((await fs.stat(fixture.exe, { bigint: true })).ino, exeBefore.ino);
        assert.equal(await fs.readFile(ownedChinese, 'utf8'), 'OWNED OLD CHINESE');
        assert.equal((await fs.stat(ownedChinese, { bigint: true })).ino, ownedBefore.ino);
        assert.equal(
          (await fs.readdir(fixture.root)).some((file) =>
            /^ACG-album-(?:runtime|update)-(?:stage|backup)-/.test(file)
          ),
          false
        );
      }
    );
  }
}
for (const failure of ['delete-and-exit', 'missing-new-ownership']) {
  test(
    `Full Standard rollback restores original runtime after ${failure}`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = await temporary(t),
        directory = path.join(root, 'application');
      const executable = path.join(directory, 'ACG-album.exe');
      await fs.mkdir(path.join(directory, 'resources', 'fonts'), { recursive: true });
      await fs.writeFile(executable, 'ORIGINAL STANDARD');
      await fs.writeFile(path.join(directory, 'resources', 'fonts', 'font'), 'PRIVATE FONT');
      await writeOwnership(directory);
      const source = `$p=${decode({ mode: 'full', directory, executable, edition: 'standard', version })}\n${runtimeTransactionScript()}\n${editionTransactionScript()}
function Invoke-AlbumInstaller($mode) {
  Remove-Item -LiteralPath $p.directory -Recurse -Force
  ${failure === 'delete-and-exit' ? 'return @{ ExitCode=7 }' : "New-Item -ItemType Directory -Path $p.directory | Out-Null; [IO.File]::WriteAllText($p.executable,'NEW'); return @{ ExitCode=0 }"}
}
Install-AlbumEdition 'currentuser'`;
      const result = await runPowershell(root, source);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stderr,
        failure === 'delete-and-exit'
          ? /Installer failed with exit code 7/
          : /Runtime ownership is unavailable/
      );
      assert.equal(await fs.readFile(executable, 'utf8'), 'ORIGINAL STANDARD');
      assert.equal(
        await fs.readFile(path.join(directory, 'resources', 'fonts', 'font'), 'utf8'),
        'PRIVATE FONT'
      );
      await assertRuntimeOwnership(directory);
    }
  );
}

// Minimal stored ZIP writer for synthetic fixtures only. Never builds an app.
function zipFixture(entries) {
  let offset = 0;
  const chunks = [],
    central = [];
  const crc32 = (data) => {
    let crc = -1;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      data = Buffer.from(entry.data || 'NEW'),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names, as emitted by the production .NET ZIP writer.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(entry.link ? 0xa1ff0000 : 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}
async function runPowershell(root, source) {
  const file = path.join(root, 'synthetic-transaction.ps1');
  await fs.writeFile(file, '\uFEFF$ErrorActionPreference="Stop"\n' + source);
  const result = spawnSync(
    path.win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    ),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  );
  assert.equal(result.error, undefined);
  return result;
}
const decode = (value) =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}'))|ConvertFrom-Json`;
for (const variant of ['standard', 'lite', 'full'])
  for (const failure of ['', 'hash', 'traversal', 'link', 'after-switch']) {
    test(
      `actual PowerShell runtime ${variant}: ${failure || 'preserves index, fonts, full payload and profile'}`,
      { skip: process.platform !== 'win32' },
      async (t) => {
        const root = await temporary(t),
          directory = path.join(root, 'application');
        await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
        const executable = path.join(directory, 'ACG-album.exe');
        await fs.writeFile(executable, 'OLD');
        await fs.writeFile(path.join(directory, 'resources', 'old-runtime'), 'OLD');
        const oldUnicodeNames = [
          unicodeRuntimePaths[0],
          'resources/demo/旧版本（回滚）/旧照片😀.jpg'
        ];
        const oldUnicodeInodes = [];
        for (const name of oldUnicodeNames) {
          await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
          await fs.writeFile(path.join(directory, name), 'OLD CHINESE');
          oldUnicodeInodes.push((await fs.stat(path.join(directory, name), { bigint: true })).ino);
        }
        await fs.mkdir(path.join(directory, 'resources', 'fonts', 'founder-lanting-yuan'), {
          recursive: true
        });
        await fs.writeFile(path.join(directory, 'resources', 'fonts', 'old-font'), 'LOCAL FONT');
        for (const weight of FONT_WEIGHTS)
          await fs.writeFile(
            path.join(directory, 'resources', 'fonts', 'founder-lanting-yuan', weight + '.ttf'),
            weight + ' PRIVATE FONT'
          );
        const index = path.join(directory, 'resources', 'local-index');
        const identity =
          variant === 'standard' ? STANDARD_IDENTITY : await writeIndex(index, variant);
        const before =
          variant === 'standard'
            ? null
            : await fs.stat(path.join(index, 'subjects.sqlite'), { bigint: true });
        const profile = path.join(root, 'profile');
        await fs.mkdir(profile);
        await fs.writeFile(path.join(profile, 'token'), 'UNCHANGED');
        const value = manifest(identity);
        for (const name of unicodeRuntimePaths)
          value.files.push({ path: name, bytes: 3, sha256: hash('NEW') });
        const entries = runtimeEntries(value);
        await writeOwnership(directory);
        if (failure === 'hash') entries[0].data = 'BAD';
        if (failure === 'traversal') entries[0].path = '../escape';
        if (failure === 'link') entries[0].link = true;
        const installer = path.join(root, 'payload.zip');
        await fs.writeFile(installer, zipFixture(entries));
        const p = {
          directory,
          executable,
          installer,
          indexIdentity: identity,
          runtimeManifest: value,
          fontOverlay: []
        };
        const script = `$p=${decode(p)}\n${runtimeTransactionScript()}\n${failure === 'after-switch' ? "function Confirm-AlbumRuntimeFiles($directory) { if ($directory -eq $p.directory) { throw 'Injected post-switch failure' } }" : ''}\nInstall-AlbumRuntime`;
        const result = await runPowershell(root, script);
        assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
        if (failure)
          assert.match(
            result.stderr,
            failure === 'hash'
              ? /Runtime file verification failed/
              : failure === 'after-switch'
                ? /Injected post-switch failure/
                : /unexpected or linked entry/
          );
        assert.equal(await fs.readFile(executable, 'utf8'), failure ? 'OLD' : 'NEW');
        assert.equal(
          await fs.readFile(path.join(directory, 'resources', 'fonts', 'old-font'), 'utf8'),
          'LOCAL FONT'
        );
        for (const weight of FONT_WEIGHTS)
          assert.equal(
            await fs.readFile(
              path.join(directory, 'resources', 'fonts', 'founder-lanting-yuan', weight + '.ttf'),
              'utf8'
            ),
            weight + ' PRIVATE FONT'
          );
        assert.equal(await fs.readFile(path.join(profile, 'token'), 'utf8'), 'UNCHANGED');
        if (failure) {
          for (const [i, name] of oldUnicodeNames.entries()) {
            assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), 'OLD CHINESE');
            assert.equal(
              (await fs.stat(path.join(directory, name), { bigint: true })).ino,
              oldUnicodeInodes[i]
            );
          }
          await assertRuntimeOwnership(directory);
        } else {
          await assert.rejects(fs.stat(path.join(directory, oldUnicodeNames[1])), {
            code: 'ENOENT'
          });
        }
        if (variant !== 'standard') {
          assert.deepEqual(await bundledIndexIdentity(path.join(directory, 'resources')), identity);
          const after = await fs.stat(path.join(index, 'subjects.sqlite'), { bigint: true });
          assert.equal(after.ino, before.ino);
        } else await assert.rejects(fs.stat(index), { code: 'ENOENT' });
        if (!failure) {
          for (const row of value.files)
            assert.equal(hash(await fs.readFile(path.join(directory, row.path))), row.sha256);
          assert.equal(
            (await fs.readdir(root)).some((name) => name.startsWith('ACG-album-runtime-backup-')),
            false
          );
        }
      }
    );
  }

for (const failure of ['', 'changed-source', 'different-existing']) {
  test(
    `runtime preserves all five exact local fonts: ${failure || 'success'}`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = await temporary(t),
        directory = path.join(root, 'application');
      await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
      const executable = path.join(directory, 'ACG-album.exe');
      await fs.writeFile(executable, 'OLD');
      const sourceApp = path.join(root, 'source-app.asar');
      const folder = path.join(sourceApp, 'src', 'assets', 'fonts', 'founder-lanting-yuan');
      await fs.mkdir(folder, { recursive: true });
      for (const weight of FONT_WEIGHTS)
        await fs.writeFile(path.join(folder, weight + '.ttf'), weight + ' FONT');
      const fontOverlay = await prepareFontOverlay(sourceApp, root);
      if (failure === 'changed-source') await fs.writeFile(fontOverlay[0].source, 'CHANGED');
      const destination = path.join(directory, 'resources', 'fonts', 'founder-lanting-yuan');
      if (failure === 'different-existing') {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, 'regular.ttf'), 'OTHER');
      }
      const value = manifest(),
        installer = path.join(root, 'payload.zip');
      await writeOwnership(directory);
      await fs.writeFile(installer, zipFixture(runtimeEntries(value)));
      const result = await runPowershell(
        root,
        `$p=${decode({ directory, executable, installer, indexIdentity: STANDARD_IDENTITY, runtimeManifest: value, fontOverlay })}\n${runtimeTransactionScript()}\nInstall-AlbumRuntime`
      );
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      if (failure) {
        assert.match(result.stderr, /Local font overlay changed|Existing local font differs/);
        assert.equal(await fs.readFile(executable, 'utf8'), 'OLD');
      } else
        for (const weight of FONT_WEIGHTS)
          assert.equal(
            await fs.readFile(path.join(destination, weight + '.ttf'), 'utf8'),
            weight + ' FONT'
          );
    }
  );
}

test(
  'full installer failure restores original runtime, original index and local fonts',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await temporary(t),
      directory = path.join(root, 'application');
    await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
    const executable = path.join(directory, 'ACG-album.exe');
    await fs.writeFile(executable, 'OLD');
    const index = path.join(directory, 'resources', 'local-index');
    const identity = await writeIndex(index, 'full');
    const fonts = path.join(directory, 'resources', 'fonts');
    await fs.mkdir(fonts);
    await fs.writeFile(path.join(fonts, 'retained-font'), 'FONT');
    await writeOwnership(directory);
    const source = `$p=${decode({ mode: 'full', directory, executable, edition: 'lite', fontOverlay: [] })}\n${runtimeTransactionScript()}\n${editionTransactionScript()}
function Invoke-AlbumInstaller($mode) { [IO.File]::WriteAllText($p.executable,'BROKEN'); return @{ ExitCode=7 } }
Install-AlbumEdition 'currentuser'`;
    const result = await runPowershell(root, source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Installer failed with exit code 7/);
    assert.equal(await fs.readFile(executable, 'utf8'), 'OLD');
    assert.equal(await fs.readFile(path.join(fonts, 'retained-font'), 'utf8'), 'FONT');
    assert.deepEqual(await bundledIndexIdentity(path.join(directory, 'resources')), identity);
  }
);
