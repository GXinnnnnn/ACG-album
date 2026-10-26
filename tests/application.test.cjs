'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { validRepository } = require('../src/repository.cjs');
const entry = path.resolve(__dirname, '../src/application.cjs'),
  localRequire = createRequire(entry);
function harness({
  repository = '',
  fetch = async () => {
    throw new Error('unexpected network');
  },
  request = () => {
    throw new Error('unexpected native network');
  },
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  const handlers = new Map(),
    sent = [],
    external = [];
  let template = [],
    popupOptions,
    copies = 0;
  const win = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 900, height: 600 }),
    webContents: { send: (...args) => sent.push(args), copy: () => copies++ }
  };
  const electron = {
    app: { getName: () => 'ACG-album', getVersion: () => '0.3.0' },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Menu: {
      setApplicationMenu: () => {},
      buildFromTemplate: (items) => {
        template = items;
        return {
          closePopup: () => {},
          popup: (options) => {
            popupOptions = options;
            options.callback();
          }
        };
      }
    },
    net: { fetch, request },
    shell: {
      openExternal: (url) => {
        external.push(url);
        return Promise.resolve();
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(entry, 'utf8'),
    {
      require: (name) => (name === 'electron' ? electron : localRequire(name)),
      module,
      exports: module.exports,
      URL,
      AbortSignal,
      setTimeout: schedule,
      clearTimeout: cancel,
      Set,
      Promise,
      Number,
      String,
      Math,
      Error
    },
    { filename: entry }
  );
  module.exports.registerApplicationHandlers({
    call: async (method) => {
      assert.equal(method, 'init');
      return { settings: { githubRepository: repository } };
    },
    getWindow: () => win
  });
  return {
    ...module.exports,
    handlers,
    sent,
    external,
    get template() {
      return template;
    },
    get popupOptions() {
      return popupOptions;
    },
    get copies() {
      return copies;
    },
    check: () => handlers.get('library:checkUpdate')()
  };
}
const response = (status, data) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => data
});
test('repository accepts one public owner/repo and rejects traversal, hosts and credentials', () => {
  for (const repo of ['GXinnnnnn/album', 'a/a.b-c_d', 'a/..git'])
    assert.equal(validRepository(repo), true, repo);
  for (const repo of [
    '',
    null,
    'owner',
    'a/.',
    'a/..',
    '../a',
    'a/b/c',
    'https://github.com/a/b',
    'a:b/repo',
    '-a/repo',
    'a/re po',
    'a/repo?x'
  ])
    assert.equal(validRepository(repo), false, String(repo));
});
test('blank update settings use the official release API and app info carries download metadata', async () => {
  const h = harness({
    fetch: async (url) => {
      assert.equal(url, 'https://api.github.com/repos/GXinnnnnn/ACG-album/releases/latest');
      return response(200, { tag_name: 'v0.3.0' });
    }
  });
  assert.equal((await h.check()).status, 'current');
  const info = await h.handlers.get('library:appInfo')();
  assert.equal(info.version, '0.3.0');
  assert.equal(info.repository, 'GXinnnnnn/ACG-album');
  assert.equal(info.officialRepository, 'GXinnnnnn/ACG-album');
  assert.equal(info.releaseUrl, 'https://github.com/GXinnnnnn/ACG-album/releases/tag/v0.3.0');
  for (const [key, label] of [
    ['lite', 'Lite'],
    ['full', 'Full']
  ])
    assert.equal(
      info.downloads[key],
      `https://github.com/GXinnnnnn/ACG-album/releases/download/v0.3.0/ACG-album-Setup-0.3.0-${label}.exe`
    );
  for (const group of ['runtime', 'development', 'assets', 'services'])
    assert.ok(Array.isArray(info.credits[group]) && info.credits[group].length);
});
test('update checks compare stable versions and use only the configured GitHub API', async () => {
  for (const [tag, status] of [
    ['v0.3.1', 'available'],
    ['release0.3.0', 'current'],
    ['0.2.99', 'current'],
    ['v1.0.0-beta.1', 'unknown']
  ]) {
    const h = harness({
      repository: 'fixture-owner/fixture-repo',
      fetch: async (url, options) => {
        assert.equal(
          url,
          'https://api.github.com/repos/fixture-owner/fixture-repo/releases/latest'
        );
        assert.ok(options.signal);
        assert.equal(options.headers.Authorization, undefined);
        return response(200, {
          tag_name: tag,
          html_url: 'https://github.com/fixture-owner/fixture-repo/releases/tag/' + tag
        });
      }
    });
    const result = await h.check();
    assert.equal(result.status, status, tag);
    assert.match(result.url, /^https:\/\/github.com\/fixture-owner\/fixture-repo\/releases/);
  }
});
test('draft, prerelease and off-repository release URLs cannot become trusted updates', async () => {
  for (const attributes of [{ draft: true }, { prerelease: true }]) {
    const h = harness({
      repository: 'fixture-owner/fixture-repo',
      fetch: async () =>
        response(200, {
          tag_name: 'v9.0.0',
          html_url: 'https://elsewhere.invalid/download',
          ...attributes
        })
    });
    const result = await h.check();
    assert.equal(result.status, 'unknown');
    assert.equal(result.url, 'https://github.com/fixture-owner/fixture-repo/releases');
  }
});
test('missing release is readable and connection/rate errors propagate', async () => {
  const missing = harness({ repository: 'a/b', fetch: async () => response(404) });
  assert.equal((await missing.check()).status, 'unknown');
  for (const status of [403, 429, 500])
    await assert.rejects(
      harness({ repository: 'a/b', fetch: async () => response(status) }).check(),
      status === 500 ? /500/ : /频率受限/
    );
  await assert.rejects(
    harness({
      repository: 'a/b',
      fetch: async () => {
        throw Object.assign(new Error(), { name: 'TimeoutError' });
      }
    }).check(),
    /超时/
  );
  await assert.rejects(
    harness({
      repository: 'a/b',
      fetch: async () => {
        throw new Error('offline');
      }
    }).check(),
    /无法连接/
  );
});
test('rate-limited API falls back to a public HEAD redirect for stable versions', async () => {
  for (const status of [403, 429]) {
    for (const [tag, expected] of [
      ['v0.3.1', 'available'],
      ['v0.3.0', 'current'],
      ['v0.2.0', 'current']
    ]) {
      const requests = [];
      const h = harness({
        repository: 'fixture-owner/fixture-repo',
        fetch: async (url, options) => {
          requests.push(url);
          if (requests.length === 1) return response(status);
          assert.equal(url, 'https://github.com/fixture-owner/fixture-repo/releases/latest');
          assert.equal(options.method, 'HEAD');
          assert.equal(options.redirect, 'follow');
          assert.ok(options.signal);
          return {
            ok: true,
            status: 200,
            url: 'https://github.com/fixture-owner/fixture-repo/releases/tag/' + tag
          };
        }
      });
      const result = await h.check();
      assert.equal(result.status, expected);
      assert.equal(result.latestVersion, tag.slice(1));
      assert.equal(requests.length, 2);
    }
  }
});

function nativeHead(run) {
  const calls = [];
  return {
    calls,
    request: (options) => {
      const request = new EventEmitter();
      request.aborted = false;
      request.abort = () => {
        request.aborted = true;
        request.emit('abort');
      };
      request.end = () => queueMicrotask(() => run(request));
      calls.push({ options, request });
      return request;
    }
  };
}
function nativeResponse(request, statusCode = 200) {
  const message = new EventEmitter();
  message.statusCode = statusCode;
  request.emit('response', message);
}

test('empty Electron fetch URLs use native HEAD redirects with no credentials', async () => {
  for (const emptyUrl of ['', undefined, null]) {
    for (const status of [403, 429]) {
      const target = 'https://github.com/a/b/releases/tag/v0.3.1';
      const native = nativeHead((request) => {
        request.emit('redirect', 302, 'HEAD', 'https://github.com/a/b/releases', {});
        request.emit('redirect', 302, 'HEAD', target, {});
        nativeResponse(request);
      });
      const h = harness({
        repository: 'a/b',
        request: native.request,
        fetch: async (url, options) => {
          if (url.startsWith('https://api.')) return response(status);
          assert.equal(options.method, 'HEAD');
          assert.equal(options.credentials, 'omit');
          return { ok: true, status: 200, url: emptyUrl };
        }
      });
      const result = await h.check();
      assert.equal(result.status, 'available');
      assert.equal(result.latestVersion, '0.3.1');
      assert.equal(result.url, target);
      assert.equal(native.calls.length, 1);
      const { options, request } = native.calls[0];
      assert.equal(options.url, 'https://github.com/a/b/releases/latest');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'follow');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.useSessionCookies, false);
      assert.equal(options.headers, undefined);
      assert.equal(request.aborted, false);
    }
  }
});

test('native HEAD still rejects foreign, invalid, prerelease and unsuccessful destinations', async () => {
  for (const [target, status] of [
    ['https://evil.invalid/a/b/releases/tag/v9.0.0', 200],
    ['https://github.com/other/b/releases/tag/v9.0.0', 200],
    ['http://github.com/a/b/releases/tag/v9.0.0', 200],
    ['https://user@github.com/a/b/releases/tag/v9.0.0', 200],
    ['https://github.com:444/a/b/releases/tag/v9.0.0', 200],
    ['https://github.com/a/b/releases/tag/v9.0.0?fake=1', 200],
    ['https://github.com/a/b/releases/tag/v9.0.0#fake', 200],
    ['https://github.com/a/b/releases/tag/v9.0.0-beta.1', 200],
    ['https://github.com/a/b/releases/tag/v9.0.0/extra', 200],
    ['https://github.com/a/b/releases/tag/v9.0.0', 503],
    [null, 200]
  ]) {
    const native = nativeHead((request) => {
      if (target) request.emit('redirect', 302, 'HEAD', target, {});
      nativeResponse(request, status);
    });
    await assert.rejects(
      harness({
        repository: 'a/b',
        request: native.request,
        fetch: async (url) =>
          url.startsWith('https://api.') ? response(429) : { ok: true, status: 200, url: '' }
      }).check(),
      /频率受限/
    );
  }
});

test('native HEAD times out or fails with abort and clears its injected ten-second timer', async () => {
  for (const failure of ['timeout', 'error', 'abort', 'end']) {
    let expire,
      delay,
      cleared = 0;
    const timer = {};
    const native = nativeHead((request) => {
      if (failure === 'timeout') expire();
      else request.emit(failure, new Error('network failure'));
      // A transport error can arrive after cancellation; it must stay handled.
      request.emit('error', new Error('late failure'));
    });
    const request = (options) => {
      const result = native.request(options);
      if (failure === 'end')
        result.end = () => {
          throw new Error('end failed');
        };
      return result;
    };
    await assert.rejects(
      harness({
        repository: 'a/b',
        request,
        schedule: (callback, ms) => {
          expire = callback;
          delay = ms;
          return timer;
        },
        cancel: (handle) => {
          assert.equal(handle, timer);
          cleared++;
        },
        fetch: async (url) =>
          url.startsWith('https://api.') ? response(403) : { ok: true, status: 200, url: '' }
      }).check(),
      /频率受限/
    );
    assert.equal(delay, 10000);
    assert.equal(cleared, 1);
    assert.equal(native.calls[0].request.aborted, true);
  }
});

test('failed or unsafe public fallback never reports current or trusts foreign URLs', async () => {
  for (const url of [
    'https://evil.invalid/a/b/releases/tag/v9.0.0',
    'http://github.com/a/b/releases/tag/v9.0.0',
    'https://user@github.com/a/b/releases/tag/v9.0.0',
    'https://github.com:444/a/b/releases/tag/v9.0.0',
    'https://github.com/other/b/releases/tag/v9.0.0',
    'https://github.com/a/b/releases/latest',
    'https://github.com/a/b/releases/tag/v9.0.0-beta.1',
    'https://github.com/a/b/releases/tag/v9.0.0/extra',
    'https://github.com/a/b/releases/tag/v9.0.0?fake=1'
  ]) {
    await assert.rejects(
      harness({
        repository: 'a/b',
        fetch: async (request) =>
          request.startsWith('https://api.') ? response(429) : { ok: true, status: 200, url }
      }).check(),
      /频率受限/
    );
  }
  await assert.rejects(
    harness({
      fetch: async (url) => {
        if (url.startsWith('https://api.')) return response(403);
        throw new Error('offline');
      }
    }).check(),
    /频率受限/
  );
});

test('custom repository controls updates while downloads always use official versioned assets', async () => {
  const h = harness({ repository: 'a/custom' });
  const info = await h.handlers.get('library:appInfo')();
  assert.equal(info.repository, 'a/custom');
  assert.equal(info.officialRepository, 'GXinnnnnn/ACG-album');
  assert.match(
    info.downloads.full,
    /^https:\/\/github.com\/GXinnnnnn\/ACG-album\/releases\/download\/v0.3.0\//
  );
  await assert.rejects(harness({ repository: 'https://evil.invalid/a/b' }).check(), /配置无效/);
});

test('version parsing accepts stable tags and rejects partial, prerelease and unsafe integers', () => {
  const { releaseVersion } = harness();
  for (const tag of ['v0.3.0', 'release/0.3.0', 'release-0.3.0', '0.3.0+build.7'])
    assert.deepEqual(Array.from(releaseVersion(tag)), [0, 3, 0]);
  for (const tag of ['0.3', 'v0.3.0-beta.1', '9007199254740992.0.0', 'x0.3.0', '0.3.0/fake'])
    assert.equal(releaseVersion(tag), null);
});
test('invalid update JSON produces a readable error and suspicious release URLs fall back', async () => {
  for (const data of [null, [], 42])
    await assert.rejects(
      harness({ repository: 'a/b', fetch: async () => response(200, data) }).check(),
      /无法识别/
    );
  await assert.rejects(
    harness({
      repository: 'a/b',
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('bad JSON');
        }
      })
    }).check(),
    /无法识别/
  );
  for (const url of [
    'https://github.com:444/a/b/releases/tag/v1.0.0',
    'https://user@github.com/a/b/releases/tag/v1.0.0',
    'https://github.com/else/repo/releases/tag/v1.0.0'
  ]) {
    const result = await harness({
      repository: 'a/b',
      fetch: async () => response(200, { tag_name: 'v1.0.0', html_url: url })
    }).check();
    assert.equal(result.url, 'https://github.com/a/b/releases');
  }
});
test('menus dispatch About, updates and bitmap copy while preserving native editing roles', async () => {
  const h = harness(),
    menu = h.handlers.get('application:menu');
  await menu(null, { name: 'application', x: -3, y: 9999 });
  assert.equal(h.popupOptions.x, 0);
  assert.equal(h.popupOptions.y, 600);
  assert.equal(h.template.at(-1).role, 'quit');
  h.template[0].click();
  h.template[1].click();
  assert.equal(h.sent[0][1].data.action, 'about');
  assert.equal(h.sent[1][1].data.action, 'updates');
  await menu(null, { name: 'edit', copyImage: true });
  assert.equal(h.template[0].role, 'undo');
  assert.equal(h.template[1].role, 'redo');
  assert.equal(h.template.at(-1).role, 'selectAll');
  h.template.find((i) => i.label === '复制').click();
  assert.equal(h.sent.at(-1)[1].data.action, 'copy');
  await menu(null, { name: 'edit', copyImage: false });
  h.template.find((i) => i.label === '复制').click();
  assert.equal(h.copies, 1);
});
test('all displayed credit and author links open through the HTTPS allowlist', async () => {
  const h = harness(),
    credits = localRequire('./assets/credits.json');
  for (const entry of Object.values(credits).flat()) await h.openExternal(entry.url);
  await h.openExternal('https://space.bilibili.com/396517775');
  for (const url of [
    'file:///C:/Windows',
    'http://github.com/a/b',
    'https://evil.invalid',
    'https://user:password@github.com/a/b',
    'https://github.com:444/a/b'
  ])
    assert.throws(() => h.openExternal(url));
  assert.equal(h.external.length, Object.values(credits).flat().length + 1);
});
