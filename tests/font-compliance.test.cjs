'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/typography.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/ui/typography.css'), 'utf8');
const regular = '方正兰亭圆_GBK';
const bundled = 'ACG Source Han Sans';
const presets = [regular, regular + '_准', regular + '_中', regular + '_中粗', regular + '_特'];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function harness({
  installed = [],
  localLoad,
  fontFace = true,
  load = async () => [{}],
  systemFonts = async () => ({ families: [], source: 'unsupported-platform' }),
  fontsAvailable = true
} = {}) {
  const probes = [],
    loads = [],
    calls = [],
    writes = [],
    events = [],
    restored = [],
    listeners = new Set();
  let fontFamily = 'Existing Font';
  const style = {
    set fontFamily(value) {
      writes.push(value);
      fontFamily = value;
    },
    get fontFamily() {
      return fontFamily;
    },
    setProperty(name, value) {
      this[name] = value;
    }
  };
  const root = { style, dataset: {} };
  const viewport = {
    addEventListener: (_event, callback) => listeners.add(callback),
    removeEventListener: (_event, callback) => listeners.delete(callback)
  };
  let captures = 0;
  const context = {
    document: {
      documentElement: root,
      getElementById: () => viewport,
      fonts: fontsAvailable
        ? {
            load: (font, sample) => {
              loads.push({ font, sample });
              return load(font, sample);
            },
            check() {
              assert.fail('CSS aliases or fallback success cannot prove a system installation');
            },
            add() {
              assert.fail('The installation probe must never register or install a font');
            },
            ready: Promise.resolve()
          }
        : undefined
    },
    window: {
      album: {
        call: (method) => {
          calls.push(method);
          return systemFonts();
        }
      },
      dispatchEvent: (event) => events.push(event)
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    CustomEvent: class {
      constructor(type, { detail }) {
        this.type = type;
        this.detail = detail;
      }
    },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    captureDisplayAnchor: () => ({ id: ++captures }),
    restoreDisplayAnchor: (anchor) => restored.push(anchor),
    viewKey: () => 'library'
  };
  if (fontFace) {
    context.FontFace = class {
      constructor(family, source) {
        assert.equal(family, 'ACG Installed Font Probe');
        assert.match(source, /^local\("[^"\n]+"\)$/);
        this.source = source;
        probes.push(source);
      }
      async load() {
        if (localLoad) return localLoad(this.source);
        const family = JSON.parse(this.source.slice(6, -1));
        if (!installed.includes(family)) throw Error('Local font is not installed');
        return this;
      }
    };
  }
  vm.runInNewContext(source, context);
  return {
    apply: context.window.albumTypography.apply,
    root,
    probes,
    loads,
    calls,
    writes,
    events,
    restored,
    listeners
  };
}

test('uninstalled defaults ignore usable CSS aliases and preload all five Source Han Sans UI weights', async () => {
  const h = harness();
  const settings = Object.freeze({ fontFamily: '' });
  assert.equal(await h.apply(settings), true);
  assert.match(h.root.style.fontFamily, /^"ACG Source Han Sans",/);
  assert.match(h.root.style['--secondary-font-family'], /^"ACG Source Han Sans",/);
  assert.deepEqual(
    h.loads.map(({ font }) => Number(font.split(' ')[0])),
    [400, 500, 600, 700, 900]
  );
  assert.ok(h.loads.every(({ font }) => font.includes(`"${bundled}"`)));
  assert.equal(h.probes.length, 5);
  assert.ok(h.probes.every((probe) => !/url|archive|assets|ACG Lanting/.test(probe)));
  assert.equal(h.calls.length, 0);
  assert.equal(settings.fontFamily, '');
  assert.equal(h.root.dataset.fontState, 'ready');
  assert.equal(h.writes.length, 1);
  assert.equal(h.restored.length, 1);
  assert.equal(h.listeners.size, 0);
});

test('a real installed regular face keeps the previous default family and does not enumerate the disk', async () => {
  const h = harness({ installed: presets });
  await h.apply(Object.freeze({}));
  assert.match(h.root.style.fontFamily, /^"方正兰亭圆_GBK",.*ACG Source Han Sans/);
  assert.deepEqual(h.probes, [`local("${regular}")`]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.events[0].detail.family, regular);
});

test('a genuinely installed nonregular variant can be the default while secondary ink stays regular', async () => {
  const h = harness({ installed: [presets[2]] });
  await h.apply({});
  assert.match(h.root.style.fontFamily, /^"方正兰亭圆_GBK_中",/);
  assert.equal(h.probes.length, 3);
  assert.match(h.root.style['--secondary-font-family'], /^"方正兰亭圆_GBK",.*ACG Source Han Sans/);
});

test('only the existing Windows installed-font enumeration may substitute for a missing FontFace API', async () => {
  for (const origin of ['windows-installed-fonts', 'archive-files', 'fontconfig', undefined]) {
    const h = harness({
      fontFace: false,
      systemFonts: async () => ({ families: [regular], source: origin })
    });
    await h.apply({});
    assert.deepEqual(h.calls, ['systemFonts']);
    assert.equal(
      h.events[0].detail.family,
      origin === 'windows-installed-fonts' ? regular : bundled
    );
  }
  const variant = harness({
    fontFace: false,
    systemFonts: async () => ({ families: [presets[3]], source: 'windows-installed-fonts' })
  });
  await variant.apply({});
  assert.equal(variant.events[0].detail.family, presets[3]);
});

test('enumeration failure leaves a usable bundled default without rewriting a stored preference', async () => {
  const h = harness({
    fontFace: false,
    systemFonts: async () => {
      throw Error('enumeration unavailable');
    }
  });
  const settings = Object.freeze({ fontFamily: '' });
  assert.equal(await h.apply(settings), true);
  assert.match(h.root.style.fontFamily, /^"ACG Source Han Sans",/);
  assert.equal(settings.fontFamily, '');
});

test('all existing explicit choices stay first even when local faces have disappeared', async () => {
  for (const family of [...presets, 'ACG Lanting Yuan', '用户选择的其他字体']) {
    const h = harness({
      load: async (font) => (font.includes(`"${bundled}"`) ? [{}] : [])
    });
    const settings = Object.freeze({ fontFamily: family });
    const result = await h.apply(settings);
    assert.ok(h.root.style.fontFamily.startsWith(JSON.stringify(family) + ','));
    assert.match(h.root.style.fontFamily, /ACG Source Han Sans/);
    assert.equal(settings.fontFamily, family);
    assert.equal(h.probes.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(result, family === '用户选择的其他字体');
    assert.equal(h.events[0].detail.ready, result);
  }
});

test('loading a new family does not expose an intermediate fallback stack before the final commit', async () => {
  const gate = deferred();
  const h = harness({ load: () => gate.promise });
  const pending = h.apply({ fontFamily: bundled });
  assert.equal(h.root.style.fontFamily, 'Existing Font');
  assert.equal(h.root.style['--secondary-font-family'], undefined);
  assert.equal(h.root.dataset.fontState, 'loading');
  assert.equal(h.writes.length, 0);
  gate.resolve([{}]);
  await pending;
  assert.equal(h.writes.length, 1);
  assert.match(h.root.style['--secondary-font-family'], /^"ACG Source Han Sans",/);
  assert.deepEqual(
    h.events.map(({ type }) => type),
    ['album:font-loaded', 'resize']
  );
});

test('heavier local presets wait for regular small-label ink before changing either stack', async () => {
  const gate = deferred();
  const h = harness({
    load: (font) => (font.endsWith(JSON.stringify(regular)) ? gate.promise : Promise.resolve([{}]))
  });
  const pending = h.apply({ fontFamily: presets[3] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(h.loads.some(({ font }) => font === `400 16px "${regular}"`));
  assert.equal(h.root.style.fontFamily, 'Existing Font');
  assert.equal(h.writes.length, 0);
  gate.resolve([{}]);
  await pending;
  assert.match(h.root.style.fontFamily, /^"方正兰亭圆_GBK_中粗",/);
  assert.match(h.root.style['--secondary-font-family'], /^"方正兰亭圆_GBK",/);
  assert.equal(h.writes.length, 1);
});

test('an explicit legacy aggregate loads all mapped weights and honestly reports a missing weight', async () => {
  const h = harness({
    load: async (font) => (font === '600 16px "ACG Lanting Yuan"' ? [] : [{}])
  });
  assert.equal(await h.apply(Object.freeze({ fontFamily: 'ACG Lanting Yuan' })), false);
  assert.deepEqual(
    h.loads
      .filter(({ font }) => font.includes('"ACG Lanting Yuan"'))
      .map(({ font }) => Number(font.split(' ')[0])),
    [400, 500, 600, 700, 900]
  );
  assert.match(h.root.style.fontFamily, /^"ACG Lanting Yuan",.*ACG Source Han Sans/);
  assert.match(h.root.style['--secondary-font-family'], /^"方正兰亭圆_GBK",/);
  assert.equal(h.root.dataset.fontState, 'fallback');
});

test('late automatic detection cannot replace an explicit selection or restore its stale anchor', async () => {
  const gate = deferred();
  const h = harness({ localLoad: () => gate.promise });
  const automatic = h.apply({});
  const manual = h.apply({ fontFamily: 'Manual Font' });
  assert.equal(await manual, true);
  gate.resolve({});
  assert.equal(await automatic, false);
  assert.match(h.root.style.fontFamily, /^"Manual Font",/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.events[0].detail.family, 'Manual Font');
  assert.equal(h.restored.length, 1);
  assert.equal(h.restored[0].id, 2);
  assert.equal(h.listeners.size, 0);
});

test('missing bundled data is reported as fallback and still settles layout only once', async () => {
  const h = harness({ load: async () => [] });
  assert.equal(await h.apply({ fontFamily: bundled }), false);
  assert.equal(h.root.dataset.fontState, 'fallback');
  assert.equal(h.events[0].detail.ready, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.restored.length, 1);
  assert.equal(await h.apply({ fontFamily: bundled }), false);
  assert.equal(h.writes.length, 1);
});

test('a browser without font loading APIs retains the chosen stack and releases its anchor listener', async () => {
  const h = harness({ fontsAvailable: false });
  assert.equal(await h.apply({ fontFamily: 'Manual Font' }), false);
  assert.match(h.root.style.fontFamily, /^"Manual Font",.*ACG Source Han Sans/);
  assert.equal(h.root.dataset.fontState, 'fallback');
  assert.equal(h.listeners.size, 0);
});

test('font assets are local-only for Founder and the official VF advertises its actual weight range', () => {
  const rules = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const sourceHan = rules.filter((rule) => /font-family:\s*'ACG Source Han Sans'/.test(rule));
  assert.equal(sourceHan.length, 1);
  assert.match(sourceHan[0], /font-weight:\s*250 900;/);
  assert.match(
    sourceHan[0],
    /src:\s*url\('\.\.\/assets\/fonts\/source-han-sans\/SourceHanSansSC-VF\.otf'\)/
  );
  for (const rule of rules.filter((rule) => !sourceHan.includes(rule))) {
    assert.match(rule, /src:\s*local\('[^']+'\);/);
    assert.doesNotMatch(rule, /url\(|\.ttf|https?:/);
  }
  assert.equal([...css.matchAll(/url\(/g)].length, 1);
  assert.doesNotMatch(css, /founder-lanting-yuan/);
});

test('only Source Han Sans gets the previous regular metrics without changing glyph scale or advances', () => {
  const rules = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const sourceHan = rules.find((rule) => /font-family:\s*'ACG Source Han Sans'/.test(rule));
  const metric = (name) => Number(new RegExp(name + ':\\s*([0-9.]+)%;').exec(sourceHan)[1]);
  // The prior regular font's head.unitsPerEm=256, hhea/win ascent=229,
  // descent=67 and lineGap=0. Source Han Sans hhea/win uses 1160/288/1000.
  // Equal normalized metrics keep normal-line controls and text ranges stable.
  assert.equal(metric('ascent-override'), (229 / 256) * 100);
  assert.equal(metric('descent-override'), (67 / 256) * 100);
  assert.equal(metric('line-gap-override'), 0);
  assert.ok((metric('ascent-override') + metric('descent-override')) / 100 < 1.2);
  for (const rule of rules.filter((rule) => rule !== sourceHan)) {
    assert.doesNotMatch(rule, /(?:ascent|descent|line-gap)-override/);
  }
  assert.doesNotMatch(css, /size-adjust\s*:|font-size-adjust\s*:/);
});

test('long font names can shrink and wrap without changing card, text-box or canvas geometry', () => {
  assert.match(
    css,
    /\.setting-row:has\(#font-current\) > div\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/
  );
  assert.match(
    css,
    /#font-options\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*overflow:\s*auto;/
  );
  assert.match(css, /\.font-option\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
  const readability = fs.readFileSync(path.join(__dirname, '../src/ui/readability.css'), 'utf8');
  assert.match(
    readability,
    /\.card-meta,[\s\S]*font-family:\s*var\(--secondary-font-family, inherit\);\s*font-weight:\s*400;/
  );
  assert.doesNotMatch(css, /(?:canvas|\.card-title|\.field-input)\s*\{/);
});
