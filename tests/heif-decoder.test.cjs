'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createHeifDecoder } = require('../src/heif-decoder.cjs');

async function mockCodec(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-heif-test-'));
  // Minimal valid module; the fake factory records lifecycle through output bytes.
  await fs.writeFile(
    path.join(directory, 'libheif.wasm'),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
  );
  await fs.writeFile(
    path.join(directory, 'libheif.js'),
    `
    let imagesLive = 0, contextsLive = 0;
    module.exports = function(options) {
      options.instantiateWasm({}, () => {});
      return {
        heif_context_free() { contextsLive--; },
        HeifDecoder: class {
          constructor() { contextsLive++; this.decoder = 1; }
          decode(bytes) {
            if (bytes[0] === 253) process.exit(7);
            if (bytes[0] === 252) { for (;;) {} }
            if (bytes[0] === 251) throw new Error('Malformed HEIF');
            return [false, true].map(primary => {
              imagesLive++;
              return {
                is_primary: () => primary,
                get_width: () => bytes[0] === 250 ? 40000001 : 2,
                get_height: () => 1,
                free() { imagesLive--; },
                display(rgba, callback) {
                  if (bytes[0] === 249) return callback(null);
                  if (bytes[0] === 248) return require('node:http').get('https://example.invalid/');
                  if (bytes[0] === 247) return fetch('https://example.invalid/').then(callback);
                  rgba.data.set([primary ? 11 : 99, imagesLive, contextsLive, 255, bytes[0], 6, 7, 255]);
                  setTimeout(() => callback(rgba), bytes[0] === 246 ? 180 : 0);
                }
              };
            });
          }
        }
      };
    };
  `
  );
  const decoder = createHeifDecoder({ codecDirectory: directory, timeoutMs: 3000, ...options });
  t.after(async () => {
    await decoder.stop();
    // This is the exact isolated temporary directory allocated above.
    assert.ok(path.basename(directory).startsWith('acg-heif-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return decoder;
}
const input = (first = 1) => Buffer.from([first, 2, 3, 4]);
const code = (value) => (error) => error.code === value;

test('construction and idle are lazy, inputs and local codec locations are validated before startup', async () => {
  const decoder = createHeifDecoder({ codecDirectory: path.join(os.tmpdir(), 'absent-acg-codec') });
  await decoder.idle();
  await assert.rejects(decoder.decode(Buffer.alloc(0)), code('HEIF_INPUT'));
  await assert.rejects(decoder.decode(input(), { maxBytes: 3 }), code('HEIF_INPUT_LIMIT'));
  await assert.rejects(decoder.decode(input(), { maxInputBytes: 3 }), code('HEIF_INPUT_LIMIT'));
  await assert.rejects(decoder.decode(input(), { maxPixels: -1 }), /maxPixels/);
  assert.throws(
    () => createHeifDecoder({ codecDirectory: 'https://example.invalid/' }),
    /local directory/
  );
  await decoder.stop();
  await assert.rejects(decoder.decode(input()), code('HEIF_STOPPED'));
});

test('primary RGBA transfers once without detaching caller input and each job releases images/context', async (t) => {
  const decoder = await mockCodec(t),
    bytes = input(42),
    before = Buffer.from(bytes);
  for (let i = 0; i < 3; i++) {
    const result = await decoder.decode(bytes, { firstFrame: true, maxPixels: 160000000 });
    assert.equal(result.width, 2);
    assert.equal(result.height, 1);
    assert.equal(result.channels, 4);
    assert.ok(Buffer.isBuffer(result.data));
    assert.deepEqual([...result.data], [11, 2, 1, 255, 42, 6, 7, 255]);
    assert.deepEqual(bytes, before);
  }
  await decoder.idle();
});

test('pixel/output caps, malformed and display failures release resources for the next job', async (t) => {
  const decoder = await mockCodec(t);
  await assert.rejects(
    decoder.decode(input(250), { maxPixels: 160000000 }),
    code('HEIF_OUTPUT_LIMIT')
  );
  await assert.rejects(decoder.decode(input(), { maxPixels: 1 }), code('HEIF_OUTPUT_LIMIT'));
  await assert.rejects(decoder.decode(input(), { maxOutputBytes: 7 }), code('HEIF_OUTPUT_LIMIT'));
  await assert.rejects(decoder.decode(input(251)), /Malformed HEIF/);
  await assert.rejects(decoder.decode(input(249)), /RGBA decoding failed/);
  const result = await decoder.decode(input());
  assert.deepEqual([...result.data].slice(0, 3), [11, 2, 1]);
});

test('the single active worker has a bounded queue and copies admitted input immediately', async (t) => {
  const decoder = await mockCodec(t, { maxQueue: 1 });
  const first = decoder.decode(input(246)),
    mutable = input(42),
    second = decoder.decode(mutable);
  mutable[0] = 99;
  await assert.rejects(decoder.decode(input()), code('HEIF_BUSY'));
  await first;
  assert.equal((await second).data[4], 42);
  await decoder.idle();
});

test('zero waiting capacity rejects overlap but accepts the first job and later reuse', async (t) => {
  const decoder = await mockCodec(t, { maxQueue: 0, maxPixels: 160000000 });
  const first = decoder.decode(input(246));
  await assert.rejects(decoder.decode(input()), code('HEIF_BUSY'));
  await first;
  await assert.rejects(decoder.decode(input(250)), code('HEIF_OUTPUT_LIMIT'));
  assert.equal((await decoder.decode(input())).data[0], 11);
});

test('queued deadlines expire independently while active work continues', async (t) => {
  const decoder = await mockCodec(t),
    first = decoder.decode(input(246));
  await assert.rejects(decoder.decode(input(), { timeoutMs: 20 }), code('HEIF_TIMEOUT'));
  await first;
  assert.equal((await decoder.decode(input())).data[0], 11);
});

test('a synchronous infinite decode times out off-thread then a fresh worker recovers', async (t) => {
  const decoder = await mockCodec(t);
  await assert.rejects(decoder.decode(input(252), { timeoutMs: 200 }), code('HEIF_TIMEOUT'));
  await decoder.idle();
  assert.equal((await decoder.decode(input())).data[0], 11);
});

test('unexpected worker exit rejects active work and resumes queued decoding', async (t) => {
  const decoder = await mockCodec(t),
    first = decoder.decode(input(253));
  const second = decoder.decode(input());
  await assert.rejects(first, code('HEIF_WORKER'));
  assert.equal((await second).data[0], 11);
});

test('stop terminates synchronous decoding and rejects active plus queued requests', async (t) => {
  const decoder = await mockCodec(t);
  const active = assert.rejects(decoder.decode(input(252)), code('HEIF_STOPPED'));
  const queued = assert.rejects(decoder.decode(input()), code('HEIF_STOPPED'));
  await decoder.stop();
  await Promise.all([active, queued]);
  await decoder.idle();
  await decoder.stop();
  await assert.rejects(decoder.decode(input()), code('HEIF_STOPPED'));
});

test('codec HTTP requests are rejected offline without destroying subsequent decoding', async (t) => {
  const decoder = await mockCodec(t);
  await assert.rejects(decoder.decode(input(248)), code('HEIF_NETWORK'));
  assert.equal((await decoder.decode(input())).data[0], 11);
});

test('audited public HEIC decodes to the verified primary RGBA hash when the audit fixture exists', async (t) => {
  const audit =
    process.env.ACG_HEIF_AUDIT_DIR || 'C:\\ACG\\资料归档\\media-compat-20261028\\heif-audit';
  const file = path.join(audit, 'libheif-example-source.heic');
  try {
    await fs.access(file);
  } catch {
    t.skip('Public audit HEIC is deliberately not distributed with the app');
    return;
  }
  const codecDirectory = path.join(audit, 'libheif-js-1.23.5/package/libheif-wasm');
  const decoder = createHeifDecoder({ codecDirectory });
  t.after(() => decoder.stop());
  const bytes = await fs.readFile(file);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2'
  );
  const result = await decoder.decode(bytes, {
    maxBytes: 1024 * 1024,
    maxPixels: 160000000,
    firstFrame: true
  });
  assert.deepEqual(
    [result.width, result.height, result.channels, result.data.length],
    [1280, 854, 4, 4372480]
  );
  assert.equal(
    crypto.createHash('sha256').update(result.data).digest('hex'),
    '7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b'
  );
});
