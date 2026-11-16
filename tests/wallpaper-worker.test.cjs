'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const spec = require('../src/wallpaper-settings.cjs');
async function client(dataDir) {
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false, deferBackground: true }
  });
  let sequence = 0;
  const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  worker.on('message', (message) => {
    if (message.event === 'ready') resolveReady();
    const request = pending.get(message.request);
    if (!request) return;
    pending.delete(message.request);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  worker.on('error', (error) => {
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });
  await ready;
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout: ' + method));
      }, 10000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  return {
    call,
    async close() {
      try {
        await call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}

test(
  'worker defaults, strict wallpaper settings validation, persistence and invalid legacy fallback',
  { timeout: 30000 },
  async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-wallpaper-worker-owned-'));
    t.diagnostic('owned fixture: ' + dataDir);
    let c = await client(dataDir);
    const saved = {
      wallpaperEnabled: true,
      wallpaperLight: 'custom-' + 'b'.repeat(64),
      wallpaperDark: 'builtin-bilibili-01',
      wallpaperMask: false,
      wallpaperBlur: false,
      wallpaperPositionX: 0,
      wallpaperPositionY: 100,
      wallpaperScale: 50,
      wallpaperMaskTransparency: 100,
      wallpaperBlurAmount: 27,
      wallpaperGallery: {
        version: 1,
        light: {
          hidden: ['builtin-bilibili-02'],
          order: ['builtin-bilibili-03', 'builtin-bilibili-01'],
          crops: { 'builtin-bilibili-01': { x: 12, y: 84, scale: 160 } }
        },
        dark: {
          hidden: [],
          order: [],
          crops: { 'builtin-bilibili-01': { x: 88, y: 16, scale: 90 } }
        }
      }
    };
    try {
      const initial = (await c.call('init', { lightweight: true })).settings;
      for (const [key, value] of Object.entries(spec.defaults))
        assert.deepEqual(initial[key], value, key);
      for (const [key, value] of Object.entries(saved))
        assert.deepEqual(await c.call('settings', { key, value }), value);
      for (const [key, value] of [
        ['wallpaperEnabled', 'false'],
        ['wallpaperLight', 'file:///secret.jpg'],
        ['wallpaperDark', '../outside'],
        ['wallpaperScale', 49],
        ['wallpaperScale', 301],
        ['wallpaperPositionX', NaN],
        ['wallpaperPositionY', '50'],
        ['wallpaperMaskTransparency', Infinity],
        ['wallpaperBlur', 1],
        ['wallpaperBlurAmount', 41],
        ['wallpaperMask', null],
        ['wallpaperGallery', { ...saved.wallpaperGallery, version: 2 }],
        [
          'wallpaperGallery',
          {
            ...saved.wallpaperGallery,
            light: { ...saved.wallpaperGallery.light, path: 'C:/secret' }
          }
        ],
        [
          'wallpaperGallery',
          {
            ...saved.wallpaperGallery,
            light: {
              ...saved.wallpaperGallery.light,
              hidden: ['builtin-bilibili-02', 'builtin-bilibili-02']
            }
          }
        ],
        [
          'wallpaperGallery',
          {
            ...saved.wallpaperGallery,
            dark: {
              ...saved.wallpaperGallery.dark,
              crops: { 'builtin-bilibili-01': { x: 50, y: 50, scale: 301 } }
            }
          }
        ],
        [
          'wallpaperGallery',
          {
            ...saved.wallpaperGallery,
            dark: {
              ...saved.wallpaperGallery.dark,
              crops: JSON.parse('{"__proto__":{"x":50,"y":50,"scale":100}}')
            }
          }
        ]
      ])
        await assert.rejects(c.call('settings', { key, value }), /壁纸设置值无效/);
    } finally {
      await c.close();
    }
    c = await client(dataDir);
    try {
      const restored = (await c.call('init', { lightweight: true })).settings;
      for (const [key, value] of Object.entries(saved)) assert.deepEqual(restored[key], value, key);
      assert.deepEqual(spec.cropFor(restored, 'light', 'builtin-bilibili-01'), {
        x: 12,
        y: 84,
        scale: 160
      });
      assert.deepEqual(spec.cropFor(restored, 'dark', 'builtin-bilibili-01'), {
        x: 88,
        y: 16,
        scale: 90
      });
      assert.deepEqual(spec.cropFor(restored, 'light', 'builtin-bilibili-04'), {
        x: 0,
        y: 100,
        scale: 50
      });
    } finally {
      await c.close();
    }
    const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
      insert.run('wallpaperScale', JSON.stringify('300'));
      insert.run('wallpaperLight', JSON.stringify('https://example.test/remote.jpg'));
      insert.run('wallpaperEnabled', JSON.stringify('true'));
      insert.run('wallpaperGallery', JSON.stringify({ ...saved.wallpaperGallery, version: 0 }));
      insert.run('wallpaperBlurAmount', JSON.stringify(-1));
    } finally {
      db.close();
    }
    c = await client(dataDir);
    try {
      const restored = (await c.call('init', { lightweight: true })).settings;
      assert.equal(restored.wallpaperScale, spec.defaults.wallpaperScale);
      assert.equal(restored.wallpaperLight, spec.defaults.wallpaperLight);
      assert.equal(restored.wallpaperEnabled, false);
      assert.equal(restored.wallpaperDark, saved.wallpaperDark);
      assert.equal(restored.wallpaperPositionY, 100);
      assert.deepEqual(restored.wallpaperGallery, spec.defaults.wallpaperGallery);
      assert.equal(restored.wallpaperBlurAmount, 14);
      assert.deepEqual(spec.cropFor(restored, 'light', 'builtin-bilibili-01'), {
        x: 0,
        y: 100,
        scale: 100
      });
    } finally {
      await c.close();
    }
  }
);
