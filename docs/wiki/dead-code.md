# Dead code: the tool, the ratchet, and how to allow-list

Owner, 2026-11-07: dead code is deleted, and it must not come back. Two measurements run on every
pull request that touches the frontend, and their counts may only go down.

## What is measured

| Measurement                                                                                                   | Tool                                                                                | Config                                         | What it counts                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unused files, exports, exported types, duplicate exports, unused or unlisted dependencies, unresolved imports | [knip](https://knip.dev) `6.43.0`, pinned in `frontend/package.json` and `bun.lock` | `frontend/knip.json`                           | the `files`, `exports`, `types`, `duplicates`, `dependencies`, `devDependencies`, `unlisted`, `binaries`, `unresolved` ... rows of `frontend/dead-code-baseline.json` |
| Translation keys no source names                                                                              | `.github/scripts/dead-code-ratchet.mjs`                                             | `frontend/dead-code-allowlist.json` (optional) | the `messages` row                                                                                                                                                    |

A key of `frontend/messages/fr.json` is dead when its name appears as an identifier or inside a
string in no `.ts`, `.js`, `.mjs` or `.svelte` file under `frontend/src/` (the generated
`src/lib/paraglide/` excluded: it names every key). `m.key()`, `{ key }` imports and a
`{ labelKey: 'key' }` table all name it. Nothing in the app builds a key from a variable (checked
2026-11-07: no `m[...]`, no template literal feeding `m`); the one place that enumerates `m` is
`paraglideTestAlias.test.ts`, which checks the test build, not a product key.

## The ratchet

`bun .github/scripts/dead-code-ratchet.mjs frontend` (step `Dead-code ratchet` of `test-frontend`
in `ci.yml`, no fifth visible workflow). It compares each count with
`frontend/dead-code-baseline.json`:

- **more than the baseline fails**, and prints every item of that category: a new unused export is
  deleted, or allow-listed with a reason;
- **fewer than the baseline also fails** until `bun .github/scripts/dead-code-ratchet.mjs frontend
  --update` lowers the baseline, so a gain is locked the day it is made. `--update` refuses to
  raise any number.

The baseline is a COUNT per category, not a list, so two pull requests that each delete something
do not conflict. The target is every number at 0, after which the file is just zeros.
`frontend/knip.json` is the only place a false positive is declared.

## Entry points, configured as reachable (never deleted)

knip's SvelteKit, Vite, Vitest and `package.json` plugins already find the routes, the hooks, the
workers named by `new URL(..., import.meta.url)`, every `*.test.ts` and the `package.json` scripts.
What they cannot see is declared in `knip.json`:

- `kit.config.js` (read by `vite.config.js`, which names the two adapters), `src/env.ts` (the
  SvelteKit 3 env declaration, read by `$app/env`), `src/lib/mlsServicePlatform.native.ts` (swapped
  in by `platformMlsService()` in `vite.config.js` for the native build);
- `scripts/**` (run by hand or by the Makefile);
- `ignoreUnresolved`: the generated `$lib/wasm`, `$lib/proto/canari` and `$lib/paraglide`, which are
  not in git;
- `ignoreDependencies`: `emoji-picker-element-data` (read by `tools/emoji-data/sync.mjs`), `husky`
  (installed by `scripts/install-husky.js`); `ignoreBinaries`: `wasm-pack`.

**Reached only by name, so a deletion needs a grep first**: Tauri commands (`invoke('cmd')` in TS
against `#[tauri::command]` in Rust), the Kotlin, Swift and Objective-C bridges in
`frontend/src-tauri/`, and NestJS providers wired by decorator. knip checks TS imports only; before
deleting an export that smells like a bridge, grep its name under `frontend/src-tauri/` and `apps/`.

## How to allow-list

1. A false positive in knip: prefer an `entry` or `ignoreDependencies` line in `knip.json` with a
   reason in this page; a single symbol may carry a `/** @public */` JSDoc tag, which knip honours.
2. A translation key reached without being named: add it to `frontend/dead-code-allowlist.json`,
   `{ "messages": { "the_key": "why it is reached" } }`. The reason is mandatory.

## Rust

`cargo` already warns on `dead_code` and clippy is part of the Rust jobs. The tree was read
on 2026-11-07 for a silenced one: every in-repo `allow(dead_code)` is a `cfg_attr(not(target_os =
...), allow(dead_code))` over code that exists for one platform (iOS, Android, macOS) with the
reason in the comment above it, or sits in the vendored `src-tauri/patches/` forks. None is a bare
silencing. A new one needs the same shape.

## Where it stands

Frontend only so far: the four NestJS apps are the next measurement to bring in (knip per app,
same ratchet). Progress is the baseline file itself.
