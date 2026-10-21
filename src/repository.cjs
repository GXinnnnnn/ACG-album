'use strict';

const OFFICIAL_REPOSITORY = 'GXinnnnnn/ACG-album';

function effectiveRepository(value) {
  return value == null || (typeof value === 'string' && !value.trim())
    ? OFFICIAL_REPOSITORY
    : value;
}

function officialDownloads(version) {
  const base = `https://github.com/${OFFICIAL_REPOSITORY}/releases`;
  const tag = encodeURIComponent(`v${version}`);
  return {
    releaseUrl: `${base}/tag/${tag}`,
    downloads: {
      lite: `${base}/download/${tag}/ACG-album-Setup-${encodeURIComponent(version)}-Lite.exe`,
      full: `${base}/download/${tag}/ACG-album-Setup-${encodeURIComponent(version)}-Full.exe`
    }
  };
}

function validRepository(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0]) &&
    /^[a-z\d._-]{1,100}$/i.test(parts[1]) &&
    !/^\.{1,2}$/.test(parts[1])
  );
}

module.exports = { OFFICIAL_REPOSITORY, effectiveRepository, officialDownloads, validRepository };
