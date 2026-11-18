'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemFonts } = require('../src/fonts.cjs');

// First 20 entries from the identical 180-family AppKit outputs on both macOS 15
// runners in diagnostic run 44278189158 (2026-11-18). No machine paths are needed.
const RUNNER_FAMILIES = [
  'Academy Engraved LET',
  'Al Bayan',
  'Al Nile',
  'Al Tarikh',
  'American Typewriter',
  'Andale Mono',
  'Apple Braille',
  'Apple Chancery',
  'Apple Color Emoji',
  'Apple SD Gothic Neo',
  'Apple Symbols',
  'AppleGothic',
  'AppleMyungjo',
  'Arial',
  'Arial Black',
  'Arial Hebrew',
  'Arial Hebrew Scholar',
  'Arial Narrow',
  'Arial Rounded MT Bold',
  'Arial Unicode MS'
];
const APPKIT_ARGS = [
  '-l',
  'JavaScript',
  '-e',
  "ObjC.import('AppKit'); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies));"
];
const report = JSON.stringify(RUNNER_FAMILIES);

test('macOS uses fixed bounded AppKit JXA and caches real runner families for 60 seconds', async () => {
  let calls = 0,
    time = 0;
  const fonts = createSystemFonts({
    platform: 'darwin',
    now: () => time,
    run(file, args, options, done) {
      calls++;
      assert.equal(file, '/usr/bin/osascript');
      assert.deepEqual(args, APPKIT_ARGS);
      assert.deepEqual(options, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024
      });
      setImmediate(() => done(null, report));
    }
  });
  assert.equal(calls, 0);
  const [first, second] = await Promise.all([fonts.list(), fonts.list()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.source, 'macos-installed-fonts');
  assert.deepEqual([...first.families].sort(), [...RUNNER_FAMILIES].sort());
  first.families.length = 0;
  assert.equal(second.families.length, RUNNER_FAMILIES.length);
  time = 59999;
  assert.equal((await fonts.list()).families.length, RUNNER_FAMILIES.length);
  assert.equal(calls, 1);
  time = 60000;
  await Promise.all([fonts.list(), fonts.list()]);
  assert.equal(calls, 2);
});

test('macOS rejects empty, malformed, null and non-string AppKit reports without poisoning retries', async () => {
  const invalidReports = [
    ['', /格式/u],
    ['not json', /格式/u],
    ['{}', /格式/u],
    ['null', /格式/u],
    ['42', /格式/u],
    ['"Arial"', /格式/u],
    ['[null]', /格式/u],
    ['["Arial",42]', /格式/u],
    ['[{}]', /格式/u],
    ['[["Arial"]]', /格式/u],
    ['[]', /未读取/u],
    ['["", " ", "bad\\nfamily"]', /未读取/u]
  ];
  for (const [output, error] of invalidReports) {
    let attempts = 0;
    const fonts = createSystemFonts({
      platform: 'darwin',
      run(_file, _args, _options, done) {
        attempts++;
        done(null, attempts === 1 ? output : report);
      }
    });
    await assert.rejects(fonts.list(), error, `reject ${JSON.stringify(output)}`);
    assert.deepEqual(
      [...(await fonts.list()).families].sort(),
      [...RUNNER_FAMILIES].sort(),
      `retry after ${JSON.stringify(output)}`
    );
    assert.equal(attempts, 2);
  }
});

test('macOS AppKit timeouts and command errors reject shared reads and permit retry', async () => {
  let attempts = 0;
  const errors = [
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('killed'), { killed: true }),
    Object.assign(new Error('execution failed'), { code: 1 })
  ];
  const fonts = createSystemFonts({
    platform: 'darwin',
    run(_file, _args, _options, done) {
      const error = errors[attempts++];
      setImmediate(() => done(error || null, error ? '' : report));
    }
  });
  const first = await Promise.allSettled([fonts.list(), fonts.list()]);
  assert.equal(attempts, 1);
  for (const result of first) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /超时/u);
  }
  await assert.rejects(fonts.list(), /超时/u);
  await assert.rejects(fonts.list(), /无法读取/u);
  assert.equal((await fonts.list()).families.length, RUNNER_FAMILIES.length);
  assert.equal(attempts, 4);
});

test(
  'real macOS AppKit enumeration returns available font families',
  { skip: process.platform !== 'darwin' && 'requires macOS AppKit', timeout: 20000 },
  async () => {
    const fonts = createSystemFonts();
    const first = await fonts.list();
    assert.equal(first.source, 'macos-installed-fonts');
    assert.ok(first.families.length > 0);
    assert.ok(first.families.every((family) => typeof family === 'string' && family.length > 0));
    const expected = [...first.families];
    first.families.length = 0;
    assert.deepEqual((await fonts.list()).families, expected);
  }
);
