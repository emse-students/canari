### Fixed - the web app downloaded its 2 MB of engine, scripts and styles uncompressed, so a weak link waited twice as long

The frontend nginx compressed JSON only: production served the MLS WASM at 2 126 190 bytes and every script and the stylesheet raw. JS, CSS, WASM and SVG are gzipped now (WASM 2.09 -> 0.76 MB); a Slow 3G cold start goes from 94 s to 39 s and a 2G one from 12 to 4.7 minutes ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#10-package-status-2026-10-09)). Reaches users with the next pre-release or stable.
