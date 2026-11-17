'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const { FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher');
const {
  publicFontExclusion,
  publicFontFiles,
  isPrivateFontPath,
  licensedFont
} = require('../scripts/public-font-package.cjs');
const metadata = require('../package.json');
const fontDirectory = 'src/assets/fonts/founder-lanting-yuan/';
const fontFiles = ['regular', 'medium', 'semibold', 'bold', 'heavy'].map(
  (name) => fontDirectory + name + '.ttf'
);

test('actual builder filters permit only the exact licensed font across all package entrypoints', () => {
  const original = [...metadata.build.files];
  const files = publicFontFiles(original);
  assert.deepEqual(original, metadata.build.files, 'Do not mutate caller configuration');
  assert.notEqual(files, original);
  assert.equal(files.at(-2), publicFontExclusion);
  assert.equal(files.at(-1), licensedFont.path);
  assert.ok(
    original.includes(publicFontExclusion),
    'Base directory and installer must apply the exclusion'
  );
  assert.ok(
    original.indexOf(licensedFont.path) > original.indexOf(publicFontExclusion),
    'Base config must re-include only the approved path'
  );
  const root = path.resolve(__dirname, '..');
  const filters = [original, files].map((patterns) =>
    new FileMatcher(root, root, (value) => value, patterns).createFilter()
  );
  const privateFiles = [
    ...fontFiles,
    ...['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc', 'eot'].flatMap((extension) =>
      [extension, extension.toUpperCase()].flatMap((extension) => [
        fontDirectory + 'nested/EXTRA.' + extension,
        'src/moved-font.' + extension
      ])
    ),
    'src/copied-font.TtF',
    'src/copied-font.WoFf2',
    'elsewhere/SourceHanSansSC-VF.otf',
    'src/assets/fonts/source-han-sans/other.otf',
    'src/assets/fonts/source-han-sans/sourcehansanssc-vf.otf'
  ];
  for (const file of privateFiles) {
    for (const filter of filters)
      assert.equal(filter(path.join(root, file), { isDirectory: () => false }), false, file);
    assert.equal(isPrivateFontPath(file), true);
  }
  for (const file of [
    fontDirectory + 'PROVENANCE.json',
    fontDirectory + 'README.md',
    'src/ui/typography.css',
    licensedFont.path,
    licensedFont.licensePath
  ]) {
    for (const filter of filters)
      assert.equal(filter(path.join(root, file), { isDirectory: () => false }), true, file);
    assert.equal(isPrivateFontPath(file), false);
  }
  for (const directory of [
    'src',
    'src/assets',
    'src/assets/fonts',
    'src/assets/fonts/source-han-sans'
  ])
    for (const filter of filters)
      assert.equal(
        filter(path.join(root, directory), { isDirectory: () => true }),
        true,
        directory
      );
  assert.equal(
    isPrivateFontPath('resources\\fonts\\founder-lanting-yuan\\nested\\font.WoFf2'),
    true
  );
  assert.throws(() => publicFontFiles(undefined), /explicit files array/);
});

test('standard and both search editions apply public exclusion without reinheriting build config', () => {
  for (const script of ['build-standard.cjs', 'build-search-editions.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts', script), 'utf8');
    assert.match(source, /const \{ publicFontFiles \} = require\('\.\/public-font-package\.cjs'\)/);
    assert.match(source, /files: publicFontFiles\(metadata\.build\.files\)/);
    assert.doesNotMatch(
      source,
      /\.\.\.metadata\.build\s*[,}]/,
      'electron-builder inherits the base config; spreading it duplicates resource copy tasks'
    );
    assert.equal((source.match(/files: publicFontFiles/g) || []).length, 1);
  }
});

test('private originals alone are ignored; font provenance stays publishable', () => {
  const ignored = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8').split(/\r?\n/);
  for (const file of fontFiles) assert.ok(ignored.includes('/' + file));
  for (const file of [fontDirectory + 'PROVENANCE.json', fontDirectory + 'README.md'])
    assert.equal(ignored.includes('/' + file), false);
  assert.equal(ignored.includes('/' + fontDirectory), false);
});
