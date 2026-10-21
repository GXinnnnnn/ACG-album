'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'ACG-album';

function resolveDataDirectory({ documents, dataDir, existsSync = fs.existsSync }) {
  if (dataDir) return path.resolve(dataDir);
  // Keep the original database precedence so renaming never switches libraries.
  for (const name of ['ACG-album', 'ACG-album']) {
    const directory = path.join(documents, name);
    if (existsSync(path.join(directory, 'library.sqlite'))) return directory;
  }
  return path.join(documents, APP_NAME);
}

function resolveUserDataDirectory({
  appData,
  dataDir,
  currentUserData,
  existsSync = fs.existsSync
}) {
  if (dataDir) return path.join(path.resolve(dataDir), 'chromium-profile');
  // The former product names were also Electron's default profile folder names.
  const candidates = [
    path.join(appData, 'ACG-album'),
    path.join(appData, 'ACG-album'),
    currentUserData
  ];
  return (
    candidates.find((directory) => directory && existsSync(directory)) ||
    path.join(appData, APP_NAME)
  );
}

module.exports = { APP_NAME, resolveDataDirectory, resolveUserDataDirectory };
