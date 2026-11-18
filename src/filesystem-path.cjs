'use strict';
const path = require('node:path');

// Paths are filesystem identities, not search text. Keep the original Unicode
// spelling and case on POSIX, including case-sensitive APFS volumes. Windows
// deliberately retains the exact resolve().toLowerCase() input used by old IDs.
const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);
function pathKey(value, platform = process.platform) {
  const absolute = pathApi(platform).resolve(value);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function samePath(a, b, platform = process.platform) {
  return pathKey(a, platform) === pathKey(b, platform);
}
function containsPath(parent, child, platform = process.platform) {
  const api = pathApi(platform);
  const relative = api.relative(pathKey(parent, platform), pathKey(child, platform));
  return (
    !relative ||
    (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + api.sep))
  );
}
const pathCollation = (platform = process.platform) => (platform === 'win32' ? 'NOCASE' : 'BINARY');

module.exports = { pathKey, samePath, containsPath, pathCollation };
