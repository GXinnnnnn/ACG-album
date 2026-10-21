'use strict';
// Development builds stay in code/release; the reviewed runnable copy lives beside the code tree.
const fs = require('node:fs');
const path = require('node:path');
const codeRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(codeRoot, '..');
const metadata = require('../package.json');
function runtimeDirectory() {
  const staged = path.join(codeRoot, 'release/win-unpacked');
  if (fs.existsSync(path.join(staged, metadata.build.productName + '.exe'))) return staged;
  return path.join(workspaceRoot, '当前版本');
}
function installerDirectory() {
  const staged = path.join(codeRoot, 'release');
  const name = `${metadata.build.productName} Setup ${metadata.version}.exe`;
  return fs.existsSync(path.join(staged, name)) ? staged : path.join(workspaceRoot, '安装包');
}
module.exports = { codeRoot, workspaceRoot, runtimeDirectory, installerDirectory };
