'use strict';
// Run alone: GUI or build work in parallel would contaminate frame timings.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  path = require('node:path');
const root = path.resolve(__dirname, '..');
let source;
const run = path.join(root, 'artifacts/desktop-diagnosis-' + Date.now());
(async () => {
  source = path.dirname(await require('./fixture-profile.cjs').latestMediaProfile(root));
  await fs.mkdir(run, { recursive: true });
  await fs.cp(path.join(source, 'profile'), path.join(run, 'profile'), { recursive: true });
  const env = { ...process.env, ACG_DATA_DIR: path.join(run, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w.isMaximized()) w.unmaximize();
      w.setContentSize(1920, 1032);
      w.webContents.setBackgroundThrottling(false);
    });
    await page.evaluate(async () => {
      await navigate({ parent: S.roots[0].id, view: 'library', filter: 'images' });
      await changeDisplaySetting('density', 158);
      await changeDisplaySetting('details', false);
    });
    await page.waitForFunction(() => grid.total > 400 && grid.cards.size > 0);
    const variants = [];
    for (const variant of [
      { name: 'desktop-step', width: 1920, height: 1032 },
      { name: '4k-step', width: 3840, height: 2160 },
      { name: '4k-step-warm', width: 3840, height: 2160 },
      { name: '4k-sweep', width: 3840, height: 2160, sweep: true },
      { name: '4k-sweep-warm', width: 3840, height: 2160, sweep: true }
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
        variant
      );
      await page.waitForFunction((width) => innerWidth === width, variant.width);
      const result = await page.evaluate(async (variant) => {
        const v = $('#viewport');
        v.scrollTop = 0;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const deltas = [],
          draws = [];
        let last = performance.now();
        const step = variant.sweep ? Math.max(30, (v.scrollHeight - v.clientHeight) / 49) : 83;
        for (let i = 0; i < 100; i++) {
          v.scrollTop = (i % 50) * step;
          const start = performance.now();
          grid.render();
          draws.push(performance.now() - start);
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          deltas.push(now - last);
          last = now;
        }
        deltas.sort((a, b) => a - b);
        draws.sort((a, b) => a - b);
        return {
          variant: variant.name,
          step,
          scrollHeight: v.scrollHeight,
          p50: deltas[50],
          p95: deltas[95],
          max: deltas.at(-1),
          drawP50: draws[50],
          drawP95: draws[95],
          cards: grid.cards.size
        };
      }, variant);
      variants.push(result);
      console.log(JSON.stringify(result));
    }
    // Capture trace separately so tracing does not affect the benchmark above.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,v8,blink',
      transferMode: 'ReturnAsStream'
    });
    await page.evaluate(async () => {
      const v = $('#viewport');
      v.scrollTop = 0;
      for (let i = 0; i < 40; i++) {
        v.scrollTop += 83;
        grid.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    const completed = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await completed;
    let trace = '';
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream });
      trace += chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    await fs.writeFile(path.join(run, 'trace.json'), trace);
    const events = JSON.parse(trace).traceEvents,
      costs = {};
    for (const e of events)
      if (e.ph === 'X' && e.dur) {
        const c = (costs[e.name] ??= { count: 0, totalMs: 0, maxMs: 0 });
        c.count++;
        c.totalMs += e.dur / 1000;
        c.maxMs = Math.max(c.maxMs, e.dur / 1000);
      }
    const environment = await app.evaluate(async ({ app, screen }) => ({
      features: app.getGPUFeatureStatus(),
      gpu: await app.getGPUInfo('complete'),
      displays: screen.getAllDisplays().map((d) => ({ size: d.size, scaleFactor: d.scaleFactor }))
    }));
    const result = {
      run,
      variants,
      traceCosts: Object.entries(costs)
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .slice(0, 35),
      environment
    };
    await fs.writeFile(path.join(run, 'performance.json'), JSON.stringify(result, null, 2));
    console.log('RESULT ' + run);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
