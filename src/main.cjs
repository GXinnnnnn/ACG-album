'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  nativeImage,
  shell,
  safeStorage
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { largestPngFromIco, customFolderIco } = require('./icons.cjs');
const { rangedFileResponse } = require('./file-response.cjs');
const { writeBitmap } = require('./clipboard.cjs');
const { normalizeAccessToken } = require('./bangumi-access.cjs');
const { registerApplicationHandlers, openExternal } = require('./application.cjs');
const { APP_NAME, resolveDataDirectory, resolveUserDataDirectory } = require('./profile-path.cjs');
const profile = resolveUserDataDirectory({
  appData: app.getPath('appData'),
  currentUserData: app.getPath('userData'),
  dataDir: process.env.ACG_DATA_DIR
});
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName(APP_NAME);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'acg-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);
let win,
  worker,
  seq = 0,
  dataDir,
  tokenPath;
const pending = new Map();
let closing = false;
const log = (...args) => {
  console.log(...args);
  if (dataDir)
    try {
      fs.appendFileSync(
        path.join(dataDir, 'app.log'),
        new Date().toISOString() + ' ' + args.join(' ') + '\n'
      );
    } catch {}
};
function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const request = ++seq;
    pending.set(request, { resolve, reject });
    worker.postMessage({ request, method, args });
  });
}
function bootWorker() {
  return new Promise((resolve, reject) => {
    let token = '';
    try {
      if (safeStorage.isEncryptionAvailable() && fs.existsSync(tokenPath))
        token = normalizeAccessToken(safeStorage.decryptString(fs.readFileSync(tokenPath)));
    } catch {
      log('Token unavailable: saved credential could not be decrypted or validated.');
    }
    worker = new Worker(path.join(__dirname, 'library-worker.cjs'), {
      workerData: {
        dataDir,
        token,
        resourcesPath: app.isPackaged
          ? process.resourcesPath
          : path.join(__dirname, '..', 'resources'),
        localIndexPath:
          process.env.ACG_TEST === '1' && process.env.ACG_LOCAL_INDEX_PATH
            ? path.resolve(process.env.ACG_LOCAL_INDEX_PATH)
            : undefined
      }
    });
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event && win && !win.isDestroyed())
        win.webContents.send('library:event', { type: m.event, data: m.data });
      if (m.request) {
        const p = pending.get(m.request);
        if (!p) return;
        pending.delete(m.request);
        if (m.error) {
          log(m.error, m.stack || '');
          p.reject(new Error(m.error));
        } else p.resolve(m.result);
      }
    });
    worker.on('error', (e) => {
      log('Worker:', e.stack);
      reject(e);
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    });
  });
}
function createWindow() {
  let state = { width: 1600, height: 1000 };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(path.join(dataDir, 'window.json'), 'utf8')) };
  } catch {}
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    minWidth: 980,
    minHeight: 680,
    show: false,
    frame: true,
    titleBarStyle: 'hidden',
    thickFrame: true,
    fullscreenable: false,
    backgroundColor: '#e9ebf4',
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href))
      event.preventDefault();
  });
  win.on('maximize', () =>
    win.webContents.send('library:event', { type: 'window', data: { maximized: true } })
  );
  win.on('unmaximize', () =>
    win.webContents.send('library:event', { type: 'window', data: { maximized: false } })
  );
  win.on('close', () => {
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(
        path.join(dataDir, 'window.json'),
        JSON.stringify({ width: b.width, height: b.height, maximized: win.isMaximized() })
      );
    } catch {}
  });
}
function handlers() {
  registerApplicationHandlers({ call, getWindow: () => win });
  const methods = [
    'mediaInfo',
    'mediaStats',
    'setPlace',
    'setAlbumKind',
    'storeVideoThumb',
    'init',
    'localIndexStatus',
    'searchLocalIndex',
    'list',
    'get',
    'ancestors',
    'patch',
    'setCover',
    'resetCover',
    'match',
    'bind',
    'refreshMetadata',
    'sync',
    'cacheInfo',
    'cleanCache',
    'dimensions',
    'cancel',
    'removeRoot',
    'settings'
  ];
  for (const method of methods)
    ipcMain.handle('library:' + method, (_, args) => call(method, args));
  ipcMain.handle('library:exportMedia', async (_, args) => {
    const n = await call('get', { id: args.id });
    if (n?.kind !== 'image') throw new Error('请选择图片。');
    const ext =
      { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' }[args.format] || 'png';
    const result = await dialog.showSaveDialog(win, {
      title: '导出编辑副本',
      defaultPath: path.join(app.getPath('documents'), path.parse(n.name).name + '_编辑.' + ext),
      filters: [{ name: ext.toUpperCase() + ' 图片', extensions: [ext] }],
      properties: ['createDirectory', 'dontAddToRecent']
    });
    if (result.canceled) return { cancelled: true };
    return call('exportMedia', { id: n.id, destination: result.filePath, edit: args.edit });
  });
  ipcMain.handle('library:openMedia', async (_, args) => {
    const n = await call('get', args);
    if (!n || n.kind === 'folder' || n.missing) throw new Error('媒体不存在。');
    const error = await shell.openPath(n.path);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('library:demo', async () => {
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'demo')
      : path.join(__dirname, 'demo');
    let first = null;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const result = await call('scan', { path: path.join(base, entry.name), offline: true });
        if (!first) first = result;
      }
    }
    return first;
  });
  ipcMain.handle('library:import', async (_, options = {}) => {
    const safeOptions = require('./matching-policy.cjs').importOptions(options);
    const result = await dialog.showOpenDialog(win, {
      title: '选择要导入的相册分类',
      properties: ['openDirectory', 'dontAddToRecent']
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return call('scan', { path: result.filePaths[0], ...safeOptions });
  });
  ipcMain.handle('library:refresh', async (_, args) => {
    const n = await call('get', args);
    if (!n) throw new Error('分类不存在');
    const root = await call('get', { id: n.root });
    return call('scan', { path: root.path });
  });
  ipcMain.handle('library:chooseAvatar', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择个人头像',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    });
    if (result.canceled) return null;
    const sharp = require('sharp');
    const buffer = await sharp(result.filePaths[0], { limitInputPixels: 160000000, page: 0 })
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 88 })
      .toBuffer();
    const value = 'data:image/webp;base64,' + buffer.toString('base64');
    await call('settings', { key: 'avatar', value });
    return value;
  });
  ipcMain.handle('library:chooseCover', async (_, args) => {
    const n = await call('get', args);
    if (!n || n.kind !== 'folder') throw new Error('请选择相册文件夹');
    const result = await dialog.showOpenDialog(win, {
      title: '选择相册内的封面图片',
      defaultPath: n.path,
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        {
          name: '图片',
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'webp',
            'gif',
            'bmp',
            'ico',
            'tif',
            'tiff',
            'avif',
            'heic'
          ]
        }
      ]
    });
    if (result.canceled) return null;
    return call('selectCoverPath', { id: n.id, file: result.filePaths[0] });
  });
  ipcMain.handle('library:reveal', async (_, args) => {
    const n = await call('get', args);
    if (n) shell.showItemInFolder(n.path);
    return true;
  });
  ipcMain.handle('library:copyPath', async (_, args) => {
    const n = await call('get', args);
    if (!n) throw new Error('资源不存在');
    clipboard.writeText(n.path);
    return true;
  });
  ipcMain.handle('library:copyImage', async (_, args) => {
    const asset = await call('asset', args);
    let image = nativeImage.createFromPath(asset.path);
    if (image.isEmpty()) {
      const result = await call('clipboardImage', args);
      image = nativeImage.createFromBuffer(Buffer.from(result));
    }
    if (image.isEmpty()) throw new Error('此图片暂不能转换为剪贴板位图，请尝试 PNG/JPEG。');
    await writeBitmap(image);
    return true;
  });
  ipcMain.handle('library:tokenStatus', () => ({
    saved: fs.existsSync(tokenPath),
    encrypted: safeStorage.isEncryptionAvailable()
  }));
  ipcMain.handle('library:saveToken', async (_, args) => {
    const value = normalizeAccessToken(args.value);
    if (value && !safeStorage.isEncryptionAvailable())
      throw new Error('系统加密服务不可用，未保存 Token。');
    if (value) fs.writeFileSync(tokenPath, safeStorage.encryptString(value));
    else if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    await call('token', { value });
    return true;
  });
  ipcMain.handle('library:openData', () => shell.openPath(dataDir));
  ipcMain.handle('library:external', (_, args) => openExternal(args.url));
  ipcMain.handle('window:action', (_, action) => {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
  });
}
async function imageProtocol(request) {
  try {
    const u = new URL(request.url),
      id = u.pathname.slice(1);
    if (!/^[a-f0-9]{24}$/.test(id)) return new Response('', { status: 400 });
    let result;
    if (u.hostname === 'thumb')
      result = await call('thumb', {
        id,
        size: Number(u.searchParams.get('size')) || 512,
        priority: u.searchParams.get('p') === '1'
      });
    else if (u.hostname === 'original') result = await call('asset', { id });
    else if (u.hostname === 'frame')
      result = await call('frame', {
        id,
        index: Number(u.searchParams.get('index')) || 0,
        size: Number(u.searchParams.get('size')) || 1600
      });
    else return new Response('', { status: 404 });
    if (result.placeholder) return new Response('', { status: 404 });
    if (result.icon) {
      let file = result.path;
      try {
        if (fs.statSync(file).isDirectory()) file = (await customFolderIco(file)) || file;
      } catch {}
      let image;
      if (path.extname(file).toLowerCase() === '.ico') {
        try {
          const png = largestPngFromIco(await fs.promises.readFile(file));
          if (png) image = nativeImage.createFromBuffer(png);
        } catch {}
      }
      if (!image || image.isEmpty()) image = nativeImage.createFromPath(file);
      if (image.isEmpty()) image = await app.getFileIcon(result.path, { size: 'large' });
      return new Response(image.toPNG(), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
      });
    }
    const ranged = await rangedFileResponse(result.path, request);
    if (ranged) return ranged;
    const response = await net.fetch(pathToFileURL(result.path).href, {
      headers: request.headers.has('range') ? { Range: request.headers.get('range') } : {}
    });
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (e) {
    return new Response('', { status: 404 });
  }
}
if (!app.requestSingleInstanceLock() && !process.env.ACG_TEST) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      dataDir = resolveDataDirectory({
        documents: app.getPath('documents'),
        dataDir: process.env.ACG_DATA_DIR
      });
      fs.mkdirSync(dataDir, { recursive: true });
      tokenPath = path.join(dataDir, 'bangumi-token.enc');
      await bootWorker();
      protocol.handle('acg-image', imageProtocol);
      handlers();
      createWindow();
    })
    .catch((e) => {
      log(e.stack);
      dialog.showErrorBox(APP_NAME + ' 启动失败', e.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  let quitReady = false;
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => {
      quitReady = true;
      worker?.terminate();
      app.quit();
    }, 10000);
    (worker ? call('shutdown') : Promise.resolve())
      .catch((e) => log('Shutdown:', e.message))
      .finally(() => {
        clearTimeout(deadline);
        quitReady = true;
        worker?.terminate();
        app.quit();
      });
  });
}
