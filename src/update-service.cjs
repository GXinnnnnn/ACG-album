'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const { createReadStream } = syncFs;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  bundledIndexIdentity,
  validIdentity,
  validateRuntimeManifest,
  sameIdentity,
  prepareFontOverlay,
  assertRuntimeOwnership,
  MAX_RUNTIME_MANIFEST_BYTES
} = require('./runtime-update.cjs');
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
  if (app.isPackaged !== true) {
    const metadata = require('../package.json');
    return EDITIONS.includes(metadata.searchEdition) ? metadata.searchEdition : 'standard';
  }
  try {
    const executable = app.getPath?.('exe');
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) return null;
    const installation = path.dirname(executable);
    let resources = path.parse(installation).root;
    const components = installation.slice(resources.length).split(path.sep).filter(Boolean);
    // Only an absent index beneath confirmed real parents proves Standard.
    for (const component of [...components, 'resources']) {
      resources = path.join(resources, component);
      const item = syncFs.lstatSync(resources);
      if (!item.isDirectory() || item.isSymbolicLink()) return null;
    }
    const index = path.join(resources, 'local-index');
    let directory;
    try {
      directory = syncFs.lstatSync(index);
    } catch (error) {
      return error.code === 'ENOENT' ? 'standard' : null;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    const manifestFile = path.join(index, 'manifest.json');
    const item = syncFs.lstatSync(manifestFile);
    if (!item.isFile() || item.isSymbolicLink() || item.size <= 0 || item.size > 65536) return null;
    // Do not cache the edition from a common runtime's embedded metadata.
    const manifest = JSON.parse(syncFs.readFileSync(manifestFile, 'utf8'));
    if (
      manifest.manifestVersion !== 1 ||
      manifest.bundled !== true ||
      !['lite', 'full'].includes(manifest.variant) ||
      manifest.database !== 'subjects.sqlite' ||
      !validIdentity({
        variant: manifest.variant,
        dataVersion: manifest.dataVersion,
        readerSchemaVersion: manifest.readerSchemaVersion,
        bytes: manifest.bytes,
        sha256: manifest.sha256
      })
    )
      return null;
    // Full content hashing remains in the runtime compatibility/install checks.
    const database = syncFs.lstatSync(path.join(index, 'subjects.sqlite'));
    if (!database.isFile() || database.isSymbolicLink() || database.size !== manifest.bytes)
      return null;
    return manifest.variant;
  } catch {
    return null;
  }
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
  timeouts = {},
  testMode = process.env.ACG_TEST === '1'
}) {
  let offer = null;
  let releasePending = Promise.resolve();
  const resourcesDirectory = () =>
    path.join(path.dirname(app.getPath?.('exe') || process.execPath), 'resources');
  const timeoutError = (message) => Object.assign(new Error(message), { code: 'UPDATE_TIMEOUT' });
  const waitTime = (key, fallback) => timeouts[key] ?? fallback;
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
    releasePending = (async () => {
      if (!result) return result;
      const candidate = result.assets?.find((row) => row.kind === 'runtime-manifest');
      const resolved = {
        ...result,
        assets: result.assets?.filter((row) => row.kind !== 'runtime-manifest') || [],
        runtime: null,
        runtimeReason: '此 Release 未提供运行时更新清单，使用完整安装包。'
      };
      if (candidate && ['available', 'current'].includes(result.status)) {
        try {
          const response = await fetchAsset(
            fetch,
            candidate.url,
            AbortSignal.timeout(waitTime('metadata', 10000))
          );
          const text = await readLimited(response, MAX_RUNTIME_MANIFEST_BYTES);
          if (Buffer.byteLength(text) !== candidate.size) throw new Error('运行时清单大小不匹配。');
          const manifest = validateRuntimeManifest(JSON.parse(text), {
            repository: result.repository,
            tag: candidate.tag,
            version: result.latestVersion,
            platform,
            arch
          });
          if (
            manifest.payload.name !== candidate.payload.name ||
            manifest.payload.bytes !== candidate.payload.size ||
            manifest.url !== candidate.payload.url ||
            (candidate.payload.sha256 && manifest.payload.sha256 !== candidate.payload.sha256)
          )
            throw new Error('运行时载荷与 Release 记录不一致。');
          const identity = await bundledIndexIdentity(resourcesDirectory());
          if (!manifest.localIndexes.some((row) => sameIdentity(row, identity)))
            throw new Error('原随包离线索引身份或数据版本不匹配。');
          resolved.runtime = {
            mode: 'runtime',
            edition: identity.variant,
            name: manifest.payload.name,
            size: manifest.payload.bytes,
            sha256: manifest.payload.sha256,
            checksumUrl: '',
            url: manifest.url,
            verifiable: true,
            manifest,
            indexIdentity: identity
          };
          resolved.runtimeReason =
            '原随包索引的版本、读取协议、大小与 SHA-256 全部匹配，仅更新运行程序并原样保留索引。';
        } catch (error) {
          resolved.runtimeReason = `使用完整安装包：${error.message}`;
        }
      }
      if (offer === result) offer = resolved;
      return resolved;
    })();
    return releasePending;
  }
  async function download({ edition, mode = 'auto' } = {}) {
    if (controller || installing) throw new Error('更新操作正在进行，请稍候。');
    await releasePending;
    if (!EDITIONS.includes(edition))
      throw new Error('无法确认当前版型，请先明确选择版本或前往发布页。');
    if (!['auto', 'full', 'runtime'].includes(mode)) throw new Error('更新模式无效。');
    if (!offer || offer.status !== 'available') throw new Error('请先重新检查可用更新。');
    const library = await getLibrary();
    const repository = library.settings?.githubRepository || 'GXinnnnnn/ACG-album';
    if (repository.toLowerCase() !== offer.repository.toLowerCase())
      throw new Error('更新仓库已改变，请重新检查。');
    const runtime = mode !== 'full' && offer.runtime?.edition === edition ? offer.runtime : null;
    if (mode === 'runtime' && !runtime)
      throw new Error('运行时更新不兼容，请重新检查或选择完整安装包。');
    const asset = runtime || offer.assets?.find((row) => row.edition === edition);
    if (!asset?.verifiable) throw new Error('该安装包没有 SHA-256 校验信息，请前往发布页。');
    const selected = {
      ...structuredClone(asset),
      mode: runtime ? 'runtime' : 'full',
      repository: offer.repository,
      version: offer.latestVersion
    };
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(
      () => abort.abort(timeoutError('下载超过时限，请重试。')),
      waitTime('total', 60 * 60 * 1000)
    );
    const signal = abort.signal;
    let directory, file;
    downloaded = null;
    publish({
      phase: 'downloading',
      mode: selected.mode,
      reason: offer.runtimeReason,
      releaseUrl: offer.url || `https://github.com/${selected.repository}/releases`,
      errorKind: '',
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
      const headerTimer = setTimeout(
        () => abort.abort(timeoutError('连接下载服务超时，请重试。')),
        waitTime('headers', 30000)
      );
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
            idleTimer = setTimeout(
              () => {
                const error = timeoutError('下载连接长时间无响应，请重试。');
                abort.abort(error);
                reject(error);
              },
              waitTime('idle', 30000)
            );
          });
          let chunk;
          try {
            chunk = await Promise.race([reader.read(), idle]);
          } finally {
            clearTimeout(idleTimer);
          }
          if (signal.aborted) throw signal.reason;
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > asset.size) throw new Error('下载内容超过发布记录大小。');
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
          signal.throwIfAborted();
          if (Date.now() - lastNotice > 200) {
            publish({ received });
            lastNotice = Date.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      publish({ phase: 'verifying', received });
      signal.throwIfAborted();
      if (received !== asset.size || hash.digest('hex') !== expected)
        throw new Error('安装包 SHA-256 校验失败，请重新下载。');
      await file.close();
      file = null;
      signal.throwIfAborted();
      const installer = path.join(
        directory,
        selected.mode === 'runtime' ? 'runtime.zip' : 'installer.exe'
      );
      await fs.rename(partial, installer);
      signal.throwIfAborted();
      downloaded = { ...selected, installer, sha256: expected };
      return publish({ phase: 'ready', received, sha256: expected });
    } catch (error) {
      await file?.close().catch(() => {});
      // Only remove this invocation's freshly created, app-owned cache leaf.
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      const failure = signal.aborted ? signal.reason : error;
      const cancelled = failure?.code === 'UPDATE_CANCELLED';
      const errorKind = cancelled
        ? 'cancelled'
        : failure?.code === 'UPDATE_TIMEOUT' || failure?.name === 'TimeoutError'
          ? 'timeout'
          : failure instanceof TypeError ||
              /network|fetch|连接|下载失败/i.test(failure?.message || '')
            ? 'network'
            : 'verification';
      publish({
        phase: cancelled ? 'cancelled' : 'error',
        errorKind,
        error: failure?.message || String(failure)
      });
      throw failure;
    } finally {
      clearTimeout(timeout);
      controller = null;
    }
  }
  function cancel() {
    controller?.abort(
      Object.assign(new Error('下载已由你取消，可重新下载。'), { code: 'UPDATE_CANCELLED' })
    );
    return snapshot();
  }
  async function install({ confirm, repository, version, edition, mode } = {}) {
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
      !(selected.mode === 'runtime'
        ? offer.runtime?.url === selected.url &&
          offer.runtime?.sha256 === selected.sha256 &&
          JSON.stringify(offer.runtime?.manifest) === JSON.stringify(selected.manifest) &&
          sameIdentity(offer.runtime?.indexIdentity, selected.indexIdentity)
        : offer.assets?.some(
            (asset) =>
              asset.edition === selected.edition &&
              asset.url === selected.url &&
              asset.size === selected.size &&
              asset.checksumUrl === selected.checksumUrl &&
              (!asset.sha256 || asset.sha256 === selected.sha256) &&
              asset.verifiable
          )) ||
      (mode !== undefined && mode !== selected.mode) ||
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
      if (
        selected.mode === 'runtime' &&
        !sameIdentity(await bundledIndexIdentity(resourcesDirectory()), selected.indexIdentity)
      )
        throw new Error('随包离线索引已改变，请重新检查更新。');
      const { sha256: ownershipSha256 } = await assertRuntimeOwnership(
        context.installationDirectory
      );
      const fontOverlay = await prepareFontOverlay(
        app.getAppPath?.() || path.join(resourcesDirectory(), 'app.asar'),
        path.dirname(selected.installer)
      );
      const plan = installationPlan({
        mode: selected.mode,
        runtimeManifest: selected.manifest,
        indexIdentity: selected.indexIdentity,
        fontOverlay,
        ownershipSha256,
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
      publish({
        phase: 'ready',
        error: error.message,
        errorKind: error.code === 'UPDATE_OWNERSHIP' ? 'ownership' : ''
      });
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
