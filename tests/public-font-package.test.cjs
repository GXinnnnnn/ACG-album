'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicFontExclusion, publicFontFiles } = require('../scripts/public-font-package.cjs');
const metadata = require('../package.json');
const fontDirectory = 'src/assets/fonts/founder-lanting-yuan/';
const fontFiles = ['regular', 'medium', 'semibold', 'bold', 'heavy'].map(
  (name) => fontDirectory + name + '.ttf'
);

test('public package excludes all five private fonts even when files are present locally', () => {
  const original = [...metadata.build.files];
  const files = publicFontFiles(original);
  assert.deepEqual(original, metadata.build.files, 'Do not change local package defaults');
  assert.notEqual(files, original);
  assert.equal(files.at(-1), publicFontExclusion);
  const exclusion = publicFontExclusion.slice(1);
  for (const file of [...fontFiles, fontDirectory + 'EXTRA.TTF']) {
    assert.ok(path.matchesGlob(file, 'src/**/*'), 'Base configuration would include ' + file);
    assert.ok(path.matchesGlob(file, exclusion), 'Public configuration must exclude ' + file);
  }
  for (const file of [
    fontDirectory + 'PROVENANCE.json',
    fontDirectory + 'README.md',
    'src/ui/typography.css'
  ])
    assert.equal(path.matchesGlob(file, exclusion), false, 'Keep source and provenance: ' + file);
  assert.throws(() => publicFontFiles(undefined), /explicit files array/);
});

test('standard and both search editions apply the same public exclusion after base config', () => {
  for (const script of ['build-standard.cjs', 'build-search-editions.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts', script), 'utf8');
    assert.match(source, /const \{ publicFontFiles \} = require\('\.\/public-font-package\.cjs'\)/);
    assert.match(
      source,
      /\.\.\.metadata\.build,\s*files: publicFontFiles\(metadata\.build\.files\)/
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
