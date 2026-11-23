'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeBrowseSortPreferences } = require('../src/browse-date.cjs');

test('root media has its own descending date default and durable explicit preference', async () => {
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(fs.readFileSync(require.resolve('../src/ui/browse-sort.js'), 'utf8'), context);
  const kit = context.window.albumBrowseSort;
  let saved;
  const memory = kit.create({
    save: async (value) => {
      saved = JSON.parse(JSON.stringify(value));
    }
  });
  memory.set('library', null, { sort: 'name', direction: 'asc' });
  assert.equal(memory.get('library-media').sort, 'contentDate');
  assert.equal(memory.get('library-media').direction, 'desc');
  memory.set('library-media', null, { sort: 'size', direction: 'desc' });
  await memory.flush();
  assert.deepEqual(normalizeBrowseSortPreferences(saved, 'win32'), saved);
  const reopened = kit.create({ save: async () => {} });
  reopened.hydrate(saved, reopened.beginRead());
  assert.equal(reopened.get('library-media').sort, 'size');
  assert.equal(reopened.get('library').sort, 'name');
  assert.equal(reopened.get('library', 'C:\\photos', { insideAlbum: true }).sort, 'contentDate');
});

test('root media routing and unknown-folder defaults do not reuse another view memory', () => {
  const source = fs.readFileSync(require.resolve('../src/ui/app.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    S: { view: 'library', parent: null, filter: 'images' }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/ui/browse-sort.js'), 'utf8'), context);
  vm.runInContext(
    source.slice(
      source.indexOf('function browseSortView('),
      source.indexOf('function browseSortPath(')
    ),
    context
  );
  assert.equal(vm.runInContext('browseSortView()', context), 'library-media');
  assert.equal(
    vm.runInContext("browseSortView('library', 'folder', 'images')", context),
    'library'
  );
  assert.equal(
    vm.runInContext("browseSortView('favorites', null, 'images')", context),
    'favorites'
  );
  const defaults = context.window.albumBrowseSort.defaults('library', { insideAlbum: true });
  assert.equal(defaults.sort, 'contentDate');
  assert.equal(defaults.direction, 'desc');
});
