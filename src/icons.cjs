'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function largestPngFromIco(data) {
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return null;
  const count = data.readUInt16LE(4),
    entries = [];
  if (count > 256 || 6 + count * 16 > data.length) return null;
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16,
      bytes = data.readUInt32LE(p + 8),
      start = data.readUInt32LE(p + 12);
    if (start < 6 + count * 16 || start + bytes > data.length || bytes < 8) continue;
    if (data.subarray(start, start + 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      entries.push({ area: (data[p] || 256) * (data[p + 1] || 256), bytes, start });
  }
  entries.sort((a, b) => b.area - a.area || b.bytes - a.bytes);
  const best = entries[0];
  return best ? data.subarray(best.start, best.start + best.bytes) : null;
}

async function customFolderIco(folder) {
  try {
    const bytes = await fs.readFile(path.join(folder, 'desktop.ini'));
    let text =
      (bytes[0] === 255 && bytes[1] === 254) || bytes.includes(0)
        ? bytes.toString('utf16le')
        : bytes.toString('utf8');
    if (text.includes('\uFFFD')) text = new TextDecoder('gb18030').decode(bytes);
    const value =
      text.match(/^\s*IconResource\s*=\s*(.+)$/im)?.[1] ||
      text.match(/^\s*IconFile\s*=\s*(.+)$/im)?.[1];
    if (!value) return null;
    const name = value
      .trim()
      .replace(/,\s*-?\d+\s*$/, '')
      .replace(/^"(.*)"$/, '$1')
      .replace(/%([^%]+)%/g, (all, key) => process.env[key] || all);
    if (path.extname(name).toLowerCase() !== '.ico') return null;
    const file = path.resolve(folder, name),
      stat = await fs.stat(file);
    return stat.isFile() && stat.size <= 16 * 1024 * 1024 ? file : null;
  } catch {
    return null;
  }
}
module.exports = { largestPngFromIco, customFolderIco };
