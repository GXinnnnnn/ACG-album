'use strict';
// Serial, source-only GUI verification with generated media/profile and the read-only Archive index.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const artifactRoot = require('node:fs').realpathSync(path.join(root, 'artifacts'));
const run = path.join(
  artifactRoot,
  'character-gui',
  new Date().toISOString().replace(/[:.]/g, '-')
);
const profile = path.join(run, 'generated-profile');
const collection = path.join(run, 'generated-roles');
const known = path.join(collection, '朝武芳乃');
const other = path.join(collection, '自定义角色GUI夹具');
const knownId = idFor(known),
  otherId = idFor(other);
const index = process.env.ACG_INDEX_SOURCE
  ? path.join(process.env.ACG_INDEX_SOURCE, 'subjects.sqlite')
  : path.resolve(root, '../资料归档/local-index-pilot-2026-10-20/subjects.sqlite');
const report = {
  run,
  profile,
  index,
  checks: [],
  errors: [],
  screenshots: [],
  notes: [
    'Every profile and imported image is generated for this check. The Archive database is opened read-only.',
    'Native directory selection is stubbed. Import, offline matching, manual ID binding, custom metadata and refresh use real IPC/backend.',
    'Online portrait HTTP behavior is covered by worker integration tests, not this offline GUI run.'
  ]
};
let app,
  page,
  stage = 'setup';
const originalHashes = new Map();
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function check(name, action) {
  stage = name;
  await action();
  report.checks.push({ name, status: 'passed' });
  console.log('PASS ' + name);
}
async function size(width, height = 900) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setMinimumSize(320, 280);
      win.setContentSize(width, height);
    },
    { width, height }
  );
  await page.waitForFunction((width) => innerWidth === width, width);
}
async function go(id) {
  await page.evaluate((id) => navigate({ parent: id }), id);
  await page.waitForFunction((id) => S.current?.id === id, id);
}
async function edit(id) {
  await go(id);
  await page.locator('#intro-edit, #intro-bind').click();
  await page.waitForSelector('#character-save');
}
async function waitClosed() {
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function bounds(selector) {
  return page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect();
    return {
      x: r.x,
      right: r.right,
      width: r.width,
      viewport: innerWidth,
      scroll: element.scrollWidth,
      client: element.clientWidth
    };
  });
}
(async () => {
  try {
    await fs.mkdir(profile, { recursive: true });
    await fs.access(index);
    report.indexHashBefore = await fileDigest(index);
    for (const folder of [known, other]) {
      await fs.mkdir(folder, { recursive: true });
      for (const [name, color, time] of [
        ['1.png', '#f4acbb', 1600000000],
        ['2.png', '#aad4eb', 1800000000],
        ['10.png', '#d6c2eb', 1900000000]
      ]) {
        const file = path.join(folder, name);
        const image = await sharp({
          create: { width: 90, height: 128, channels: 3, background: color }
        })
          .png()
          .toBuffer();
        await fs.writeFile(file, image);
        await fs.utimes(file, time, time);
        originalHashes.set(file, digest(image));
      }
      const video = path.join(folder, '0.mp4');
      await fs.writeFile(video, 'generated placeholder; never decoded in this check');
      originalHashes.set(video, digest(await fs.readFile(video)));
    }
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: index
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['.'],
      cwd: root,
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname !== undefined);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await size(1180);
    await app.evaluate(({ dialog }, collection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
    }, collection);
    await check('isolated source runtime discovers the actual read-only Full index', async () => {
      const runtime = await app.evaluate(({ app }) => ({
        version: app.getVersion(),
        userData: app.getPath('userData'),
        packaged: app.isPackaged
      }));
      assert.equal(runtime.packaged, false);
      assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
      const status = await rpc('localIndexStatus');
      assert.equal(status.available, true);
      assert.equal(path.resolve(status.path), path.resolve(index));
      report.runtime = runtime;
    });
    await check(
      'real import dialog offers character local-first and Bangumi policies independently of online matching',
      async () => {
        await page.evaluate(() => importFolder());
        await page.selectOption('#import-directory-kind', 'character', { force: true });
        assert.equal(await page.locator('#import-character-options').isVisible(), true);
        await page.selectOption('#import-character-cover', 'bangumi', { force: true });
        assert.equal(await page.locator('#import-character-cover').inputValue(), 'bangumi');
        await page.selectOption('#import-character-cover', 'local-first', { force: true });
        const online = page.locator('#import-online-match');
        if (await online.isChecked()) await online.uncheck({ force: true });
        await shot('character-import-light');
        await page.locator('#import-options-confirm').click();
        await expect
          .poll(async () => (await rpc('get', { id: knownId }))?.character_id, { timeout: 45000 })
          .toBe(39360);
        const knownNode = await rpc('get', { id: knownId });
        assert.equal(knownNode.effective_album_kind, 'character');
        assert.equal(knownNode.character_id, 39360);
        assert.equal(knownNode.subject_id, null);
        assert.equal(knownNode.cover, idFor(path.join(known, '1.png')));
        assert.equal((await rpc('get', { id: otherId })).cover, idFor(path.join(other, '1.png')));
      }
    );
    await check(
      'offline role introduction renders real character details and preserves local-first cover',
      async () => {
        await go(knownId);
        await page.waitForSelector('#intro-edit');
        assert.ok((await page.locator('.intro-panel').innerText()).includes('芳乃'));
        const node = await rpc('get', { id: knownId });
        assert.ok(node.metadata.summary.length > 20);
        assert.equal(node.metadata.kind, 'character');
        await shot('character-introduction-light');
      }
    );
    await check(
      'custom character name and summary save through real UI without a fake Bangumi ID',
      async () => {
        await edit(otherId);
        await page.selectOption('#character-mode', 'custom', { force: true });
        await page.fill('#character-name', '自定义角色 · 测试');
        await page.fill(
          '#character-summary',
          '第一段：本地保存的角色简介。\n第二段：重扫后仍保留人工整理。'
        );
        await page.locator('#character-save').click();
        await waitClosed();
        await page.waitForFunction(
          () => document.querySelector('.intro-panel h2')?.textContent === '自定义角色 · 测试'
        );
        const node = await rpc('get', { id: otherId });
        assert.equal(node.character_id, null);
        assert.equal(node.subject_id, null);
        assert.equal(node.metadata.source, 'custom');
        assert.equal(node.metadata.name, '自定义角色 · 测试');
        assert.ok(node.metadata.summary.includes('\n第二段'));
        await shot('character-custom-light');
      }
    );
    await check(
      'rescan retains the custom introduction and natural-order first image',
      async () => {
        await rpc('refresh', { id: idFor(collection) });
        const node = await rpc('get', { id: otherId });
        assert.equal(node.metadata.source, 'custom');
        assert.equal(node.cover, idFor(path.join(other, '1.png')));
        assert.equal((await rpc('get', { id: knownId })).cover, idFor(path.join(known, '1.png')));
      }
    );
    await check(
      'manual character URL resolves by ID offline even when folder name differs',
      async () => {
        await edit(otherId);
        await page.selectOption('#character-mode', 'bangumi', { force: true });
        await page.fill('#character-url', 'https://bgm.tv/character/39360');
        await page.locator('#character-save').click();
        await waitClosed();
        const node = await rpc('get', { id: otherId });
        assert.equal(node.character_id, 39360);
        assert.equal(node.manual_character, 1);
        assert.equal(node.subject_id, null);
        assert.equal(node.metadata.source, 'local-index');
        assert.equal(node.cover, idFor(path.join(other, '1.png')));
      }
    );
    await check('invalid character URL shows an inline error and re-enables saving', async () => {
      await edit(otherId);
      await page.fill('#character-url', 'https://example.com/character/39360');
      await page.locator('#character-save').click();
      await page.waitForFunction(() => !!document.querySelector('#character-error')?.textContent);
      assert.equal(await page.locator('#character-save').isEnabled(), true);
      assert.equal((await rpc('get', { id: otherId })).character_id, 39360);
      await page.evaluate(() => closeModal());
    });
    for (const width of [980, 320]) {
      await check(
        'dark character editor and import options remain within ' + width + 'px bounds',
        async () => {
          await size(width);
          await page.evaluate(async () => {
            await saveSetting('theme', 'dark');
            applySettings();
          });
          await edit(otherId);
          await page.selectOption('#character-mode', 'custom', { force: true });
          const editor = await bounds('#modal');
          assert.ok(editor.x >= -1 && editor.right <= editor.viewport + 1, JSON.stringify(editor));
          assert.ok(editor.scroll <= editor.client + 1, JSON.stringify(editor));
          await shot('character-editor-dark-' + width);
          await page.evaluate(() => closeModal());
          await page.evaluate(() => importFolder());
          await page.selectOption('#import-directory-kind', 'character', { force: true });
          const importer = await bounds('#modal');
          assert.ok(
            importer.x >= -1 && importer.right <= importer.viewport + 1,
            JSON.stringify(importer)
          );
          assert.ok(importer.scroll <= importer.client + 1, JSON.stringify(importer));
          await shot('character-import-dark-' + width);
          await page.locator('#import-options-cancel').click();
        }
      );
    }
    await check(
      'renderer stays error-free and generated originals plus Archive database remain unchanged',
      async () => {
        assert.deepEqual(report.errors, []);
        for (const [file, expected] of originalHashes)
          assert.equal(digest(await fs.readFile(file)), expected);
        report.indexHashAfter = await fileDigest(index);
        assert.equal(report.indexHashAfter, report.indexHashBefore);
      }
    );
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { stage, error: error.stack };
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('REPORT ' + path.join(run, 'report.json'));
  }
})();
