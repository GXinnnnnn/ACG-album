'use strict';
// Prepare only application assets; imported albums are never read or modified.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const staged = path.join(root, 'artifacts', 'asset-sources');
(async () => {
  for (const platform of ['github', 'bilibili']) {
    const input = path.join(
      staged,
      platform === 'github' ? 'github-avatar.png' : 'bilibili-avatar.jpg'
    );
    const output = path.join(root, 'src', 'assets', 'author', platform + '.webp');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await sharp(input)
      .rotate()
      .resize(128, 128, { fit: 'cover' })
      .webp({ quality: 86 })
      .toFile(output);
  }
  const sources = [
    {
      name: 'alipay',
      file: 'alipay-original.png',
      rect: { left: 200, top: 595, width: 680, height: 680 },
      border: 64
    },
    {
      name: 'wechat',
      file: 'wechat-original.jpg',
      rect: { left: 310, top: 384, width: 498, height: 498 },
      border: 48
    }
  ];
  const report = [];
  for (const source of sources) {
    const input = path.join(staged, source.file),
      output = path.join(root, 'src', 'assets', 'sponsor', source.name + '-qr.png');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const expected = await sharp(input).extract(source.rect).removeAlpha().raw().toBuffer();
    await sharp(input)
      .extract(source.rect)
      .extend({
        top: source.border,
        bottom: source.border,
        left: source.border,
        right: source.border,
        background: '#ffffff'
      })
      .png({ compressionLevel: 9 })
      .toFile(output);
    const actual = await sharp(output)
      .extract({
        left: source.border,
        top: source.border,
        width: source.rect.width,
        height: source.rect.height
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(actual, expected, source.name + ' source pixels must remain unchanged');
    report.push({
      platform: source.name,
      sourceRectangle: source.rect,
      whiteBorder: source.border,
      retainedPixelsIdentical: true,
      bytes: (await fs.stat(output)).size
    });
  }
  await fs.writeFile(
    path.join(staged, 'crop-verification.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
