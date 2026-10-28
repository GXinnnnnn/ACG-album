'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

// The replaceable codec is a local library, never a download endpoint. Block the
// Node/browser network entry points in this isolated worker before loading it.
function networkDenied() {
  throw Object.assign(new Error('HEIF codec network access is disabled'), { code: 'HEIF_NETWORK' });
}
globalThis.fetch = async () => networkDenied();
globalThis.WebSocket = class {
  constructor() {
    networkDenied();
  }
};
require('node:net').Socket.prototype.connect = networkDenied;
for (const [name, methods] of [
  ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']]
]) {
  const api = require(name);
  for (const method of methods) api[method] = networkDenied;
}
let loading;
function loadHeif() {
  loading ||= (async () => {
    const directory = workerData.codecDirectory;
    const bytes = await fs.readFile(path.join(directory, 'libheif.wasm'));
    const compiled = await WebAssembly.compile(bytes);
    const factory = require(path.join(directory, 'libheif.js'));
    if (typeof factory !== 'function')
      throw new Error('HEIF codec does not export a module factory');
    const heif = factory({
      locateFile(name) {
        if (name !== 'libheif.wasm') throw new Error('Unexpected HEIF codec resource');
        return path.join(directory, name);
      },
      print() {},
      printErr() {},
      instantiateWasm(imports, receiveInstance) {
        // This upstream build requires synchronous registration after async compilation.
        const instance = new WebAssembly.Instance(compiled, imports);
        receiveInstance(instance, compiled);
        return instance.exports;
      }
    });
    if (typeof heif?.HeifDecoder !== 'function' || typeof heif.heif_context_free !== 'function')
      throw new Error('HEIF codec is missing its decoder/context API');
    return heif;
  })();
  return loading;
}
function limitError(message) {
  return Object.assign(new Error(message), { code: 'HEIF_OUTPUT_LIMIT' });
}
async function decode(bytes, limits) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > limits.maxInputBytes
  )
    throw Object.assign(new Error('Invalid HEIF input byte count'), { code: 'HEIF_INPUT_LIMIT' });
  const heif = await loadHeif(),
    decoder = new heif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes) || [];
    const image = images.find((candidate) => candidate.is_primary()) || images[0];
    if (!image) throw new Error('No decodable HEIF image');
    const width = image.get_width(),
      height = image.get_height(),
      pixels = width * height;
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      !Number.isSafeInteger(pixels) ||
      pixels > limits.maxPixels ||
      pixels * 4 > limits.maxOutputBytes
    )
      throw limitError('HEIF dimensions exceed the configured pixel/output limit');
    const rgba = { width, height, data: new Uint8ClampedArray(pixels * 4) };
    await new Promise((resolve, reject) => {
      image.display(rgba, (out) =>
        out ? resolve() : reject(new Error('HEIF RGBA decoding failed'))
      );
    });
    return { width, height, channels: 4, data: new Uint8Array(rgba.data.buffer) };
  } finally {
    // Free every top-level handle, including unselected images and failures.
    try {
      for (const image of images) {
        try {
          image.free();
        } catch {}
      }
    } finally {
      if (decoder.decoder) {
        heif.heif_context_free(decoder.decoder);
        decoder.decoder = null;
      }
    }
  }
}
let busy = false;
parentPort.on('message', async (message) => {
  if (busy) {
    parentPort.postMessage({
      id: message.id,
      error: { code: 'HEIF_BUSY', message: 'HEIF worker is already decoding' }
    });
    return;
  }
  busy = true;
  try {
    const result = await decode(message.bytes, message.limits);
    parentPort.postMessage({ id: message.id, ...result }, [result.data.buffer]);
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: {
        code: error.code || 'HEIF_DECODE',
        message: String(error.message || error).slice(0, 1000)
      }
    });
  } finally {
    busy = false;
  }
});
