### Changed - the MLS engine starts downloading with the page instead of after its scripts

A browser that already holds an MLS device now requests the hashed WASM from the first bytes of the document (a low-priority preload that the later `fetch` reuses), instead of after the 200 scripts that used to precede it: on Slow 3G the request starts at 0.8 s rather than 46 s ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#10-package-status-2026-10-09)). Web build only.
