'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  APP_NAME,
  resolveDataDirectory,
  resolveUserDataDirectory
} = require('../src/profile-path.cjs');

const documents = path.resolve('migration-fixture', 'Documents');
const appData = path.resolve('migration-fixture', 'AppData');
const existing = (...paths) => {
  const files = new Set(paths);
  return (file) => files.has(file);
};

test('fresh installs use the ACG-album library and Electron profile directories', () => {
  assert.equal(APP_NAME, 'ACG-album');
  assert.equal(
    resolveDataDirectory({ documents, existsSync: existing() }),
    path.join(documents, 'ACG-album')
  );
  assert.equal(
    resolveUserDataDirectory({ appData, existsSync: existing() }),
    path.join(appData, 'ACG-album')
  );
});

test('legacy databases retain their existing precedence even with a new branded library', () => {
  const old = path.join(documents, 'ACG-album');
  const previous = path.join(documents, 'ACG-album');
  const branded = path.join(documents, APP_NAME);
  const existsSync = existing(
    ...[old, previous, branded].map((directory) => path.join(directory, 'library.sqlite'))
  );
  assert.equal(resolveDataDirectory({ documents, existsSync }), old);
  assert.equal(
    resolveDataDirectory({
      documents,
      existsSync: existing(
        path.join(previous, 'library.sqlite'),
        path.join(branded, 'library.sqlite')
      )
    }),
    previous
  );
});

test('empty legacy directories do not capture a new library', () => {
  assert.equal(
    resolveDataDirectory({
      documents,
      existsSync: existing(path.join(documents, 'ACG-album'), path.join(documents, 'ACG-album'))
    }),
    path.join(documents, APP_NAME)
  );
});

test('existing Electron profiles survive the product rename', () => {
  const previous = path.join(appData, 'ACG-album');
  const old = path.join(appData, 'ACG-album');
  const currentUserData = path.join(appData, 'acg-album');
  assert.equal(
    resolveUserDataDirectory({
      appData,
      currentUserData,
      existsSync: existing(previous, old, currentUserData)
    }),
    previous
  );
  assert.equal(
    resolveUserDataDirectory({
      appData,
      currentUserData,
      existsSync: existing(old, currentUserData)
    }),
    old
  );
  assert.equal(
    resolveUserDataDirectory({ appData, currentUserData, existsSync: existing(currentUserData) }),
    currentUserData
  );
});

test('explicit data overrides keep their isolated Chromium profile and ignore legacy locations', () => {
  const dataDir = path.join('migration-fixture', 'custom-data');
  const existsSync = () => {
    throw new Error('override must not inspect unrelated profiles');
  };
  assert.equal(resolveDataDirectory({ documents, dataDir, existsSync }), path.resolve(dataDir));
  assert.equal(
    resolveUserDataDirectory({ appData, dataDir, existsSync }),
    path.join(path.resolve(dataDir), 'chromium-profile')
  );
});
