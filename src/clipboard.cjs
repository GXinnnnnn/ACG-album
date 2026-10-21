'use strict';
const { clipboard } = require('electron');

// Windows can briefly refuse ownership while another process reads the clipboard.
// Verify the bitmap before reporting success; retry only this explicit user action.
async function writeBitmap(image) {
  const wanted = image.getSize();
  for (let attempt = 0; attempt < 4; attempt++) {
    clipboard.writeImage(image);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = clipboard.readImage(),
      size = result.getSize();
    if (!result.isEmpty() && size.width === wanted.width && size.height === wanted.height)
      return true;
  }
  throw new Error('系统剪贴板正忙，图片暂未复制，请再试一次。');
}
module.exports = { writeBitmap };
