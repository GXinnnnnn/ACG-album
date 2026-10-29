'use strict';

const { app, ipcMain, Menu, net, shell } = require('electron');
const { createUpdater } = require('./update-service.cjs');
const { releaseAssets, readLimited } = require('./update-release.cjs');
const {
  validRepository,
  OFFICIAL_REPOSITORY,
  effectiveRepository,
  officialDownloads
} = require('./repository.cjs');

const EXTERNAL_HOSTS = new Set([
  'bgm.tv',
  'bangumi.tv',
  'chii.in',
  'next.bgm.tv',
  'github.com',
  'space.bilibili.com',
  'www.electronjs.org',
  'www.chromium.org',
  'nodejs.org',
  'www.sqlite.org',
  'sqlite.org',
  'sharp.pixelplumbing.com',
  'www.libvips.org',
  'libvips.github.io',
  'developers.google.com',
  'www.foundertype.com'
]);
function openExternal(value) {
  const url = new URL(String(value || ''));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !EXTERNAL_HOSTS.has(url.hostname)
  )
    throw new Error('不支持的外部网址。');
  return shell.openExternal(url.href);
}

function releaseVersion(tag) {
  const match = /^(?:v|release[-/]?)?(\d+)\.(\d+)\.(\d+)(?:\+[\da-z.-]+)?$/i.exec(
    String(tag || '').trim()
  );
  return match && match.slice(1, 4).map(Number).every(Number.isSafeInteger)
    ? match.slice(1, 4).map(Number)
    : null;
}

function publicReleaseHead(url) {
  return new Promise((resolve, reject) => {
    let request,
      timer,
      finalUrl = url,
      settled = false;
    const finish = (error, page) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          request?.abort();
        } catch {}
        reject(error);
      } else resolve(page);
    };
    const fail = (error) => finish(error);
    try {
      request = net.request({
        url,
        method: 'HEAD',
        redirect: 'follow',
        credentials: 'omit',
        useSessionCookies: false
      });
      request.on('redirect', (_status, _method, target) => {
        finalUrl = target;
      });
      request.on('error', fail);
      request.on('abort', () => fail(new Error('Release request aborted')));
      request.on('response', (message) => {
        message.on('error', fail);
        const status = message.statusCode;
        finish(null, { status, ok: status >= 200 && status < 300, url: finalUrl });
      });
      timer = setTimeout(() => fail(new Error('Release request timed out')), 10000);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function registerApplicationHandlers({
  call,
  getWindow,
  systemFonts = require('./fonts.cjs').systemFonts
}) {
  Menu.setApplicationMenu(null);
  let popup = null;
  const emit = (action) => {
    const win = getWindow();
    if (win && !win.isDestroyed())
      win.webContents.send('library:event', { type: 'application', data: { action } });
  };
  const repository = async () =>
    effectiveRepository((await call('init')).settings?.githubRepository);
  const updater = createUpdater({
    app,
    fetch: (...args) => net.fetch(...args),
    getLibrary: () => call('init'),
    notify: (data) => {
      const win = getWindow();
      if (win && !win.isDestroyed())
        win.webContents.send('library:event', { type: 'update', data });
    }
  });
  ipcMain.handle('library:updateInfo', () => updater.info());
  ipcMain.handle('library:updateStatus', () => updater.snapshot());
  ipcMain.handle('library:downloadUpdate', (_event, args) => updater.download(args));
  ipcMain.handle('library:cancelUpdate', () => updater.cancel());
  ipcMain.handle('library:installUpdate', (_event, args) => updater.install(args));
  ipcMain.handle('library:systemFonts', (_event, args = {}) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
      throw new Error('读取本机字体不接受参数。');
    return systemFonts();
  });
  ipcMain.handle('library:quit', () => app.quit());
  ipcMain.handle('library:appInfo', async () => ({
    name: app.getName(),
    version: app.getVersion(),
    author: '友利奈绪的胖次 (GXinnnnnn)',
    repository: await repository(),
    officialRepository: OFFICIAL_REPOSITORY,
    ...officialDownloads(app.getVersion()),
    credits: require('./assets/credits.json')
  }));
  ipcMain.handle('library:checkUpdate', async () => {
    updater.setRelease(null);
    const repo = await repository(),
      currentVersion = app.getVersion();
    const base = { repository: repo, currentVersion };
    if (!validRepository(repo)) throw new Error('GitHub 仓库配置无效。');
    const releasesUrl = `https://github.com/${repo}/releases`;
    let response;
    try {
      response = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `ACG-album/${currentVersion}`
        },
        signal: AbortSignal.timeout(10000)
      });
    } catch (error) {
      throw new Error(
        ['TimeoutError', 'AbortError'].includes(error.name)
          ? '连接 GitHub 超时，请稍后再试。'
          : '无法连接 GitHub，请检查网络后重试。'
      );
    }
    if (response.status === 404)
      return updater.setRelease({ ...base, status: 'unknown', url: releasesUrl, assets: [] });
    if ([403, 429].includes(response.status)) {
      // Public release redirects remain usable when the unauthenticated API is
      // rate limited. Follow redirects for Electron and trust only this repo's
      // final stable release tag, never a login page or an unrelated location.
      try {
        let page = await net.fetch(`${releasesUrl}/latest`, {
          method: 'HEAD',
          redirect: 'follow',
          credentials: 'omit',
          signal: AbortSignal.timeout(10000)
        });
        // Electron can leave fetch Response.url empty even after following a
        // redirect. Native request events expose the final location instead.
        if (page.ok && !page.url) page = await publicReleaseHead(`${releasesUrl}/latest`);
        const url = new URL(page.url);
        const prefix = `/${repo}/releases/tag/`;
        if (
          !page.ok ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash ||
          url.hostname !== 'github.com' ||
          !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
        )
          throw new Error();
        const tag = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!releaseVersion(tag)) throw new Error();
        response = {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: tag, html_url: url.href })
        };
      } catch {
        throw new Error('GitHub 请求频率受限，请稍后再试。');
      }
    }
    if (!response.ok) throw new Error(`GitHub 更新检查失败（${response.status}）。`);
    let release;
    try {
      release = JSON.parse(await readLimited(response));
      if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error();
    } catch {
      throw new Error('更新服务返回了无法识别的数据，请稍后再试。');
    }
    const latest = releaseVersion(release.tag_name),
      current = releaseVersion(currentVersion);
    let url = releasesUrl;
    try {
      const candidate = new URL(release.html_url);
      if (
        candidate.protocol === 'https:' &&
        !candidate.username &&
        !candidate.password &&
        !candidate.port &&
        candidate.hostname === 'github.com' &&
        candidate.pathname.toLowerCase().startsWith('/' + repo.toLowerCase() + '/releases/')
      )
        url = candidate.href;
    } catch {}
    if (!latest || !current || release.draft || release.prerelease)
      return updater.setRelease({
        ...base,
        status: 'unknown',
        latestVersion: String(release.tag_name || ''),
        url,
        assets: []
      });
    let comparison = 0;
    for (let i = 0; i < 3; i++)
      if (latest[i] !== current[i]) {
        comparison = latest[i] > current[i] ? 1 : -1;
        break;
      }
    return updater.setRelease({
      ...base,
      status: comparison > 0 ? 'available' : 'current',
      latestVersion: latest.join('.'),
      url,
      assets: releaseAssets(release, repo, latest.join('.'))
    });
  });
  ipcMain.handle('application:menu', (_, args = {}) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !['application', 'edit'].includes(args.name)) return;
    popup?.closePopup(win);
    const items =
      args.name === 'application'
        ? [
            { label: '关于 ACG-album', click: () => emit('about') },
            { label: '检查更新…', click: () => emit('updates') },
            { type: 'separator' },
            { label: '退出', role: 'quit', accelerator: 'Alt+F4' }
          ]
        : [
            { label: '撤销', role: 'undo', accelerator: 'CommandOrControl+Z' },
            { label: '重做', role: 'redo', accelerator: 'CommandOrControl+Y' },
            { type: 'separator' },
            { label: '剪切', role: 'cut', accelerator: 'CommandOrControl+X' },
            {
              label: '复制',
              accelerator: 'CommandOrControl+C',
              enabled: args.copyEnabled !== false,
              click: () => (args.copyImage ? emit('copy') : win.webContents.copy())
            },
            { label: '粘贴', role: 'paste', accelerator: 'CommandOrControl+V' },
            { type: 'separator' },
            { label: '全选', role: 'selectAll', accelerator: 'CommandOrControl+A' }
          ];
    const menu = Menu.buildFromTemplate(items),
      bounds = win.getContentBounds();
    popup = menu;
    const coordinate = (value, limit) =>
      Math.max(0, Math.min(limit, Math.round(Number(value) || 0)));
    return new Promise((resolve) =>
      menu.popup({
        window: win,
        x: coordinate(args.x, bounds.width),
        y: coordinate(args.y, bounds.height),
        callback: () => {
          if (popup === menu) popup = null;
          resolve();
        }
      })
    );
  });
}

module.exports = { registerApplicationHandlers, openExternal, releaseVersion };
