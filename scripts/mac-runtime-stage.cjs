'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { runtimePackages, digest, lockIntegrity } = require('./mac-support.cjs');
const root = path.resolve(__dirname, '..');
const collectorStrategy = 'traversal@1.0.0';

function builderRequire() {
  return createRequire(
    require.resolve('app-builder-lib', {
      paths: [path.dirname(require.resolve('electron-builder'))]
    })
  );
}

async function createRuntimeStage() {
  const temporary = await fsp.realpath(os.tmpdir());
  const stage = await fsp.mkdtemp(path.join(temporary, 'acg-mac-build-'));
  assert.equal(path.dirname(await fsp.realpath(stage)), temporary);
  assert.ok(!(await fsp.lstat(stage)).isSymbolicLink());
  console.log('Created isolated runtime stage: ' + stage);
  return stage;
}

async function snapshotRuntime(stage) {
  const records = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Runtime stage must not contain symlinks: ' + filename);
      if (entry.isDirectory()) await visit(filename);
      else {
        assert.ok(entry.isFile(), 'Unsupported runtime file: ' + filename);
        const file = path.relative(stage, filename).replaceAll('\\', '/');
        assert.ok(
          Object.keys(runtimePackages).some((name) =>
            file.startsWith('node_modules/' + name + '/')
          ),
          'Unrecorded runtime package file: ' + file
        );
        records.push({
          file,
          bytes: (await fsp.stat(filename)).size,
          sha256: await digest(filename)
        });
      }
    }
  }
  await visit(path.join(stage, 'node_modules'));
  return records.sort((a, b) => a.file.localeCompare(b.file));
}

async function assertCollectorClosure(stage, result) {
  const actual = [];
  const visit = async (nodes) => {
    for (const node of nodes) {
      assert.equal(
        node.version,
        runtimePackages[node.name],
        'Foreign or changed runtime package: ' + node.name
      );
      const expected = path.join(stage, 'node_modules', ...node.name.split('/'));
      assert.equal(
        path.resolve(node.dir),
        expected,
        'Collector escaped curated runtime stage: ' + node.name
      );
      assert.equal(
        await fsp.realpath(node.dir),
        expected,
        'Collector runtime package is linked outside stage: ' + node.name
      );
      actual.push({ name: node.name, version: node.version, directory: expected });
      if (node.dependencies) await visit(node.dependencies);
    }
  };
  await visit(result.nodeModules);
  actual.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    actual.map(({ name, version }) => [name, version]),
    Object.entries(runtimePackages).sort(([a], [b]) => a.localeCompare(b)),
    'Collector must return exactly the nine curated runtime packages'
  );
  const optionalMissing = result.logSummary['missing optional dependencies'] || [];
  return { strategy: collectorStrategy, packages: actual, optionalMissing };
}

async function verifyRuntimeStage(stage, packages, cache, baseline) {
  assert.equal(await fsp.realpath(stage), path.resolve(stage), 'Runtime stage must be a real path');
  const metadata = JSON.parse(await fsp.readFile(path.join(stage, 'package.json'), 'utf8'));
  assert.equal(metadata.packageManager, collectorStrategy);
  assert.deepEqual(metadata.dependencies, runtimePackages);
  const fromBuilder = builderRequire();
  const { detectPackageManager, PM } = fromBuilder(
    'app-builder-lib/out/node-module-collector/packageManager.js'
  );
  const detected = await detectPackageManager([stage]);
  assert.equal(
    detected.pm,
    PM.TRAVERSAL,
    'Builder must use its explicit filesystem traversal strategy'
  );
  assert.equal(detected.resolvedDirectory, stage);
  const { getCollectorByPackageManager } = fromBuilder(
    'app-builder-lib/out/node-module-collector/index.js'
  );
  const collector = getCollectorByPackageManager(PM.TRAVERSAL, stage);
  const closure = await assertCollectorClosure(
    stage,
    await collector.getNodeModules({ packageName: metadata.name })
  );
  assert.deepEqual(
    packages.map(({ name, version }) => [name, version]),
    Object.entries(runtimePackages)
  );
  const lock = await fsp.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const row of packages) {
    const integrity = lockIntegrity(lock, row.name, row.version);
    assert.equal(row.integrity, 'sha512-' + integrity);
    const archive = path.join(cache, row.name.split('/').at(-1) + '-' + row.version + '.tgz');
    assert.equal(
      await digest(archive, 'sha512', 'base64'),
      integrity,
      'Runtime package archive no longer matches lock: ' + row.name
    );
  }
  const files = await snapshotRuntime(stage);
  if (baseline)
    assert.deepEqual(files, baseline, 'Curated npm runtime package bytes changed during packaging');
  return { ...closure, files };
}

module.exports = {
  collectorStrategy,
  builderRequire,
  createRuntimeStage,
  snapshotRuntime,
  assertCollectorClosure,
  verifyRuntimeStage
};
