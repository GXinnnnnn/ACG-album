'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

// Keep these in sync with the image/video extensions accepted by model.cjs.
const MIME_TYPES = {
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

/**
 * Serve one byte range from a filesystem path using the Fetch Response API.
 * request is a Fetch Request (or an object with compatible headers and method).
 * null tells the caller to use its existing full-file response. Unsupported or
 * malformed ranges are ignored, as permitted by HTTP. Without a validated file
 * validator, If-Range is conservatively handled by returning the full file too.
 * File/stat/read errors remain errors for the caller or response body consumer.
 */
async function rangedFileResponse(file, request) {
  const requestHeaders = new Headers(request.headers);
  const range = requestHeaders.get('range');
  if (range === null || requestHeaders.has('if-range')) return null;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return null;

  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  // Do not round attacker-controlled offsets or pass unsafe offsets to Node.
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;

  const { size } = await fs.promises.stat(file);
  if (!Number.isSafeInteger(size)) return null;

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
  });

  let start;
  let end;
  if (first === null) {
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = first;
    end = last === null ? size - 1 : Math.min(last, size - 1);
  }

  if (size === 0 || (first === null && last === 0) || start >= size || end < start) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }

  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  if (request.method?.toUpperCase() === 'HEAD') {
    return new Response(null, { status: 206, headers });
  }

  const stream = fs.createReadStream(file, { start, end });
  // Count queued bytes rather than chunks, so buffering stays bounded even for
  // large videos. The Node adapter destroys the file stream on body cancellation.
  const body = Readable.toWeb(stream, {
    strategy: {
      highWaterMark: stream.readableHighWaterMark,
      size: (chunk) => chunk.byteLength
    }
  });
  return new Response(body, { status: 206, headers });
}

module.exports = { rangedFileResponse };
