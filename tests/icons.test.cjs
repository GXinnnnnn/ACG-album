'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const sharp = require('sharp');
const { largestPngFromIco, customFolderIco } = require('../src/icons.cjs');
test('uses the largest embedded PNG layer without accepting malformed ICO offsets', async () => {
  const ico = await fs.readFile(path.resolve('src/assets/app.ico')),
    png = largestPngFromIco(ico),
    meta = await sharp(png).metadata();
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.equal(largestPngFromIco(Buffer.from([0, 0, 1, 0])), null);
  const bad = Buffer.from(ico);
  bad.writeUInt16LE(65535, 4);
  assert.equal(largestPngFromIco(bad), null);
});
test('reads UTF-16 Windows custom folder icons without modifying desktop.ini', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-ico-'));
  try {
    const ico = path.resolve('src/assets/app.ico'),
      ini = Buffer.from('\uFEFF[.ShellClassInfo]\r\nIconResource="' + ico + '",0\r\n', 'utf16le');
    await fs.writeFile(path.join(dir, 'desktop.ini'), ini);
    assert.equal(await customFolderIco(dir), ico);
    assert.deepEqual(await fs.readFile(path.join(dir, 'desktop.ini')), ini);
    await fs.writeFile(
      path.join(dir, 'desktop.ini'),
      '[.ShellClassInfo]\r\nIconResource=C:\\Windows\\System32\\imageres.dll,-3'
    );
    assert.equal(await customFolderIco(dir), null);
  } finally {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'acg-ico-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
