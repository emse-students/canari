# Development workflow

**Source**: `Makefile`, `scripts/`, `infrastructure/local/`

## Quick start

```bash
# Full local setup
make all                  # installs deps + builds frontend + starts services

# Or step by step:
make install              # installs Node, Bun, Rust, wasm-pack, frontend + service deps,
                         # then generates the MLS WASM and protobuf bindings - both are
                         # build artefacts and are NOT in git
make install-hooks        # installs Git hooks (Husky + oxlint + oxfmt + svelte-check)
make build-frontend       # builds WASM + protobuf bindings + SvelteKit
make run-services         # starts Docker Compose (local dev)
```

After setup, run the frontend dev server:

```bash
cd frontend
bun run dev
```

## Makefile targets

### Installation

| Target | What it does |
|---|---|
| `make install` | Runs all install targets below |
| `make install-node` | Installs Node.js (nvm LTS), Linux/Mac only |
| `make install-bun` | Installs Bun, Linux/Mac only |
| `make install-rust` | Installs Rust >= 1.93 via rustup |
| `make install-wasm-pack` | Installs `wasm-pack`, PINNED, via `scripts/install-wasm-pack.sh` |
| `make install-frontend` | `npm install` + `svelte-kit sync` + `npm run generate` in `frontend/` |
| `make install-services` | `npm install` in all NestJS service dirs + shared-ts |
| `make install-hooks` | Husky + pre-commit hooks |

### Build

| Target | What it does |
|---|---|
| `make build-frontend` | `npm run generate` (WASM + protobuf) → `npm run build` (SvelteKit) |

### Services

| Target | What it does |
|---|---|
| `make run-services` | `docker compose up -d` with local dev compose file |
| `make reload-services` | Down + up (restart) |
| `make reset-services` | Down -v + up (wipe volumes) |

### Testing

| Target | What it does |
|---|---|
| `make test` | Runs all test suites (libs + gateway + delivery + frontend) |
| `make test-libs` | `cargo test` in `libs/shared-rust` |
| `make test-gateway` | `cargo test` in `apps/chat-gateway` |
| `make test-history` | `npm test` in `apps/chat-delivery-service` |
| `make test-frontend` | `npm test` (Vitest) in `frontend/` |
| `make bench-mls` | Criterion benchmarks for mls-core hot paths |

### CI

| Target | What it does |
|---|---|
| `make run-ci` | `lint-frontend` + `test` (full local CI pipeline) |
| `make lint-frontend` | `check` + `lint` + `format:check` in frontend |

### Environment

| Target | What it does |
|---|---|
| `make setup-env` | Creates `frontend/.env` + `infrastructure/.env` with generated secrets |
| `make setup-env-prod` | Creates `infrastructure/.env` only (production) |

### Production

| Target | What it does |
|---|---|
| `make production` | `pull` + `up -d` with production compose file |
| `make reset-services-prod` | Wipe volumes + pull + start (production) |
| `make update-services-prod` | Pull new images + restart (production) |

## Pre-commit hooks

Husky runs on every commit:

```bash
# In frontend/:
oxlint       # Lint TypeScript
oxvelte      # Lint Svelte
oxfmt --check # Format check
svelte-check  # Type check
```

The hooks run across the **whole frontend** and re-stage modified files. Isolate unrelated dirty files before committing.

**A generated file that is also committed must not be formatted, or the two fight for ever.** The
Tauri plugin build script writes `src-tauri/plugins/*/permissions/` (the ACL reference and its JSON
schema) and those files are committed, so every local Android build re-expanded the JSON and every
commit hook re-collapsed it - two files dirty in every unrelated diff, and a `git status` that lies
about what a session touched. They are in `oxfmt.json`'s `ignorePatterns` as of 2026-08-11: the
generator's output is the committed truth. Ask the same of any new generated-and-committed path,
and note that `oxfmt.json` is plain JSON with no comment syntax - the reason for an entry belongs
here, not beside it.

## Contracts the compiler does not check

Canari spans TypeScript, Rust, Kotlin, Swift and ObjC, and the boundaries between them are strings
and JSON. Every rule below describes a contract that compiles, lints and type-checks while being
wrong, and each one has already shipped a bug.

### Cross-language boundaries

- **Tauri command names are unchecked strings on both sides.** An `invoke()` literal matching no
  `#[tauri::command]` passes every gate and fails at runtime. Grep both sides on any rename.
- **A plugin command needs three things right, not one.** The prefix is the Tauri *plugin* name
  (`plugin:keystore|…`, from `Builder::new`), **not** the Android class id (`app.tauri.keystore`);
  the command is the snake_case Rust fn, not the Kotlin/Swift method; and it must appear in the
  plugin's `build.rs` `COMMANDS` **and** in `permissions/default.toml`, or the IPC boundary refuses
  it even though the Rust fn exists. Build identifiers with `keystoreCommand()`;
  `keystoreCommands.test.ts` reads the Rust sources and fails on drift.
- **`push_context.json` is a JSON contract across four languages** — Rust writes it; ObjC, Swift and
  Kotlin read it. Nothing checks it: the v0.11.0 `pin` → `deviceKeyB64` rename killed iOS background
  decrypt for three releases. `src/lib/mobile/pushContextFields.test.ts` is the only guard; change
  the fields and change it too.
- **A `postMessage` payload is typed by whoever writes the literal — i.e. by nobody.** All three MLS
  worker contracts live in `src/lib/mls-client/mlsWorkerProtocol.ts` and are imported by both ends.
  Add new worker messages there, never as a local interface.
- **A plugin in `Cargo.toml` is not a plugin the app may CALL.** Tauri v2 gates every plugin *command*
  behind the capability files, and nothing connects the two: the dependency compiles, the plugin
  loads, `tauri.conf.json` configures it, and the command still rejects at runtime on a real device
  with `<plugin>.<command> not allowed`. `deep-link` shipped that way — declared, configured, called
  from `hooks.client.ts`, granted nowhere — so `getCurrent()` failed on every launch and a
  notification tapped from a **closed** app never opened its conversation (WP-DEEPLINK-1). The
  asymmetry is what hid it: *events* (`onOpenUrl`) are not ACL-gated, so the app-already-running path
  worked and only the cold start was dead. `src/lib/mobile/tauriCapabilities.test.ts` now fails on
  any plugin that exposes commands and is granted in no capability file; an exemption there must
  carry its justification in writing.

### Silent-degradation traps

- **Never let a capability probe swallow its own failure.** `isKeyPresent` returned `false` on a
  thrown invoke, making "the plugin does not exist" indistinguishable from "no key here" — a wrong
  command name silently disabled biometric unlock for three releases. A probe that fails must log.
- **`getStorage()`'s IndexedDB fallback is a last resort, not a mode.** It announces itself with a
  `console.warn` inside a WebView, so a permanent degradation looks like a healthy start. Confirm
  the backend with `[DB] Using SQLite storage (Tauri)`. `canari_<userId>.db` is frontend-only; the
  native side owns `mls_pending.db`.
- **Two `vite build` runs writing `build/` at once produce a bundle that cannot boot, and every
  gate passes.** SvelteKit stamps each build with a per-build id and uses it as a global's name:
  `build/index.html` writes `__sveltekit_<id> = {...}` and the runtime chunk reads
  `globalThis.__sveltekit_<id>.data`. They match only because they came from the same build —
  nothing checks it. Mixed, the app dies during `kit.start()` with
  `TypeError: Cannot read properties of undefined (reading 'data')`, which names neither the cause
  nor the file, and on mobile the only symptom is the splash screen never going away. Measured
  2026-08-10: an Android debug APK shipped `__sveltekit_5wp7yq` in the HTML against
  `__sveltekit_10pyqm3` in all four chunks, and was installed before anyone noticed.
  `bun run build` now ends with `scripts/check-bundle-consistency.mjs`, which fails the build
  instead (validated as a negative control against a hand-patched id, on both adapters).
  **The first version of that gate broke the CD, and how is the reusable part:** it asserted
  `build/index.html` + `build/_app/immutable`, i.e. a LAYOUT, and that layout is adapter-static's —
  the web build sets `BUILD_WEB=1` and gets adapter-node (`build/client/`, `build/server/`, and a
  shell rendered per request rather than a file), so a correct build failed outright. A gate must
  assert the INVARIANT, never the shape one producer happens to write it in. Two corollaries the
  rewrite had to respect: the id is a NAME, so a loose `__sveltekit_[a-z0-9]+` scan also matches
  unrelated globals built the same way (`__sveltekit_sw`, the service-worker env payload, which
  lives only in the server bundle — hence `build/server/` is excluded from the name scan); and
  adapter-node never writes the name literally on the server side, it interpolates it from
  `options.version_hash`, so the server half is checked as that value instead. Corollary: **never run an
  Android/iOS build concurrently with anything else that builds the frontend** — `beforeBuildCommand`
  is `bun run build`, writing the very directory a parallel build is writing.
- **A vendored plugin still ships the sample it was forked from.** `tauri-plugin-keystore` carried
  the UniMe `store`/`retrieve`/`remove` API with zero callers, yet it was registered in
  `generate_handler!`, in the `build.rs` ACL and in `permissions/default.toml` — reachable over IPC
  with a real biometric prompt and keystore write behind it. Unused native code is not inert; delete
  the API you did not fork the crate for.

### Things that look type-safe and are not

- **Never redeclare an `init`/lifecycle override with fewer parameters.** TypeScript accepts it, so
  the dropped argument is invisible to `bun run check`. Prefer inheriting `BaseMlsService.init` over
  copying it.
- **Never branch on an error message.** `onLoginFailed(msg, code)` carries a typed `LoginErrorCode`
  (`loginErrors.ts`) precisely because the message is localized: a regex over it ships dead in
  French.
- **"Logged in" means two things.** `globalSession.isLoggedIn` means MLS is ready; the login page
  checks the OIDC/refresh session. Page guards test `currentUserId()`, and MLS-dependent sections
  handle MLS absence themselves.
- **A migration outlives the schema it was written against.** Branches keyed on `PRAGMA
  user_version` all run on a brand-new database, which starts at 0 — so the v1→v2 purge kept naming
  a `salt` column dropped later and threw on every fresh install. In `db/sqliteMigrations.ts` a
  freshly created DB is stamped at `SCHEMA_VERSION` and skips every historical branch (detected via
  `sqlite_master` **before** the `CREATE TABLE`s, since `user_version` is 0 for a pre-migration DB
  too), and column-inspecting statements are built from `PRAGMA table_info`.

## Working in this repo

- Backend apps call bare `oxlint`/`oxfmt` from their local `node_modules/.bin` with repo-level
  configs (`-c ../../oxfmt.json`, `-c ../../.oxlintrc.nest.json`). A hook failing with
  `'oxlint' n'est pas reconnu` means `npm install` has not been run in that app directory.
- Before pushing: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`. A stale
  `dist/` makes the pre-push hook replay compiled specs.
- Commit signing is on globally over SSH (`gpg.format ssh`,
  `user.signingkey ~/.ssh/id_ed25519.pub`). Every commit is Verified — do not disable it.
- Driving several logged-in sessions at once (chrome-devtools MCP): `new_page` with
  `isolatedContext: "<name>"` gives a fully separate cookie jar, IndexedDB and sessionStorage —
  i.e. a distinct device with its own MLS state and device id. Two contexts plus two accounts is
  the only way to exercise Welcome/epoch/decrypt paths from the outside. Note that `fill()` sets a
  value without firing the input events Svelte tracks; use `type_text` for composers and debounced
  search.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/setup-env.sh` | Interactive env file generator (dev + prod) |
| `scripts/bump-app-version.sh` | Bump mobile app version (Android + iOS) |
| `scripts/check-oidc.sh` | Test OIDC configuration against Authentik |
| `scripts/install-oxvelte.sh` | Install oxvelte (Svelte linter) |

## Local services (Docker Compose)

**File**: `infrastructure/local/docker-compose.yml`

All services + infrastructure run in Docker with host port mapping. Dev host ports are offset to avoid conflicts:

| Service | Container port | Dev host port |
|---|---|---|
| frontend (Nginx) | 80 | 3080 |
| chat-gateway | 3000 | 3100 |
| call-service | 3004 | 3104 |
| chat-delivery-service | 3010 | 3110 |
| media-service | 3011 | 3111 |
| core-service | 3012 | 3112 |
| social-service | 3014 | 3114 |
| Redis | 6379 | 6380 |
| PostgreSQL | 5432 | 5433 |
| Kafka | 9092 | 9093 |
| Garage S3 API | 3900 | 19100 |

### Dockerfiles

Each service has a build-only `Dockerfile` in `infrastructure/local/`:

| Dockerfile | Service |
|---|---|
| `Dockerfile.frontend` | Nginx + SvelteKit static bundle |
| `Dockerfile.chat-gateway` | Rust chat-gateway |
| `Dockerfile.call-service` | Rust call-service |
| `Dockerfile.chat-delivery-service` | NestJS chat-delivery |
| `Dockerfile.core-service` | NestJS core-service |
| `Dockerfile.media-service` | NestJS media-service |
| `Dockerfile.social-service` | NestJS social-service |

## Production deployment

See [`cicd.md`](cicd.md) for the full CI/CD pipeline and [`infrastructure/docker.md`](infrastructure/docker.md) for production Docker Compose.

## Environment variables

Two env files:
- `frontend/.env` — build-time Vite variables (baked into the SvelteKit bundle)
- `infrastructure/.env` — runtime variables for all Docker services

See `infrastructure/.env.example` for the template.

### Frontend build-time variables

| Variable | Default |
|---|---|
| `VITE_GATEWAY_URL` | chat-gateway WS URL |
| `VITE_DELIVERY_URL` | chat-delivery-service URL |
| `VITE_MEDIA_URL` | media-service URL |
| `VITE_CORE_URL` | core-service URL |
| `VITE_SOCIAL_URL` | social-service URL |
| `VITE_OIDC_AUTHORITY` | Authentik issuer URL |
| `VITE_OIDC_CLIENT_ID` | OIDC client ID |
| `VITE_OIDC_REDIRECT_URI` | OIDC callback URI |

## Package manager

- **Frontend**: Bun (committed `bun.lock`, CI uses `--frozen-lockfile`).
- **Backend services**: npm (each service has its own `package.json`).
- **Makefile**: shells out to npm for service installs.

Prefer `bun` locally for frontend work; `npm` also works.

## Rust toolchain

Rust >= 1.93 required (enforced by `rust-toolchain.toml`). Relevant crates:

| Crate | Path | Purpose |
|---|---|---|
| `chat-gateway` | `apps/chat-gateway/` | WebSocket gateway |
| `call-service` | `apps/call-service/` | WebRTC SFU |
| `shared-rust` | `libs/shared-rust/` | Shared Kafka event types |
| `mls-core` | `frontend/mls-core/` | Core MLS operations |
| `mls-wasm` | `frontend/mls-wasm/` | WASM bindings for mls-core |
| `src-tauri` | `frontend/src-tauri/` | Tauri 2 native app |

### Linting

```bash
cargo clippy   # All Rust crates
```
