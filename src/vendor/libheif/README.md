# Replaceable offline HEIC decoder

This directory contains the unmodified `libheif-js` 1.23.5 WASM factory and binary, built from libheif 1.23.5 and libde265 1.0.15. It is independent of Sharp's AVIF support. The shipped binary includes an HEVC decoder, not an AV1 decoder.

- Upstream npm wrapper: https://github.com/catdad-experiments/libheif-js/tree/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d
- Build wrapper: https://github.com/catdad-experiments/libheif-emscripten/tree/5c8968a44e9c68ae677e24790d77d001ed7fe7cc
- Native libheif: https://github.com/strukturag/libheif/tree/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00
- Native libde265: https://github.com/strukturag/libde265/tree/v1.0.15

`LICENSE` preserves the complete upstream LGPLv3, GPLv3 and MIT notices; `LICENSE-wrapper` preserves the npm wrapper license. The application code's MIT license does not replace these licenses. Corresponding source and build scripts are included in `sources/`. The source archives retain code, scripts, copyright notices and metadata, but omit non-build image fixtures; `PROVENANCE.json` lists every omission and both original and included archive hashes. The decoder and compiled library sources are unmodified. No test photograph is bundled with the application.

## Rebuild and replacement

Extract the four source archives. Put the native libheif tree at the `libheif` submodule location expected by the build wrapper. The original build uses Emscripten 3.1.61, Ubuntu 22.04 and Node 24, `USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1`; libde265 defaults to 1.0.15. Follow the included `build-emscripten.sh`, CI workflow and wrapper install scripts for exact options. ACG-album has not rebuilt this binary or claimed a bit-for-bit reproducible build.

Development loads this directory. Packaged applications copy the directory intact to `resources/codecs/libheif`, outside ASAR. Exit the application, back up this directory, then replace `libheif.js` and `libheif.wasm` together with an interface-compatible modified pair. Restart to load it. No original-vendor hash is enforced during runtime loading; provenance hashes identify the shipped files only. The loader uses local paths and a separate worker, not a remote URL. Keep the `HeifDecoder`, image display and context-release API compatible. The application permits reverse engineering necessary to debug modifications to LGPL components. There is no extra signature lock on the codec files.

The application's adapter and worker source are supplied as `src/heif-decoder.cjs` and `src/heif-worker.cjs`. They asynchronously read and compile local WASM before synchronous instantiation in the decoder worker; decoding remains CPU work in that separate thread. An incompatible replacement reports a visible image-preview error. Restore the saved pair to roll back.
