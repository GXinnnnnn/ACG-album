'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const { validRepository } = require('../src/repository.cjs');
const entry = path.resolve(__dirname, '../src/application.cjs'),
  localRequire = createRequire(entry);
function harness({
  repository = '',
  fetch = async () => {
    throw new Error('unexpected network');
  }
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
    app: { getName: () => '玖玖瑠相册', getVersion: () => '0.3.0' },
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
    net: { fetch },
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
test('blank update settings never access network; app information carries actual credits', async () => {
  const h = harness();
  assert.equal((await h.check()).status, 'unconfigured');
  const info = await h.handlers.get('library:appInfo')();
  assert.equal(info.version, '0.3.0');
  assert.equal(info.repository, '');
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
