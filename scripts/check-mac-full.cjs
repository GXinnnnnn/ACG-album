'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  FULL,
  run,
  runCli,
  digest,
  download,
  validateManifest,
  asarTool,
  binaryKind,
  walkFiles
} = require('./mac-support.cjs');
const { licensedFont } = require('./public-font-package.cjs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { verifyNativeSources } = require('./mac-native-sources.cjs');
const { detachMacVolume } = require('./mac-volume-detach.cjs');
const HEIC = Object.freeze({
  url: 'https://raw.githubusercontent.com/strukturag/libheif/v1.19.8/examples/example.heic',
  bytes: 718114,
  sha256: '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2',
  rgbaSha256: '7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b'
});

function parseMachOMinimumOS(output, architecture, maximum = '12.0') {
  assert.ok(['arm64', 'x86_64'].includes(architecture), 'Unexpected Mach-O architecture');
  const versionParts = (value) => {
    assert.match(value, /^[1-9]\d*(?:\.(?:0|[1-9]\d*)){0,2}$/, 'Malformed macOS version: ' + value);
    const parts = value.split('.').map((part) => BigInt(part));
    while (parts.length < 3) parts.push(0n);
    return parts;
  };
  const maximumParts = versionParts(maximum);
  const headers = [...output.matchAll(/^.*\(architecture ([^)]+)\):\s*$/gm)];
  assert.ok(headers.length <= 1, 'Expected output for exactly one Mach-O slice');
  if (headers.length) assert.equal(headers[0][1], architecture, 'Mach-O slice header mismatch');
  const minimumCommands = [];
  for (const block of output.split(/^Load command \d+\s*$/m).slice(1)) {
    const field = (name) => {
      const lines = block
        .split(/\r?\n/)
        .filter((line) => new RegExp('^\\s*' + name + '(?:\\s|$)').test(line));
      assert.equal(lines.length, 1, 'Expected exactly one ' + name + ' field');
      const tokens = lines[0].trim().split(/\s+/);
      assert.equal(tokens.length, 2, 'Malformed ' + name + ' field');
      return tokens[1];
    };
    const loadCommand = field('cmd');
    if (!['LC_BUILD_VERSION', 'LC_VERSION_MIN_MACOSX'].includes(loadCommand)) continue;
    const versionField = loadCommand === 'LC_BUILD_VERSION' ? 'minos' : 'version';
    if (loadCommand === 'LC_BUILD_VERSION') {
      const platform = field('platform');
      assert.ok(
        ['1', 'MACOS', 'macos'].includes(platform),
        'LC_BUILD_VERSION platform is not macOS: ' + platform
      );
    }
    const version = field(versionField);
    const parts = versionParts(version);
    const difference = parts.findIndex((part, index) => part !== maximumParts[index]);
    assert.ok(
      difference === -1 || parts[difference] < maximumParts[difference],
      `Mach-O ${architecture} ${loadCommand} minimum macOS ${version} exceeds ${maximum}`
    );
    minimumCommands.push({ architecture, loadCommand, platform: 'macos', versionField, version });
  }
  assert.equal(
    minimumCommands.length,
    1,
    'Expected exactly one minimum macOS load command per slice'
  );
  return minimumCommands[0];
}

function readMachOMinimumOS(filename, architecture, runTool = run) {
  // -m treats literal parentheses as filename characters, not archive(member) syntax.
  const args = ['-m', '-arch', architecture, '-l', filename];
  return { ...parseMachOMinimumOS(runTool('otool', args), architecture), tool: 'otool', args };
}

function assertMacContentsLayout(entries) {
  const allowed = new Set([
    'Info.plist',
    'PkgInfo',
    'MacOS',
    'Resources',
    'Frameworks',
    'SharedFrameworks',
    'SharedSupport',
    'PlugIns',
    'XPCServices',
    'Helpers',
    'Library',
    '_CodeSignature',
    '_MASReceipt',
    'embedded.provisionprofile'
  ]);
  for (const name of entries)
    assert.ok(
      allowed.has(name),
      'Nonstandard macOS Contents entry; static data belongs in Resources: ' + name
    );
}

async function inspectApp(appPath) {
  assertMacContentsLayout(await fsp.readdir(path.join(appPath, 'Contents')));
  const resources = path.join(appPath, 'Contents', 'Resources');
  const archive = path.join(resources, 'app.asar');
  const index = path.join(resources, 'local-index', 'subjects.sqlite');
  const manifest = validateManifest(
    JSON.parse(await fsp.readFile(path.join(resources, 'local-index', 'manifest.json'), 'utf8'))
  );
  assert.equal((await fsp.stat(index)).size, FULL.bytes);
  assert.equal(await digest(index), FULL.sha256);
  const asar = asarTool();
  const entries = asar
    .listPackage(archive)
    .map((name) => name.replace(/^\//, '').replaceAll('\\', '/'));
  assert.ok(
    !entries.some((name) => /\.sqlite(?:$|-)/i.test(name)),
    'Full database must be outside ASAR'
  );
  const fonts = entries.filter((name) => /\.(?:ttf|otf|woff2?|ttc|otc|eot)$/i.test(name));
  assert.deepEqual(fonts, [licensedFont.path]);
  for (const [name, expected] of [
    [licensedFont.path, licensedFont.sha256],
    [licensedFont.licensePath, licensedFont.licenseSha256]
  ])
    assert.equal(
      crypto.createHash('sha256').update(asar.extractFile(archive, name)).digest('hex'),
      expected
    );
  for (const filename of [
    'LICENSE.app.txt',
    'README.md',
    'docs/THIRD_PARTY_NOTICES.md',
    'docs/LOCAL_SEARCH_DATA.md'
  ])
    assert.ok(
      (await fsp.stat(path.join(resources, filename))).size > 0,
      'Missing distribution notice: ' + filename
    );
  const licenseDirectory = path.join(resources, 'licenses', 'mac-runtime');
  const licenses = JSON.parse(
    await fsp.readFile(path.join(licenseDirectory, 'manifest.json'), 'utf8')
  );
  assert.equal(licenses.packages.length, 9);
  for (const row of licenses.packages) {
    assert.ok(
      row.files.some((entry) =>
        /^(?:licen[cs]e|notice|copying|copyright)(?:[.-]|$)/i.test(entry.file)
      )
    );
    for (const entry of row.files)
      assert.equal(
        await digest(path.join(licenseDirectory, row.name.replaceAll('/', '__'), entry.file)),
        entry.sha256
      );
  }
  const nativeSources = await verifyNativeSources(resources);
  const codecDirectory = path.join(resources, 'codecs', 'libheif');
  const codec = JSON.parse(
    await fsp.readFile(path.join(codecDirectory, 'PROVENANCE.json'), 'utf8')
  );
  for (const row of codec.runtime) {
    assert.equal(await digest(path.join(codecDirectory, row.file)), row.sha256, row.file);
    assert.equal((await fsp.stat(path.join(codecDirectory, row.file))).size, row.bytes, row.file);
  }
  assert.equal(codec.sources.length, 4);
  for (const row of codec.sources)
    assert.equal(
      await digest(path.join(codecDirectory, 'sources', row.includedArchive)),
      row.includedSha256,
      row.includedArchive
    );
  assert.ok(
    entries.includes('src/native/macos-rename.c'),
    'Helper corresponding source is bundled'
  );
  const minimumSystemVersion = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :LSMinimumSystemVersion',
    path.join(appPath, 'Contents', 'Info.plist')
  ]);
  assert.equal(minimumSystemVersion, '12.0');
  const packageInfo = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(packageInfo.searchEdition, 'full');
  assert.equal(packageInfo.version, FULL.version);
  for (const entry of entries) {
    if (asar.statFile(archive, entry).files || asar.statFile(archive, entry).link) continue;
    assert.notEqual(
      binaryKind(asar.extractFile(archive, entry).subarray(0, 4)),
      'pe',
      'Windows PE in ASAR: ' + entry
    );
    assert.ok(
      !/node_modules\/@img\/.*(?:win32|linux)/.test(entry),
      'Foreign sharp package: ' + entry
    );
  }
  const files = await walkFiles(appPath);
  const databases = files.filter((name) => /\.sqlite$/i.test(name));
  assert.deepEqual(databases, [index], 'Exactly one Full SQLite database in final application');
  const macho = [];
  for (const filename of files) {
    const handle = await fsp.open(filename, 'r');
    const header = Buffer.alloc(4);
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    assert.notEqual(binaryKind(header), 'pe', 'Windows PE in mac runtime: ' + filename);
    if (/\.(?:ttf|otf|woff2?|ttc|otc|eot)$/i.test(filename))
      throw new Error('Unexpected unpacked font: ' + filename);
    if (binaryKind(header) !== 'macho') continue;
    const relative = path.relative(appPath, filename).replaceAll('\\', '/');
    const architectures = run('lipo', ['-archs', filename]).split(/\s+/).sort();
    const native = relative.match(
      /\/node_modules\/@img\/(?:sharp|sharp-libvips)-darwin-(arm64|x64)\//
    );
    assert.deepEqual(
      architectures,
      native ? [native[1] === 'x64' ? 'x86_64' : 'arm64'] : ['arm64', 'x86_64'],
      relative
    );
    const minimumOS = architectures.map((architecture) => {
      try {
        return readMachOMinimumOS(filename, architecture);
      } catch (error) {
        throw new Error(
          `Minimum macOS check failed for ${relative} [${architecture}]: ${error.message}`,
          { cause: error }
        );
      }
    });
    macho.push({ path: relative, architectures, minimumOS });
  }
  for (const arch of ['arm64', 'x64']) {
    assert.ok(
      macho.some((row) => row.path.includes(`/sharp-darwin-${arch}/`) && row.path.endsWith('.node'))
    );
    assert.ok(
      macho.some(
        (row) => row.path.includes(`/sharp-libvips-darwin-${arch}/`) && row.path.endsWith('.dylib')
      )
    );
  }
  assert.ok(macho.some((row) => row.path === 'Contents/MacOS/ACG-album'));
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  assert.ok(macho.some((row) => row.path === 'Contents/Resources/bin/acg-fs-rename'));
  run('codesign', ['--verify', '--strict', path.join(resources, 'bin', 'acg-fs-rename')]);
  return {
    manifest,
    index,
    resources,
    macho,
    fonts,
    nativeSources,
    heicCodec: { version: codec.version, sources: codec.sources.length },
    minimumSystemVersion,
    adHocSignatureVerified: true
  };
}

async function helperProbe(resources, evidence, arch) {
  const directory = path.join(evidence, 'rename-helper');
  await fsp.mkdir(directory);
  const helper = path.join(resources, 'bin', 'acg-fs-rename');
  const identity = (stat) =>
    `${stat.isDirectory() ? 'd' : 'f'}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  const results = [];
  for (const kind of ['file', 'directory']) {
    const source = path.join(directory, kind + '-source');
    const destination = path.join(directory, kind + '-renamed');
    if (kind === 'file') await fsp.writeFile(source, 'original source bytes');
    else await fsp.mkdir(source);
    const st = await fsp.lstat(source, { bigint: true });
    const parentIdentity = identity(await fsp.lstat(directory, { bigint: true }));
    const invoke = (from, to, sourceIdentity) => {
      const result = spawnSync(
        '/usr/bin/arch',
        [
          arch === 'x64' ? '-x86_64' : '-arm64',
          helper,
          from,
          to,
          kind,
          sourceIdentity,
          parentIdentity
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      return { exitCode: result.status, response: JSON.parse(result.stdout.trim()) };
    };
    const success = invoke(source, destination, identity(st));
    assert.equal(success.exitCode, 0);
    assert.equal(success.response.ok, true);
    assert.equal(identity(await fsp.lstat(destination, { bigint: true })), identity(st));
    await assert.rejects(fsp.lstat(source), { code: 'ENOENT' });
    if (kind === 'file') await fsp.writeFile(source, 'collision survivor');
    else await fsp.mkdir(source);
    const collisionIdentity = identity(await fsp.lstat(source, { bigint: true }));
    const collision = invoke(source, destination, collisionIdentity);
    assert.equal(collision.exitCode, 1);
    assert.equal(collision.response.ok, false);
    assert.equal(collision.response.code, 'EEXIST');
    assert.equal(identity(await fsp.lstat(source, { bigint: true })), collisionIdentity);
    assert.equal(identity(await fsp.lstat(destination, { bigint: true })), identity(st));
    if (kind === 'file') {
      assert.equal(await fsp.readFile(source, 'utf8'), 'collision survivor');
      assert.equal(await fsp.readFile(destination, 'utf8'), 'original source bytes');
    }
    results.push({ kind, success, collision, noOverwriteVerified: true });
  }
  return { nativeArch: arch, results };
}

function nativeProbe(executable, resources, arch, fixture, importImage) {
  const script = `
    (async () => {
      const assert = require('node:assert/strict');
      const path = require('node:path');
      const { createRequire } = require('node:module');
      const load = createRequire(path.join(${JSON.stringify(resources)}, 'app.asar', 'package.json'));
      assert.equal(process.arch, ${JSON.stringify(arch)});
      assert.equal(process.versions.electron, '40.10.6');
      const sharp = load('sharp');
      assert.equal(sharp.versions.sharp, '0.34.5');
      const input = await sharp({create:{width:32,height:48,channels:3,background:'#e8b9cc'}}).png().toBuffer();
      for (const format of ['jpeg','webp','png']) {
        const data = await sharp(input).resize(16,24).toFormat(format).toBuffer();
        const meta = await sharp(data).metadata();
        assert.equal(meta.width, 16); assert.equal(meta.height, 24);
      }
      await require('node:fs/promises').writeFile(${JSON.stringify(importImage)}, input);
      const decoder = load('./src/heif-decoder.cjs').createHeifDecoder({codecDirectory:path.join(${JSON.stringify(resources)}, 'codecs', 'libheif')});
      try {
        const heic = await require('node:fs/promises').readFile(${JSON.stringify(fixture)});
        const rgba = await decoder.decode(heic, {maxBytes:1024*1024,maxPixels:160000000,firstFrame:true});
        assert.deepEqual([rgba.width,rgba.height,rgba.channels,rgba.data.length],[1280,854,4,4372480]);
        assert.equal(require('node:crypto').createHash('sha256').update(rgba.data).digest('hex'), ${JSON.stringify(HEIC.rgbaSha256)});
      } finally { await decoder.stop(); }
      const systemFonts = await load('./src/fonts.cjs').createSystemFonts({platform:'darwin'}).list();
      assert.equal(systemFonts.source, 'macos-installed-fonts');
      assert.ok(systemFonts.families.length > 0, 'Real system_profiler must return installed font families');
      const local = load('./src/local-index.cjs').createLocalIndex({resourcesPath:${JSON.stringify(resources)}});
      assert.equal(local.status().available, true, JSON.stringify(local.status()));
      const queries = [
        {query:'千恋＊万花',kind:'subject',types:[4],id:172612},
        {query:'AIR',kind:'subject',types:[4],id:232},
        {query:'朝武芳乃',kind:'character',subjectId:172612,id:39360},
        {query:'こぶいち',kind:'person',subjectId:172612,id:5795}
      ];
      for (const {id,...query} of queries) {
        const result = local.search(query);
        assert.equal(result.available, true);
        const found = result.candidates.find(item=>item.id===id);
        assert.ok(found, JSON.stringify(result));
        if (id===172612) assert.ok(found.summary.length>20);
      }
      console.log(JSON.stringify({arch:process.arch,electron:process.versions.electron,node:process.versions.node,
        sharp:sharp.versions,systemFonts:{source:systemFonts.source,count:systemFonts.families.length},formats:['jpeg','webp','png'],heic:{width:1280,height:854,channels:4,rgbaSha256:${JSON.stringify(HEIC.rgbaSha256)}},queries:queries.map(row=>row.id)}));
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const name of ['ACG_DATA_DIR', 'ACG_USER_DATA_DIR', 'ACG_LOCAL_INDEX_PATH'])
    delete env[name];
  const output = run(
    '/usr/bin/arch',
    [arch === 'x64' ? '-x86_64' : '-arm64', executable, '-e', script],
    { env, timeout: 120_000 }
  );
  return JSON.parse(output.split(/\r?\n/).at(-1));
}

async function guiSmoke(executable, index, evidence, arch, importRoot, originalAlbum) {
  const { _electron } = require('@playwright/test');
  const profile = path.join(evidence, 'isolated-profile');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ACG_LOCAL_INDEX_PATH;
  const before = await fsp.stat(index);
  const errors = [];
  let app;
  let exitPromise;
  let result;
  try {
    app = await _electron.launch({
      executablePath: executable,
      env,
      timeout: 90_000,
      args: ['--host-resolver-rules=MAP * ~NOTFOUND']
    });
    exitPromise = once(app.process(), 'exit');
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, done) => done({ cancel: true })
      );
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await app.context().setOffline(true);
    await page.waitForSelector('#local-search-button', { timeout: 90_000 });
    const runtime = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      arch: process.arch,
      userData: app.getPath('userData')
    }));
    assert.equal(runtime.version, FULL.version);
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.arch, arch);
    assert.equal(runtime.userData, path.join(profile, 'chromium-profile'));
    await page.waitForSelector('#modal[open] #settings-panel-metadata:not([hidden])', {
      timeout: 60_000
    });
    await page.click('#modal-close');
    const status = await page.evaluate(() => window.album.call('localIndexStatus'));
    assert.equal(status.available, true, JSON.stringify(status));
    assert.equal(status.variant, 'full');
    assert.equal(status.path, index);
    const library = await page.evaluate(
      async ({ importRoot, originalAlbum }) => {
        await window.album.call('settings', { key: 'autoMatch', value: false });
        const scan = await window.album.call('scan', {
          path: importRoot,
          offline: true,
          onlineMatch: false,
          directoryKind: 'photo'
        });
        if (scan.errors) throw new Error(JSON.stringify(scan));
        const before = await window.album.call('get', { path: originalAlbum });
        if (!before || before.kind !== 'folder') throw new Error('Imported album not found');
        await window.album.call('patch', { id: before.id, changes: { favorite: 1 } });
        const rename = await window.album.call('rename', { id: before.id, name: 'Renamed Album' });
        const after = await window.album.call('get', { id: rename.id });
        const favorites = await window.album.call('list', { favorites: true });
        return { scan, before, rename, after, favorites };
      },
      { importRoot, originalAlbum }
    );
    assert.equal(library.scan.errors, 0);
    assert.equal(library.after.name, 'Renamed Album');
    assert.equal(library.after.favorite, 1, 'Favorite survives path ID remapping');
    assert.notEqual(library.after.id, library.before.id);
    assert.equal(
      await digest(path.join(library.after.path, 'photo.png')),
      await digest(path.join(evidence, 'original-photo.png'))
    );
    await assert.rejects(fsp.lstat(originalAlbum), { code: 'ENOENT' });
    assert.ok(JSON.stringify(library.favorites).includes(library.after.id));
    await page.screenshot({ path: path.join(evidence, 'offline-import-rename-favorite.png') });
    await page.click('#local-search-button');
    await page.waitForSelector('#local-search-dialog[open]');
    await page.locator('#local-search-source').filter({ hasText: '完整检索' }).waitFor();
    await page.selectOption('#local-search-type', '4', { force: true });
    await page.fill('#local-search-query', '千恋＊万花');
    await page.click('#local-search-submit');
    await page.waitForSelector('[data-local-result-id="172612"]');
    await page.click('[data-local-result-id="172612"] .local-search-summary summary');
    assert.ok(
      (await page.locator('[data-local-result-id="172612"] .local-search-summary p').innerText())
        .length > 20
    );
    await page.screenshot({ path: path.join(evidence, 'offline-full-subject.png') });
    for (const input of [
      { kind: 'character', query: '朝武芳乃', id: 39360 },
      { kind: 'person', query: 'こぶいち', id: 5795 }
    ]) {
      await page.selectOption('#local-search-kind', input.kind, { force: true });
      await page.fill('#local-search-subject', '172612');
      await page.fill('#local-search-query', input.query);
      await page.click('#local-search-submit');
      await page.waitForSelector(`[data-local-result-id="${input.id}"]`);
    }
    await page.screenshot({ path: path.join(evidence, 'offline-full-person.png') });
    assert.deepEqual(errors, []);
    result = {
      runtime,
      status,
      library,
      offlineRenderer: true,
      blockedHttpSession: true,
      checks: [
        'offline import, atomic folder rename and favorite preservation',
        'Full subject summary',
        'subject-filtered character and person GUI queries',
        'no renderer errors'
      ]
    };
  } finally {
    if (app) {
      await app.close();
      const [exitCode, signal] = await exitPromise;
      assert.equal(exitCode, 0, 'Owned packaged application must quit normally');
      assert.equal(signal, null, 'Owned packaged application must not require termination');
      if (result) result.ownedProcessExit = { exitCode, signal };
    }
    const after = await fsp.stat(index);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  }
  return result;
}

async function main() {
  assert.equal(process.platform, 'darwin', 'A native macOS runner is required');
  const arch = process.env.ACG_MAC_EXPECT_ARCH;
  assert.ok(
    ['arm64', 'x64'].includes(arch),
    'Set ACG_MAC_EXPECT_ARCH to the native runner architecture'
  );
  assert.equal(
    process.arch,
    arch,
    'Native host architecture must match; Rosetta is not native arm64 acceptance'
  );
  const directory = path.resolve(
    process.env.ACG_MAC_OUTPUT || path.join(__dirname, '..', 'release', 'mac-' + FULL.version)
  );
  const dmg = path.join(directory, `ACG-album-Setup-${FULL.version}-Full-universal.dmg`);
  const report = JSON.parse(await fsp.readFile(path.join(directory, 'build-report.json'), 'utf8'));
  assert.equal(await digest(dmg), report.sha256);
  const expectedLine = `${report.sha256}  ${path.basename(dmg)}\n`;
  assert.equal(
    await fsp.readFile(path.join(directory, 'SHA256SUMS.mac.txt'), 'utf8'),
    expectedLine
  );
  const evidence = path.resolve(
    process.env.ACG_MAC_EVIDENCE || path.join(directory, `verification-${arch}`)
  );
  await fsp.mkdir(evidence, { recursive: false });
  const mount = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'acg-mac-dmg-')));
  let mounted = false;
  let pendingError;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    const appPath = path.join(mount, 'ACG-album.app');
    const inspection = await inspectApp(appPath);
    const executable = path.join(appPath, 'Contents', 'MacOS', 'ACG-album');
    const helper = await helperProbe(inspection.resources, evidence, arch);
    const fixture = path.join(evidence, 'public-example.heic');
    await download(HEIC.url, fixture, HEIC.sha256);
    assert.equal((await fsp.stat(fixture)).size, HEIC.bytes);
    const importRoot = path.join(evidence, 'import-media');
    const originalAlbum = path.join(importRoot, 'Original Album');
    await fsp.mkdir(originalAlbum, { recursive: true });
    const importImage = path.join(evidence, 'original-photo.png');
    const probe = nativeProbe(executable, inspection.resources, arch, fixture, importImage);
    await fsp.copyFile(importImage, path.join(originalAlbum, 'photo.png'));
    const gui = await guiSmoke(
      executable,
      inspection.index,
      evidence,
      arch,
      importRoot,
      originalAlbum
    );
    const result = {
      ok: true,
      createdAt: new Date().toISOString(),
      nativeArch: arch,
      macOS: run('sw_vers', ['-productVersion']),
      dmg: path.basename(dmg),
      sha256: report.sha256,
      sourceCommit: report.sourceCommit,
      signing: report.signing,
      notarized: report.notarized,
      inspection,
      helper,
      probe,
      gui,
      databaseUnchanged: true
    };
    await fsp.writeFile(path.join(evidence, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    pendingError = error;
    await fsp.writeFile(
      path.join(evidence, 'error.json'),
      JSON.stringify({ error: error.stack || String(error) }, null, 2) + '\n'
    );
    throw error;
  } finally {
    if (mounted) await detachMacVolume(mount, { pendingError });
  }
}

if (require.main === module) runCli(main);
module.exports = {
  parseMachOMinimumOS,
  readMachOMinimumOS,
  assertMacContentsLayout,
  inspectApp,
  nativeProbe,
  guiSmoke,
  main
};
