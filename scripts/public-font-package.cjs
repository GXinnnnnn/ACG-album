'use strict';

const provenance = require('../src/assets/fonts/source-han-sans/PROVENANCE.json');
const fontDirectory = 'src/assets/fonts/source-han-sans/';
const licensedFont = Object.freeze({
  path: fontDirectory + provenance.font.file,
  bytes: provenance.font.bytes,
  sha256: provenance.font.sha256,
  licensePath: fontDirectory + provenance.licenseFile,
  licenseSha256: provenance.licenseSha256
});
// Apply the exclusion after broad source globs, then re-include only this exact
// licensed font. Character classes also exclude mixed-case extension aliases.
const publicFontExclusion =
  '!**/*.{[tT][tT][fF],[oO][tT][fF],[wW][oO][fF][fF],[wW][oO][fF][fF]2,[tT][tT][cC],[oO][tT][cC],[eE][oO][tT]}';
const fontPath = /\.(?:ttf|otf|woff2?|ttc|otc|eot)$/i;
function isFontPath(value) {
  return fontPath.test(value);
}
function isPrivateFontPath(value) {
  return isFontPath(value) && value.replaceAll('\\', '/') !== licensedFont.path;
}
function publicFontFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('Public packages require an explicit files array');
  return [...files, publicFontExclusion, licensedFont.path];
}
module.exports = {
  publicFontExclusion,
  publicFontFiles,
  isPrivateFontPath,
  isFontPath,
  licensedFont
};
