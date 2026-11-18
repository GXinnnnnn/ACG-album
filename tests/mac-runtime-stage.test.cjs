'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runtimePackages } = require('../scripts/mac-support.cjs');
const {
  collectorStrategy,
  builderRequire,
  assertCollectorClosure,
  snapshotRuntime
} = require('../scripts/mac-runtime-stage.cjs');

async function fixture(t) {
  const temporary = await fsp.realpath(os.tmpdir());
  const owned = await fsp.mkdtemp(path.join(temporary, 'acg-mac-collector-test-'));
  t.after(async () => {
    assert.equal(path.dirname(owned), temporary);
    assert.ok(path.basename(owned).startsWith('acg-mac-collector-test-'));
    await fsp.rm(owned, { recursive: true });
  });
  const stage = path.join(owned, 'app-stage');
  await fsp.mkdir(stage);
  await fsp.writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: 'mac-runtime-fixture',
      version: '1.0.0',
      packageManager: collectorStrategy,
      dependencies: runtimePackages
    })
  );
  for (const [name, version] of Object.entries(runtimePackages)) {
    const directory = path.join(stage, 'node_modules', ...name.split('/'));
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        ...(name === 'sharp'
          ? {
              dependencies: { '@img/colour': '1.1.0', 'detect-libc': '^2.1.2', semver: '^7.8.5' },
              optionalDependencies: {
                '@img/sharp-darwin-arm64': '0.34.5',
                '@img/sharp-darwin-x64': '0.34.5',
                '@img/sharp-libvips-darwin-arm64': '1.2.4',
                '@img/sharp-libvips-darwin-x64': '1.2.4',
                'foreign-runtime': '1.0.0'
              }
            }
          : {})
      })
    );
    await fsp.writeFile(path.join(directory, 'index.js'), 'module.exports = true;\n');
  }
  return { owned, stage };
}

async function collect(stage) {
  const fromBuilder = builderRequire();
  const { PM, detectPackageManager } = fromBuilder(
    'app-builder-lib/out/node-module-collector/packageManager.js'
  );
  const { getCollectorByPackageManager } = fromBuilder(
    'app-builder-lib/out/node-module-collector/index.js'
  );
  const actual = await detectPackageManager([stage]);
  assert.equal(actual.pm, PM.TRAVERSAL);
  assert.equal(actual.resolvedDirectory, stage);
  return getCollectorByPackageManager(actual.pm, stage).getNodeModules({
    packageName: 'mac-runtime-fixture'
  });
}

test('real builder strategy collects exactly nine flat curated packages without a package manager command', async (t) => {
  const { stage } = await fixture(t);
  const closure = await assertCollectorClosure(stage, await collect(stage));
  assert.equal(closure.packages.length, 9);
  assert.deepEqual(closure.optionalMissing, ['foreign-runtime@1.0.0']);
  for (const row of closure.packages)
    assert.equal(row.directory, path.join(stage, 'node_modules', ...row.name.split('/')));
});

test('real collector upward optional resolution cannot import a foreign parent runtime', async (t) => {
  const { stage, owned } = await fixture(t);
  const foreign = path.join(owned, 'node_modules', 'foreign-runtime');
  await fsp.mkdir(foreign, { recursive: true });
  await fsp.writeFile(
    path.join(foreign, 'package.json'),
    JSON.stringify({ name: 'foreign-runtime', version: '1.0.0' })
  );
  await assert.rejects(
    assertCollectorClosure(stage, await collect(stage)),
    /Foreign or changed runtime package/
  );
});

test('collector closure rejects missing, changed, escaped and duplicate packages', async (t) => {
  const { stage } = await fixture(t);
  const result = await collect(stage);
  const change = (transform) => ({
    ...result,
    nodeModules: transform(structuredClone(result.nodeModules))
  });
  await assert.rejects(
    assertCollectorClosure(
      stage,
      change((rows) => rows.slice(1))
    ),
    /exactly the nine/
  );
  await assert.rejects(
    assertCollectorClosure(
      stage,
      change((rows) => {
        rows[0].version = '99.0.0';
        return rows;
      })
    ),
    /Foreign or changed/
  );
  await assert.rejects(
    assertCollectorClosure(
      stage,
      change((rows) => {
        rows[0].dir = path.dirname(stage);
        return rows;
      })
    ),
    /escaped curated/
  );
  await assert.rejects(
    assertCollectorClosure(
      stage,
      change((rows) => [...rows, rows[0]])
    ),
    /exactly the nine/
  );
});

test('runtime file inventory detects changed original bytes and unrecorded package files', async (t) => {
  const { stage } = await fixture(t);
  const before = await snapshotRuntime(stage);
  const target = path.join(stage, 'node_modules', 'sharp', 'index.js');
  await fsp.appendFile(target, '// altered\n');
  const after = await snapshotRuntime(stage);
  assert.notDeepEqual(after, before);
  assert.notEqual(
    after.find((row) => row.file.endsWith('/sharp/index.js')).sha256,
    before.find((row) => row.file.endsWith('/sharp/index.js')).sha256
  );
  const extra = path.join(stage, 'node_modules', 'foreign-runtime');
  await fsp.mkdir(extra);
  await fsp.writeFile(path.join(extra, 'index.js'), 'unrecorded');
  await assert.rejects(snapshotRuntime(stage), /Unrecorded runtime package/);
});
