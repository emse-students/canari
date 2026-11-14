## P3 - the $lib alias migration waits for a quiet frontend (2026-10-27)

target: 1.9.0

SvelteKit 3 deprecates `alias: { $lib: 'src/lib' }`; the deprecation warning prints on EVERY build and sync. The fix is `bunx sv@latest migrate sveltekit-3 --tasks lib-alias`: 1567 files, 7645 imports gaining a `.js` extension. Tried and reverted on 2026-10-27 because it conflicts with every open frontend pull request. **Do it as ONE mechanical commit while the frontend is frozen; trigger: the open frontend pull requests are few.** It removes the alias in `kit.config.js` and, on Windows, the false `tsconfig_invalid` warning ([architecture](../frontend/architecture.md#sveltekit-3-and-adapter-node-6-2026-10-27)).
