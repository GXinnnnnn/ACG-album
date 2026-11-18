'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  FULL,
  runtimePackages,
  run,
  runCli,
  digest,
  download,
  lockIntegrity,
  validateManifest,
  archivePaths,
  safeArchivePath,
  builderConfig,
  walkFiles
} = require('./mac-support.cjs');
const { prepareNativeSources, installNativeSources } = require('./mac-native-sources.cjs');
const { writeRuntimeLicenses } = require('./mac-runtime-licenses.cjs');
const {
  collectorStrategy,
  createRuntimeStage,
  verifyRuntimeStage
} = require('./mac-runtime-stage.cjs');
const root = path.resolve(__dirname, '..');

async function prepareIndex(input, seven) {
  const installer = path.join(input, FULL.installer);
  const url = `https://github.com/GXinnnnnn/ACG-album/releases/download/v${FULL.version}/${FULL.installer}`;
  await download(url, installer, FULL.installerSha256);
  if ((await fsp.stat(installer)).size !== FULL.installerBytes)
    throw new Error('Full installer size mismatch');
  let archive = installer;
  let paths = archivePaths(run(seven, ['l', '-slt', archive]));
  const inner = paths.filter((name) => /(?:^|\/)app-(?:64|x64)\.7z$/.test(name));
  if (inner.length) {
    if (inner.length !== 1 || !safeArchivePath(inner[0])) throw new Error('Ambiguous NSIS payload');
    const wrapper = path.join(input, 'wrapper');
    await fsp.mkdir(wrapper);
    run(seven, ['x', '-y', '-bsp0', '-bso0', '-o' + wrapper, archive, inner[0]]);
    archive = path.join(wrapper, ...inner[0].split('/'));
    paths = archivePaths(run(seven, ['l', '-slt', archive]));
  }
  const wanted = paths.filter((name) =>
    /(?:^|\/)resources\/local-index\/(?:subjects\.sqlite|manifest\.json|SOURCE\.(?:txt|md))$/.test(
      name
    )
  );
  const databases = wanted.filter((name) => name.endsWith('/subjects.sqlite'));
  const manifests = wanted.filter((name) => name.endsWith('/manifest.json'));
  if (
    databases.length !== 1 ||
    manifests.length !== 1 ||
    wanted.some((name) => !safeArchivePath(name))
  )
    throw new Error('Expected one trusted resources/local-index database and manifest');
  if (path.posix.dirname(databases[0]) !== path.posix.dirname(manifests[0]))
    throw new Error('Index paths disagree');
  const extracted = path.join(input, 'extracted-index');
  await fsp.mkdir(extracted);
  // Selective extraction never executes or stages any Windows runtime payload.
  run(seven, ['x', '-y', '-bsp0', '-bso0', '-o' + extracted, archive, ...wanted]);
  const database = path.join(extracted, ...databases[0].split('/'));
  const manifestPath = path.join(extracted, ...manifests[0].split('/'));
  const manifest = validateManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8')));
  if ((await fsp.stat(database)).size !== FULL.bytes || (await digest(database)) !== FULL.sha256)
    throw new Error('Full index byte identity mismatch');
  return { database, manifestPath, manifest, installerUrl: url };
}

async function prepareRuntime(stage, cache) {
  const lock = await fsp.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const evidence = [];
  for (const [name, version] of Object.entries(runtimePackages)) {
    const integrity = lockIntegrity(lock, name, version);
    const basename = name.split('/').at(-1);
    const tarball = path.join(cache, `${basename}-${version}.tgz`);
    const url = `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
    await download(url, tarball, integrity, 'sha512', 'base64');
    const destination = path.join(stage, 'node_modules', ...name.split('/'));
    await fsp.mkdir(destination, { recursive: true });
    // Exact pnpm-lock integrity; no lifecycle scripts, native rebuild, install
    // platform pruning, or dependency resolution against a mutable registry.
    const entries = run('tar', ['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
    if (
      entries.some(
        (entry) => !entry.startsWith('package/') || !safeArchivePath(entry.replace(/\/$/, ''))
      )
    )
      throw new Error(`Unsafe registry archive: ${name}`);
    run('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1']);
    const metadata = JSON.parse(await fsp.readFile(path.join(destination, 'package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== version)
      throw new Error(`Unexpected package: ${name}`);
    evidence.push({ name, version, integrity: 'sha512-' + integrity, url });
  }
  return evidence;
}

async function buildRenameHelper(stage, resources) {
  const source = path.join(stage, 'src', 'native', 'macos-rename.c');
  const directory = path.join(resources, 'bin');
  await fsp.mkdir(directory, { recursive: true });
  const executable = path.join(directory, 'acg-fs-rename');
  run('xcrun', [
    'clang',
    '-std=c11',
    '-D_DARWIN_C_SOURCE',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=12.0',
    source,
    '-o',
    executable
  ]);
  const architectures = run('lipo', ['-archs', executable]).split(/\s+/).sort();
  if (architectures.join(',') !== 'arm64,x86_64')
    throw new Error('Rename helper must contain both native slices');
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', executable]);
  run('codesign', ['--verify', '--strict', executable]);
  return {
    path: 'Contents/Resources/bin/acg-fs-rename',
    architectures,
    source: 'src/native/macos-rename.c',
    sourceSha256: await digest(source),
    sha256: await digest(executable),
    compiler: run('xcrun', ['clang', '--version']),
    deploymentTarget: '12.0'
  };
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('A native macOS runner is required; Windows cross-build is forbidden');
  const { build, Platform, Arch } = require('electron-builder');
  const metadata = require('../package.json');
  if (
    metadata.version !== FULL.version ||
    metadata.devDependencies.electron !== '40.10.6' ||
    metadata.devDependencies['electron-builder'] !== '26.8.1'
  )
    throw new Error('Unexpected release toolchain');
  const output = path.resolve(
    process.env.ACG_MAC_OUTPUT || path.join(root, 'release', 'mac-' + metadata.version)
  );
  const relative = path.relative(path.join(root, 'release'), output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('mac output must be a fresh child of repository release/');
  const release = path.join(root, 'release');
  await fsp.mkdir(release, { recursive: true });
  if ((await fsp.lstat(release)).isSymbolicLink())
    throw new Error('release/ must be a real directory');
  await fsp.mkdir(output, { recursive: false }); // Refuse to overwrite any candidate or old release.
  const input = path.join(output, 'input');
  await fsp.mkdir(input);
  // Retained only for this ephemeral runner; never stage under the pnpm source tree.
  const stage = await createRuntimeStage();
  const seven = process.env.ACG_MAC_7ZIP || '7zz';
  const index = await prepareIndex(input, seven);
  await fsp.cp(path.join(root, 'src'), path.join(stage, 'src'), {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      const relative = path.relative(root, source).replaceAll('\\', '/');
      if ((await fsp.lstat(source)).isSymbolicLink())
        throw new Error('Source symlinks are not accepted: ' + relative);
      if (/\.(?:ttf|otf|woff2?|ttc|otc|eot)$/i.test(relative))
        return relative === 'src/assets/fonts/source-han-sans/SourceHanSansSC-VF.otf';
      return true;
    }
  });
  const packages = await prepareRuntime(stage, input);
  const preparedSources = await prepareNativeSources(input, stage, seven);
  await fsp.writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        author: metadata.author,
        license: 'MIT',
        main: metadata.main,
        searchEdition: 'full',
        // electron-builder 26.8.1 explicitly supports this collector strategy.
        packageManager: collectorStrategy,
        dependencies: runtimePackages
      },
      null,
      2
    ) + '\n'
  );
  const runtimeStage = await verifyRuntimeStage(stage, packages, input);
  let indexCopies = 0;
  let runtimeLicenses;
  let nativeSources;
  let renameHelper;
  const config = builderConfig({
    root,
    stage,
    output,
    afterPack: async (context) => {
      await verifyRuntimeStage(stage, packages, input, runtimeStage.files);
      if (context.arch !== Arch.universal) return;
      if (++indexCopies !== 1)
        throw new Error('Index insertion must run exactly once after universal merge');
      const destination = path.join(
        context.appOutDir,
        'ACG-album.app',
        'Contents',
        'Resources',
        'local-index'
      );
      await fsp.mkdir(destination);
      await fsp.copyFile(
        index.database,
        path.join(destination, 'subjects.sqlite'),
        fs.constants.COPYFILE_EXCL
      );
      await fsp.copyFile(
        index.manifestPath,
        path.join(destination, 'manifest.json'),
        fs.constants.COPYFILE_EXCL
      );
      await fsp.copyFile(
        path.join(root, 'docs', 'LOCAL_SEARCH_DATA.md'),
        path.join(destination, 'SOURCE.md')
      );
      if ((await digest(path.join(destination, 'subjects.sqlite'))) !== FULL.sha256)
        throw new Error('Bundled index hash mismatch');
      const resources = path.dirname(destination);
      runtimeLicenses = await writeRuntimeLicenses(
        stage,
        resources,
        packages,
        preparedSources.directory
      );
      nativeSources = await installNativeSources(preparedSources, resources);
      renameHelper = await buildRenameHelper(stage, resources);
    }
  });
  config.beforePack = async (context) => {
    const packager = context.packager.info;
    if (
      packager.appDir !== stage ||
      packager.projectDir !== stage ||
      (await packager.getPackageManager()) !== 'traversal'
    )
      throw new Error(
        'Builder must collect runtime packages only from the isolated traversal stage'
      );
    await verifyRuntimeStage(stage, packages, input, runtimeStage.files);
  };
  const artifacts = await build({
    projectDir: stage,
    targets: Platform.MAC.createTarget('dmg', Arch.universal),
    publish: 'never',
    config
  });
  await verifyRuntimeStage(stage, packages, input, runtimeStage.files);
  if (indexCopies !== 1) throw new Error('Universal afterPack hook did not insert Full index');
  const dmg = path.join(output, `ACG-album-Setup-${metadata.version}-Full-universal.dmg`);
  const images = (await walkFiles(output)).filter((name) => name.endsWith('.dmg'));
  if (images.length !== 1 || images[0] !== dmg)
    throw new Error('Exactly one Full universal DMG is required');
  const sha256 = await digest(dmg);
  const report = {
    version: metadata.version,
    sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
    sourceDirty: !!run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }),
    createdAt: new Date().toISOString(),
    platform: process.platform,
    hostArch: process.arch,
    electron: '40.10.6',
    electronBuilder: '26.8.1',
    signing: 'ad-hoc',
    notarized: false,
    artifacts,
    dmg: path.basename(dmg),
    bytes: (await fsp.stat(dmg)).size,
    sha256,
    indexCopiesInUniversalApp: indexCopies,
    index: index.manifest,
    installerUrl: index.installerUrl,
    installerSha256: FULL.installerSha256,
    runtimePackages: packages,
    runtimeStage,
    runtimeLicenses,
    nativeSources,
    renameHelper,
    minimumSystemVersion: '12.0',
    verification:
      'Build only; check-mac-full.cjs must pass on native Intel and Apple Silicon runners before delivery.'
  };
  await fsp.writeFile(
    path.join(output, 'build-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  await fsp.writeFile(
    path.join(output, 'SHA256SUMS.mac.txt'),
    `${sha256}  ${path.basename(dmg)}\n`
  );
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) runCli(main);
module.exports = { prepareIndex, prepareRuntime, buildRenameHelper, main };
