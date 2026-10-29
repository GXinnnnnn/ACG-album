'use strict';

const { validRepository } = require('./repository.cjs');
const EDITIONS = ['standard', 'lite', 'full'];
const MAX_INSTALLER_BYTES = 8 * 1024 ** 3;
const MAX_METADATA_BYTES = 2 * 1024 ** 2;

function githubAssetUrl(value, repository, tag, name) {
  try {
    const url = new URL(value);
    const expected = `/${repository}/releases/download/${tag}/${name}`;
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.hostname === 'github.com' &&
      decodeURIComponent(url.pathname) === expected
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function releaseAssets(release, repository, version) {
  if (!validRepository(repository) || !/^\d+\.\d+\.\d+$/.test(version)) return [];
  const assets = Array.isArray(release.assets) ? release.assets.slice(0, 100) : [];
  return EDITIONS.flatMap((edition) => {
    const label = edition[0].toUpperCase() + edition.slice(1);
    const name = `ACG-album-Setup-${version}-${label}.exe`;
    // Duplicate names and unsupported platform/architecture assets are never guessed.
    const matches = assets.filter((row) => row?.name === name);
    if (matches.length !== 1) return [];
    const asset = matches[0];
    const url = githubAssetUrl(asset.browser_download_url, repository, release.tag_name, name);
    if (
      !url ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > MAX_INSTALLER_BYTES
    )
      return [];
    const checksumMatches = assets.filter((row) => row?.name === name + '.sha256');
    const checksum = checksumMatches.length === 1 ? checksumMatches[0] : null;
    const checksumUrl =
      checksum && Number.isSafeInteger(checksum.size) && checksum.size > 0 && checksum.size <= 65536
        ? githubAssetUrl(checksum.browser_download_url, repository, release.tag_name, checksum.name)
        : '';
    const digest = /^sha256:[a-f\d]{64}$/i.test(asset.digest || '')
      ? asset.digest.slice(7).toLowerCase()
      : '';
    return [
      {
        edition,
        name,
        size: asset.size,
        url,
        sha256: digest,
        checksumUrl,
        verifiable: !!(digest || checksumUrl)
      }
    ];
  });
}

async function readLimited(response, limit = MAX_METADATA_BYTES) {
  // The json fallback is for injected test transports. Electron fetch exposes body.
  if (!response.body) {
    const data = await response.json();
    if (Buffer.byteLength(JSON.stringify(data) || '') > limit) throw new Error('更新数据过大。');
    return JSON.stringify(data);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('更新数据过大。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function checksumFor(text, name) {
  const rows = String(text).trim().split(/\r?\n/).filter(Boolean);
  if (rows.length === 1 && /^[a-f\d]{64}$/i.test(rows[0].trim()))
    return rows[0].trim().toLowerCase();
  const matches = rows
    .map((row) => /^([a-f\d]{64})\s+\*?(.+)$/i.exec(row))
    .filter((match) => match && match[2] === name);
  if (matches.length !== 1) throw new Error('发布的 SHA-256 校验文件无效。');
  return matches[0][1].toLowerCase();
}

async function fetchAsset(fetch, value, signal) {
  let url = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.hash ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com'
      ].includes(target.hostname)
    )
      throw new Error('更新下载地址或重定向不安全。');
    const response = await fetch(target.href, {
      redirect: 'manual',
      credentials: 'omit',
      signal,
      headers: { 'User-Agent': 'ACG-album updater', Accept: 'application/octet-stream' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('更新下载重定向无效。');
      url = new URL(location, target).href;
      continue;
    }
    if (!response.ok || response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`下载失败（${response.status}），请重试。`);
    }
    return response;
  }
  throw new Error('更新下载重定向次数过多。');
}

module.exports = {
  EDITIONS,
  MAX_INSTALLER_BYTES,
  MAX_METADATA_BYTES,
  githubAssetUrl,
  releaseAssets,
  readLimited,
  checksumFor,
  fetchAsset
};
