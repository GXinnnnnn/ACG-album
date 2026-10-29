'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fetchAsset, checksumFor, readLimited, EDITIONS } = require('./update-release.cjs');
const {
  installationPlan,
  launchInstaller,
  preflightInstallation
} = require('./update-install.cjs');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function currentEdition(app) {
  const metadata = require('../package.json');
  if (EDITIONS.includes(metadata.searchEdition)) return metadata.searchEdition;
  if (app.isPackaged && process.resourcesPath) {
    try {
      const manifest = require(path.join(process.resourcesPath, 'local-index', 'manifest.json'));
      if (['lite', 'full'].includes(manifest.variant)) return manifest.variant;
    } catch {}
  }
  return 'standard';
}

async function noLinkedAncestors(value) {
  let directory = path.parse(value).root;
  for (const component of value.slice(directory.length).split(path.sep)) {
    directory = path.join(directory, component);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw new Error('更新路径包含链接目录，请从发布页手动安装。');
  }
}

async function pathIdentities(value) {
  const identities = [];
  let current = path.resolve(value);
  while (true) {
    try {
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error('更新保护路径包含链接，请从发布页手动安装。');
      identities.push(`${stat.dev}:${stat.ino}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return identities;
}

async function assertExternalPaths(directory, values) {
  const installStat = await fs.stat(directory, { bigint: true });
  const installId = `${installStat.dev}:${installStat.ino}`;
  const installAncestors = new Set(await pathIdentities(directory));
  for (const value of values) {
    if (typeof value !== 'string' || !path.isAbsolute(value))
      throw new Error('资料或原图路径无效，无法安全安装更新。');
    const ancestors = await pathIdentities(value);
    let ownId;
    try {
      const stat = await fs.stat(value, { bigint: true });
      ownId = `${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (ancestors.includes(installId) || (ownId && installAncestors.has(ownId)))
      throw new Error(
        '资料、配置或已索引原图目录与程序目录重叠；自动安装会损坏原图。请先在应用外将相关目录移至独立位置并更新根目录设置，再从发布页手动处理。'
      );
  }
}

function createUpdater({
  app,
  fetch,
  getLibrary,
  notify = () => {},
  platform = process.platform,
  arch = process.arch,
  launch = launchInstaller,
  preflight = preflightInstallation,
  tempDirectory = os.tmpdir(),
  testMode = process.env.ACG_TEST === '1'
}) {
  let offer = null;
  let controller = null;
  let downloaded = null;
  let state = { phase: 'idle' };
  let installing = false;
  const snapshot = () => ({ ...state });
  const publish = (next) => {
    state = { ...state, ...next };
    notify(snapshot());
    return snapshot();
  };
  const supported = () =>
    app.isPackaged === true &&
    platform === 'win32' &&
    arch === 'x64' &&
    !testMode &&
    require('../package.json').build?.nsis?.deleteAppDataOnUninstall !== true;
  async function info() {
    const library = await getLibrary();
    const executable = app.getPath?.('exe') || process.execPath;
    return {
      currentEdition: currentEdition(app),
      canInstall: supported(),
      installationDirectory: path.dirname(executable),
      dataDirectory: library.dataDir || '',
      userDataDirectory: app.getPath?.('userData') || ''
    };
  }
  function setRelease(result) {
    offer = result;
    return result;
  }
  async function download({ edition } = {}) {
    if (controller || installing) throw new Error('更新操作正在进行，请稍候。');
    if (!offer || offer.status !== 'available') throw new Error('请先重新检查可用更新。');
    const library = await getLibrary();
    const repository = library.settings?.githubRepository || 'GXinnnnnn/ACG-album';
    if (repository.toLowerCase() !== offer.repository.toLowerCase())
      throw new Error('更新仓库已改变，请重新检查。');
    const asset = offer.assets?.find((row) => row.edition === edition);
    if (!asset?.verifiable) throw new Error('该安装包没有 SHA-256 校验信息，请前往发布页。');
    const selected = { ...asset, repository: offer.repository, version: offer.latestVersion };
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(
      () => abort.abort(new Error('下载超过 60 分钟，请重试。')),
      60 * 60 * 1000
    );
    const signal = abort.signal;
    let directory, file;
    downloaded = null;
    publish({
      phase: 'downloading',
      edition,
      repository: selected.repository,
      version: selected.version,
      received: 0,
      total: asset.size,
      error: '',
      name: asset.name
    });
    try {
      let expected = asset.sha256;
      if (!expected) {
        const checksumSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const response = await fetchAsset(fetch, asset.checksumUrl, checksumSignal);
        expected = checksumFor(await readLimited(response, 65536), asset.name);
      }
      directory = await fs.mkdtemp(path.join(tempDirectory, 'ACG-album-update-'));
      const partial = path.join(directory, 'installer.part');
      const headerTimer = setTimeout(() => abort.abort(new Error('连接下载服务超时。')), 30000);
      let response;
      try {
        response = await fetchAsset(fetch, asset.url, signal);
      } finally {
        clearTimeout(headerTimer);
      }
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== asset.size) {
        await response.body?.cancel();
        throw new Error('安装包大小与发布记录不一致。');
      }
      if (!response.body) throw new Error('下载服务未提供安装包。');
      file = await fs.open(partial, 'wx');
      const reader = response.body.getReader();
      const hash = crypto.createHash('sha256');
      let received = 0,
        lastNotice = 0;
      try {
        while (true) {
          let idleTimer;
          const idle = new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              abort.abort();
              reject(new Error('下载连接超过 30 秒无响应，请重试。'));
            }, 30000);
          });
          let chunk;
          try {
            chunk = await Promise.race([reader.read(), idle]);
          } finally {
            clearTimeout(idleTimer);
          }
          if (signal.aborted) throw new Error('下载已取消或超时。');
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > asset.size) throw new Error('下载内容超过发布记录大小。');
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
          if (Date.now() - lastNotice > 200) {
            publish({ received });
            lastNotice = Date.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      publish({ phase: 'verifying', received });
      if (received !== asset.size || hash.digest('hex') !== expected)
        throw new Error('安装包 SHA-256 校验失败，请重新下载。');
      await file.close();
      file = null;
      const installer = path.join(directory, 'installer.exe');
      await fs.rename(partial, installer);
      downloaded = { ...selected, installer, sha256: expected };
      return publish({ phase: 'ready', received, sha256: expected });
    } catch (error) {
      await file?.close().catch(() => {});
      // Only remove this invocation's freshly created, app-owned cache leaf.
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      publish({ phase: signal.aborted ? 'cancelled' : 'error', error: error.message });
      throw error;
    } finally {
      clearTimeout(timeout);
      controller = null;
    }
  }
  function cancel() {
    controller?.abort();
    return snapshot();
  }
  async function install({ confirm, repository, version, edition } = {}) {
    if (confirm !== true || controller || installing || !downloaded || state.phase !== 'ready')
      throw new Error('请先完成下载校验，再点击安装。');
    const selected = downloaded;
    const library = await getLibrary();
    const configured = library.settings?.githubRepository || 'GXinnnnnn/ACG-album';
    if (
      !offer ||
      offer.status !== 'available' ||
      offer.repository !== selected.repository ||
      offer.latestVersion !== selected.version ||
      !offer.assets?.some(
        (asset) =>
          asset.edition === selected.edition &&
          asset.url === selected.url &&
          asset.size === selected.size &&
          asset.checksumUrl === selected.checksumUrl &&
          (!asset.sha256 || asset.sha256 === selected.sha256) &&
          asset.verifiable
      ) ||
      configured.toLowerCase() !== selected.repository.toLowerCase() ||
      repository !== selected.repository ||
      version !== selected.version ||
      edition !== selected.edition
    )
      throw new Error('更新来源或版本已改变，请重新检查下载。');
    const context = await info();
    if (!context.canInstall) throw new Error('此运行环境不支持应用内安装，请前往发布页。');
    installing = true;
    try {
      for (const value of [
        context.installationDirectory,
        context.dataDirectory,
        context.userDataDirectory,
        selected.installer
      ])
        await noLinkedAncestors(value);
      await assertExternalPaths(context.installationDirectory, [
        context.dataDirectory,
        context.userDataDirectory,
        selected.installer,
        ...(library.roots || []).map((root) => root.path)
      ]);
      if ((await hashFile(selected.installer)) !== selected.sha256)
        throw new Error('安装包已改变，请重新下载。');
      const plan = installationPlan({
        executable: app.getPath('exe'),
        dataDirectory: context.dataDirectory,
        userData: context.userDataDirectory,
        installer: selected.installer,
        sha256: selected.sha256,
        parentPid: process.pid,
        edition: selected.edition,
        version: selected.version,
        platform,
        packaged: app.isPackaged,
        testMode
      });
      await preflight(plan);
      await launch(plan);
      publish({ phase: 'installing' });
      app.quit();
      return snapshot();
    } catch (error) {
      publish({ phase: 'ready', error: error.message });
      throw error;
    } finally {
      installing = false;
    }
  }
  let operation = false;
  const exclusive = (action) => async (args) => {
    if (operation) throw new Error('更新操作正在进行，请稍候。');
    operation = true;
    try {
      return await action(args);
    } finally {
      operation = false;
    }
  };
  return {
    info,
    setRelease,
    download: exclusive(download),
    cancel,
    install: exclusive(install),
    snapshot
  };
}

module.exports = {
  createUpdater,
  currentEdition,
  hashFile,
  noLinkedAncestors,
  assertExternalPaths
};
