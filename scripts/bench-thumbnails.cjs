'use strict';
// Read-only source sampler and in-memory encoder benchmark. Never opens the app
// profile, imports the library worker, writes thumbnails, or changes source files.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

function options(argv) {
  const result = {
    root: 'D:\\游戏图片',
    count: 24,
    tiers: [512, 768, 1024],
    rounds: 2,
    maxScan: 12000,
    screen: 15,
    fastShrink: true
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') return null;
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--root') result.root = path.resolve(value);
    else if (flag === '--count') result.count = Number(value);
    else if (flag === '--tiers') result.tiers = value.split(',').map(Number);
    else if (flag === '--rounds') result.rounds = Number(value);
    else if (flag === '--max-scan') result.maxScan = Number(value);
    else if (flag === '--screen') result.screen = Number(value);
    else if (flag === '--fast-shrink') {
      if (!['true', 'false', 'both'].includes(value)) throw new Error('Invalid fast-shrink');
      result.fastShrink = value === 'both' ? 'both' : value === 'true';
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(result.count) || result.count < 16 || result.count > 32)
    throw new Error('Use 16-32 real sample images');
  if (!result.tiers.length || result.tiers.some((size) => ![512, 768, 1024].includes(size)))
    throw new Error('Supported tiers: 512,768,1024');
  if (!Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > 5)
    throw new Error('Use 1-5 rounds');
  if (!Number.isInteger(result.maxScan) || result.maxScan < result.count || result.maxScan > 50000)
    throw new Error('Invalid max-scan');
  if (!Number.isInteger(result.screen) || result.screen < 1 || result.screen > result.count)
    throw new Error('Screen count must be between 1 and sample count');
  return result;
}
function round(value, places = 2) {
  return Number(value.toFixed(places));
}
function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction,
    lower = Math.floor(position),
    upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function summary(values) {
  return {
    min: round(Math.min(...values)),
    median: round(quantile(values, 0.5)),
    max: round(Math.max(...values))
  };
}
let seed = 0x51a7c09;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
const formats = new Map([
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
  ['.avif', 'avif'],
  ['.gif', 'gif'],
  ['.tif', 'tiff'],
  ['.tiff', 'tiff'],
  ['.bmp', 'bmp']
]);
async function sampleSources(config, sharp) {
  const root = await fs.realpath(config.root);
  const queue = [root],
    buckets = new Map(),
    seen = new Map();
  let scanned = 0,
    directories = 0,
    ignoredLinks = 0,
    unreadable = 0;
  while (queue.length && scanned < config.maxScan && directories < 10000) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      unreadable++;
      continue;
    }
    directories++;
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        ignoredLinks++;
        continue;
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(file);
        continue;
      }
      const format = formats.get(path.extname(entry.name).toLowerCase());
      if (!entry.isFile() || !format) continue;
      scanned++;
      const count = (seen.get(format) || 0) + 1;
      seen.set(format, count);
      if (!buckets.has(format)) buckets.set(format, []);
      const bucket = buckets.get(format),
        capacity = config.count * 4;
      if (bucket.length < capacity) bucket.push(file);
      else {
        const slot = Math.floor(random() * count);
        if (slot < capacity) bucket[slot] = file;
      }
      if (scanned >= config.maxScan) break;
    }
  }
  const candidates = [];
  while ([...buckets.values()].some((files) => files.length))
    for (const format of [...buckets.keys()].sort()) {
      const file = buckets.get(format).shift();
      if (file) candidates.push(file);
    }
  const selected = [],
    skipped = [];
  for (const candidate of candidates) {
    if (selected.length === config.count) break;
    try {
      const file = await fs.realpath(candidate);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside root');
      const stat = await fs.stat(file);
      if (stat.size > 96 * 1024 * 1024) throw new Error('Compressed input exceeds 96 MiB');
      // Read every selected compressed file once before timing. OS cache is warm
      // for all variants; no claim is made about cold disk or app startup latency.
      const buffer = await fs.readFile(file);
      const metadata = await sharp(buffer, { limitInputPixels: 160000000, page: 0 }).metadata();
      if (!metadata.width || !metadata.height) throw new Error('No image dimensions');
      selected.push({
        file,
        id: createHash('sha256').update(relative).digest('hex').slice(0, 12),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        alpha: !!metadata.hasAlpha,
        pages: metadata.pages || 1
      });
    } catch (error) {
      skipped.push(error.message);
    }
  }
  if (selected.length !== config.count)
    throw new Error(
      `Only ${selected.length} eligible images; need ${config.count}. Skips: ${skipped.join('; ')}`
    );
  return {
    sources: selected,
    inventory: {
      scanned,
      directories,
      ignoredLinks,
      unreadable,
      truncated: queue.length > 0,
      seenByFormat: Object.fromEntries(seen),
      skippedCandidates: skipped.length,
      sourceBytes: summary(selected.map((n) => n.bytes)),
      sourcePixels: summary(selected.map((n) => n.width * n.height)),
      selectedByFormat: selected.reduce((counts, n) => {
        counts[n.format] = (counts[n.format] || 0) + 1;
        return counts;
      }, {}),
      alphaImages: selected.filter((n) => n.alpha).length,
      animatedImages: selected.filter((n) => n.pages > 1).length
    }
  };
}
function pipeline(sharp, source, size, fastShrink) {
  return sharp(source.file, { limitInputPixels: 160000000, page: 0 })
    .rotate()
    .resize({
      width: size,
      height: Math.round((size * 1400) / 1024),
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: fastShrink
    });
}
async function timedBatch(sharp, sources, size, variant, concurrency, screen) {
  const outputs = new Array(sources.length),
    service = [],
    completed = [],
    screenDone = new Set(),
    started = performance.now(),
    cpu = process.cpuUsage();
  let cursor = 0,
    firstMs = 0,
    screenMs = 0,
    rssPeak = process.memoryUsage().rss;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const timer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 20);
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < sources.length) {
          const index = cursor++,
            itemStart = performance.now();
          const webp = { quality: variant.quality, alphaQuality: 100 };
          // Baseline deliberately omits effort to measure sharp/libwebp's default 4.
          if (variant.effort !== null) webp.effort = variant.effort;
          outputs[index] = await pipeline(sharp, sources[index], size, variant.fastShrink)
            .webp(webp)
            .toBuffer({ resolveWithObject: true });
          const now = performance.now(),
            latency = now - started;
          service.push(now - itemStart);
          completed.push(latency);
          if (!firstMs) firstMs = latency;
          if (index < screen) {
            screenDone.add(index);
            if (screenDone.size === screen) screenMs = latency;
          }
        }
      })
    );
  } finally {
    clearInterval(timer);
    delay.disable();
  }
  const elapsed = performance.now() - started,
    used = process.cpuUsage(cpu);
  return {
    outputs,
    metrics: {
      firstMs: round(firstMs),
      screenMs: round(screenMs),
      allMs: round(elapsed),
      imagesPerSecond: round((sources.length * 1000) / elapsed),
      serviceP50Ms: round(quantile(service, 0.5)),
      serviceP95Ms: round(quantile(service, 0.95)),
      completionP95Ms: round(quantile(completed, 0.95)),
      totalBytes: outputs.reduce((sum, out) => sum + out.data.length, 0),
      screenBytes: outputs.slice(0, screen).reduce((sum, out) => sum + out.data.length, 0),
      rssPeakMiB: round(rssPeak / 1048576),
      cpuMs: round((used.user + used.system) / 1000),
      eventLoopMaxMs: round(delay.max / 1e6)
    }
  };
}
function errorMetrics(reference, decoded) {
  if (reference.info.width !== decoded.info.width || reference.info.height !== decoded.info.height)
    throw new Error('Quality comparison dimensions changed');
  const a = reference.data,
    b = decoded.data;
  if (a.length !== b.length) throw new Error('Quality comparison channels changed');
  let rgbSse = 0,
    alphaSse = 0;
  for (let i = 0; i < a.length; i += 4) {
    const alphaA = a[i + 3] / 255,
      alphaB = b[i + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      const delta =
        a[i + channel] * alphaA + 255 * (1 - alphaA) - b[i + channel] * alphaB - 255 * (1 - alphaB);
      rgbSse += delta * delta;
    }
    alphaSse += (a[i + 3] - b[i + 3]) ** 2;
  }
  return { rgbSse, alphaSse, pixels: a.length / 4 };
}
function psnr(sse, channels) {
  return sse ? round(10 * Math.log10(255 ** 2 / (sse / channels)), 3) : null;
}
async function qualityMetrics(sharp, sources, size, variants, encoded) {
  const records = new Map(
    variants.map((variant) => [
      variant.name,
      {
        name: variant.name,
        rgbSse: 0,
        alphaSse: 0,
        pixels: 0,
        imagePsnr: [],
        worst: null
      }
    ])
  );
  for (let i = 0; i < sources.length; i++) {
    const references = new Map();
    for (const variant of variants) {
      if (!references.has(variant.fastShrink))
        references.set(
          variant.fastShrink,
          await pipeline(sharp, sources[i], size, variant.fastShrink)
            .toColourspace('srgb')
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
        );
      const decoded = await sharp(encoded.get(variant.name)[i].data)
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const difference = errorMetrics(references.get(variant.fastShrink), decoded),
        record = records.get(variant.name),
        imagePsnr = psnr(difference.rgbSse, difference.pixels * 3);
      record.rgbSse += difference.rgbSse;
      record.alphaSse += difference.alphaSse;
      record.pixels += difference.pixels;
      if (imagePsnr !== null) record.imagePsnr.push(imagePsnr);
      if (imagePsnr !== null && (!record.worst || imagePsnr < record.worst.psnrDb))
        record.worst = { sample: sources[i].id, psnrDb: imagePsnr };
    }
  }
  return [...records.values()].map((record) => ({
    name: record.name,
    rgbPsnrDbAgainstUncompressedResize: psnr(record.rgbSse, record.pixels * 3),
    alphaPsnrDb: psnr(record.alphaSse, record.pixels),
    perImagePsnrDb: record.imagePsnr.length ? summary(record.imagePsnr) : null,
    worst: record.worst,
    losslessPsnrRepresentedByNull: true
  }));
}
async function main() {
  const config = options(process.argv.slice(2));
  if (!config) {
    console.log(
      'node scripts/bench-thumbnails.cjs [--root D:\\游戏图片] [--count 24] [--tiers 512,768,1024] [--rounds 2] [--fast-shrink true|false|both]'
    );
    return;
  }
  const sharp = require('sharp');
  sharp.cache({ memory: 48, files: 0, items: 80 });
  sharp.concurrency(2);
  const sampled = await sampleSources(config, sharp);
  const variants = [
    { name: 'q86-default-e4', quality: 86, effort: null, fastShrink: true },
    { name: 'q86-e1', quality: 86, effort: 1, fastShrink: true },
    { name: 'q82-default-e4', quality: 82, effort: null, fastShrink: true },
    { name: 'q82-e1', quality: 82, effort: 1, fastShrink: true }
  ];
  if (config.fastShrink === false) for (const variant of variants) variant.fastShrink = false;
  if (config.fastShrink === 'both')
    for (const variant of [...variants])
      variants.push({ ...variant, name: variant.name + '-no-fast-shrink', fastShrink: false });
  const report = {
    kind: 'read-only-thumbnail-encoder-benchmark',
    createdAt: new Date().toISOString(),
    config,
    environment: {
      node: process.version,
      sharp: sharp.versions,
      platform: process.platform,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      sharpConcurrency: sharp.concurrency(),
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || 'default-4'
    },
    methodology: {
      screen: 'All first N queued requests completed; not any N fastest completions',
      sourceReads:
        'Format-stratified deterministic reservoir over bounded breadth-first scan; each input warmed before timing',
      output:
        'Memory only. Excludes cache file writes, SQLite, IPC, net.fetch, browser decode and paint',
      cache: '48 MiB libvips cache, 0 cached files, 80 operations; same as worker at preparation',
      order:
        'Forward variants in round 1, reverse in round 2; no apps or other perf jobs started here',
      quality:
        'Decoded WebP vs same uncompressed rotate+resize, sRGB RGB composited on white, alpha measured separately; PSNR does not establish visual equivalence'
    },
    inventory: sampled.inventory,
    samples: sampled.sources.map(({ file, mtimeMs, ...sample }) => sample),
    tiers: []
  };
  console.log(
    JSON.stringify({
      event: 'sample-ready',
      inventory: report.inventory,
      samples: report.samples,
      environment: report.environment
    })
  );
  for (const size of config.tiers) {
    const cases = variants.flatMap((variant) =>
        [2, 4].map((concurrency) => ({ variant, concurrency }))
      ),
      records = new Map(),
      encoded = new Map();
    for (let iteration = 0; iteration < config.rounds; iteration++) {
      for (const item of iteration % 2 ? [...cases].reverse() : cases) {
        // Clear operation cache between cases without flushing the OS file cache.
        sharp.cache(false);
        sharp.cache({ memory: 48, files: 0, items: 80 });
        const result = await timedBatch(
          sharp,
          sampled.sources,
          size,
          item.variant,
          item.concurrency,
          config.screen
        );
        const key = `${item.variant.name}/c${item.concurrency}`;
        if (!records.has(key))
          records.set(key, { variant: item.variant.name, concurrency: item.concurrency, runs: [] });
        records.get(key).runs.push(result.metrics);
        encoded.set(item.variant.name, result.outputs);
        console.log(
          JSON.stringify({
            event: 'case',
            size,
            round: iteration + 1,
            variant: item.variant.name,
            concurrency: item.concurrency,
            ...result.metrics
          })
        );
      }
    }
    const measurements = [...records.values()].map((record) => ({
      ...record,
      screenMs: summary(record.runs.map((run) => run.screenMs)),
      allMs: summary(record.runs.map((run) => run.allMs)),
      totalBytes: summary(record.runs.map((run) => run.totalBytes))
    }));
    const quality = await qualityMetrics(sharp, sampled.sources, size, variants, encoded);
    const tier = { size, measurements, quality };
    report.tiers.push(tier);
    console.log(JSON.stringify({ event: 'tier-complete', ...tier }));
  }
  for (const source of sampled.sources) {
    const current = await fs.stat(source.file);
    if (source.bytes !== current.size || source.mtimeMs !== current.mtimeMs)
      throw new Error(`Source changed during benchmark: ${source.id}`);
  }
  report.sourcesUnchanged = true;
  console.log(JSON.stringify({ event: 'final-report', report }));
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
