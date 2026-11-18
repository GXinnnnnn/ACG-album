'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// Only directory selection is controlled input. Every library operation still
// crosses the real preload/IPC/main/worker boundary in development and packaged GUI runs.
async function exerciseGuiLibrary(app, page, { importRoot, originalAlbum }) {
  assert.ok(path.isAbsolute(importRoot), 'Import fixture root must be absolute');
  assert.ok(path.isAbsolute(originalAlbum), 'Import fixture album must be absolute');
  const relativeAlbum = path.relative(importRoot, originalAlbum);
  assert.ok(
    relativeAlbum &&
      !relativeAlbum.startsWith('..' + path.sep) &&
      relativeAlbum !== '..' &&
      !path.isAbsolute(relativeAlbum),
    'Import fixture album must be inside the fixture root'
  );
  let step = 'settings:autoMatch';
  const rpc = async (method, args) => {
    step = method + (method === 'get' ? (args.path ? ':path' : ':id') : '');
    return page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
  };
  try {
    await rpc('settings', { key: 'autoMatch', value: false });
    let picker;
    let importError;
    let scan;
    try {
      step = 'fixture-chooser:install';
      picker = await app.evaluateHandle(({ dialog }, directory) => {
        const original = dialog.showOpenDialog;
        if (typeof original !== 'function') throw new Error('Missing native directory chooser');
        const state = { original, calls: [] };
        state.replacement = async (...args) => {
          const [window, options] = args;
          const observed = {
            argumentCount: args.length,
            hasWindow: !!window,
            title: options?.title,
            properties: options?.properties
          };
          state.calls.push(observed);
          if (
            state.calls.length !== 1 ||
            args.length !== 2 ||
            !window ||
            !options ||
            Object.keys(options).sort().join(',') !== 'properties,title' ||
            options.title !== '选择要导入的相册分类' ||
            !Array.isArray(options.properties) ||
            options.properties.length !== 2 ||
            options.properties[0] !== 'openDirectory' ||
            options.properties[1] !== 'dontAddToRecent'
          )
            throw new Error('Unexpected fixture chooser request: ' + JSON.stringify(observed));
          return { canceled: false, filePaths: [directory] };
        };
        try {
          dialog.showOpenDialog = state.replacement;
          if (dialog.showOpenDialog !== state.replacement)
            throw new Error('Cannot install controlled fixture chooser');
          return state;
        } catch (error) {
          try {
            dialog.showOpenDialog = original;
            if (dialog.showOpenDialog !== original) throw new Error('Chooser restoration failed');
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              'Fixture chooser installation and restoration failed',
              { cause: error }
            );
          }
          throw error;
        }
      }, importRoot);
      // The renderer cannot supply a path or call worker-only scan. The native
      // import handler sanitizes these options and obtains the path from the chooser.
      scan = await rpc('import', { onlineMatch: false, directoryKind: 'photo' });
      assert.ok(
        scan && typeof scan === 'object' && !Array.isArray(scan),
        'Import returned no scan result'
      );
      assert.equal(scan.errors, 0, 'Import scan must complete without errors');
      assert.notEqual(scan.cancelled, true, 'Import must not be cancelled');
      assert.notEqual(scan.paused, true, 'Import must not be paused');
      assert.equal(typeof scan.root, 'string', 'Import must identify its root');
      assert.ok(scan.root, 'Import root ID must not be empty');
      step = 'fixture-chooser:verify';
      const chooser = await app.evaluate(
        ({ dialog }, state) => ({
          calls: state.calls,
          installed: dialog.showOpenDialog === state.replacement
        }),
        picker
      );
      assert.equal(chooser.installed, true, 'Fixture chooser changed during import');
      assert.equal(chooser.calls.length, 1, 'Import must use exactly one native directory chooser');
    } catch (error) {
      importError = new Error(`[mac-gui-library:${step}] ${error.message}`, { cause: error });
      throw importError;
    } finally {
      if (picker) {
        const cleanupErrors = [];
        try {
          step = 'fixture-chooser:restore';
          await app.evaluate(({ dialog }, state) => {
            const unchanged = dialog.showOpenDialog === state.replacement;
            dialog.showOpenDialog = state.original;
            if (dialog.showOpenDialog !== state.original)
              throw new Error('Native directory chooser was not restored');
            if (!unchanged)
              throw new Error('Fixture chooser was unexpectedly replaced during import');
          }, picker);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await picker.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length) {
          throw new AggregateError(
            [...(importError ? [importError] : []), ...cleanupErrors],
            '[mac-gui-library:fixture-chooser:restore] Cleanup failed',
            { cause: importError || cleanupErrors[0] }
          );
        }
      }
    }
    const before = await rpc('get', { path: originalAlbum });
    assert.ok(before && before.kind === 'folder', 'Imported fixture album not found');
    assert.equal(before.path, originalAlbum, 'Imported album path differs from fixture');
    assert.equal(before.root, scan.root, 'Imported album is outside the selected root');
    const patched = await rpc('patch', { id: before.id, changes: { favorite: 1 } });
    assert.equal(patched?.id, before.id, 'Favorite patch returned a different album');
    assert.equal(patched.favorite, 1, 'Favorite patch did not persist');
    const rename = await rpc('rename', { id: before.id, name: 'Renamed Album' });
    assert.equal(rename?.renamed, true, 'Fixture album was not renamed');
    assert.equal(rename.oldId, before.id, 'Rename returned a different source ID');
    assert.equal(rename.oldPath, originalAlbum, 'Rename returned a different source path');
    assert.equal(rename.path, path.join(path.dirname(originalAlbum), 'Renamed Album'));
    assert.equal(typeof rename.id, 'string', 'Rename must return its new ID');
    assert.notEqual(rename.id, before.id, 'Rename must remap the path-derived ID');
    const after = await rpc('get', { id: rename.id });
    assert.equal(after?.id, rename.id, 'Renamed album could not be read by its new ID');
    assert.equal(after.path, rename.path, 'Renamed album has an unexpected path');
    assert.equal(after.name, 'Renamed Album');
    assert.equal(after.favorite, 1, 'Favorite must survive rename');
    const favorites = await rpc('list', { favorites: true });
    assert.ok(Array.isArray(favorites?.items), 'Favorites list must contain an items array');
    assert.ok(
      favorites.items.some((item) => item.id === after.id && item.favorite === 1),
      'Favorites list does not contain the renamed album'
    );
    return { scan, before, rename, after, favorites };
  } catch (error) {
    if (error.message.startsWith('[mac-gui-library:')) throw error;
    throw new Error(`[mac-gui-library:${step}] ${error.message}`, { cause: error });
  }
}

module.exports = { exerciseGuiLibrary };
