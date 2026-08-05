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
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (Le Cercle, via ProxyJump canari; key installed
  2026-08-03, no password needed). Postgres db is `auth_db`, not `canari`.
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

State lives HERE (canonical). Five repos: Canari (this monorepo), Sky (../Sky), MiGallery
(../MiGallery) and Portail-etu (../refonte-portail-etu) are `emse-students/*` on GitHub;
**Le Cercle (../le-cercle)** is `gitlab.emse.fr:aurel.dautry/le-cercle`.
Sky, MiGallery and Portail-etu are COMPLETE - nothing open on any of them.
All on `main` EXCEPT Le Cercle: Aurel owns that repo. Never commit to its `main`; work on a branch
and hand him a merge request.

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that
is broken), **P2** (correctness, nothing at risk), **P3** (hygiene). `[ ]` open, `[~]` in progress.
Delete a WP outright once it ships: the rule it taught goes to DURABLE RULES, the story to
`CHANGELOG.md`.

---

### LE CERCLE (../le-cercle) - TWO BRANCHES PUSHED, BOTH AWAITING AUREL

**Merge request !4 OPENED 2026-08-04** (branch `chore/project-conventions`, 9 commits, TARGETS
`fix/audit-2026-08-canari-and-session` so the diff shows only its own work; GitLab retargets it to
`main` once !3 merges) - https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/4
**Description still to PASTE by hand: `../MR-CERCLE-2.md`.** It could not be pushed: git refuses a
push option containing newlines, so `merge_request.description` is unusable for anything real - but
`merge_request.create` + `.target_branch` + `.title` over SSH DO work, and that is how !4 was opened
with no `glab` and no token.
Decisions taken so they are not re-litigated: FR+EN complete (not FR-only), Docker + full GitLab CD
(not gates-only), stacked on !3 (not branched from main), both themes + a toggle, access exceptions
= cercleux + bartenders of an open perm, `/menu` and `/about` created.

Commits, oldest first: `d77b7d8` docs (LICENSE/README/CONTRIBUTING/SECURITY/CHANGELOG/AGENTS.md +
`docs/wiki/` x8), `6efcbfb` tooling (Dockerfile + compose, `.gitlab-ci.yml`, husky + lint-staged,
Paraglide FR+EN), then the redesign: art direction + icon set + cotisant gate (59 files), member
pages (25), `feat(gestion)` (39), `test(canari)` (10), the wiki update, and `0f84dec`
`fix(events)`. Gates green throughout: `bun run check` 5008 files 0 errors, lint clean,
`bun test` **31/31**.

**What the redesign found, all fixed and all in `CHANGELOG.md`:** every `/gestion` action ran
unguarded - eleven called `fail(403, ...)` without `return` (fail BUILDS a value, it does not
interrupt), `futs`/`pression_types` had no check, and `/gestion/ledger` CREDITS an account, so any
member could POST themselves a balance; a refusal answered a bare string that landed under `form.0`
and was displayed nowhere; `/gestion` itself was an empty file behind a navbar link; prices were
typed in raw cents; `setKegTapNumber` coerced an out-of-range tap to "no tap" and answered success;
`/gestion/historique`'s load-more called an empty function; and an empty `CANARI_WEBHOOK_SECRET`
failed OPEN (now CLOSED, with a test). Still flagged as a caveat rather than fixed: the session row
stores the WHOLE `X-Forwarded-For`.

**No other Work Package is open on the Cercle.** What was owed either shipped, moved to the merge request
below, or is a test in `docs/PROD-TEST-CERCLE.md` (V1 a real MiConnect round trip, V2 the access
gate, V4 the alcohol gate at a till - all three need a human, none is a WP). The link itself is LIVE
and proven both directions on prod; every probe and its answer is in that file, do not re-derive it.

**Merge request !3, awaiting Aurel** (2026-08-04): branch `fix/audit-2026-08-canari-and-session`,
7 commits, gates green - https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/3
Description to paste: `../MR-CERCLE.md`. It carries the rolled-back balance on a replayed top-up,
opening ledger entries + `bun run db:check`, a `.env.example` that can actually build and whose
placeholders are all unusable (`JWT_SECRET="secret"` was a working 6-byte key), two lint fixes, and
- head commit `0a6fbaa`, 2026-08-04 - the session alignment: revoke on replay, a 60 s grace window
(migration `08` adds `previous_jti` + `rotation_datetime`), the rotation as ONE conditional `UPDATE`,
`JWT_OLD_SECRET` removed, and `bun test` (10 tests, `src/lib/server/auth/cercle/rotation.ts`). The
Cercle now runs the same session model as Canari; Sky and MiGallery were audited the same day and
need nothing (opaque token, real `DELETE` on logout, expiry in the SELECT, sweeps).

**Two things it cannot do, both on HIS host, both to raise with him rather than patch around:**
`JWT_OLD_SECRET` is non-empty outside any rotation (55 chars, a real former secret) - the MR deletes
the code that reads it, but until the value is emptied AND `cercleapp.service` restarted, the running
build still accepts it; and `AUTH_SECRET` is byte-for-byte the `.env.example` placeholder (dead config
since Auth.js left, so weight rather than a hole). Verified 2026-08-04 by fingerprint: `JWT_SECRET`
and `MICONNECT_CLIENT_SECRET` on prod are real random values, distinct from every dev value, and the
dev `.env` leaks nothing. Left alone on purpose: `secure: false` on the session cookie is correct
while the host is HTTP-only.

**First question the big work must settle:** `undo` and `cashout` are declared in the ledger schema
and written by nothing, so the ledger is append-only with no way to correct a mis-keyed consumption
(the user declined an `adjustment` kind, 2026-07-28). Both `db:check` and migration 07 REFUSE to
guess their sign - they stop rather than compute a wrong balance - so implementing them means
choosing that convention first, in one place.

**Stack:** SvelteKit 5 +
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
nothing that POSTs - each action guards itself. `CANARI_INTEGRATION_ENABLED` still sits in the
deployed `.env` but is referenced NOWHERE in the code since the rewrite - it is dead, not a switch.

**Driving the Cercle locally to test it (2026-08-01, all four cost time):** the DEV server is not
worth testing against - `$env/dynamic/private` there came from a stale process and read the OLD
`.env`, silently disabling the Canari link; build and run `bun ./build/index.js` with the env
explicit on the command line instead. `TaskStop` does NOT free the port (a survivor kept 5387 and
answered every request); kill by port with `Get-NetTCPConnection ... | Stop-Process`. That server
needs `ORIGIN=http://127.0.0.1:<port>` or SvelteKit's CSRF check 403s every form action, and Bun's
`fetch` cannot set `Origin` itself (forbidden header) - drive actions with an explicit header the
runtime allows. `localhost` resolves to `::1`, where another project's Vite was listening: always
address `127.0.0.1`.

**Cercle prod access:** `ssh cercle` (10.0.0.6, ProxyJump canari, key installed - no password).
`cercleapp.service` serves `/var/www/le-cercle`; the checkout `/home/cercle/le-cercle` does NOT
serve. DB `/var/www/le-cercle/data/le_cercle.db`. No `node`, no `sqlite3` - use `bun`; and
`journalctl` shows nothing to that account (not in `adm`), so probe the endpoint instead.
Aurel's rewrite is what runs; our audit branch is archived
(`archive/audit/security-and-canari-integration`) and must never be redeployed. **His model,
overriding any older note:** no cotisant snapshot, no TTL - `syncCanaryMembership` writes
`users.id_membership` (FK to `memberships`) at login and on the 5-minute session-JWT refresh.

---

### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE, nothing open

**WP-LEGACY-DB SHIPPED 2026-08-04.** The FULL legacy database was recovered: all 12 databases on the
prod host (`portailetu`, `bde`, `bde_ismin`, `bde_old`, `cercle`, `dbhandi`, `omeka`+`wp_*`,
`photos_db`, `bcollery`, `test_scripts`, plus system `mysql`/`phpmyadmin`), 24.4 MB SQL, dump clean.
It lives at `../refonte-portail-etu/data-export/legacy-full-dump-2026-08-04.sql` (gitignored, PII,
NEVER commit). The rescue workflow was deleted and all its Actions runs (logs + encrypted artifacts)
purged from the public repo - no security residue.
Facts worth keeping if this ever recurs: MySQL `root@localhost` uses `mysql_native_password` (a
password we do NOT have, and resetting it on shared prod is off-limits); the working credential is
`/etc/mysql/debian.cnf`, which holds a read-only `mysqldump@localhost` backup user - it lacks the
`EVENT` privilege on the `mysql` DB, so `--events` fails and must be dropped. The dump ran through a
temporary `workflow_dispatch` workflow because there is no SSH to that box, only the self-hosted CD
runner (account `muselli`, passwordless sudo).

---

### CANARI - OPEN WORK PACKAGES

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running, and the whole owed list lives in
**[device-verification](docs/wiki/device-verification.md)** - checks B-N, the build to install, the
verdict log line of each, and the PASS/owed table. Android passed the ladder on v0.11.7; **iOS has
never run one check on hardware**. Owed on both: H (deep link into the conversation), K (quick
reply), L (revoked device re-enrolling), N (offline unlock + promotion), plus M (PDF preview) on
Android. **Open a WP only when a
check FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo root.

- \[ \] **WP-SEO-1 / WP-SEO-2 / WP-PREV-2 - checks owed AFTER the next deploy, none a code task.**
  Everything shipped and is green locally: the built server was probed on every enriched path kind
  with a stub social-service (real titles, JSON-LD, `article:*`, the injected client payload), the
  sitemap was seen to grow with associations and posts and to degrade to its static entries when the
  services are unreachable, and `app-shell.html` was confirmed to prerender with a route-less
  `kit.start`. What a curl cannot prove: (1) paste a `/posts/{id}` and a `/c/join/{token}` link into
  **Discord and Slack** and check the unfurl; (2) install the Android build and confirm it still
  boots, the build-target switch being new; (3) run the association and agenda pages through
  **Google's Rich Results Test** - the JSON-LD is verified by tests, not by Google's own parser;
  (4) submit `/sitemap.xml` in Search Console and check the coverage report a few days later.
  The deploy itself is the risk to watch: `INTERNAL_SECRET` must reach `frontend-ssr` or every
  preview stays generic (recorded in `infrastructure/MIGRATION.md`). A dead `frontend-ssr` no longer
  takes the site down - nginx serves the prerendered shell - but it does silently cost every head,
  so `X-Canari-Degraded: ssr-unavailable` in the access log is the thing to grep for.
  Open a WP only if one of these FAILS.

- \[ \] **WP-HIST-3 (P2) - Pool history per MESSAGE between devices, not all-or-nothing.** Successor
  to WP-HIST-2 (shipped 2026-08-02), which stopped the blind soliciting but left the exchange itself
  binary: `sendFullHistoryBundle` ships the responder's ENTIRE store and the receiver dedupes by id,
  one-way, with neither side knowing what the other holds. **The algorithm already exists and is
  tested**: `frontend/src/lib/sync/syncEngine.ts` - `buildLocalSyncManifest` (all message ids per
  conversation, sorted) and `diffLocalAndRemoteManifest` (symmetric difference, returning
  `missingOnRequester` AND `missingOnPeer`), computed entirely client-side. What is missing is the
  TRANSPORT: today it only runs over a QR-paired session between two of the user's own devices,
  driven by hand (`SyncSessionModal.svelte`, `useSyncSession.svelte.ts`). Putting the manifest on the
  MLS transport turns the bundle into a diff, makes the union bidirectional across all members, and
  subsumes the `no-local-history` clause of WP-HIST-2 - "awaiting history" becomes "my diff with at
  least one peer is non-empty", which empties itself.
  **DESIGN SETTLED 2026-08-02 by reading the code - nothing is open, the next session writes it.**
  (a) SIZE - two digest modes: `ids` (the sorted id list) below ~1000 ids, `buckets` above it (per
  `YYYY-MM`: count + truncated SHA-256 of that month's sorted ids, ~2 KB for any history). A
  differing bucket over-sends that month; the receiver dedupes by id, so the cost is bandwidth, never
  correctness.
  (b) DELETIONS - a NON-problem, verified in code: a deletion keeps a TOMBSTONE row (`isDeleted`),
  so the id stays in the manifest, and both stores import non-destructively (`INSERT OR IGNORE` /
  IDB `add`). Bulk row deletion exists only for CHANNELS and for a whole conversation. Rule on merge:
  a tombstone WINS over a body, or a peer that missed the deletion undoes it.
  (c) METADATA - the digest rides INSIDE MLS, so the server learns nothing it does not already hold.
  Co-members learn which ids this device kept, hashed per month in bucket mode. Accepted.
  **The protocol, 3 legs.** Leg 1 is today's WS `history_request` UNCHANGED - server-side election is
  what keeps one responder instead of a storm. Leg 2: the elected peer answers `history_digest`
  INSTEAD of its whole store. Leg 3: the requester - who alone knows both sides - diffs, then
  `history_pull {to, ids|buckets}` for what it lacks and a filtered `history_bundle` for what the peer
  lacks. No difference = zero traffic, marker clears, and the empty-bundle hack in
  `sendFullHistoryBundle` retires.
  **Two traps.** Every leg is a GROUP broadcast, so the pull must carry its target and non-targets
  must ignore it. And the REPLAY path (`historySystemEvents.ts`) must ignore `history_digest` /
  `history_pull` - transient negotiation, meaningless re-read days later.
  **Scope: DMs and groups only** - channel rows are wiped and re-fetched from the server tally at
  every load, so pooling would fight the refresh (`isChannelConversationId`).
  **Order of work:** (1) a pure `historyManifest.ts` + tests; (2) the wiring -
  `handleHistoryRequest` sends a digest, `systemMessageHandler` gains the digest and pull branches,
  `groupActions` gains a bundle filtered by id; (3) marker semantics; (4) the three below; (5) wiki
  + CHANGELOG.
  Left out of WP-HIST-2 on purpose, they belong here or nowhere: the client **ignores the
  `no_peer_online` the server already returns** (`deliveryKeepalivePost` swallows the body), so it
  burns a 30 s window on a settled question; nothing re-solicits when a peer comes back, though
  presence is polled every 10 s; and `checkPresenceNow` (`stores/presenceStore.ts`) has **no
  in-flight guard**, so a bad link stacks 4-5 concurrent `/api/presence` calls (32 s each, measured).

- \[ \] **WP-FWD-1 (P2) - One forwarded message was silently lost. OBSERVATIONAL, by decision.**
  2026-07-29, prod, channel -> DM: the toast said success, the echo persisted, the outbox drained -
  and the peer never received it. Not reproducible (two later attempts delivered), and nothing is
  specific to forwarding - `forwardMessage` uses the same `sendChatMessage` the composer does. The
  instrumentation already shipped (`ca8e3ef0` logs every swallowed outbox branch), so the decision is
  to WAIT for a recurrence rather than audit a working queue blind. If it recurs, capture
  `[OUTBOX]`/`[QUEUE]` on both sides at the moment of loss.

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
- Offline unlock is only ever the paths that ALREADY skip the server check online (biometrics,
  vault). Widening it to the PIN means caching the server salt, which is a security change wearing
  a UX hat - `offlineUnlock.test.ts` pins the predicate.
- A status code is an ANSWER, a transport failure is not: only a 401/403 may log a user out, and
  `navigator.onLine` alone never proves reachability (a captive portal reports `true`).
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
- `appMsgToEnvelope` returning NULL for a system event is load-bearing: every replay path is
  `if (envelope) display else if (system) handle`, so an envelope there silently kills the handler.
- A DM system event is a JSON control payload to EXECUTE; a channel notice is pre-rendered text to
  DISPLAY (`appMsgToChannelSystemEnvelope`), attributed to `'system'`, never to its trigger.
- A card written by three producers (local insert, live event, replay) needs ONE derived id.
- A channel roster is the CHANNEL's, not the workspace's - except the settings picker, which must
  offer people not in the channel yet (`?scope=workspace`).

#### MLS membership and routing -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [chat-delivery](docs/wiki/services/chat-delivery.md)

- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- An external commit is the one join path with no Welcome - pass `redeliverMissed: false`.
- The unread badge is derived via `isUnreadForUser`, never stored; recount AFTER the metadata merge.
- A community is soft-deleted, never dropped; `DELETE workspaces/:id` needs MANAGE_WORKSPACE only.
- `channel.moderate` = pin or delete SOMEONE ELSE's message, nothing more.
- Dead devices are reaped after 90 days - until then a churned id keeps receiving fan-out.
- A join is NOT evidence of a gap: the message store and the seen-frame ledger are keyed by USER, so
  a rotated identity rejoins every group while the browser still holds every message.
- A durable marker must carry the EVIDENCE that justified it, or nothing can ever revisit the
  diagnosis; one written without evidence is legacy - drop it, do not replay it.
- The only moment the app learns history is genuinely missing is the replay declaring a frame
  permanently undecryptable - record it THERE, the frame is consumed in the same breath.

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
- An access token is time-bound, so a COPY of it passed down a component tree is a bug waiting for
  the TTL: resolve it at the fetch (`getToken`). `authToken` as a prop means "session is authed".
- A flush listening on `online` races the token that makes it valid - sequence it after the session
  is promoted, never beside it, or every queued entry burns an attempt on the first tick.
- A retry ladder must not run while offline at all: the queue is then slowest exactly when
  connectivity returns.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md)

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens.
- Detect one-way colour per CLASS LIST (`find-oneway-colors.mjs`), never per file. The sweep is done
  (390 -> 31) and the 31 left are DELIBERATE: switch thumbs, colour-picker handles, always-dark
  call/lightbox chrome, the white plate behind a QR. Do not "fix" them.
- A `@theme` entry is what makes a token exist - an undefined token is silently inert.
- EVERY modal body clips on BOTH axes (`overflow-y-auto` forces the `visible` axis to `auto`), so an
  anchored dropdown must be portalled + `fixed` (`bindFixedPopover`), never `absolute`. No z-index
  takes an element out of an ancestor that clips.
- A native prompt is UI you only partly own: `reason` alone leaves the plugin's English defaults up.
- But Android stacks title+subtitle+description and adds its own hint - four fields, four lines.
- No user-facing string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time).
- A native process cannot resolve a locale, so prompt text must travel down the call.
- Nothing types a string as user-visible, so no compiler enforces Paraglide.
- Svelte TRIMS whitespace at a block boundary: `{label}{#if x}<span>` loses the space, `{label}`
  then `{#if x}` on the next line keeps it.
- Re-run `bun run paraglide:compile` before `bun run test` after any build.
- An API helper ending in `res.json()` throws on the empty body a DELETE/void POST returns - AFTER
  the server acted, so the call that WORKED is the one displayed as failed and the UI never updates.

#### The public head, and the two adapters -> [frontend/seo](docs/wiki/frontend/seo.md), [nginx](docs/wiki/infrastructure/nginx.md)

- A crawler on this site sees NO content: Googlebot renders, but as an anonymous visitor, so what
  it renders is the login screen. The injected `<head>` is the whole indexable surface - which is
  why the content itself (titles, dates, authors) has to travel in the JSON-LD.
- Nothing links to anything in served HTML, so the SITEMAP is the entire link graph. A static list
  of routes advertises nothing; it has to enumerate the entities.
- Not blocking a URL and SUBMITTING it are different acts: the sitemap carries association posts
  (`feed=associations`), never a student's personal post, though both are readable.
- `JSON.stringify` leaves `</script>` intact and that sequence ENDS a script element - JSON-LD
  needs its own escaper (`<`), not the attribute one.
- Hydration REPLACES the server's head with what the browser can derive alone, which is weaker. An
  unfurler never notices; a crawler indexes the downgrade. Ship the resolved meta as a JSON payload
  the client adopts - keyed on the REQUESTED path, since `/` canonicalises to `/posts`.
- An `error_page` without `=` keeps the original 5xx while serving the fallback body. Browsers run
  the scripts of a 5xx body, so that is a working app for a person and a retry for a crawler - a
  200 carrying `noindex` would instead ask Google to DEINDEX the page.
- Docker strips `#` comment lines inside a continued instruction, so an apostrophe in one never
  reaches the shell and the comment never reaches the generated file. Emulating a Dockerfile
  locally means stripping comments FIRST, then joining continuations, or you diagnose a bug that
  does not exist.

- `transformPageChunk` FIRES with `ssr = false`: a server-rendered `<head>` costs no SSR at all.
  Nothing renders server-side, `hooks.server.ts` just rewrites two literal markers in `app.html`.
- Those markers are the whole contract and nothing type-checks them - a test asserts both still
  exist in `app.html`, or the injector no-ops in silence.
- `svelte.config.js` picks the adapter from `BUILD_WEB`: web = `adapter-node`, everything else =
  `adapter-static`. The polarity is the point - a build that forgets it must not produce a server
  Tauri cannot consume.
- `adapter-node` emits NO `index.html`. A prerendered `/app-shell` supplies one, so a dead
  `frontend-ssr` costs the head, not the site. Both images ship from one artifact, together.
- A prerendered page under `ssr = false` boots at ANY url (`kit.start(app, element)`, no route
  data) - that is what makes one shell file a valid answer for every path.
- The SSR process reads services with `X-Internal-Secret`, never `X-Internal-Token` (bound to a
  user id = impersonation). Any enrichment failure falls back to the baseline: a page must never
  fail because its preview did.
- Entity text lands in HTML ATTRIBUTES in the shell - one escaper, applied to every interpolation.
- `associationLogoSrc()` falls back to `http://localhost:3011` when `window` is undefined, which is
  exactly the SSR case: build `og:image` from the site origin instead.
- A crawler never hydrates, but a user does: tag the injected block and remove it on mount.

#### Server-side fetches -> [chat-delivery](docs/wiki/services/chat-delivery.md)

- An `<img src>` at a third party inside an E2E conversation tells that host who read and when.
  Proxying it is not a nicety - and the proxy is also the only thing checking the bytes are an image.
- Proxy the favicon CANDIDATES too: the conventional paths are derived client-side, so nothing
  server-side ever rewrote them.
- Cache a FAILURE too, for a tenth of the success TTL, or every render of a dead link pays the
  full timeout.
- oEmbed only ever FILLS GAPS - Open Graph wins wherever both speak, which is what makes the
  enrichment safe to apply blindly to any site.
- Every `href` read out of someone else's markup needs its SCHEME checked, whether it ends in an
  `<img src>` or in an outbound fetch. `new URL(x, base)` resolves `javascript:` rather than throwing.

- One predicate guards every fetch of a user-supplied URL, before the fetch AND at connect time.
  RFC 1918 is not the whole blocklist: `0.0.0.0`/`::`, IPv4-mapped IPv6, bracketed literals.
- `new URL(href, base)` RESOLVES hostile input rather than throwing - `javascript:` and `data:`
  survive as absolute URLs - so anything reaching an `<img src>` needs its SCHEME checked. A
  try/catch around the parse guards nothing.
- A third-party icon/metadata service answers a PLACEHOLDER for hosts it never crawled, which is
  indistinguishable from a real answer. We already download the page: read the site's own tags.
- A dispatcher and the `fetch` that carries it must come from the SAME undici copy: Node's global
  `fetch` rejects an `undici` `Agent` (`invalid onRequestStart method`) before opening a socket, so
  every request dies and the guard it carried never runs. One seam, `ssrfSafeFetch`.
- `fetch` reports every transport failure as a bare `TypeError: fetch failed` - the diagnosis is
  entirely in `cause`, so a handler that answers a generic message without logging it hides an outage.
- One missing `/favicon.ico` is not proof a site has no icon (an SPA answers `index.html`, a 200 that
  is not an image): cascade the candidates, and reach the globe only when all of them failed.
- But never cascade a fallback chain through ONE element's `onerror`: a new `src` aborts the old
  load without unqueueing its error, so the stale event skips the candidate now displayed. Probe
  each URL on its own `Image` - an answer must only be about the URL that was asked.
- A great many sites set `og:site_name` to the page title, so a chip showing it above the title
  prints the same sentence twice. Show the HOST: short by construction, and it says where you go.
- nginx `mime.types` has NO `.mjs`, so any ES-module build asset is served as octet-stream and the
  browser refuses it. A `types {}` block would REPLACE the whole map - use `default_type` in a
  location. Serving a file is not serving it correctly: check the header, not the status code.

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
- Android/iOS native parity is COMPLETE as of v0.12.0 (audited 2026-08-03, file by file): same push
  types, same 12-entry FFI surface, state lock, quick actions, deferred outbox retry, badge, sent-
  message cache, background Welcome. The only asymmetries are OS-imposed - no boot broadcast on iOS,
  CallKit vs full-screen intent, and no self `Person` on iOS. Do not re-audit; extend this line.
- A silent push (`content-available`) NEVER runs the iOS NSE - it wakes the app process. So a control
  frame's handler belongs in `canari_push.mm`, and the twin branch in the NSE is dead code.

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
- The split watermark IS the intended design (`79645923`): whole logos side by side was tried on
  2026-08-01 and rejected. Contrast is not what makes a band vanish - an opaque image covers a plate.
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
- An audit table is ONE row per subject, updated in place - never one row per attempt. A retry that
  INSERTS leaves the failure it was pressed on in the list whatever happens, so the button reads as
  dead: success adds an invisible row, failure adds a second visible one.
- A retry button must not re-run the dispatcher's backoff ladder: sleeps + timeouts blow past the
  proxy timeout, so the one call that would have worked is the one displayed as failed.
- Automatic retry needs its OWN counter (`autoRetryCount`): the initial dispatch already burns
  `attemptCount`, so a shared counter reports the ladder exhausted before it starts.
- A ladder must END. A delivery still failing a day later is a configuration problem, and retrying
  forever hides it - `nextAttemptAt = null` is what says "a human must look at this".
- A uuid in an admin list is not information: join the name, and leave it NULL when the account is
  gone (that is a different problem from a failed delivery, and needs a different action).
- `balance_topup` is repeatable BY DEFINITION and cannot run out - the product defaults
  (`allowRepeatPurchase: false`, purchase caps) silently cap every user at one recharge for life.
  Forcing them at write repairs nothing already stored, so the TYPE decides in `assertCanPurchase`.
  A column that cannot mean anything for a type must not be READ for it, only kept tidy.
- A product entity carries `webhookSecret`: `toSafeProduct` is the ONE seam that strips it, and
  `/products/all` answers every logged-in user (same lesson as `Channel.masterSecret` and
  `toSafeAssociation`). Stripping the secret is only half of it: the REST of the row is not public
  either, so the read still needs its guard, and the anonymous audience gets `/api/public/*` with
  its own explicit projection. A guard is a decorator nothing type-checks - assert the metadata.
- A delivery id is not an authorization: retry/delete resolve the product through `associationId`
  too, or an admin of any association acts on another's top-up.
- `variantKey` is editable and the tags follow; convert rather than delete a tier with cotisants.
- Named tiers sort before the base tier, so a legacy base-tag holder is not reported as `tier: null`.
- Cotisant status is server-authoritative - no client-side tag derivation.
- `isActive` gates BUYING a tier, never RECOGNIZING one: creation forces it false when the asso
  cannot take payments, so filtering tier enumeration on it reports a whole roster as non-cotisant.
- The test top-up is the real path (`resolvePurchase` + `handlePurchaseCompleted`) minus Stripe; a
  parallel implementation would only ever prove itself. Intent prefix `pi_canari_test_`.
- A dispatch the fulfillment SKIPS silently (no `webhookUrl`/`webhookSecret`) must be refused up
  front by any test, or the test reports a success for something that never left the building.
- The `sha256=` prefix must be STRIPPED before hex-decoding: `Buffer.from('sha256=..','hex')` gives
  an EMPTY buffer, so the compare fails on length and the digest is never looked at. It presents as
  a secret mismatch - compare secret FINGERPRINTS first, and you stop chasing the wrong thing.
- An undeployed SvelteKit route answers an HTML 404, indistinguishable from a broken receiver: for a
  webhook, "not working" and "not deployed" are the same status code. Probe the route before the code.
- `webhookUrl` must be the FINAL https URL - `maxRedirects: 0` and 2xx-only, so a http->https hop
  fails every delivery. And a user who never logged into the Cercle is a 404, i.e. a failed delivery
  needing a manual retry, not a lost payment.
- Prove idempotency by re-signing a FRESH body with the same key field, never by replaying the exact
  bytes: byte-identity would pass even if the dedup were a checksum of the request.
- An integrity check that is permanently red because of fixture data is not a monitor. Seed rows need
  the same opening entry real rows get, or the alarm can never be acted on.

#### Le Cercle auth and merging its fork -> `../le-cercle/README.md`

- MEASURED 2026-08-03, correcting the older note here: `TextEncoder().encode(undefined)` is NOT the
  key "undefined" - the WebIDL default makes it ZERO bytes, and jose refuses a zero-length key, so an
  unset secret fails CLOSED. It only fails open where the value is STRINGIFIED first ("undefined" is
  a valid 9-byte public key). Skip absent keys anyway: the safe behaviour is a caught exception two
  layers down, not a decision.
- Every new page under `/gestion` re-opens the layout-load hole; the guard belongs in the ACTION.
- A control the server will refuse must not be DRAWN, and the page cannot answer that itself - a
  bartender list is not something the browser holds, so the load returns the ids it may act on.
- Never point a refusal at a page: `/unauthorized` did not exist (a bare 404), and its `301` is
  cached forever, so a member refused once stays bounced after being granted the right. Throw 403.
- One app, one date model. Half the seams in a merge are a `Date` meeting a string, and the compiler
  only catches the ones that cross a typed boundary - a SQL default writing `datetime('now')` into
  an ISO column type-checks perfectly and reads back two hours off.
- CORRECTED 2026-08-04 by reading `db/scripts/migrate.ts`: a duplicate migration NUMBER is NOT
  silently skipped - the runner detects it and `exit(1)` before applying anything. It is loud, but
  only once both branches have merged. Migrations that NEVER ran are collapsible: recreate the shape.
- `Intl.DateTimeFormat` without `timeZone` renders in the server's zone during SSR and the reader's
  on hydration - one row, two times.
- Rolling a transaction back by THROWING a success value leaks the uncommitted state into the
  response: the balance reported on a duplicate top-up is the one that was just rolled back.
- `bun:sqlite` binds a bare named key (`{uuid}` against `$uuid`) to NULL unless the Database was
  opened with `strict: true` - the query then returns nothing, and nothing errors. `lib/server/db`
  sets it; any standalone script must too.
- But `db.run(sql, obj)` types its bindings as an ARRAY, so named bindings only type-check through
  `db.query(sql).run(obj)`. It runs either way; only `svelte-check` tells you.
- `db:create` stamps the LATEST migration number, so a data fix shipped as a migration never runs on
  a fresh DB - it has to be in the fixtures as well, or day one is already inconsistent.
- Its prod facts (paths, DB, missing tooling) are in `docs/PROD-TEST-CERCLE.md` - `/var/www` serves,
  the git checkout does not; `bun` only, no `node`/`sqlite3`; `journalctl` is unreadable to that user.

#### Sessions, in every app -> [MiGallery authentication](../MiGallery/docs/wiki/authentication.md)

Settled 2026-08-04 by WP-SESS-1 and WP-SESS-2, now SHIPPED in all four apps. **The house model is
Sky's**: an OPAQUE token in the cookie, one server-side row holding everything else - MiGallery and
the Cercle likewise. Canari is the one variant: its 1 h access token stays STATELESS (six services
and nginx verify it without a DB), so the row backs the REFRESH token and carries `sid` + `jti`
(`apps/core-service/src/auth/auth-sessions.service.ts`, wiki `services/core-service.md`).

- A cookie whose content IS the identity it claims is not a credential, it is a form field.
- `httpOnly` stops other people's JavaScript from READING a cookie; nothing stops the holder from
  WRITING one. It is an XSS mitigation, never an authentication mechanism.
- "Hard to guess" is not a defence for an id an ordinary endpoint hands out to any logged-in user.
- An empty key can fail OPEN or CLOSED and you cannot guess which: `crypto.createHmac('sha256','')`
  signs happily (anyone can forge), while jose refuses a zero-length key. Decide explicitly.
- Impersonation belongs in the session ROW, never in a second cookie: a parallel credential outlives
  the logout of the first, and nothing can then prove who really acted. Authorise STARTING one on
  the effective user and STOPPING one on the real user - that split is the design.
- An audit trail names the account that ACTED, so it reads the real user, not the worn identity.
- A logout that only clears the cookie has revoked nothing; deleting the row is the whole point.
- A SvelteKit `redirect()` is not an `Error`, so `catch (e) { if (e instanceof Error) ... }` swallows
  it and answers 500 on a handler that worked. Throw redirects OUTSIDE the try.
- A replayed rotating token is TWO holders of one cookie: revoke the session. Detecting it and only
  LOGGING it rotates the token for whoever presented it - the theft succeeds, with an alarm attached.
- But that rule is unsafe without a GRACE window: two tabs share one cookie, so exactly one wins the
  rotation and the loser is one generation behind through nobody's fault. Keep the replaced `jti`
  valid ~60 s and hand back the CURRENT token, rotating nothing.
- Settle the rotation race in SQL - one conditional `UPDATE ... WHERE "tokenId" = :presented` - never
  by reading the row then writing it. Read-then-write is not a narrow window when something SLOW sits
  between the halves: the Cercle had a network call to Canari there.
- Rejecting a replay without revoking is not a safer middle ground - it signs out whoever LOST the
  race and leaves the session to whoever won, and the loser is as likely to be the real user.
- Put revocation and expiry in that same `WHERE`, or a session revoked mid-request is rotated back
  to life by the request that was already in flight.
- The grace window is also what makes claiming the rotation BEFORE issuing the token safe: if signing
  then fails, the browser still holds the jti just recorded as previous, so the next request is
  reissued instead of being read as a replay.
- Never `JWT_OLD_SECRET`: its second step is invisible and never taken, and it is backwards for the
  case you rotate in. Rotating `JWT_SECRET` is the hard cut; the everyday lever is the session row.
- One key signing two token KINDS means each verifier must check the kind: a refresh token verifies
  wherever an access token does, so without a `type` guard it authenticates its holder for 7 days.
- An id generated by the DB drags an extension in (`uuid_generate_v4()` needs `uuid-ossp`), so
  TypeORM `synchronize` in dev and the prod migration stop describing the same table. Generate in Node.
- Take the client IP from the LAST `X-Forwarded-For` entry: nginx APPENDS the connecting address to
  whatever the client sent, so the head of the list is attacker-controlled.

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
