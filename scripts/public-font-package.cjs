'use strict';

// Private local font copies have no public redistribution grant. Keep this
// exclusion last so broad source globs cannot opt them back into a release.
const publicFontExclusion = '!**/*.{ttf,TTF}';

function publicFontFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('Public packages require an explicit files array');
  return [...files, publicFontExclusion];
}

module.exports = { publicFontExclusion, publicFontFiles };
