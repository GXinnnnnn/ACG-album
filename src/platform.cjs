'use strict';

const path = require('node:path');

function windowPlatformOptions(platform = process.platform) {
  return platform === 'darwin'
    ? {
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 12, y: 6 },
        fullscreenable: true
      }
    : { titleBarStyle: 'hidden', thickFrame: true, fullscreenable: false };
}

// Historical bundled fonts were shipped only in the Windows runtime layout.
// execPath on macOS is Contents/MacOS/<name>, not Contents/Resources. Do not
// migrate files inside a signed .app, or create private backups in its bundle.
function legacyFontRuntimeDirectory(platform, executable) {
  return platform === 'win32' ? path.dirname(executable) : null;
}

function macMenuTemplate({ name, emit }) {
  return [
    {
      label: name,
      submenu: [
        { label: `关于 ${name}`, click: () => emit('about') },
        { label: '检查更新…', click: () => emit('updates') },
        { type: 'separator' },
        { label: '偏好设置…', accelerator: 'Command+,', click: () => emit('settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他应用' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${name}`, accelerator: 'Command+Q' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '导入文件夹…', accelerator: 'Command+O', click: () => emit('import') },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口', accelerator: 'Command+W' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做', accelerator: 'Command+Shift+Z' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        // Route through the renderer so Command+C copies the current image in
        // the viewer and still copies selected text when an input has focus.
        { label: '复制', accelerator: 'Command+C', click: () => emit('copy') },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { role: 'startSpeaking', label: '开始朗读' },
        { role: 'stopSpeaking', label: '停止朗读' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { label: '刷新资料库', accelerator: 'Command+R', click: () => emit('refresh') },
        { label: '搜索资料库', accelerator: 'Command+K', click: () => emit('search') },
        { label: '返回上一层', accelerator: 'Command+[', click: () => emit('back') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      role: 'windowMenu',
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      ]
    }
  ];
}

module.exports = { windowPlatformOptions, legacyFontRuntimeDirectory, macMenuTemplate };
