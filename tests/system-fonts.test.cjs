'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSystemFonts } = require('../src/fonts.cjs');

test('font discovery is lazy, concurrent calls merge, localized aliases survive, and the short cache expires', async () => {
  let calls = 0,
    time = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fonts = createSystemFonts({
    now: () => time,
    ttlMs: 60000,
    enumerate: async () => {
      calls++;
      if (calls === 1) await gate;
      return {
        families: [
          'Microsoft YaHei',
          '微软雅黑',
          'SimSun',
          '宋体',
          'Arial',
          'arial',
          ' Arial ',
          '',
          'bad\nfamily'
        ],
        source: 'test-installed'
      };
    }
  });
  assert.equal(calls, 0);
  const first = fonts.list(),
    second = fonts.list();
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.ok(a.families.includes('微软雅黑'));
  assert.ok(a.families.includes('宋体'));
  assert.equal(a.families.filter((name) => name.toLowerCase() === 'arial').length, 1);
  assert.ok(!a.families.includes('bad\nfamily'));
  a.families.length = 0;
  assert.ok((await fonts.list()).families.length);
  assert.equal(calls, 1);
  time = 60001;
  await fonts.list();
  assert.equal(calls, 2);
});

test('failed, empty and malformed discovery does not poison retries', async () => {
  let calls = 0;
  const fonts = createSystemFonts({
    enumerate: async () => {
      calls++;
      if (calls === 1) throw Error('temporary failure');
      if (calls === 2) return { families: [], source: 'windows-installed-fonts' };
      if (calls === 3) return { families: [42], source: 'windows-installed-fonts' };
      return { families: ['等线'], source: 'windows-installed-fonts' };
    }
  });
  await assert.rejects(fonts.list(), /temporary failure/);
  await assert.rejects(fonts.list(), /未读取/);
  await assert.rejects(fonts.list(), /格式/);
  assert.deepEqual(await fonts.list(), { families: ['等线'], source: 'windows-installed-fonts' });
  assert.equal(calls, 4);
});

test('Windows enumeration uses one fixed bounded asynchronous script and reads family metadata rather than filenames', async () => {
  let command;
  const fonts = createSystemFonts({
    platform: 'win32',
    run: (file, args, options, done) => {
      command = { file, args, options };
      setImmediate(() => done(null, '["Microsoft YaHei","微软雅黑","宋体"]', ''));
    }
  });
  assert.equal(command, undefined);
  const found = await fonts.list();
  assert.equal(found.source, 'windows-installed-fonts');
  assert.ok(found.families.includes('微软雅黑'));
  assert.match(command.file, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.deepEqual(command.args.slice(0, 4), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand'
  ]);
  assert.equal(command.args.length, 5);
  assert.equal(command.options.timeout, 10000);
  assert.equal(command.options.maxBuffer, 2 * 1024 * 1024);
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.encoding, 'utf8');
  assert.ok(!command.options.shell);
  const script = Buffer.from(command.args[4], 'base64').toString('utf16le');
  assert.match(script, /InstalledFontCollection/);
  assert.match(script, /GetName\(/);
  assert.ok(
    !script.includes('AddFontFile'),
    'enumeration must not reload installed fonts or probe registered paths'
  );
  assert.ok(!script.includes('Invoke-Expression'));
  assert.ok(!script.includes('Install-Font'));
  assert.ok(!script.includes('http'));
});

test('process timeout is reported clearly and may be retried', async () => {
  let attempts = 0;
  const fonts = createSystemFonts({
    platform: 'win32',
    run: (_file, _args, _options, done) => {
      attempts++;
      setImmediate(() =>
        attempts === 1
          ? done(Object.assign(Error('timeout'), { killed: true }))
          : done(null, '["宋体"]')
      );
    }
  });
  await assert.rejects(fonts.list(), /超时.*重试/);
  assert.deepEqual((await fonts.list()).families, ['宋体']);
});

test('Linux uses read-only fontconfig and unsupported platforms honestly retain the system default', async () => {
  let argv;
  const linux = createSystemFonts({
    platform: 'linux',
    run: (file, args, _options, done) => {
      argv = { file, args };
      done(null, 'Noto Sans CJK SC\nDejaVu Sans\n');
    }
  });
  const found = await linux.list();
  assert.equal(argv.file, 'fc-list');
  assert.deepEqual(argv.args, ['--format=%{family[0]}\\n']);
  assert.equal(found.source, 'fontconfig');
  assert.ok(found.families.includes('Noto Sans CJK SC'));
  const other = createSystemFonts({
    platform: 'darwin',
    run: () => {
      throw Error('unexpected process');
    }
  });
  assert.deepEqual(await other.list(), { families: [], source: 'unsupported-platform' });
});

test('preload exposes only the fixed systemFonts IPC method alongside its existing allowlist', async () => {
  let bridge;
  const invoked = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/preload.cjs'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            assert.equal(name, 'album');
            bridge = api;
          }
        },
        ipcRenderer: {
          invoke: async (...args) => {
            invoked.push(args);
            return { families: ['宋体'], source: 'windows-installed-fonts' };
          },
          on() {},
          removeListener() {}
        }
      };
    }
  });
  const result = await bridge.call('systemFonts');
  assert.deepEqual(result.families, ['宋体']);
  assert.equal(invoked[0][0], 'library:systemFonts');
  assert.equal(Object.keys(invoked[0][1]).length, 0);
  await assert.rejects(bridge.call('executeFontScript', { command: 'anything' }), /不支持/);
  assert.equal(invoked.length, 1);
});
