'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  releaseAssets,
  checksumFor,
  readLimited,
  fetchAsset
} = require('../src/update-release.cjs');
const { createUpdater } = require('../src/update-service.cjs');
const { makeRuntimeOwnership, OWNERSHIP_PATH } = require('../src/runtime-update.cjs');
const { installationPlan, helperScript, launchInstaller } = require('../src/update-install.cjs');
const payload = Buffer.from('MZ test fixture only; never execute');
const digest = crypto.createHash('sha256').update(payload).digest('hex');
const repository = 'fixture-owner/fixture-repo';
const version = '1.2.0';
function release({ tag = 'v1.2.0', checksum = false } = {}) {
  const rows = ['Standard', 'Lite', 'Full'].flatMap((label) => {
    const name = `ACG-album-Setup-${version}-${label}.exe`;
    const asset = (name, size) => ({
      name,
      size,
      browser_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`
    });
    return checksum
      ? [asset(name, payload.length), asset(name + '.sha256', 64)]
      : [{ ...asset(name, payload.length), digest: 'sha256:' + digest }];
  });
  return { tag_name: tag, assets: rows };
}
const offer = (options) => ({
  repository,
  latestVersion: version,
  status: 'available',
  assets: releaseAssets(release(options), repository, version)
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'album-updater-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    exe: path.join(root, 'Program Files 相册', 'ACG-album.exe'),
    userData: path.join(root, 'custom profile 用户'),
    data: path.join(root, 'library')
  };
  for (const directory of [path.dirname(paths.exe), paths.userData, paths.data])
    await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(paths.exe, 'do not run');
  await fs.mkdir(path.join(path.dirname(paths.exe), 'resources'));
  await fs.writeFile(
    path.join(path.dirname(paths.exe), OWNERSHIP_PATH),
    JSON.stringify(
      makeRuntimeOwnership({
        version: '1.2.1',
        files: [
          {
            path: 'ACG-album.exe',
            bytes: 10,
            sha256: crypto.createHash('sha256').update('do not run').digest('hex')
          }
        ]
      })
    )
  );
  await fs.writeFile(path.join(paths.data, 'library.sqlite'), 'roots/token/profile sentinel');
  const events = [],
    launches = [];
  let repo = repository,
    roots = [],
    quits = 0;
  const app = { isPackaged: true, getPath: (name) => paths[name], quit: () => quits++ };
  const service = createUpdater({
    app,
    getLibrary: async () => ({ settings: { githubRepository: repo }, dataDir: paths.data, roots }),
    preflight: async () => {},
    fetch: async (url) => new Response(url.endsWith('.sha256') ? digest : payload),
    platform: 'win32',
    arch: 'x64',
    testMode: false,
    tempDirectory: root,
    notify: (event) => events.push(event),
    launch: async (plan) => launches.push(plan),
    ...options
  });
  service.setRelease(offer());
  return {
    service,
    root,
    paths,
    events,
    launches,
    app,
    setRoots: (value) => {
      roots = value;
    },
    setRepository: (value) => {
      repo = value;
    },
    quits: () => quits
  };
}

test('cancellation on verifying never publishes ready or keeps an installable file and permits retry', async (t) => {
  let service,
    cancelOnce = true;
  const events = [];
  const fixtureResult = await fixture(t, {
    notify: (event) => {
      events.push(event);
      if (cancelOnce && event.phase === 'verifying') {
        cancelOnce = false;
        service.cancel();
      }
    }
  });
  service = fixtureResult.service;
  await assert.rejects(service.download({ edition: 'standard' }), { code: 'UPDATE_CANCELLED' });
  assert.equal(service.snapshot().phase, 'cancelled');
  assert.equal(
    events.some((event) => event.phase === 'ready'),
    false
  );
  assert.equal(
    (await fs.readdir(fixtureResult.root)).some((name) => name.startsWith('ACG-album-update-')),
    false
  );
  await assert.rejects(
    service.install({ confirm: true, repository, version, edition: 'standard' }),
    /先完成下载/
  );
  assert.equal((await service.download({ edition: 'standard' })).phase, 'ready');
});

for (const point of ['write', 'reader-cancel', 'close', 'rename']) {
  test(`cancel after awaited ${point} cannot commit a ready download and permits retry`, async (t) => {
    let service,
      armed = true;
    const cancel = () => {
      if (armed) {
        armed = false;
        service.cancel();
      }
    };
    const fixtureResult = await fixture(t, {
      fetch: async () => {
        const response = new Response(payload);
        if (point === 'reader-cancel') {
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = () => {
            const reader = getReader();
            return {
              read: reader.read.bind(reader),
              releaseLock: reader.releaseLock.bind(reader),
              cancel: async () => {
                await reader.cancel();
                cancel();
              }
            };
          };
        }
        return response;
      }
    });
    service = fixtureResult.service;
    const originalOpen = fs.open,
      originalRename = fs.rename;
    try {
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (path.basename(args[0]) !== 'installer.part') return handle;
        return {
          writeFile: async (bytes) => {
            await handle.writeFile(bytes);
            if (point === 'write') cancel();
          },
          close: async () => {
            await handle.close();
            if (point === 'close') cancel();
          }
        };
      };
      fs.rename = async (...args) => {
        await originalRename(...args);
        if (point === 'rename') cancel();
      };
      await assert.rejects(service.download({ edition: 'standard' }), { code: 'UPDATE_CANCELLED' });
      assert.equal(service.snapshot().phase, 'cancelled');
      assert.equal(
        fixtureResult.events.some((event) => event.phase === 'ready'),
        false
      );
      assert.equal(
        (await fs.readdir(fixtureResult.root)).some((name) => name.startsWith('ACG-album-update-')),
        false
      );
      await assert.rejects(
        service.install({ confirm: true, repository, version, edition: 'standard' }),
        /先完成下载/
      );
      assert.equal((await service.download({ edition: 'standard' })).phase, 'ready');
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
    }
  });
}

test('unknown edition from info and empty IPC edition cannot start an implicit Standard download', async (t) => {
  let networkCalls = 0;
  const h = await fixture(t, {
    fetch: async () => {
      networkCalls++;
      return new Response(payload);
    }
  });
  const index = path.join(path.dirname(h.paths.exe), 'resources', 'local-index');
  await fs.mkdir(index);
  await fs.writeFile(path.join(index, 'manifest.json'), '{broken');
  assert.equal((await h.service.info()).currentEdition, null);
  const originalEntries = await fs.readdir(h.root);
  for (const edition of [null, undefined, '', 'STANDARD', 'unsupported'])
    await assert.rejects(h.service.download({ edition }), /版型|选择/);
  await assert.rejects(h.service.download(), /版型|选择/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(await fs.readdir(h.root), originalEntries);
  assert.equal(h.service.snapshot().phase, 'idle');
  assert.equal(h.launches.length, 0);
  const result = await h.service.download({ edition: 'full', mode: 'full' });
  assert.equal(result.edition, 'full');
  assert.equal(networkCalls, 1);
});

test('actual latest assets select all three editions and retain supported release tag formats', () => {
  for (const tag of ['v1.2.0', 'release/1.2.0', 'release-1.2.0', '1.2.0+build.7']) {
    const assets = releaseAssets(release({ tag }), repository, version);
    assert.deepEqual(
      assets.map((asset) => asset.edition),
      ['standard', 'lite', 'full']
    );
    assert.ok(assets.every((asset) => asset.verifiable && asset.sha256 === digest));
  }
  const old = release();
  old.assets.forEach((asset) => {
    delete asset.digest;
  });
  assert.ok(releaseAssets(old, repository, version).every((asset) => !asset.verifiable));
  assert.ok(
    releaseAssets(release({ checksum: true }), repository, version).every(
      (asset) => asset.verifiable
    )
  );
});

test('duplicate, missing, wrong-version, traversal, foreign and oversized assets are not guessed', () => {
  for (const mutate of [
    (value) => value.assets.push(value.assets[0]),
    (value) => {
      value.assets[0].name = 'ACG-album-Setup-1.1.0-Standard.exe';
    },
    (value) => {
      value.assets[0].browser_download_url = 'https://evil.invalid/installer.exe';
    },
    (value) => {
      value.assets[0].browser_download_url = `https://github.com/${repository}/releases/download/v1.2.0/../ACG-album-Setup-1.2.0-Standard.exe`;
    },
    (value) => {
      value.assets[0].size = 9 * 1024 ** 3;
    }
  ]) {
    const value = release();
    mutate(value);
    assert.equal(
      releaseAssets(value, repository, version).some((asset) => asset.edition === 'standard'),
      false
    );
  }
  assert.deepEqual(releaseAssets(release(), '../bad', version), []);
  assert.equal(checksumFor(digest, 'setup.exe'), digest);
  assert.equal(checksumFor(`${digest} *setup.exe`, 'setup.exe'), digest);
  assert.throws(() => checksumFor(`${digest} other.exe`, 'setup.exe'), /无效/);
  assert.throws(() => checksumFor(`${digest} setup.exe\n${digest} setup.exe`, 'setup.exe'), /无效/);
});

test('metadata is bounded and download redirects cannot reach local or third-party servers', async () => {
  await assert.rejects(readLimited(new Response('x'.repeat(65)), 64), /过大/);
  const seen = [];
  const transport = async (url) => {
    seen.push(url);
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/private' }
    });
  };
  await assert.rejects(fetchAsset(transport, offer().assets[0].url), /不安全/);
  assert.equal(seen.length, 1);
  let count = 0;
  const ok = await fetchAsset(
    async () =>
      ++count === 1
        ? new Response(null, {
            status: 302,
            headers: {
              Location: 'https://release-assets.githubusercontent.com/asset?signature=test'
            }
          })
        : new Response(payload),
    offer().assets[0].url
  );
  assert.equal(await ok.text(), payload.toString());
});

for (const edition of ['standard', 'lite', 'full']) {
  test(`${edition}: verified download needs explicit install and preserves exact paths/profile/data`, async (t) => {
    const h = await fixture(t);
    const ready = await h.service.download({ edition });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.edition, edition);
    assert.equal(ready.sha256, digest);
    assert.equal(h.launches.length, 0);
    assert.equal(h.quits(), 0);
    await assert.rejects(h.service.install({ repository, version, edition }), /点击安装/);
    await h.service.install({ confirm: true, repository, version, edition });
    assert.equal(h.quits(), 1);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].directory, path.dirname(h.paths.exe));
    assert.equal(h.launches[0].userData, h.paths.userData);
    assert.equal(h.launches[0].dataDirectory, h.paths.data);
    assert.equal(h.launches[0].edition, edition);
    assert.equal(
      await fs.readFile(path.join(h.paths.data, 'library.sqlite'), 'utf8'),
      'roots/token/profile sentinel'
    );
    assert.ok(h.events.some((event) => event.phase === 'downloading'));
    assert.ok(h.events.some((event) => event.phase === 'verifying'));
  });
}

test('checksum sidecars work; absent checksum and hash/length mismatch fail closed and clean partial files', async (t) => {
  const checked = await fixture(t);
  checked.service.setRelease(offer({ checksum: true }));
  assert.equal((await checked.service.download({ edition: 'full' })).phase, 'ready');
  for (const response of [
    new Response(Buffer.from('corrupt')),
    new Response(payload, {
      headers: { 'content-length': String(payload.length + 1) }
    })
  ]) {
    const h = await fixture(t, { fetch: async () => response });
    await assert.rejects(h.service.download({ edition: 'full' }), /校验失败|大小/);
    assert.equal(h.service.snapshot().phase, 'error');
    assert.equal(h.launches.length, 0);
    assert.equal(
      (await fs.readdir(h.root)).filter((name) => name.startsWith('ACG-album-update-')).length,
      0
    );
  }
  const missing = await fixture(t);
  const value = offer();
  value.assets[0].verifiable = false;
  missing.service.setRelease(value);
  await assert.rejects(missing.service.download({ edition: 'standard' }), /校验信息/);
});

test('cancel aborts streaming; concurrent operations never create two downloads', async (t) => {
  let streamStarted;
  const started = new Promise((resolve) => {
    streamStarted = resolve;
  });
  const h = await fixture(t, {
    fetch: async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(new Error('cancelled')), {
              once: true
            });
            streamStarted();
          }
        })
      )
  });
  const downloading = h.service.download({ edition: 'full' });
  await started;
  await assert.rejects(h.service.download({ edition: 'lite' }), /正在进行/);
  h.service.cancel();
  await assert.rejects(downloading, /cancelled|取消/);
  assert.equal(h.service.snapshot().phase, 'cancelled');
  assert.equal(h.launches.length, 0);
});

test('version/edition/repository changes and altered downloaded bytes cannot start installer', async (t) => {
  for (const change of ['version', 'edition', 'repository', 'release', 'file']) {
    const h = await fixture(t);
    await h.service.download({ edition: 'full' });
    const args = { confirm: true, repository, version, edition: 'full' };
    if (change === 'version') args.version = '9.0.0';
    if (change === 'edition') args.edition = 'lite';
    if (change === 'repository') h.setRepository('other/repo');
    if (change === 'release') h.service.setRelease({ ...offer(), latestVersion: '9.0.0' });
    if (change === 'file') {
      const cache = (await fs.readdir(h.root)).find((name) => name.startsWith('ACG-album-update-'));
      await fs.writeFile(path.join(h.root, cache, 'installer.exe'), 'tampered');
    }
    await assert.rejects(h.service.install(args), /改变/);
    assert.equal(h.launches.length, 0);
    assert.equal(h.quits(), 0);
  }
});

test('test/development/unsupported platforms never execute even after valid download', async (t) => {
  for (const options of [{ testMode: true }, { platform: 'linux' }, { arch: 'arm64' }]) {
    const h = await fixture(t, options);
    await h.service.download({ edition: 'standard' });
    await assert.rejects(
      h.service.install({ confirm: true, repository, version, edition: 'standard' }),
      /不支持/
    );
    assert.equal(h.launches.length, 0);
  }
});

test('failed helper spawn retains the verified installer and permits explicit retry without quitting', async (t) => {
  let attempts = 0;
  const h = await fixture(t, {
    launch: async () => {
      if (++attempts === 1) throw new Error('helper could not start');
    }
  });
  await h.service.download({ edition: 'full' });
  const args = { confirm: true, repository, version, edition: 'full' };
  await assert.rejects(h.service.install(args), /helper could not start/);
  assert.equal(h.service.snapshot().phase, 'ready');
  assert.equal(h.quits(), 0);
  await h.service.install(args);
  assert.equal(h.quits(), 1);
  assert.equal(attempts, 2);
});

test('registry preflight failure keeps the app open and verified download ready', async (t) => {
  const h = await fixture(t, {
    preflight: async () => {
      throw new Error('预检失败: registered directory differs');
    }
  });
  await h.service.download({ edition: 'full' });
  await assert.rejects(
    h.service.install({ confirm: true, repository, version, edition: 'full' }),
    /预检失败/
  );
  assert.equal(h.quits(), 0);
  assert.equal(h.launches.length, 0);
  assert.equal(h.service.snapshot().phase, 'ready');
});

test('indexed originals inside or above the installation block updates while external originals remain untouched', async (t) => {
  for (const placement of ['inside', 'above', 'external']) {
    const h = await fixture(t);
    const images =
      placement === 'inside'
        ? path.join(path.dirname(h.paths.exe), 'photos')
        : placement === 'above'
          ? h.root
          : path.join(h.root, 'original photos');
    await fs.mkdir(images, { recursive: true });
    const image = path.join(images, 'original.jpg');
    await fs.writeFile(image, 'original bytes must remain');
    h.setRoots([{ path: images }]);
    await h.service.download({ edition: 'standard' });
    const action = () =>
      h.service.install({ confirm: true, repository, version, edition: 'standard' });
    if (placement === 'external') {
      await action();
      assert.equal(h.quits(), 1);
    } else {
      await assert.rejects(action(), /原图.*重叠|重叠.*原图/);
      assert.equal(h.quits(), 0);
      assert.equal(h.launches.length, 0);
    }
    assert.equal(await fs.readFile(image, 'utf8'), 'original bytes must remain');
  }
});

test('installer handoff encodes paths as data, waits for exit, rehashes, preserves profile and puts /D last', async () => {
  const plan = installationPlan({
    executable: 'C:\\Program Files\\相册\\ACG-album.exe',
    dataDirectory: 'D:\\资料 & files',
    userData: 'C:\\Users\\用户\\profile',
    installer: 'C:\\Temp\\cache\\installer.exe',
    sha256: digest,
    parentPid: 1234,
    edition: 'full',
    version,
    platform: 'win32',
    packaged: true,
    testMode: false
  });
  const script = helperScript(plan);
  assert.match(script, /WaitForExit\(120000\)/);
  assert.match(script, /Get-FileHash -LiteralPath \$p.installer -Algorithm SHA256/);
  assert.match(script, /'\/S \/' \+ \$mode \+ ' \/D=' \+ \$p.directory/);
  assert.match(script, /ACG_DATA_DIR = \$p.dataDirectory/);
  assert.match(script, /ACG_USER_DATA_DIR = \$p.userData/);
  assert.match(script, /--user-data-dir=/);
  assert.doesNotMatch(script, /Remove-Item.*(?:dataDirectory|userData)/);
  assert.ok(script.indexOf('WaitForExit') < script.indexOf('$mode = Confirm-AlbumInstallation'));
  assert.match(script, /if \(\$Apply\) \{ exit 0 \}/);
  assert.deepEqual(
    JSON.parse(Buffer.from(/FromBase64String\('([^']+)'/.exec(script)[1], 'base64').toString()),
    plan
  );
  for (const overrides of [
    { directory: 'unused', dataDirectory: 'C:\\Program Files\\相册\\data' },
    { userData: 'C:\\Program Files\\相册\\profile' },
    { executable: 'C:\\ACG-album.exe' },
    { installer: '\\\\server\\setup.exe' },
    { testMode: true }
  ]) {
    assert.throws(
      () =>
        installationPlan({
          ...plan,
          platform: 'win32',
          packaged: true,
          testMode: false,
          ...overrides
        }),
      /无法|无效|仅正式/
    );
  }
  const calls = [];
  let unref = false;
  await launchInstaller(plan, {
    writeFile: async (...args) => calls.push(['write', ...args]),
    spawnProcess: (...args) => {
      calls.push(['spawn', ...args]);
      const child = new EventEmitter();
      child.unref = () => {
        unref = true;
      };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  assert.equal(calls[1][3].stdio, 'ignore');
  assert.equal(calls[1][3].detached, true);
  assert.equal(calls[1][3].env.ACG_DATA_DIR, plan.dataDirectory);
  assert.equal(unref, true);
});
