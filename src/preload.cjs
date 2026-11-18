'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set([
  'appInfo',
  'systemFonts',
  'checkUpdate',
  'updateInfo',
  'updateStatus',
  'downloadUpdate',
  'cancelUpdate',
  'installUpdate',
  'quit',
  'mediaInfo',
  'prepareImagePreview',
  'mediaStats',
  'setPlace',
  'setAlbumKind',
  'storeVideoThumb',
  'exportMedia',
  'openMedia',
  'init',
  'startupResume',
  'filesystemSync',
  'rename',
  'statistics',
  'localIndexStatus',
  'searchLocalIndex',
  'list',
  'get',
  'getRootMatchPolicy',
  'setRootMatchPolicy',
  'ancestors',
  'patch',
  'confirmReview',
  'setCover',
  'resetCover',
  'match',
  'bind',
  'refreshMetadata',
  'sync',
  'cacheInfo',
  'openCache',
  'changeCacheDirectory',
  'resetCacheDirectory',
  'cleanCache',
  'dimensions',
  'cancel',
  'removeRoot',
  'rootStatus',
  'retryRoot',
  'relinkRoot',
  'relinkFolder',
  'settings',
  'import',
  'demo',
  'refresh',
  'chooseCover',
  'chooseAvatar',
  'wallpaperList',
  'wallpaperImport',
  'reveal',
  'copyPath',
  'copyImage',
  'tokenStatus',
  'saveToken',
  'openData',
  'external'
]);
contextBridge.exposeInMainWorld('album', {
  // Expose only fixed platform identifiers, never the Node process or environment.
  platform: typeof process === 'object' ? process.platform : null,
  arch: typeof process === 'object' ? process.arch : null,
  call: (method, args = {}) => {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('library:' + method, args);
  },
  onEvent: (handler) => {
    const listener = (_, event) => handler(event);
    ipcRenderer.on('library:event', listener);
    return () => ipcRenderer.removeListener('library:event', listener);
  },
  menu: (name, options = {}) => ipcRenderer.invoke('application:menu', { ...options, name }),
  window: (action) => ipcRenderer.invoke('window:action', action)
});
