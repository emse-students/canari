### Changed - SvelteKit 3 and adapter-node 6

`svelte.config.js` became `kit.config.js` (passed to `sveltekit(...)`), `$app/environment`/`$app/stores`/`$app/paths.base` and the error-hook shape moved, and the server environment is declared in `src/env.ts`. What changed and what only the dev estate can verify: [architecture](docs/wiki/frontend/architecture.md#sveltekit-3-and-adapter-node-6-2026-10-27).
