'use strict';
// Deterministic, dependency-free NSIS artwork. Run: node build/generate-installer-art.cjs
// Original geometric album motif; no downloaded art, fonts, icons or plugins.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = __dirname;
const palette = {
  background: [233, 235, 244], // src/ui/styles.css --bg
  surface: [247, 247, 252], // --surface-solid
  accent: [198, 70, 131], // --accent
  bright: [238, 141, 185] // --accent-bright
};
function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}
function rounded(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && x < left + width && y >= top && y < top + height &&
    dx * dx + dy * dy <= radius * radius;
}
function pixel(x, y, width, height, sidebar) {
  const centerX = sidebar ? width * 0.5 : width * 0.75;
  const centerY = sidebar ? height * 0.4 : height * 0.5;
  const glow = Math.max(0, 1 - Math.hypot(x - centerX, y - centerY) / (width * 0.9));
  let color = mix(palette.surface, palette.background, sidebar ? y / height * 0.7 : 0.18);
  color = mix(color, palette.bright, glow * 0.12);
  const size = sidebar ? 82 : 40;
  const left = centerX - size / 2;
  const top = centerY - size / 2;
  // Three offset photo sheets and an inset photograph, without a security shield.
  if (rounded(x, y, left - size * 0.12, top + size * 0.1, size, size, size * 0.16))
    color = mix(palette.surface, palette.accent, 0.12);
  if (rounded(x, y, left + size * 0.05, top - size * 0.08, size, size, size * 0.16))
    color = mix(palette.surface, palette.bright, 0.45);
  if (rounded(x, y, left, top, size, size, size * 0.16))
    color = [255, 255, 255];
  if (rounded(x, y, left + size * 0.12, top + size * 0.12, size * 0.76, size * 0.64, size * 0.07)) {
    color = mix(palette.bright, palette.accent, 0.28 + (y - top) / size * 0.35);
    const hill = top + size * 0.63 - Math.abs(x - (left + size * 0.48)) * 0.5;
    if (y > hill) color = mix(color, palette.surface, 0.65);
    if (Math.hypot(x - (left + size * 0.7), y - (top + size * 0.29)) < size * 0.075)
      color = palette.surface;
  }
  if (sidebar && y > height * 0.83 && y < height * 0.83 + 2 && Math.abs(x - centerX) < 23)
    color = mix(palette.surface, palette.accent, 0.3);
  return color;
}
function bitmap(width, height, sidebar) {
  const stride = (width * 3 + 3) & ~3;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  bytes.writeInt32LE(3780, 38);
  bytes.writeInt32LE(3780, 42);
  // Four samples per pixel give the source geometry a smooth edge.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
      .map(([dx, dy]) => pixel(x + dx, y + dy, width, height, sidebar));
    const rgb = [0, 1, 2].map(channel => Math.round(samples.reduce((sum, sample) => sum + sample[channel], 0) / 4));
    const offset = 54 + (height - 1 - y) * stride + x * 3;
    bytes[offset] = rgb[2];
    bytes[offset + 1] = rgb[1];
    bytes[offset + 2] = rgb[0];
  }
  return bytes;
}
// Refuse traversal through a junction/symlink or an unrelated pre-existing file.
for (let current = directory; ; current = path.dirname(current)) {
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked resource directory refused: ' + current);
  if (path.dirname(current) === current) break;
}
for (const [name, width, height, sidebar] of [
  ['installer-header.bmp', 150, 57, false],
  ['installer-sidebar.bmp', 164, 314, true]
]) {
  const file = path.join(directory, name);
  const bytes = bitmap(width, height, sidebar);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(file).equals(bytes))
      throw new Error('Refusing to replace an unrelated resource: ' + file);
  } else fs.writeFileSync(file, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ file, width, height, bitsPerPixel: 24, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
}
