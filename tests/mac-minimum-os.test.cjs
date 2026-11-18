'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMachOMinimumOS } = require('../scripts/check-mac-full.cjs');

const buildVersion = (version = '12.0', platform = '1') => `Load command 0
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform ${platform}
    minos ${version}
      sdk 26.1
   ntools 1
     tool LD
  version 1234.5
`;
const legacyVersion = (version = '10.15.7') => `Load command 1
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version ${version}
      sdk 26.1
`;

test('mac minimum OS: records each requested native slice and ignores SDK/tool versions', () => {
  for (const architecture of ['arm64', 'x86_64']) {
    const result = parseMachOMinimumOS(
      `binary (architecture ${architecture}):\n${buildVersion()}`,
      architecture
    );
    assert.deepEqual(result, {
      architecture,
      loadCommand: 'LC_BUILD_VERSION',
      platform: 'macos',
      versionField: 'minos',
      version: '12.0'
    });
  }
  for (const platform of ['MACOS', 'macos'])
    assert.equal(parseMachOMinimumOS(buildVersion('12.0.0', platform), 'arm64').version, '12.0.0');
  assert.throws(
    () => parseMachOMinimumOS(`binary (architecture x86_64):\n${buildVersion()}`, 'arm64'),
    /header mismatch/
  );
  assert.throws(() => parseMachOMinimumOS(buildVersion(), 'x64'), /Unexpected Mach-O architecture/);
});

test('mac minimum OS: reads legacy version only from its own load command', () => {
  const unrelated = `Load command 0
      cmd LC_ID_DYLIB
  cmdsize 64
     name example.dylib (offset 24)
 current version 99.0.0
compatibility version 99.0.0
`;
  assert.deepEqual(parseMachOMinimumOS(unrelated + legacyVersion(), 'x86_64'), {
    architecture: 'x86_64',
    loadCommand: 'LC_VERSION_MIN_MACOSX',
    platform: 'macos',
    versionField: 'version',
    version: '10.15.7'
  });
  assert.throws(() => parseMachOMinimumOS(unrelated, 'x86_64'), /exactly one minimum macOS/);
});

test('mac minimum OS: compares numeric components without lexical ordering or truncation', () => {
  for (const version of ['9.9.9', '10.15.7', '11.10', '12', '12.0', '12.0.0'])
    assert.equal(parseMachOMinimumOS(buildVersion(version), 'arm64').version, version);
  for (const version of ['12.0.1', '12.1', '13.0', '100.0', '9007199254740993.0'])
    assert.throws(() => parseMachOMinimumOS(buildVersion(version), 'arm64'), /exceeds 12.0/);
  assert.throws(() => parseMachOMinimumOS(legacyVersion('12.0.1'), 'x86_64'), /exceeds 12.0/);
});

test('mac minimum OS: rejects missing, duplicate, malformed and foreign minimum metadata', () => {
  for (const output of [
    '',
    'binary:\n',
    buildVersion().replace('    minos 12.0\n', ''),
    legacyVersion().replace('  version 10.15.7\n', ''),
    buildVersion() + legacyVersion(),
    buildVersion() + buildVersion(),
    buildVersion().replace('    minos 12.0', '    minos 12.0\n    minos 12.0'),
    legacyVersion().replace('  version 10.15.7', '  version 10.15.7\n  version 10.15.7'),
    buildVersion().replace(' platform 1', ' platform 1\n platform 1'),
    buildVersion('12.0 extra'),
    buildVersion('12.0', '2'),
    buildVersion('12.0', 'IOS'),
    buildVersion().replace(' platform 1\n', ''),
    legacyVersion().replace('LC_VERSION_MIN_MACOSX', 'LC_VERSION_MIN_IPHONEOS'),
    `binary (architecture arm64):\n${buildVersion()}binary (architecture x86_64):\n${buildVersion()}`
  ])
    assert.throws(() => parseMachOMinimumOS(output, 'arm64'));
  for (const version of [
    '12x0',
    '12.0beta',
    '-1.0',
    '0.0',
    '12..0',
    '012.0',
    '12.00',
    '12.0.0.0',
    'Infinity',
    'NaN'
  ])
    assert.throws(
      () => parseMachOMinimumOS(buildVersion(version), 'arm64'),
      /Malformed macOS version/
    );
});
