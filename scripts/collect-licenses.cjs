'use strict';
// Run with Node >= 22: node scripts/collect-licenses.cjs [--refresh-upstream]
// Writes only src/assets/licenses; never runs Electron as a GUI or a build.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'src/assets/licenses');
const hash = (b) => createHash('sha256').update(b).digest('hex');
function save(relative, bytes) {
  const target = path.resolve(out, relative);
  if (!target.startsWith(out + path.sep)) throw Error('Invalid output path');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { file: relative.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
function packageRoot(name, from = path.join(root, 'package.json')) {
  const req = createRequire(from);
  for (const entry of [name + '/package.json', name + '/package', name]) {
    try {
      let loc = req.resolve(entry);
      if (!loc.endsWith('package.json')) loc = path.dirname(loc);
      else return path.dirname(loc);
      while (loc !== path.dirname(loc)) {
        const file = path.join(loc, 'package.json');
        if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).name === name) return loc;
        loc = path.dirname(loc);
      }
    } catch {}
  }
  throw Error('Installed package not found: ' + name);
}
const nativeSources = [
  ['libvips/LICENSE', 'libvips/libvips/v8.17.3/LICENSE'],
  ['libvips/UPSTREAM-README.md', 'libvips/libvips/v8.17.3/README.md'],
  ['libvips/native/libnsgif-COPYING', 'libvips/libvips/v8.17.3/libvips/foreign/libnsgif/COPYING'],
  [
    'libvips/native/mozjpeg-README.ijg',
    'mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/README.ijg'
  ],
  ['libvips/SHARP-THIRD-PARTY-NOTICES.md', 'lovell/sharp-libvips/v1.2.4/THIRD-PARTY-NOTICES.md'],
  ['libvips/BUILD-SOURCE.sh', 'lovell/sharp-libvips/v1.2.4/build/win.sh'],
  ['libvips/BUILD-README.md', 'libvips/build-win64-mxe/v8.17.3/README.md'],
  ['libvips/GPL-3.0.txt', 'gcc-mirror/gcc/master/COPYING3'],
  ['libvips/LGPL-3.0.txt', 'gcc-mirror/gcc/master/COPYING3.LIB'],
  ['libvips/native/aom-LICENSE', 'libsdl-org/aom/v3.13.1/LICENSE'],
  ['libvips/native/aom-PATENTS', 'libsdl-org/aom/v3.13.1/PATENTS'],
  [
    'libvips/native/cairo-COPYING',
    'https://gitlab.freedesktop.org/cairo/cairo/-/raw/1.18.4/COPYING'
  ],
  [
    'libvips/native/cairo-COPYING-MPL-1.1',
    'https://gitlab.freedesktop.org/cairo/cairo/-/raw/1.18.4/COPYING-MPL-1.1'
  ],
  ['libvips/native/MPL-2.0.txt', 'https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt'],
  ['libvips/native/cgif-LICENSE', 'dloebl/cgif/v0.5.0/LICENSE'],
  ['libvips/native/expat-COPYING', 'libexpat/libexpat/R_2_7_3/expat/COPYING'],
  ['libvips/native/fontconfig-COPYING', 'fontconfig/fontconfig/2.17.1/COPYING'],
  ['libvips/native/freetype-FTL.TXT', 'freetype/freetype/VER-2-14-1/docs/FTL.TXT'],
  ['libvips/native/fribidi-COPYING', 'fribidi/fribidi/v1.0.16/COPYING'],
  ['libvips/native/glib-COPYING', 'GNOME/glib/2.86.1/COPYING'],
  ['libvips/native/harfbuzz-COPYING', 'harfbuzz/harfbuzz/12.1.0/COPYING'],
  ['libvips/native/highway-LICENSE', 'google/highway/1.3.0/LICENSE'],
  ['libvips/native/highway-LICENSE-BSD3', 'google/highway/1.3.0/LICENSE-BSD3'],
  ['libvips/native/lcms-LICENSE', 'mm2/Little-CMS/lcms2.17/LICENSE'],
  ['libvips/native/libarchive-COPYING', 'libarchive/libarchive/v3.8.2/COPYING'],
  ['libvips/native/libexif-COPYING', 'libexif/libexif/v0.6.25/COPYING'],
  ['libvips/native/libffi-LICENSE', 'libffi/libffi/v3.5.2/LICENSE'],
  ['libvips/native/libheif-COPYING', 'strukturag/libheif/v1.20.2/COPYING'],
  ['libvips/native/libimagequant-COPYRIGHT', 'lovell/libimagequant/main/COPYRIGHT'],
  ['libvips/native/libpng-LICENSE', 'pnggroup/libpng/v1.6.50/LICENSE'],
  ['libvips/native/librsvg-COPYING.LIB', 'GNOME/librsvg/2.61.2/COPYING.LIB'],
  ['libvips/native/libspng-LICENSE', 'randy408/libspng/v0.7.4/LICENSE'],
  ['libvips/native/libtiff-LICENSE.md', 'libsdl-org/libtiff/v4.7.1/LICENSE.md'],
  ['libvips/native/libwebp-COPYING', 'webmproject/libwebp/v1.6.0/COPYING'],
  ['libvips/native/libwebp-PATENTS', 'webmproject/libwebp/v1.6.0/PATENTS'],
  ['libvips/native/libxml2-Copyright', 'GNOME/libxml2/v2.15.1/Copyright'],
  [
    'libvips/native/mozjpeg-LICENSE.md',
    'mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/LICENSE.md'
  ],
  ['libvips/native/pango-COPYING', 'GNOME/pango/1.57.0/COPYING'],
  [
    'libvips/native/pixman-COPYING',
    'https://gitlab.freedesktop.org/pixman/pixman/-/raw/pixman-0.46.4/COPYING'
  ],
  ['libvips/native/proxy-libintl-COPYING', 'frida/proxy-libintl/0.5/COPYING'],
  ['libvips/native/zlib-ng-LICENSE.md', 'zlib-ng/zlib-ng/2.2.5/LICENSE.md'],
  ['lucide/FEATHER-LICENSE', 'feathericons/feather/v4.29.2/LICENSE'],
  ['lucide/LICENSE', 'lucide-icons/lucide/0.468.0/LICENSE'],
  ['lucide/plus.svg', 'lucide-icons/lucide/0.468.0/icons/plus.svg'],
  ['lucide/x.svg', 'lucide-icons/lucide/0.468.0/icons/x.svg']
];
async function main() {
  const entries = [];
  const seen = new Set();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  function collect(name, from) {
    const dir = packageRoot(name, from);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    const key = `${meta.name}@${meta.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    const artifacts = fs
      .readdirSync(dir)
      .filter(
        (n) =>
          /^(licen[cs]e|notice|copying|copyright)([.-]|$)/i.test(n) &&
          fs.statSync(path.join(dir, n)).isFile()
      );
    if (!artifacts.length) throw Error('No license artifact: ' + key);
    for (const file of artifacts)
      entries.push({
        package: meta.name,
        version: meta.version,
        license: meta.license,
        source: 'node_modules/' + meta.name + '/' + file,
        ...save(
          'npm/' + meta.name.replaceAll('/', '__') + '/' + file,
          fs.readFileSync(path.join(dir, file))
        )
      });
    for (const dependency of Object.keys(meta.dependencies || {}))
      collect(dependency, path.join(dir, 'package.json'));
    for (const dependency of Object.keys(meta.optionalDependencies || {})) {
      try {
        packageRoot(dependency, path.join(dir, 'package.json'));
      } catch {
        continue;
      }
      collect(dependency, path.join(dir, 'package.json'));
    }
  }
  for (const name of Object.keys(pkg.dependencies || {}))
    collect(name, path.join(root, 'package.json'));
  const testDir = packageRoot('@playwright/test');
  const playwrightDir = packageRoot('playwright', path.join(testDir, 'package.json'));
  for (const [name, dir] of [
    ['prettier', packageRoot('prettier')],
    ['electron-builder', packageRoot('electron-builder')],
    ['@playwright/test', testDir],
    ['playwright', playwrightDir],
    ['playwright-core', packageRoot('playwright-core', path.join(playwrightDir, 'package.json'))]
  ]) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    for (const file of fs
      .readdirSync(dir)
      .filter((n) => /^(licen[cs]e|notice|thirdpartynotices)([.-]|$)/i.test(n))) {
      entries.push({
        package: name,
        version: meta.version,
        license: meta.license,
        development: true,
        source: 'node_modules/' + name + '/' + file,
        ...save(
          'development/' + name.replaceAll('/', '__') + '/' + file,
          fs.readFileSync(path.join(dir, file))
        )
      });
    }
  }
  const native = packageRoot('@img/sharp-win32-x64');
  for (const file of ['README.md', 'versions.json', 'package.json'])
    entries.push({
      source: 'node_modules/@img/sharp-win32-x64/' + file,
      ...save('libvips/SHARP-' + file, fs.readFileSync(path.join(native, file)))
    });
  const electron = packageRoot('electron');
  entries.push({
    source: 'node_modules/electron/dist/LICENSE',
    ...save('electron/LICENSE', fs.readFileSync(path.join(electron, 'dist/LICENSE')))
  });
  const chromium = fs.readFileSync(path.join(electron, 'dist/LICENSES.chromium.html'));
  for (const text of ['<span class="title">Node.js</span>', '<span class="title">sqlite</span>'])
    if (!chromium.toString().includes(text))
      throw Error('Missing Electron runtime license section ' + text);
  for (const [relative, raw] of nativeSources) {
    const url = raw.startsWith('https://') ? raw : 'https://raw.githubusercontent.com/' + raw;
    const dest = path.join(out, relative);
    if (process.argv.includes('--refresh-upstream') || !fs.existsSync(dest)) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!response.ok) throw Error('HTTP ' + response.status);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.toString().startsWith('<!DOCTYPE'))
          throw Error('Not a license/source artifact');
        save(relative, bytes);
      } catch (error) {
        console.error(relative + ': ' + url + ': ' + error.message);
        continue;
      }
    }
    if (fs.existsSync(dest))
      entries.push({ source: url, ...save(relative, fs.readFileSync(dest)) });
  }
  const missing = nativeSources.filter(([relative]) => !fs.existsSync(path.join(out, relative)));
  const binaries = fs
    .readdirSync(path.join(native, 'lib'))
    .filter((n) => /\.(dll|node)$/i.test(n))
    .map((file) => {
      const bytes = fs.readFileSync(path.join(native, 'lib', file));
      return { file, bytes: bytes.length, sha256: hash(bytes) };
    });
  const manifest = {
    format: 1,
    scope: 'Windows x64 runtime; original upstream license artifacts retained verbatim',
    nativeBinaries: binaries,
    chromium: {
      source: 'node_modules/electron/dist/LICENSES.chromium.html',
      distribution: 'LICENSES.chromium.html beside the executable',
      bytes: chromium.length,
      sha256: hash(chromium)
    },
    artifacts: entries
  };
  save('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  console.log(
    JSON.stringify(
      {
        copiedArtifacts: entries.length,
        missing: missing.map(([file]) => file),
        runtimePackages: [...seen],
        chromiumBytes: chromium.length
      },
      null,
      2
    )
  );
  if (missing.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
