'use strict';
// Read-only directory/stat benchmark. Never imports, decodes, writes or changes source media.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { IMAGE_EXT } = require('../src/model.cjs');
const { sortKey } = require('../src/natural-sort.cjs');
const root = path.resolve(process.argv[2] || 'D:\\游戏图片');
const count = Number(process.env.ACG_COVER_BENCH_DIRECTORIES || 8);
const cap = Number(process.env.ACG_COVER_BENCH_FILES || 4096);
const round = (n) => +n.toFixed(3);
async function measure(directory, strategy) {
  let entries = 0,
    stats = 0,
    choice = null;
  const started = performance.now();
  const names = [];
  for await (const entry of await fs.opendir(directory, { bufferSize: 128 })) {
    entries++;
    if (!entry.isFile() || !IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    if (strategy === 'available') {
      const s = await fs.lstat(path.join(directory, entry.name));
      stats++;
      if (!s.isSymbolicLink() && s.isFile()) {
        choice = entry.name;
        break;
      }
    } else {
      names.push(entry.name);
      if (names.length >= cap) break;
    }
  }
  if (strategy === 'natural-first') {
    let key;
    for (const name of names) {
      const candidate = sortKey(name);
      if (key === undefined || candidate < key || (candidate === key && name < choice)) {
        key = candidate;
        choice = name;
      }
    }
    if (choice) {
      await fs.lstat(path.join(directory, choice));
      stats++;
    }
  }
  if (strategy === 'newest') {
    let mtime = -Infinity;
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = names.slice(offset, offset + 32);
      const rows = await Promise.all(batch.map((name) => fs.lstat(path.join(directory, name))));
      stats += rows.length;
      for (let i = 0; i < batch.length; i++) {
        if (!rows[i].isSymbolicLink() && rows[i].isFile() && rows[i].mtimeMs > mtime) {
          choice = batch[i];
          mtime = rows[i].mtimeMs;
        }
      }
    }
  }
  return {
    strategy,
    elapsedMs: round(performance.now() - started),
    entries,
    stats,
    choice,
    capped: names.length === cap
  };
}
(async () => {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 32 ||
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > 10000
  )
    throw new Error('Bound directories to 1–32 and files to 1–10000');
  const queue = [root],
    directories = [];
  let examined = 0;
  // Bound sample discovery too; do not follow directory junctions or symlinks.
  while (queue.length && directories.length < count && examined++ < 128) {
    const directory = queue.shift();
    let hasImage = false,
      discoveryEntries = 0;
    for await (const entry of await fs.opendir(directory, { bufferSize: 128 })) {
      if (++discoveryEntries > 10000) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && queue.length < 128) queue.push(path.join(directory, entry.name));
      if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        hasImage = true;
      }
    }
    if (hasImage) directories.push(directory);
  }
  // The scanner already creates folder sort keys before selecting any cover.
  const keyInitStarted = performance.now();
  sortKey('封面2.jpg');
  const naturalKeyInitializationMs = round(performance.now() - keyInitStarted);
  const samples = [];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index],
      results = [];
    // Rotate execution order; these are warm filesystem observations, not cold disk guarantees.
    const strategies = ['available', 'natural-first', 'newest'];
    for (let turn = 0; turn < strategies.length; turn++)
      results.push(await measure(directory, strategies[(index + turn) % strategies.length]));
    samples.push({ directory, results });
  }
  const totals = ['available', 'natural-first', 'newest'].map((strategy) => {
    const rows = samples.map((sample) => sample.results.find((row) => row.strategy === strategy));
    return {
      strategy,
      elapsedMs: round(rows.reduce((sum, row) => sum + row.elapsedMs, 0)),
      stats: rows.reduce((sum, row) => sum + row.stats, 0),
      entries: rows.reduce((sum, row) => sum + row.entries, 0)
    };
  });
  console.log(
    JSON.stringify(
      {
        root,
        readOnly: true,
        warmFilesystem: true,
        noDecodeOrNetwork: true,
        naturalKeyInitializationMs,
        maxDirectories: count,
        maxImagesPerDirectory: cap,
        samples,
        totals
      },
      null,
      2
    )
  );
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
