'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { officialDownloads } = require('../src/repository.cjs');
const { releaseAssets } = require('../src/update-release.cjs');
const { createUpdater, currentEdition } = require('../src/update-service.cjs');

const repository = 'GXinnnnnn/ACG-album';
const version = '1.2.3';
const name = `ACG-album-Setup-${version}-Full-universal.dmg`;
function asset(filename = name, overrides = {}) {
  return {
    name: filename,
    size: 123456,
    digest: 'sha256:' + 'a'.repeat(64),
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${filename}`,
    ...overrides
  };
}

function release(assets) {
  return { tag_name: `v${version}`, assets };
}

test('Mac official download exposes one universal Full DMG while retaining Windows links', () => {
  const mac = officialDownloads(version, 'darwin');
  assert.deepEqual(Object.keys(mac.downloads), ['full']);
  assert.equal(mac.downloads.full, asset().browser_download_url);
  assert.equal(mac.releaseUrl, `https://github.com/${repository}/releases/tag/v${version}`);
  assert.match(officialDownloads(version).downloads.full, /-Full\.exe$/);
  assert.deepEqual(officialDownloads(version, 'linux').downloads, {});
});

test('Mac release selection ignores all Windows installers and runtime metadata', () => {
  const assets = [
    asset(),
    asset(`ACG-album-Setup-${version}-Full.exe`),
    asset(`ACG-album-Setup-${version}-Lite.exe`),
    asset(`ACG-album-Runtime-${version}-win32-x64.manifest.json`),
    asset(`ACG-album-Runtime-${version}-win32-x64.zip`)
  ];
  const mac = releaseAssets(release(assets), repository, version, { platform: 'darwin' });
  assert.equal(mac.length, 1);
  assert.equal(mac[0].edition, 'full');
  assert.equal(mac[0].name, name);
  assert.equal(mac[0].sha256, 'a'.repeat(64));
  assert.equal(mac[0].verifiable, true);
  assert(releaseAssets(release(assets), repository, version).every((x) => x.name !== name));
});

test('Mac release still rejects ambiguous names, foreign URLs and invalid sizes', () => {
  for (const assets of [
    [asset(), asset()],
    [asset(name, { browser_download_url: 'https://example.com/' + name })],
    [asset(name, { size: 0 })],
    [asset(name, { size: Number.MAX_SAFE_INTEGER })],
    [
      asset(name, {
        browser_download_url: asset().browser_download_url.replace('/v1.2.3/', '/v1.2.4/')
      })
    ]
  ]) {
    assert.deepEqual(
      releaseAssets(release(assets), repository, version, { platform: 'darwin' }),
      []
    );
  }
});

test('Mac updater never fetches Windows runtime metadata or starts download/install work', async () => {
  let network = 0;
  let library = 0;
  let exits = 0;
  const updater = createUpdater({
    app: { getVersion: () => version, quit: () => exits++ },
    platform: 'darwin',
    arch: 'arm64',
    fetch: async () => {
      network++;
      throw new Error('Unexpected network');
    },
    getLibrary: async () => {
      library++;
      throw new Error('Unexpected database');
    }
  });
  const available = await updater.setRelease({
    status: 'available',
    repository,
    latestVersion: '1.2.4',
    assets: [
      asset(),
      asset('ACG-album-Setup-1.2.4-Full.exe'),
      {
        kind: 'runtime-manifest',
        url: 'https://github.com/unexpected-windows-runtime'
      }
    ]
  });
  assert.equal(available.runtime, null);
  assert.match(available.runtimeReason, /Mac/);
  assert.equal(available.assets.length, 1);
  assert.equal(available.assets[0].name, name);
  await assert.rejects(updater.download({ edition: 'full' }), /发布页.*完整包/);
  await assert.rejects(updater.install({ confirm: true, edition: 'full' }), /发布页.*完整包/);
  assert.deepEqual({ network, library, exits }, { network: 0, library: 0, exits: 0 });
});

function macFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acg-mac-edition-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = path.join(root, 'ACG-album.app', 'Contents');
  const executable = path.join(contents, 'MacOS', 'ACG-album');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(resources);
  fs.writeFileSync(executable, 'NOT AN EXECUTABLE');
  const app = {
    isPackaged: true,
    getPath: (key) => {
      if (key !== 'exe') throw new Error('Unexpected app path');
      return executable;
    }
  };
  return { contents, resources, executable, app };
}

test('Mac edition is read from real Contents/Resources rather than an executable-side directory', (t) => {
  const fixture = macFixture(t);
  const index = path.join(fixture.resources, 'local-index');
  fs.mkdirSync(index);
  const bytes = Buffer.from('fixture');
  fs.writeFileSync(path.join(index, 'subjects.sqlite'), bytes);
  const manifest = {
    manifestVersion: 1,
    bundled: true,
    variant: 'full',
    database: 'subjects.sqlite',
    dataVersion: 'mac-test-v1',
    readerSchemaVersion: 1,
    bytes: bytes.length,
    sha256: 'a'.repeat(64)
  };
  const manifestFile = path.join(index, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal(currentEdition(fixture.app, { platform: 'darwin' }), 'full');
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, bytes: bytes.length + 1 }));
  assert.equal(currentEdition(fixture.app, { platform: 'darwin' }), null);
  fs.writeFileSync(manifestFile, '{');
  assert.equal(currentEdition(fixture.app, { platform: 'darwin' }), null);
});

test('Mac edition proves absent index only beneath real bundle parents', (t) => {
  const fixture = macFixture(t);
  assert.equal(currentEdition(fixture.app, { platform: 'darwin' }), 'standard');
  assert.equal(
    currentEdition(
      { isPackaged: true, getPath: () => path.join(path.dirname(fixture.contents), 'ACG-album') },
      { platform: 'darwin' }
    ),
    null
  );
  fs.rmSync(fixture.resources, { recursive: true });
  assert.equal(currentEdition(fixture.app, { platform: 'darwin' }), null);
});
