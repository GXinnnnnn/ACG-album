'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { rangedFileResponse } = require('../src/file-response.cjs');
const { MEDIA_EXT } = require('../src/model.cjs');

const DATA = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

async function fixture(t, extension = '.mp4', data = DATA) {
  const tempParent = path.resolve(os.tmpdir());
  const directory = await fs.promises.mkdtemp(path.join(tempParent, 'acg-file-response-'));
  // Cleanup is restricted to the exact directory returned by mkdtemp.
  assert.equal(path.dirname(directory), tempParent);
  assert.ok(path.basename(directory).startsWith('acg-file-response-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, `media${extension}`);
  await fs.promises.writeFile(file, data);
  return file;
}

function request(range, options = {}) {
  const headers = new Headers(options.headers);
  if (range !== undefined) headers.set('Range', range);
  return new Request('https://local.invalid/media', { method: options.method || 'GET', headers });
}

async function checkPartial(file, range, start, end) {
  const response = await rangedFileResponse(file, request(range));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${DATA.length}`);
  assert.equal(response.headers.get('content-length'), String(end - start + 1));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), DATA.subarray(start, end + 1));
}

test('explicit byte range returns exact bytes and HTTP range headers', async (t) => {
  const file = await fixture(t, '.MP4');
  await checkPartial(file, 'bytes=3-9', 3, 9);
  await checkPartial(file, 'bytes=0-0', 0, 0);
  await checkPartial(file, 'bytes=35-35', 35, 35);
});

test('open-ended ranges include the last byte', async (t) => {
  const file = await fixture(t);
  await checkPartial(file, 'bytes=10-', 10, 35);
  await checkPartial(file, 'bytes=0-', 0, 35);
});

test('suffix ranges return the tail and clamp oversized suffixes', async (t) => {
  const file = await fixture(t);
  await checkPartial(file, 'bytes=-5', 31, 35);
  await checkPartial(file, 'bytes=-36', 0, 35);
  await checkPartial(file, 'bytes=-100', 0, 35);
});

test('explicit end clamps to the file size without integer rounding', async (t) => {
  const file = await fixture(t);
  await checkPartial(file, 'bytes=30-100', 30, 35);
  await checkPartial(file, `bytes=30-${Number.MAX_SAFE_INTEGER}`, 30, 35);
  await checkPartial(file, 'BYTES=0002-0004', 2, 4);
});

test('unsatisfiable ranges return 416 and the current file size', async (t) => {
  const file = await fixture(t);
  for (const range of ['bytes=36-', 'bytes=100-200', 'bytes=12-5', 'bytes=-0']) {
    const response = await rangedFileResponse(file, request(range));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${DATA.length}`, range);
    assert.equal(response.headers.get('content-length'), '0', range);
    assert.equal(response.headers.get('accept-ranges'), 'bytes', range);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', range);
    assert.equal(response.body, null, range);
    assert.equal(await response.text(), '', range);
  }
});

test('every supported form is unsatisfiable for an empty file', async (t) => {
  const file = await fixture(t, '.mp4', Buffer.alloc(0));
  for (const range of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-0']) {
    const response = await rangedFileResponse(file, request(range));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */0', range);
    assert.equal(await response.text(), '', range);
  }
});

test('missing, malformed, multipart, and unsafe ranges fall back without opening a file', async () => {
  const missing = path.join(os.tmpdir(), 'acg-file-response-does-not-exist', 'missing.mp4');
  for (const range of [
    undefined,
    '',
    'bytes=-',
    'items=0-1',
    'bytes=abc-def',
    'bytes=1.5-4',
    'bytes=+1-4',
    'bytes=1 - 4',
    'bytes=0-1,3-4',
    'bytes=0-1, 3-4',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740993',
    'bytes=-9007199254740992',
    `bytes=${'9'.repeat(400)}-`
  ]) {
    assert.equal(await rangedFileResponse(missing, request(range)), null, String(range));
  }
});

test('If-Range conservatively delegates to the existing full response', async () => {
  const missing = path.join(os.tmpdir(), 'acg-file-response-does-not-exist', 'missing.mp4');
  for (const validator of ['"known-etag"', 'Wed, 21 Oct 2015 07:28:00 GMT', '']) {
    assert.equal(
      await rangedFileResponse(
        missing,
        request('bytes=0-1', {
          headers: { 'If-Range': validator }
        })
      ),
      null
    );
  }
});

test('HEAD returns range headers without creating a file stream', async (t) => {
  const file = await fixture(t);
  t.mock.method(fs, 'createReadStream', () => {
    throw new Error('HEAD opened a file stream');
  });
  const response = await rangedFileResponse(file, request('bytes=5-9', { method: 'HEAD' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 5-9/${DATA.length}`);
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal(response.body, null);
  assert.equal(await response.text(), '');
  const invalid = await rangedFileResponse(file, request('bytes=-0', { method: 'HEAD' }));
  assert.equal(invalid.status, 416);
  assert.equal(invalid.body, null);
});

test('MIME types cover all supported media extensions and unknown files use a safe fallback', async (t) => {
  const expected = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.jpe': 'image/jpeg',
    '.png': 'image/png',
    '.apng': 'image/apng',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.ico': 'image/vnd.microsoft.icon',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.3gp': 'video/3gpp',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t'
  };
  assert.deepEqual(Object.keys(expected).sort(), [...MEDIA_EXT].sort());
  const base = await fixture(t);
  for (const [extension, mime] of [
    ...Object.entries(expected),
    ['.unknown', 'application/octet-stream']
  ]) {
    const file = path.join(path.dirname(base), `type${extension.toUpperCase()}`);
    await fs.promises.writeFile(file, DATA);
    const response = await rangedFileResponse(file, request('bytes=0-0'));
    assert.equal(response.headers.get('content-type'), mime, extension);
    assert.equal(await response.text(), '0', extension);
  }
});

test(
  'large file streams bounded chunks and cancellation destroys and closes the file stream',
  {
    timeout: 10000
  },
  async (t) => {
    const file = await fixture(t, '.webm', Buffer.alloc(64 * 1024, 0x6b));
    const size = 64 * 1024 * 1024;
    const handle = await fs.promises.open(file, 'r+');
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }

    const originalCreateReadStream = fs.createReadStream;
    let stream;
    t.mock.method(fs, 'createReadStream', (...args) => {
      stream = originalCreateReadStream(...args);
      return stream;
    });
    t.after(() => stream?.destroy());

    const response = await rangedFileResponse(file, request('bytes=0-'));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), String(size));
    assert.equal(response.headers.get('content-range'), `bytes 0-${size - 1}/${size}`);
    // Adapter cancellation emits AbortError before close; observe closure directly.
    const closed = new Promise((resolve) => stream.once('close', resolve));
    const reader = response.body.getReader();
    try {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      assert.ok(value.byteLength > 0 && value.byteLength <= 64 * 1024);
      assert.deepEqual(Buffer.from(value), Buffer.alloc(value.byteLength, 0x6b));
      // Let the adapter prefetch; it must stay bounded without consuming the file.
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(stream.bytesRead < 1024 * 1024, `prefetched ${stream.bytesRead} bytes`);
      await reader.cancel();
      await closed;
      assert.equal(stream.destroyed, true);
      assert.equal(stream.closed, true);
      assert.ok(stream.bytesRead < size);
    } finally {
      reader.releaseLock();
      stream.destroy();
    }
  }
);

test('file stat errors propagate for a valid range', async (t) => {
  const file = await fixture(t);
  const missing = path.join(path.dirname(file), 'missing.mp4');
  await assert.rejects(rangedFileResponse(missing, request('bytes=0-1')), { code: 'ENOENT' });
});
