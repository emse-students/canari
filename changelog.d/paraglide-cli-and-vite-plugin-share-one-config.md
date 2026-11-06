### Fixed - `vite dev` no longer takes minutes to listen after a Paraglide compile

The CLI and the vite plugin wrote different Paraglide output into the same folder and invalidated each other's cache, so the next `vite dev` rewrote ~4,500 files first (222 s). Both now read `project.inlang/paraglide.config.js` ([architecture](docs/wiki/frontend/architecture.md#two-writers-of-srclibparaglide-one-set-of-options-2026-11-06)).
