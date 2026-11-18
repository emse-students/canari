### Changed - `$lib` is resolved by Vite and TypeScript, so SvelteKit's two `$lib` warnings are gone

`kit.alias` (deprecated) is replaced by a Vite `resolve.alias` and tsconfig `paths`; a build before and after is identical ([architecture](docs/wiki/frontend/architecture.md#sveltekit-3-and-adapter-node-6-2026-10-27)).
