'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemFonts } = require('../src/fonts.cjs');
const report = (families) =>
  JSON.stringify({
    SPFontsDataType: [
      {
        _name: 'A filename is not a font family.ttc',
        path: '/System/Library/Fonts/A filename is not a font family.ttc',
        typefaces: families.map((family) => ({
          _name: family + ' Regular',
          family,
          fullname: family + ' Regular',
          enabled: 'yes'
        }))
      }
    ]
  });

test('macOS reads installed family metadata using one fixed bounded system_profiler command', async () => {
  let command,
    calls = 0;
  const fonts = createSystemFonts({
    platform: 'darwin',
    run(file, args, options, done) {
      command = { file, args, options };
      calls++;
      setImmediate(() =>
        done(null, report(['PingFang SC', '苹方-简', 'Hiragino Sans', 'pingfang sc']))
      );
    }
  });
  assert.equal(command, undefined);
  const [first, second] = await Promise.all([fonts.list(), fonts.list()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.source, 'macos-installed-fonts');
  assert.ok(first.families.includes('PingFang SC'));
  assert.ok(first.families.includes('苹方-简'));
  assert.equal(first.families.length, 3);
  assert.equal(command.file, '/usr/sbin/system_profiler');
  assert.deepEqual(command.args, ['SPFontsDataType', '-json', '-timeout', '8']);
  assert.equal(command.options.timeout, 10000);
  assert.equal(command.options.maxBuffer, 8 * 1024 * 1024);
  assert.equal(command.options.encoding, 'utf8');
  assert.ok(!command.options.shell);
  first.families.length = 0;
  assert.equal((await fonts.list()).families.length, 3);
});

test('macOS font enumeration skips disabled faces and does not substitute filenames or PostScript names', async () => {
  const payload = JSON.parse(report(['PingFang SC']));
  payload.SPFontsDataType[0].typefaces.push({ family: 'Disabled Family', enabled: 'no' });
  const fonts = createSystemFonts({
    platform: 'darwin',
    run(_file, _args, _options, done) {
      done(null, JSON.stringify(payload));
    }
  });
  assert.deepEqual((await fonts.list()).families, ['PingFang SC']);
});

test('macOS timeout, malformed and empty reports are bounded failures and permit a retry', async () => {
  let attempts = 0;
  const fonts = createSystemFonts({
    platform: 'darwin',
    run(_file, _args, _options, done) {
      attempts++;
      if (attempts === 1) return done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      const outputs = [
        'not json',
        '{}',
        '{"SPFontsDataType":[{}]}',
        report([]),
        report(['PingFang SC'])
      ];
      done(null, outputs[attempts - 2]);
    }
  });
  await assert.rejects(fonts.list(), /超时/u);
  for (let i = 0; i < 3; i++) await assert.rejects(fonts.list(), /格式/u);
  await assert.rejects(fonts.list(), /未读取/u);
  assert.deepEqual((await fonts.list()).families, ['PingFang SC']);
  assert.equal(attempts, 6);
});
