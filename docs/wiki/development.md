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
| `make install-frontend` | `bun install` + `svelte-kit sync` + `bun run generate` in `frontend/` |
| `make install-services` | `bun install` in every NestJS service directory |
| `make install-hooks` | Husky + pre-commit hooks |

### Build

| Target | What it does |
|---|---|
| `make build-frontend` | `bun run generate` (WASM + protobuf) → `bun run build` (SvelteKit) |

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
- **`Log.d` takes a TAG and a payload, and a one-argument call makes the whole message the tag.**
  `Log.d(tag, payload?)` renders `[<iso>] [<tag>]`, so `Log.d('[CHANNEL_READ] signalled abc12345 to
  ...')` compiles, type-checks, prints, and comes out as `[[CHANNEL_READ] signalled abc12345 to ...]`
  - a shape no reader and no log rule expects. Nothing in the language distinguishes a tag from a
  sentence: both are `string`. Written 2026-08-20, when the read receipt shipped that way and only
  the cross-client watcher's exact-match classifier noticed, turning a COMM-7 run whose five
  assertions all held into `PASS-DIRTY`. Pass a short tag first, the sentence second, always.

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

### `bun run check` on a machine that skipped `generate` accuses the repository

Three errors, all of them local staleness rather than defects, measured on a reconstituted
workstation 2026-09-02:

| Error | Actual cause |
|---|---|
| `Cannot find module '@tauri-apps/plugin-os'` (twice) | declared in `package.json`, absent from `node_modules` - an incomplete `bun install` |
| `mlsWasmLoader.ts: Expected 2-4 arguments, but got 5` | `src/lib/wasm/` is GENERATED and not committed, so the local `.d.ts` was behind the Rust source it types |

Neither names its cause, and the second reads exactly like a genuine call-site bug in committed
code - it is a stale generated declaration file describing a binding that has since grown an
argument. **`bun install && bun run generate` in `frontend/` first, then believe `check`**;
`make install-frontend` does both, which is why it exists. Nothing enforces the order, because the
generated tree's absence is what `.gitignore` guarantees rather than something a gate can detect
from the source.

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

- **A query builder's output is unverified until a real Postgres sees it.** A mocked repository never
  parses SQL, and TypeORM does NOT preserve the order selects were declared in - `DISTINCT` written
  into a `.select()` string lands mid-list as soon as an `.addSelect()` follows, which is a syntax
  error the mock happily accepts. `.distinct(true)` is the only safe spelling. Where a test cannot
  reach, **the deploy log is the test**.

## Working in this repo

- Backend apps call bare `oxlint`/`oxfmt` from their local `node_modules/.bin` with repo-level
  configs (`-c ../../oxfmt.json`, `-c ../../.oxlintrc.nest.json`). A hook failing with
  `'oxlint' n'est pas reconnu` means `bun install` has not been run in that app directory.
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

### Editing files from a script, on Windows

**A Python write in TEXT MODE rewrites every line ending**, and the diff hides it: git normalises on
the way in, so `git diff` shows only the lines you added while the WORKING TREE has become CRLF. It
cost two test suites that slice a native source between multi-line anchors - a pattern matching a
newline followed by indentation cannot match one followed by a carriage return, so both files threw
at import. Always pass `newline='\n'` to `io.open(..., 'w')`, or write bytes.

**A suite that cannot LOAD reports zero tests, not a failing one.** Read the FILE count in a vitest
summary, never only the test count: "2 failed | 197 passed" beside "1743 passed" is two files that
never ran. The exit code is 1, so CI does catch it - a human skimming the tail does not. Same
instrument as [testing-methodology rule 22](testing-methodology.md).

### Compiling Android Rust from Windows

`NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125`, put
`toolchains/llvm/prebuilt/windows-x86_64/bin` on PATH, set
`CC_aarch64_linux_android=aarch64-linux-android24-clang.cmd`, then
`cargo check --target aarch64-linux-android`. It is the only local check of `#[cfg(android)]` code -
and it proves COMPILATION, never that a JNI `FindClass` resolves at runtime.

## Local services (Docker Compose)

**File**: `infrastructure/local/docker-compose.yml`, compose project **`canari-local`** (declared in
the file - see the comment at its top for why that name is load-bearing).

**THE PORT TABLE HERE USED TO CARRY OFFSETS (3080, 3100, 3104...) THAT THIS FILE HAS NEVER
PUBLISHED.** Those were the dev estate's offsets, which
[dev-environment](infrastructure/dev-environment.md) records as having been unnecessary in the first
place. Read from the compose file 2026-09-02:

| Service | Container port | Host port |
|---|---|---|
| **nginx** (the API gateway) | 80 | **8081** (`CANARI_LOCAL_API_PORT`) |
| chat-gateway | 3000 | 3000 |
| call-service | 3004 | 3004 |
| chat-delivery-service | 3010 | 3010 |
| media-service | 3011 | 3011 |
| core-service | 3012 | 3012 |
| social-service | 3014 | 3014 |
| Redis | 6379 | 6379 |
| PostgreSQL | 5432 | 5432 |
| Garage S3 API | 3900 | 9000 |
| coturn | 3478 / 5349 | same, plus 49000-49040/udp |

The app itself is NOT in this stack: `bun run dev` serves it from the host on **1420**
(`strictPort`, and the OIDC client's redirect URIs are registered on 1420/1421 - not 5173).

### Every `/api/*` request goes through nginx, and that is not a preference

**nginx is where a bearer token becomes an identity.** It runs
`auth_request /internal/auth/verify` against `core-service:3012/api/auth/verify`, then copies four
headers out of that subrequest onto the upstream request:

| From the auth subrequest | Forwarded as |
|---|---|
| `X-User-Id` | `X-User-Id` |
| `X-Logged-In` | `X-User-Logged-In` |
| `X-Global-Admin` | `X-Global-Admin` |
| `X-Internal-Token` | `X-Internal-Token` |

A service reads `X-User-Id` and nothing else; it never validates a JWT itself. So a request that
did not pass through nginx has no identity at all, and core-service answers it
`401 Missing X-User-Id header - ensure the request passes through nginx auth`. nginx also sets
`X-User-Id ""` on the public locations, which is what stops a client supplying its own.

**Until 2026-09-02 the local estate had no nginx**, and `vite.config.js` proxied `/api/*` straight
to each service. The consequence was found by performing a real login rather than by reading
anything: Authentik authenticated, `/api/auth/oidc/callback` answered 200, and then `/api/users/me`,
`/api/users/<id>` and `/api/mls/security/pin-salt/<id>` all answered 401. **A login that succeeds
and an application that can do nothing.**

Two things that table of per-service proxies also did:

- **It forged one of the four headers.** `/api/mls/` and `/api/calls/` carried
  `headers: { 'x-user-logged-in': 'true' }`, unconditionally. That is worse than the 401 it avoided:
  locally, an unauthenticated caller looked logged-in to chat-delivery, on exactly the routes the
  MLS work is measured on.
- **It omitted nine route families nginx serves** - `/api/admin`, `/api/groups`, `/api/payments`,
  `/api/moderation`, `/api/external`, `/api/minesweeper`, `/api/public/`, `/api/media/public/` and
  the calendar `.ics` feed - so those were simply broken in local development, and nobody had cause
  to notice.

The dev server now sends every `/api/*` to `http://localhost:8081` and keeps exactly two direct
proxies, `/channels` and `/ws`, neither of which is under `/api/` and neither of which nginx has a
location for. nginx reproduces both rewrites the old table performed (`/api/call` -> `/ws` on
call-service, `/api/chat-delivery-health` -> `/api/health`) and upgrades websockets, so nothing was
lost in the move.

**The image is production's own** (`infrastructure/local/Dockerfile.frontend`, the single source of
truth for the nginx config - CLAUDE.md). That has one cost worth knowing before you run
`make run-services` on a fresh clone: the Dockerfile `COPY`s `frontend/build/client` and
`frontend/build/prerendered`, which only a **web** build produces - `BUILD_WEB=1 bun run build`,
adapter-node. A plain `bun run build` is the Tauri path (adapter-static) and leaves a `build/` the
image cannot use. Extracting the config into a second file would avoid the build and is exactly what
must not be done: two copies of an nginx config diverge, and this one decides who a caller is.

### The environment a service gets is decided HERE, not in `.env`

`infrastructure/.env` holding a value proves nothing: the compose file has to forward it. A drift
audit of every environment KEY production passes, against what this file passed, found **17 keys
missing** on 2026-09-02 - and three of them (`AUTHENTIK_BASE_URL`, `AUTHENTIK_CLIENT_ID`,
`AUTHENTIK_CLIENT_SECRET`) were why no login could complete, with all three sitting correctly in
`.env` the whole time. The others decided whether a FEATURE behaved the same locally:
`GOOGLE_SAFE_BROWSING_API_KEY` (a link is scanned before it renders), `MEDIA_SERVICE_URL`,
`CERCLE_API_KEY`, the Sky pair, the five `APNS_VOIP_*`.

**That audit is now a GATE, not something to remember to re-run.** The third check of
`.github/scripts/tests/compose-wiring.test.sh` derives every key production forwards each service
and fails on any the local file does not - keys only, never values, so it is safe in a public
pipeline. Run it directly, or through `make test-ci-scripts`:

```sh
bash .github/scripts/tests/compose-wiring.test.sh   # 52 assertions
```

Three services production declares are absent locally BY DESIGN and are not drift: `frontend` and
`frontend-ssr` (the dev server serves the app) and `adminer`. They are named in the script's
`LOCAL_ABSENT_BY_DESIGN`, so adding a fourth means editing that list and saying why.

### An incomplete `optimizeDeps.include` reloads the page, and a reload is not just slow

`frontend/vite.config.js` pre-declares the packages Vite should bundle at startup. When a package
is NOT declared, the dev server discovers it the first time a route imports it, re-bundles, and then
does this:

```
[vite] (client) optimized dependencies changed. reloading
```

That is a **full page reload**, not an HMR patch. Measured 2026-09-03 on a cold cache: 36 undeclared
packages, discovered in four waves, three forced reloads - and the third one **destroyed an OIDC
login in flight**, because an authorization code is single-use, so the second attempt to redeem it
fails and the estate looks broken when only the dev server is. The same reload voids a campaign
measurement mid-run, and Android's WebView cannot survive it at all
(`Failed to fetch dynamically imported module`).

So the list is not an optimisation, it is a correctness setting, and **anything imported anywhere in
the app belongs in it** - not just the heavy or the native. To extend it, exercise the new route and
read the truth out of the dev-server log rather than guessing:

```sh
bun run dev 2>&1 | grep -E "dependencies optimized|reloading"
```

A clean startup prints neither line. If it prints either, the config is behind the code.

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
| `mls-core` | `frontend/mls-core/` | Core MLS operations |
| `mls-wasm` | `frontend/mls-wasm/` | WASM bindings for mls-core |
| `src-tauri` | `frontend/src-tauri/` | Tauri 2 native app |

### Linting

```bash
cargo clippy   # All Rust crates
```
