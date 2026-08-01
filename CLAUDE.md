# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file. DELETE shipped Work Packages (keep only forward-relevant gotchas), collapse redundant notes, drop stale entries.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE" -> STOP (compact)
- DOCUMENTATION: Technical docs live in `docs/wiki/` (English, LLM-oriented, preferred search before code). User-facing guides in `docs/user-guide/` (French). UML diagrams in `docs/diagrams/`. Root-level docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- CHANGELOG: When adding features, fixing bugs, or making breaking changes, add an entry under `[Unreleased]` in `CHANGELOG.md` (Keep a Changelog format). Move to a version section on release.
- WIKI IS PREFERRED: Always search `docs/wiki/` before reading source code. Update the relevant wiki page alongside code changes — stale wiki is worse than no wiki. Cross-link freely between pages.
- SERVICE READMES: Each `apps/*/README.md` should stay synced with its wiki counterpart. If you expand the wiki page, reflect the summary in the README.
- PROD ACCESS: `ssh canari` or `ssh mitv`.
- CLASSIFIER DOWN: End of session signal. Stop ASAP, prepare compaction + easy resume for next session.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (Front) | Rust WASM openmls | NestJS + Rust Axum (Back).
- Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.
- Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.
- Infra Truth: Keep `infrastructure/MIGRATION.md` synced with new secrets, services, or bootstrap steps. When adding a new service or infrastructure component, add it to the wiki (`docs/wiki/infrastructure/`) and `README.md` architecture diagram.

## **CODING STANDARDS**

- Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.
- Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types. All documentation files (`docs/`, `*.md` at root) are English except `docs/user-guide/` (French, user-facing).
- Factorization: Extract and export reusable logic. Zero duplication.
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals.
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); Makefile shells out to npm - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.93 (`rust-toolchain.toml`). cargo clippy for Rust crates. Pre-commit hook runs oxfmt+oxlint+oxvelte+check across WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory)**

State lives HERE (canonical). Five repos, all `emse-students/*`:
Canari (this monorepo) | Sky (../Sky) | MiGallery (../MiGallery) | Portail-etu (../refonte-portail-etu)
| **Le Cercle (../le-cercle)**.
Sky, MiGallery and Portail-etu are COMPLETE - nothing open on any of them.
All on `main` EXCEPT Le Cercle: that repo has another primary developer, so work happens on the
branch `audit/security-and-canari-integration` and ships as a PR. Never commit to its `main`.

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that
is broken), **P2** (correctness, nothing at risk), **P3** (hygiene). `[ ]` open, `[~]` in progress.
Delete a WP outright once it ships: the rule it taught goes to DURABLE RULES, the story to
`CHANGELOG.md`.

---

### LE CERCLE (../le-cercle) - OPEN WORK PACKAGES

Branch `audit/security-and-canari-integration`, forked from `main` @ `df692f2`. SvelteKit 5 +
`bun:sqlite` (file DB, `DB_PATH`), hand-written SQL modules under `src/lib/server/db/`, migrations
= numbered files in `db/sql/migrate/` replayed by `bun run db:migrate` (the runner wraps each file
in a transaction - so NO `BEGIN`/`COMMIT` and no `PRAGMA foreign_keys` inside a migration).

**Architecture decisions taken 2026-07-28 (do not re-litigate):** ledger + cached column; the
Cercle keeps `memberships` as a display-only mirror while Canari owns tier assignment; cercleux
get site access without a cotisation but may NOT consume; cash top-ups allowed with an audit
trail; Canari credits but never displays the balance.

**Cercle gotchas (cost time once, will again):** `bun run dev` MUST run Vite under Bun
(`bun --bun vite dev`) or `bun:sqlite` fails to import and every request 500s. A SvelteKit layout
`load` does NOT run for a child page's form action, so `gestion/+layout.server.ts` protected
nothing that POSTs - each action guards itself. `CANARI_INTEGRATION_ENABLED=false` is the local
switch: it freezes the cotisant snapshot instead of refreshing it, and never opens the gate.

**Driving the Cercle locally to test it (2026-08-01, all four cost time):** the DEV server is not
worth testing against - `$env/dynamic/private` there came from a stale process and read the OLD
`.env`, silently disabling the Canari link; build and run `bun ./build/index.js` with the env
explicit on the command line instead. `TaskStop` does NOT free the port (a survivor kept 5387 and
answered every request); kill by port with `Get-NetTCPConnection ... | Stop-Process`. That server
needs `ORIGIN=http://127.0.0.1:<port>` or SvelteKit's CSRF check 403s every form action, and Bun's
`fetch` cannot set `Origin` itself (forbidden header) - drive actions with an explicit header the
runtime allows. `localhost` resolves to `::1`, where another project's Vite was listening: always
address `127.0.0.1`.

- \[~\] **WP-CERCLE-1 (P1) - Audit + security fixes + Canari double link. AUREL'S FORK IS NOW MERGED
  IN (`418c268`, pushed 2026-08-01). Only the two live checks are owed.** He had forked rather than
  reviewed: `audit/security-and-canari-rewrite` was separate lineage (same merge-base `df692f2`) and
  deleted the whole Canari link. Both halves are now on this branch, nothing dropped - his revocable
  DB sessions, `auth/authentik|cercle/`, `UTCISOString`, keg inventory, bartender LRU cache; my
  `server/canari/`, `cotisant.ts`, `authz.ts`, `db/movements/`. Reconciled by hand: one date model,
  one migration line (his session scripts collapsed into `04-add_sessions.sql` - neither had ever
  run), one till (`events/open/[id]` folded into `events/[id]?/open`). Four security holes found IN
  his code and fixed on top - see DURABLE RULES / Le Cercle auth.
  Both directions were then driven end to end against a running build: inbound webhook credits once,
  idempotent on `paymentIntentId`, rejects bad/missing signature; outbound `cotisant-status` sends
  the right key+slug+sub, drives the snapshot and the gate, resolves an unnameable tier to
  sans-alcool; at the till the alcohol tier, a forged `unit_price`, a lapsed cotisation and a
  negative quantity all behave, and the ledger balances against the cached total.
  **MR open, awaiting Aurel: https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/1**
  (GitLab over SSH - `gh` is useless and there is no API token here; **git refuses a push option
  containing newlines**, so the full French description must be pasted by hand from
  `...\Temp\claude\c--Users-jolan-Documents-Programmation-canari\2df0218a-c456-4153-8f17-1a97db43e51b\scratchpad\MR-DESCRIPTION.md`,
  also a TEMP path). That description now understates the branch - it predates the merge.
  **Still owed, both needing the site online:** a run against the REAL Canari (the stub proved the
  contract, not the deployment) and a real OIDC round trip (the checks mint their own cookies).
  Runbook: `docs/PROD-TEST-CERCLE.md`, checks V1-V6.

- \[ \] **WP-CERCLE-2 (P3) - No way to correct a mis-keyed consumption.** The ledger is
  append-only and the user declined an `adjustment` kind, so a drink charged twice or to the wrong
  account cannot be undone. Revisit once the bar has used it for a term.

- \[~\] **WP-CERCLE-3 (P3) - Dev secrets are in the working `.env`.** The three real values ARE
  generated, in the session scratchpad `CERCLE-PROD-SECRETS.md` with the posting procedure - outside
  every repo on purpose - and it records which are already posted. All that is left is putting them
  in the prod env and deleting that file. **`SESSION_SECRET` is now named `JWT_SECRET`** (the merge
  took Aurel's naming; `JWT_OLD_SECRET` holds the previous value during a rotation and MUST stay
  empty otherwise). Rotating `JWT_SECRET` is still the only way to revoke every session at once.
  `CANARI_WEBHOOK_SECRET` must equal the Canari product's `webhookSecret` exactly (see WP-INT-1).

---

### CANARI - OPEN WORK PACKAGES

- \[~\] **WP-VERIF-0..4 + the DEEPLINK-1 and UI-1 residuals (P1 to P3) - [device] one single pass.**
  Everything native is verified by COMPILING, which proves nothing about running. The ordered
  runbook is **[device-verification](docs/wiki/device-verification.md)**: checks B-K, which WP each
  one closes, and the exact log line that is the verdict. Do not re-derive the checks here; extend
  that file instead - it was pruned on 2026-07-31 to bank the closed Android pass and re-point at
  iOS, and it carries the per-check PASS/owed table.
  **ANDROID IS DONE** (full ladder on v0.11.7, 2026-07-31, log on the user's desktop). **iOS is
  entirely owed - not one check has ever run on hardware.** Check A (the upgrade path) was RETIRED
  the same day: it needed a deliberate downgrade to a pre-WP-SEC-1 build.
  Check **K is new and owed on BOTH platforms**: it closes WP-NOTIF-1 and needs a build carrying it.
  All anomalies the Android log showed are now closed or filed: WP-NOTIF-1, the
  `GET /api/users/system` 404, and the two French `[OUTBOX_MIRROR]` lines (they were in
  `commands/push.rs`, not `outboxMirror.ts`).
  **Android capture tool: `test_adb.py`** at the repo root (tkinter GUI: build, install, per-device
  logcat with the runbook's tags already whitelisted).

- \[~\] **WP-NOTIF-1 (P2) - Notification quick actions. ALL THREE PARTS CODE COMPLETE AND
  COMPILED; only the device behaviour is unverified.** (a) the delivered reply left no local trace - fixed both
  platforms by writing it to `fcm_message_cache.ndjson` under OUR user id
  (`writeSentMessageToCache` / `CanariWriteSentMessageToCache`). (b) our own avatar was blank in
  the thread - fixed via a new `MlsContextLoader.loadUserId` (no Keystore hop); Android only, iOS
  has no self Person. (c) an UNDELIVERED reply was dropped by the next `store_outbox_mirror`
  rewrite - fixed by `adoptOrphanedMirrorEntries` (`outboxMirror.ts`) + the new Rust
  `read_outbox_mirror`, which at login adopts every mirror line the TS outbox does not know about
  back into the queue, plus the local message. Runs BEFORE `loadAndRestoreConversations` on
  purpose, so the ordinary load displays it and `applyOutboxPendingStatuses` marks it pending.
  **COMPILE RUN DONE 2026-08-01** on `2b5ba1b0`, both workflows dispatched green (iOS
  `30704254549`, Android `30704255667`, v0.11.8): `CompileC ...canari_push.o` present, the NSE
  Swift compile present, `Canari.ipa` + AAB/APK produced, and ZERO `summaryArgument` lines - which
  is what confirms the WP-XP-7 removal landed, that deprecation warning having been the only thing
  that ever revealed it. Nothing was published (Release/TestFlight/Play are all gated on
  `workflow_run`).
  **What is left is purely behavioural: check K** of the runbook on both platforms. Note (c) is
  pure TS + Rust, so `cargo check` and `bun run check` already covered its compile.
  **The Android artifact of that run IS the device build** - it carries WP-DEEPLINK-1, WP-NOTIF-1
  and the WP-XP-7 removal at once, so checks H, K, I and the dev-panel check all ride one install:
  https://github.com/emse-students/canari/actions/runs/30704255667/artifacts/8819943358

- \[~\] **WP-DEV-PANEL-1 (P2) - CAUSE FOUND AND FIXED, one check owed on device.** It was the
  `revoked_devices` row, and the mechanism is that `registerDevice` never consulted the denylist:
  a deleted device that came back kept the SAME id (`resolveDeviceId` restores it on purpose), got
  a 200, and was then filtered out of `getUserDevices` and resolved to a null KeyPackage - enrolled,
  invisible, never invitable, silent, forever. Registration now answers `403 DEVICE_REVOKED` and the
  client re-enrols under a fresh id (`rotateDeviceIdentity`, shared with the mismatch path).
  **Owed:** open the panel on a device whose id was deleted earlier and confirm the recovery -
  `[MLS] Device <old> was revoked - re-enrolled as <new>`, then the panel lists the new id. Costs
  the local history of that device, by design.

- \[x\] **WP-PDF-1 - SOLVED 2026-08-01, confirmed live on prod by the user. Nothing owed.**
  Cause: Tailwind Preflight's `img { max-width:100% }` clamped each band image to its WINDOW instead
  of the circle (prod DOM: inline `width:25px`, computed `12.5px`), so the band at `left:-12.5px`
  fell entirely outside its own 12.5px window and painted nothing. Fixed with
  `max-width:none;max-height:none` on the band image, plus the grid, which had never been split at
  all. Details in `CHANGELOG.md`; the two rules it taught are in DURABLE RULES / Carte de la Vie Asso.
  Kept because it cost four dead ends: the split IS the intended design (`79645923`) - do NOT replace
  it with whole logos side by side, tried 2026-08-01 and rejected. Contrast was NOT the cause and the
  adaptive-opacity remedy was NOT applied (the user judged all three test renders correct); the
  measured shifts, if it ever does resurface, are +29 (Mines'ramax) to -3.9 (DopaMines, black on
  black), `dL = alpha x (L_logo - L_band)`. A contrast plate is useless - an opaque image covers it.

- \[~\] **WP-DEEPLINK-1 (P1) - RE-OPENED 2026-08-01: a tapped notification opens the tab, not the
  conversation.** Check H had been recorded PASS on v0.11.7 - "right tab" is what a pass looks like
  from across the room. **Cause found and fixed, frontend only, not yet seen on a device.** A target
  is a GROUP ID, a selection is a MAP KEY, and for a DM those differ; only a channel is keyed by the
  id that names it, which is why channels behaved. `endLandingUnlessTarget` compared them raw, so
  the landing's own `selectConversation(key)` ended the landing at the instant it succeeded, the
  restore dropped the selection, and the tap arrived on nothing. The idle guard had the mirror bug
  (a landed DM never looked landed -> re-select + re-fetch history on every map mutation). Both now
  cross through one `resolveConversationKey` (`openConversationFromId.ts`), which
  `openConversationFromId` is itself built on. **Owed:** check H of the runbook on Android, which
  now names its verdict lines - first `[notifNav] deep link received: <url> -> target <id>` (new;
  absent = the failure is NATIVE and no JS ran), then `[notifNav] routing to ...`, then the thread
  with its history. Nothing native was touched, so no compile run is needed for this.
  Researched and cleared while hunting it, do not redo: the manifest (`singleTask`, scheme+host
  filters for `chat`), `MainActivity.onNewIntent` -> `setIntent` + `TauriActivity` ->
  `PluginManager.onNewIntent`, `DeepLinkPlugin.isDeepLink` against `plugins.deep-link.mobile`
  (matches), and the Rust `deep-link://new-url` emit. The PendingIntent shape is already the one
  every Android guide prescribes for a `singleTask` activity.

- \[ \] **WP-FWD-1 (P2) - One forwarded message was silently lost. OBSERVATIONAL, by decision.**
  2026-07-29, prod, channel -> DM: the toast said success, the echo persisted on the sender, the
  outbox drained - and the peer never received it, not live and not after a reload. Two later
  attempts through the same path both delivered, so it is NOT reproducible. Nothing is specific to
  forwarding: `forwardMessage` hands text to the same `sendChatMessage` the composer uses. The
  instrumentation it needs already shipped (`ca8e3ef0` made every swallowed outbox branch log), so
  the decision taken 2026-07-30 is to WAIT for a recurrence rather than audit the delivery layer
  blind - touching a queue that works, with no repro, risks more than it fixes. If it recurs,
  capture `[OUTBOX]`/`[QUEUE]` on both sides at the moment of loss.

- \[ \] **WP-UI-1 residual (P3) - one open question, no code left.** The sweep is done (390 -> 31,
  and the 31 are deliberate: switch thumbs, colour-picker handles, always-dark call/lightbox
  chrome, the white plate behind a QR). Detector: `frontend/scripts/find-oneway-colors.mjs`. The one
  open question (the enrolment sheet reporting DARK under a LIGHT theme) is check I of the runbook.

- \[~\] **WP-INT-1 (P3) - Cercle credentials. THE API-KEY HALF IS DONE (2026-08-01); the webhook half
  is still blocked.** It was never fully blocked on the Cercle being online - only the webhook is,
  since only `webhookUrl` needs their host. The API key is outbound Cercle -> Canari and needed
  nothing from them, and it had **never been generated at all**: prod carried an EMPTY
  `CERCLE_API_KEY`, which rejects every request (timing-safe compare, empty expected never matches),
  and `cd.yml` did not carry the variable, so any SSH hand-edit would have been reverted by the next
  deploy. Now: GitHub secret `CERCLE_API_KEY` set, `cd.yml` syncs it with a warning when unset,
  `docs/PROD-TEST-CERCLE.md` rewritten to name the secret as the source of truth.
  **Owed: run a deploy so it reaches `infrastructure/.env`** (verify:
  `ssh canari 'grep -cE "^CERCLE_API_KEY=.+" /home/canari/canari/infrastructure/.env'` -> 1), then
  give Aurel the same value as `CANARI_API_KEY`.
  Still blocked: the real `webhookUrl`/`webhookSecret` on the prod `balance_topup` product.
  The Authentik application `cercle` EXISTS (both `.well-known/openid-configuration` and `jwks/`
  answer 200); its `MICONNECT_CLIENT_ID`/`_SECRET` must be read from the Authentik admin panel -
  they cannot be generated, and the Cercle's redirect URI has to be registered there.
  **Contract verified 2026-07-29 against `../le-cercle` (code read on both sides, nothing run):**
  `dispatchCercleWebhook` POSTs `{productId, userId, amountCents, paymentIntentId, timestamp}` with
  `X-Canari-Signature: sha256=<hex HMAC-SHA256 of the RAW body>`; `verifyWebhookSignature` +
  `/api/canari/topup` expect exactly that, sign the raw body too, and read the same field names.
  `userId` IS the OIDC `sub` = `users.uuid` there, so no id mapping. Replays are idempotent on
  `paymentIntentId`. The two sides agree.
  Two operational traps for the day it goes live: Canari sets `maxRedirects: 0` and accepts 2xx
  only, so `webhookUrl` must be the FINAL https URL (an http->https redirect fails every delivery);
  and the Cercle answers **404** for a user who has never logged into its site, which Canari counts
  as a failure - after 3 attempts that top-up sits in `webhook_deliveries` as `failed` and needs a
  manual retry from the admin panel. `CANARI_WEBHOOK_SECRET` (Cercle env) and the product's
  `webhookSecret` (Canari) are the same string under two names.
  **The secret itself is already generated** (2026-07-30), together with the Cercle's
  `SESSION_SECRET`, at
  `%LOCALAPPDATA%\Temp\claude\c--Users-jolan-Documents-Programmation-canari\9451e6ef-4c01-4c18-8203-df740c9d9476\scratchpad\CERCLE-PROD-SECRETS.md`
  - deliberately outside every repo, with the posting procedure and these two traps repeated. That
  file closes WP-CERCLE-3 as well; delete it once both values are in place. It sits in a TEMP
  directory: one cleanup and both secrets have to be regenerated (which is harmless as long as
  neither has been posted yet - they are only paired, never derived).

---

### CANARI - DURABLE RULES

One line per rule, with the page that carries the reasoning. If a rule needs a paragraph, the
paragraph belongs in `docs/wiki/` - put it there and leave the pointer here.

#### MLS state and keys -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [auth](docs/wiki/frontend/modules/auth.md)

- An at-rest envelope change needs a reader for the previous format in the SAME commit.
- `classifyStateLoadFailure` alone decides: `sealed` honours `noFreshStart`, `mismatch` must not.
- After any fresh start, persist the new state BEFORE anything else can fail (or churn loop).
- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout.
- `applyNewDeviceKeyLocally` must NEVER call `BiometricService.disable`.
- The background copy of the device key is a keystore entry, never a file.
- Raw 32 bytes at rest, base64 on the FFI wire; Android must encode with `NO_WRAP`.
- Android has TWO readers per keystore alias (`MlsDeviceKeyStore` bg, `KeystorePlugin` fg) - fix both.
- Escape hatch: "forgot PIN" wipes state and restarts, at the cost of local history.
- Rust's copy of the device key seals `mls.bin` only - local messages are encrypted in the
  FRONTEND, so biometric mode must pull the key back (`recuperer_cle_session_mls`) or persist nothing.
- `isLoginInProgress` is one flag with two owners: every entry point must release it before `loginImpl`.
- A permanent denylist and an id restored ON PURPOSE across reinstalls WILL meet: the writer that
  ignores the ban does not fail, it succeeds into a state every reader silently drops.
- Rotating the device identity is ONE operation (`rotateDeviceIdentity`) - a new id IS a new device.

#### Community channels -> [chat](docs/wiki/frontend/modules/chat.md), [social-service](docs/wiki/services/social-service.md)

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- A slug is not an authorization - `getWorkspaceBySlug` gates on membership.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- A deep-linked selection must outlive the route remount, and is held until DISPLAYED, not selected.
- A deep-link target is a GROUP ID and a selection is a MAP KEY; they are the same string only for a
  channel, so cross the gap with `resolveConversationKey` or the landing cancels itself on the DM.
- A channel target can only be opened on `/communities`; `openInvitedChannel` is the one entry point.
- Holding a landing means nothing without a rule for abandoning it - but a refetch that FAILED
  proves nothing about its target, so it holds and retries; only a refetch that SUCCEEDED abandons.
- "A refresh ran" and "the list is current" are two different facts; a loader that conflates them
  empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth.
- A removal broadcast reaches every REMAINING member too - read `kickedUserId` before acting.
- A channel bubble is keyed by the SERVER row id, everywhere.
- Channel reactions are a cleartext server tally; DM reactions are encrypted MLS system messages.

#### MLS membership and routing -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [chat-delivery](docs/wiki/services/chat-delivery.md)

- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- An external commit is the one join path with no Welcome - pass `redeliverMissed: false`.
- The unread badge is derived via `isUnreadForUser`, never stored; recount AFTER the metadata merge.
- A community is soft-deleted, never dropped; `DELETE workspaces/:id` needs MANAGE_WORKSPACE only.
- `channel.moderate` = pin or delete SOMEONE ELSE's message, nothing more.
- Dead devices are reaped after 90 days - until then a churned id keeps receiving fan-out.

#### Outbound delivery -> [chat](docs/wiki/frontend/modules/chat.md)

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- A field absent from `db/messagePayload.ts` does not survive a reload, whichever backend is used.
- `waitForMessageQueueIdle` before a flush is correctness: skipping it sends at a stale epoch.
- A history request is online-only. The requester can retry and SAY it is waiting (v0.11.7); only
  a real background wake could answer it, and that is unbuilt on purpose.
- The mirror is READ as well as written: a file one side rewrites wholesale silently deletes
  whatever the other side appended, so every such pair needs an adoption pass, not just a drain.
- Adopt before the conversations load and the ordinary history load displays it - no second
  in-memory merge path to keep correct.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md)

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens.
- Detect one-way colour per CLASS LIST (`find-oneway-colors.mjs`), never per file.
- A `@theme` entry is what makes a token exist - an undefined token is silently inert.
- A native prompt is UI you only partly own: `reason` alone leaves the plugin's English defaults up.
- But Android stacks title+subtitle+description and adds its own hint - four fields, four lines.
- No user-facing string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time).
- A native process cannot resolve a locale, so prompt text must travel down the call.
- Nothing types a string as user-visible, so no compiler enforces Paraglide.
- Re-run `bun run paraglide:compile` before `bun run test` after any build.

#### Server-side fetches -> [chat-delivery](docs/wiki/services/chat-delivery.md)

- One predicate guards every fetch of a user-supplied URL, before the fetch AND at connect time.
  RFC 1918 is not the whole blocklist: `0.0.0.0`/`::`, IPv4-mapped IPv6, bracketed literals.

#### Contracts the compiler does not check -> [development](docs/wiki/development.md)

- Tauri command names are unchecked strings on both sides.
- A plugin command needs THREE things right: plugin-name prefix, snake_case fn, `build.rs` + ACL.
- `push_context.json` is a JSON contract across four languages; only its test catches drift.
- Pin the cross-process PATHS too, not just the field names: off macOS, `fcmCacheFields.test.ts` is
  the only thing standing between a Swift writer and a directory nothing ever reads.
- A `postMessage` payload is typed by nobody - contracts live in `mlsWorkerProtocol.ts`.
- Never let a capability probe swallow its own failure.
- `getStorage()`'s IndexedDB fallback is a last resort, not a mode.
- A vendored plugin still ships the sample it was forked from - delete what you did not fork it for.
- Never redeclare an `init`/lifecycle override with fewer parameters.
- NEVER branch on an error message - use the typed `LoginErrorCode`.
- "Logged in" means two things: MLS ready vs the OIDC session.
- A migration outlives the schema it was written against.

#### Mobile and native -> [frontend/mobile](docs/wiki/frontend/mobile.md)

- iOS push = all-FCM, one transport; the App Delegate Proxy must stay enabled.
- Firebase 12: `didReceiveMessage:` is GONE - hook `CanariHandleFcmData()`.
- Branch with `isIosTauriRuntime()`/`isMobileTauriRuntime()`, and decide mobile-wide vs Android-only.
- iOS pbxproj is hand-maintained (NOT xcodegen).
- iOS keychain service `fr.emse.canari`, accounts `mls_key_<alias>` and `mls_bg_key_<alias>`.
- Kotlin nested types go on the OUTER class body, never a companion object.
- An app extension has its OWN data container: `app_data_dir` inside the NSE is not the app's. The
  App Group is the only shared storage, so a cross-process file needs a hop, and a path that is
  right in the app process is silently wrong in the extension.
- The NSE runs on a locked device - write with `...UntilFirstUserAuthentication` or not at all.
- Catch up commits BEFORE the join race: a Welcome race is only possible on a group that is not
  local yet, so on a local group the race is pure latency.
- Background decrypt applies no commit, so a silent commit push leaves the next message unreadable -
  that is the epoch gap, not a bug to retry through.
- Only user-VISIBLE native strings stay French; everything read while debugging is English.

#### Release and CI -> [cicd](docs/wiki/cicd.md)

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- A green run is not proof YOUR file compiled - the iOS pbxproj is hand-maintained, so a source
  missing from it is skipped, not failed. Grep the log for `SwiftCompile ...<file>.swift` /
  `CompileC ...<file>.o`.
- That grep is iOS-ONLY. Tauri runs Gradle quietly (no `> Task :`, no `BUILD SUCCESSFUL`), so
  hunting a Kotlin task line finds nothing and proves nothing; Gradle compiles by SOURCE SET, so
  no Kotlin file can be silently skipped and the produced APK is itself the proof.
- A disappeared compiler WARNING can be the verdict: if a deprecation warning was the only thing
  that ever revealed dead code, its absence is what confirms the removal.
- Two NAMED provisioning profiles, team `4CLNB8SR6L`, expire 2027-07-11.
- `bump-app-version.sh` must patch the NSE too, and `bump-version.yml` stages an EXPLICIT add list.
- Never add a `branches` filter to a `workflow_run` chained off a release-triggered workflow.
- The CD regenerates `infrastructure/.env` from the repo secrets, so a value set over SSH lasts until
  the next deploy. A credential is only real once it is a GitHub secret AND named in `cd.yml` -
  being in `.env.example` and both compose files proves nothing about whether it is ever populated.
- An empty API key is not a permissive default: `assertCercleApiKey` compares timing-safely, and an
  empty expected value never matches, so "unset" means the endpoint refuses everyone.

#### Carte de la Vie Asso -> [carte-vie-asso](docs/wiki/carte-vie-asso.md)

- A published carte is the poster RESOLVED (poster px + `stage`), never fractions and never a layout.
- A constant the publisher needs cannot live in `PosterCanvas.svelte` - unit geometry is `layout.ts`.
- The showcase decides nothing: what it is not told, it cannot copy - it can only approximate.
- Association identity joins live; the displayed members are a snapshot, so a roster edit republishes.
- The two repos must agree on the FONTS, or every measured box is wrong.
- What must fit a card is the longest WORD, not the name: shrink to it, then widen the card.
- A card's `photo` is published, never derived from its width - widening must not grow the face.
- A debug slider whose panel is gone still ships: fold it back into constants, or it rots as plumbing.
- `data-pdf-text` goes on the box that IS the text line - padding and flex centring are invisible to
  the vector re-draw, which anchors to the marked box's TOP. Preview right + PDF high = this.
- A positional layout must NEVER be handed a compacted array: the missing entry then renumbers the
  rest, and the result looks like a correct render of different data instead of a visible gap.
- Markup built as a STRING still lives in the app document, so the global stylesheet applies to it.
  Tailwind Preflight's `img { max-width:100% }` clamped a split-watermark band image to its window
  and pushed every negatively-offset band out of view: pin `max-width:none` on any image sized
  larger than its own container.
- A probe page is not the app: reproducing app markup outside it silently drops every global rule,
  so it can only ever confirm the markup, never clear it. Measure the LIVE DOM - a computed width
  that contradicts the inline one names the culprit in one call.
- `width:X%;height:X%` is NOT a square: the two resolve against different axes, so a `rounded-full`
  box drawn that way is a pill on any non-square parent. Size one axis and use `aspect-ratio:1`.

#### Associations and agenda -> [social-service](docs/wiki/services/social-service.md)

- A second surface for an existing action mirrors the SERVER's rule, not the first surface's:
  the association page gates on `PROPOSE_EVENT` there, the server also lets any BDE
  `VALIDATE_EVENTS` holder edit any event - so that holder had the right and nowhere to use it.
- What a modal hides because it is redundant is a decision of the PAGE, never of `canEdit`.

#### Cotisations (Cercle) -> [cotisations](docs/wiki/cotisations.md)

- The XOR has ONE implementation, `UserTagService.revokeSiblingTierTags`.
- A tag revoke MUST be scoped to `issuingAssocId`, or it is a cross-tenant IDOR.
- `variantKey` is editable and the tags follow; convert rather than delete a tier with cotisants.
- Named tiers sort before the base tier, so a legacy base-tag holder is not reported as `tier: null`.
- Cotisant status is server-authoritative - no client-side tag derivation.

#### Le Cercle auth and merging its fork -> `../le-cercle/README.md`

- `TextEncoder().encode(undefined)` is the KEY "undefined": an unset secret used as a verification
  key accepts anything anyone signs with it, and it fails OPEN. Skip absent keys, never encode them.
- Detecting a replayed token and only LOGGING it makes the theft succeed - it rotates for whoever
  presented it. A reused `jti` means two holders share one cookie: revoke the session.
- Every new page under `/gestion` re-opens the layout-load hole; the guard belongs in the ACTION.
- One app, one date model. Half the seams in a merge are a `Date` meeting a string, and the compiler
  only catches the ones that cross a typed boundary - a SQL default writing `datetime('now')` into
  an ISO column type-checks perfectly and reads back two hours off.
- A duplicate migration NUMBER is silently skipped by the runner, so two branches numbering from the
  same point collide invisibly. Migrations that NEVER ran are collapsible: recreate the final shape.
- `Intl.DateTimeFormat` without `timeZone` renders in the server's zone during SSR and the reader's
  on hydration - one row, two times.

---

### SHARED GOTCHAS -> [development](docs/wiki/development.md), [cicd](docs/wiki/cicd.md)

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@`.
- Backend lint needs `npm install` in the app dir (bare `oxlint`/`oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- Never assert a wall clock in a test; two isolated browser contexts = two devices.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
