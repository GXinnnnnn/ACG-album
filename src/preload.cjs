'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set([
  'appInfo',
  'checkUpdate',
  'quit',
  'mediaInfo',
  'mediaStats',
  'setPlace',
  'setAlbumKind',
  'storeVideoThumb',
  'exportMedia',
  'openMedia',
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
  'settings',
  'import',
  'demo',
  'refresh',
  'chooseCover',
  'chooseAvatar',
  'reveal',
  'copyPath',
  'copyImage',
  'tokenStatus',
  'saveToken',
  'openData',
  'external'
]);
contextBridge.exposeInMainWorld('album', {
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
