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
  2026-08-03, no password needed). Postgres db is `auth_db`, user `canari` (NOT `postgres`, and not
  the `admin` of `.env.example`, which is local-only). **Use the PowerShell tool, never Bash** - Git
  Bash strips the backslashes out of the cloudflared ProxyCommand path and the exec fails. Quote SQL
  with a SINGLE-quoted outer string and doubled literals: `ssh canari 'docker exec … psql -U canari
  -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.

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
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals, ALWAYS, even in a plain `.ts` util with no Svelte in sight, and even when a nearby call site you're extending (e.g. `showConfirm(...)`) has pre-existing raw-string calls elsewhere - that inconsistency is not license to add another one.
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); Makefile shells out to npm - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.97 (`rust-toolchain.toml`). cargo clippy for Rust crates. Pre-commit hook runs oxfmt+oxlint+oxvelte+check across WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

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

### NEXT SESSION - START HERE (pruned 2026-08-10)

Shipped work is DELETED from this file. Its story is in `CHANGELOG.md` under `[Unreleased]`, the rule
it taught is in DURABLE RULES below, and the narrative is on the wiki page each entry points to.
**Do not reconstruct it here.** What follows is only what is OPEN or OWED.

**THE ORDER THE USER SET (2026-08-10) governs the next sessions:** (1) finish the escalation chantier
- DONE, `3be41156` + `b138f35a`, pushed; (2) do everything in the roadmap below, **the P1s first**;
(3) then **re-run the cross-client campaign from the START (post-setup)** - the scripts exist now, so
it should be fast, and it exercises everything. Commit AND push are authorised so prod picks changes
up: **prod IS the test server** until a `dev.canari-emse.fr` exists.

**FOUR DECISIONS THE USER TOOK 2026-08-10 - do not re-ask, do not re-litigate:**

1. ~~The orphaned queue~~ **DONE 2026-08-11, and the recorded predicate was WRONG.** 29 501 rows
   deleted after the `pg_dump` check (the 2026-08-11 03:30 archive post-dates the storm and carries
   them); 30 496 -> 995 rows, 70 MB -> 4.3 MB after `VACUUM FULL`. But the planned reaper -
   "devices with no key package" - would have matched **zero** of them: all 52 devices with a queue
   held a valid key package, the abandoned one included. It was not an abandoned profile either;
   28 124 of the rows are debris from the retransmission storm of 2026-08-10, addressed to a browser
   generation replaced at 01:00 on 08-11. And a TTL already existed (`RETENTION_WINDOW_MS`, 90 days,
   keyed correctly on `KeyPackage.createdAt`). What was actually missing was that nobody was looking,
   so the durable half shipped is an hourly `reportQueueDepth` that names the deepest queues and
   WARNs past a threshold - observation, never a cap, because capping trades disk for silent loss.
   **CLOSED the same day by REVOKING the debris generation** (2 073 -> 0 rows, 6 -> 0 routing
   memberships, platform 2 916 -> 847, deepest remaining queue 84 on a real user's phone): the rows
   were the symptom and the routing was the cause, so no new GC predicate was written.
   Reasoning and the numbers: [chat-delivery > the queue is bounded on ONE
   axis](docs/wiki/services/chat-delivery.md).
2. **WP-STORAGE-1's backup rewrite: BUILD IT AND PROVE A RESTORE, then show the user before any
   cutover.** The new scheme runs ALONGSIDE the tar; the tar is retired only after a restore has been
   demonstrated from the new repo. Not a free hand on prod backups.
3. **The 30-day media GC STAYS, and it no longer lies - DONE 2026-08-11.** "It is a lie today" was
   itself half stale, and the correction is the point: the chat bubble has rendered an explicit
   "Média expiré (rétention 30 jours)" since June (`d00935bd`), and 62 of the 189 prod media rows are
   already `retention_expired`, so the mechanism was live. THREE OTHER surfaces were wrong, and the
   worst was the raw token `MEDIA_PURGED_BY_RETENTION` rendered in red under a post. Fixed on all
   four - table and reasoning in
   [storage-forecast > the deletion is no longer silent](docs/wiki/infrastructure/storage-forecast.md).
4. **The phone is available this session** - the user offered to plug it in, so the Android P1s and
   LIFE-5 come before the rest of the browser roadmap.

**The user's empty-conversation observation is SOLVED and FIXED** (2026-08-11, WP-EMPTYVIEW-1). It
was found by accident: the Android HEAL run ended `W2 holds 0/14` and the sender turned out to be
rendering NOTHING at all, 598 messages in its store and 24 characters in the pane (screenshot
`w2-empty.png` in the scratchpad). Cause, table and proof are in
[chat > the render window](docs/wiki/frontend/modules/chat.md); the rule is in DURABLE RULES. In one
line: `windowStart` was recomputed only on a conversation-key change while
`loadHistoryForConversation` replaces the list with a 60-message page, so the window pointed past
the end and `slice` answered `[]` in silence. **Do not re-derive it, and do not chase the
`MainChatPage` derived binding - it was not at fault.** The reproduction that failed is worth
keeping: opening a conversation during boot does NOT reproduce it, because the list GROWS there; the
bug needs a LONG in-memory list at click time and a shrink after.

#### What the escalation chantier settled (2026-08-10, shipped - do not re-derive)

A rewound sender lost frames and the repair for it became a storm on prod: ~450 frames/min on W1,
~300-450 control messages per 30 s on W2, 324 `LOST frame` on the phone, nothing being repaired. Two
causes, both now deleted rather than tuned, both written up in
[chat > there is ONE repair](docs/wiki/frontend/modules/chat.md), with the consequence for the
campaign on [the dashboard](docs/wiki/cross-client-testing.md):

1. **One question answered by nine clocks**, two of them retry ladders driving the same request, so
   traffic was their product - and the cheap rung (`decrypt_failed`) could repair nothing by
   construction. One repair now (the history diff), one request per state edge, idempotence from the
   durable marker, termination from the empty diff.
2. **The diff's fallback mode sliced by MONTH**, i.e. by a value the two devices do not agree on, so
   a clock skew across a boundary re-sent two whole months on every exchange forever and the diff
   could never empty. It slices the ID SPACE now (`historyRangeOf`), which is identical on both sides.

Both rules are in DURABLE RULES. **Everything below is a MEASUREMENT that is owed, not a fix.**

#### OWED - the list lives on the dashboard, not here

**DONE 2026-08-10, do not re-run:** HEAL on the browser is `HEALED - 14/14` with `history diff
ran=true`, `narrow retransmission=false` and `ids mode, 554 id(s)`; the frame-rate half is green too
(14 console lines / 60 s per browser against ~450 frames/min). `wasmLogShim` is DELETED - eleven
arrivals through the thrown error, zero through the flag, and the route is unreachable by
construction after `same_epoch_ratchet.rs`.

**What is still owed, in order, is section "What is owed" of
[cross-client-testing](docs/wiki/cross-client-testing.md)** - that page is the source of truth for
campaign state and this file must not carry a second copy. It also carries the per-check state table
and the vocabulary (`pending` / `passed` / `failed` / `to-revalidate` / `deferred`).

#### The rig, and how a result earns belief

- The instrument: [`tools/cross-client-harness/README.md`](tools/cross-client-harness/README.md) -
  ports, launch flags, adb, the build traps, the file inventory. The working copy plus the ~60
  one-shot `probe-*` scripts are in the scratchpad; `heal-web.mjs`, `mlsdb.mjs`, `recon.mjs`,
  `storm.mjs`, `pin.mjs`, `watch.mjs` all exist - reuse them, do not rebuild them.
- The epistemics: [testing-methodology](docs/wiki/testing-methodology.md) - the 31 harness faults
  distilled into ten rules, plus the environment traps that read as application bugs. **Read it
  before writing a check or believing one.**

Only what neither page can say, because it is about THIS machine and THIS session:

- **Credentials are in the scratchpad `test-accounts.json` and never in the repo, which is PUBLIC.**
  No PIN, login, display name, device id, group id or device serial goes in a committed file - the
  harness copy is anonymised to `owner` / `peer` and the docs must stay that way.
- `pin.mjs` needs `--account owner` for A1; the default is the peer.
- **Never run an Android/iOS build next to anything else that builds the frontend** -
  `beforeBuildCommand` IS `bun run build`, and two builds writing `build/` ship an app that cannot
  boot. `scripts/check-bundle-consistency.mjs` now fails the build instead.
- Every Android build leaves a Gradle daemon (idle timeout 10 min).

---

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement - never assume the local `main` is the deployed truth. His commits are usually style/UI
and land in files the campaign measures, so what is owed for each is a WEB and a MOBILE pass logged
next to our own checks. He follows the conventions, so a rebase is normally clean; the thing to verify
is his change RUNNING, which no test of his can establish.

---

### LE CERCLE (../le-cercle) - MR !4 PUSHED, AWAITING AUREL

**MR !4** - `chore/project-conventions`, 13 commits, rebased onto `main` and pushed 2026-08-05 -
https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/4
**Description still to PASTE by hand: `../MR-CERCLE-2.md`** - which also carries what !4 contains and
every decision behind it, so do not re-litigate any of them from here. Git refuses a push option
containing newlines, so `merge_request.description` is unusable, while `merge_request.create` +
`.target_branch` + `.title` over SSH DO work (that is how !4 was opened, no `glab`, no token).

**VEILLE - on demand, never scheduled.** He keeps working on `main`; run this loop when asked:

1. `git fetch` in `../le-cercle`, then `git log --oneline origin/main --not chore/project-conventions`.
2. `git rebase --onto origin/main <merge-base>`. Never a commit on `main` - it is his repo.
3. Two files conflict every time: `.env.example` (HIS placeholder convention wins) and
   `.prettierignore` (keep his `/db/sql/seed.sql` line, or prettier reformats the fixture dump).
4. Re-apply our conventions to HIS new code. The canonical checklist is `../le-cercle/AGENTS.md` -
   do not duplicate it here. He does not run the gates, so expect `prettier --check` failures on what
   he merged; formatting-only fixes belong in their own commit.
5. Resync the wiki - `authentication.md`, `ledger.md`, `data-model.md`, `deployment.md` and
   `frontend.md` rot fastest. A fork followed in parallel drifts in the DOC first: the rebase is
   mechanical, what the wiki asserts about his code is not.
6. Gates, `push --force-with-lease`, then paste the MR description by hand.

**No Work Package is open on the Cercle.** What is left is his to decide (the ledger's unwritable
`undo`/`cashout`, `JWT_OLD_SECRET`, the placeholder `AUTH_SECRET`) and it is written up, with the
fingerprints that establish it, in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) - to RAISE, never to
patch. Three prod tests there need a human and are not WPs: V1 (a real MiConnect round trip), V2 (the
access gate), V4 (the alcohol gate at a till). The link itself is LIVE and proven both directions;
every probe and its answer is in that file, do not re-derive it.

**Architecture decisions taken 2026-07-28 (do not re-litigate):** ledger + cached column; the
Cercle keeps `memberships` as a display-only mirror while Canari owns tier assignment; cercleux
get site access without a cotisation but may NOT consume; cash top-ups allowed with an audit
trail; Canari credits but never displays the balance. **His membership model, overriding any older
note:** no cotisant snapshot, no TTL - `syncCanaryMembership` writes `users.id_membership` at login
and on the 5-minute session-JWT refresh.

**Ours, not the repo's** (its own traps are in `../le-cercle/AGENTS.md`, the prod facts and every
probe already run in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) **here**):
`CANARI_INTEGRATION_ENABLED` sits in the deployed `.env` and is referenced NOWHERE since the rewrite
- dead, not a switch. Never test the Canari link against the DEV server: `$env/dynamic/private` there
came from a stale process and read the OLD `.env`, silently disabling it - build, then
`bun ./build/index.js` with the env explicit on the command line. `TaskStop` does NOT free the port;
kill by port with `Get-NetTCPConnection ... | Stop-Process`. Prod is `ssh cercle` (10.0.0.6,
ProxyJump canari); our audit branch is archived
(`archive/audit/security-and-canari-integration`) and must never be redeployed.

---

### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE, nothing open

The avatar 502s closed 2026-08-06, verified on prod. Four facts survive the work:

- **The residual cause is UNKNOWN and is NOT an app defect**: for ~20 min the host could not open
  outbound connections at all (479 x bun `Unable to connect`). Everything was ruled out with
  measurements - **do not re-run any of them**: inbound rate-limiting, load, DNS/TLS/secrets, IPv6,
  conntrack, bun-vs-curl, and CrowdSec (refuted by its own evidence). What is left is the egress path
  upstream of the box. A recurrence is now timestamped in a clean, rotating log.
- **`deploy.yml` has a `workflow_dispatch`** and it is a keeper. An Actions outage drops push triggers
  outright and a lost trigger never comes back; a dispatch 500s while STILL creating the run, so check
  `gh run list` before re-dispatching. It skips the CI gate on purpose (the pre-push hook runs them).
- **No SSH to that box** - the self-hosted runner is the only way in, and the shape is a dispatch-only
  workflow then removed. The repo is **PUBLIC**, so every run log must redact - and `grep -a` is
  mandatory, the pm2 log holds binary bytes.
- **`pm2 flush`, never `rm`** - pm2 holds the fd.

The full legacy dump (12 databases, 24.4 MB) lives at
`../refonte-portail-etu/data-export/legacy-full-dump-2026-08-04.sql` - gitignored, PII, NEVER commit.
If it ever has to be redone: no SSH, only the CD runner (account `muselli`, passwordless sudo), and
the only usable MySQL credential is `/etc/mysql/debian.cnf` (a read-only `mysqldump@localhost` that
lacks `EVENT` on the `mysql` DB, so `--events` must be dropped).

---

### CANARI - THE TEST CAMPAIGN

The campaign's state - every check, its category and its state - is the dashboard at
**[cross-client-testing](docs/wiki/cross-client-testing.md)**. **Read it rather than re-deriving the
state here, and do not maintain a second copy.** The rig is
[`tools/cross-client-harness/README.md`](tools/cross-client-harness/README.md); how a result earns
belief is [testing-methodology](docs/wiki/testing-methodology.md), which carries the thirty-one
harness faults distilled into ten rules plus the environment traps that read as application bugs.
The user has asked for the whole campaign to be RE-RUN from the start once the roadmap is clear.

What a compaction must not lose, because it is a standing constraint rather than a finding:

- Runs against **PRODUCTION**, two real accounts, credentials in the scratchpad
  `test-accounts.json`, **never in the repo** - which is PUBLIC. No password is ever a tool-call
  argument, which is why W1 moved off the chrome-devtools MCP.
- **EVERY test message goes in the two-test-account DM, and NOWHERE else** (user, 2026-08-10). A
  one-off probe run in a colleague's conversation because it was convenient fired a "dangerous link"
  warning into a real person's thread. For anything needing a CHANNEL, the venue is the
  `Campagne de test` community, never MiTV - a private channel is readable by every association
  admin.
- **OBSERVATION IS PART OF EVERY CHECK, not a debugging step.** A verdict is `PASS` only if the
  assertions hold AND the run is clean. Two shipped bugs came out of a green check's noise.
- **A CHECK THAT MUST ACT INSIDE A WINDOW IT DOES NOT CONTROL MUST TRIGGER ON THE SYSTEM'S OWN
  SIGNAL AND REPORT HOW OFTEN IT GOT IN.** WP-ECHO-1's device check spaced its sends with `sleep`
  and printed PASS on seven real sends and a real reload - while the capture showed the first drain
  of the run opening three seconds AFTER the last send, so the branch under test never ran. The
  window is the app's bulk-ingest phase, 15 ms to 1.4 s. Arm first, fire on the log line that opens
  it, and count the entries with a line only the branch can emit (`[ADD_MSG] ✓ Message added` inside
  a window: inbound is buffered there and flushed through `batchAddMessages`, which never logs it).
  `inside a window: 0` is a VOID whatever else the run shows -
  [testing-methodology > rule 10](docs/wiki/testing-methodology.md).
- **RECONCILIATION is the only way this campaign's loss class can be SEEN** (`recon.mjs`). It found
  WP-LOSS-1 and WP-ECHO-1, and no per-check verdict substitutes for it.
- A check that FAILS earns a WP with its captured log; a check that passes earns a row on the
  dashboard and nothing else.

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running; the owed list is
**[device-verification](docs/wiki/device-verification.md)** - checks B-P with the verdict line of
each. Android passed the ladder on v0.11.7; **iOS has never run one check on hardware**. Owed on
both: H (deep link into the conversation), K (quick reply), L (revoked device re-enrolling), N
(offline unlock + promotion), O (the store/update destination), P (the iOS cookie jar). **Open a WP
only when a check FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo
root. The four human checks left from the SEO work are the same shape -
[seo > what no test here can prove](docs/wiki/frontend/seo.md#what-no-test-here-can-prove).

**Release status:** v0.13.1 released 2026-08-07, prod answering `{"version":"0.13.1"}`.
**`minClientVersion` stays at 0.13.0 on purpose**: the store rollout has not reached devices, and
raising it first locks everyone out.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-STORAGE-1 (P2 today, P1 the moment usage grows) - THE BACKUP SCHEME FAILS BEFORE THE
  DATA DOES.** Answer to the user's question of 2026-08-06 ("can the server hold several hundred
  users"). The whole model, every measured unit cost and the three scenarios are in
  **[storage-forecast](docs/wiki/infrastructure/storage-forecast.md)** - do not re-derive or
  re-measure it. The one sentence: `backup.sh` tars the ENTIRE MinIO volume nightly and keeps 15
  copies, so every live byte costs **16 bytes** on a 125 GB disk, and at 400 daily users the disk
  fills in **9 to 34 days** in EVERY scenario. Media are 87 % of the total; encrypted blobs are
  incompressible, so gzip buys nothing and dedup buys everything. **Ordered actions, highest leverage
  first:** (1) **DONE 2026-08-11, cutover NOT taken** - `backup-objects.sh` (restic, 14d/8w/6m,
  `restic check`, rsync mirror to mitv) is in the crontab at 04:00 next to the tar and verified under
  cron's own env; second run added **24 KB**, and a control restore matched the live volume
  **sha256-identical over 172 media objects**. What is OWED is only the decision: the cutover is
  deleting step 3 of `backup.sh`, and the user asked to see the proof first. The password is at
  `/home/canari/.config/canari/restic-password` and is deliberately NOT a GitHub secret (the CD
  rewrites `.env` every deploy; a changed password makes the repo unreadable forever) - **it must be
  copied off the box, the offsite mirror is an encrypted copy, not a second chance**; (2) **MEASURED
  AND REFUTED 2026-08-11 - do not re-plan it.** `compressImage` ALREADY runs on every upload path,
  and a 9 MP photograph through it costs **245 KB** (12 sources, Chrome's own encoder), while prod's
  five largest objects are 4.15-7.86 MB. So the megabytes are VIDEO (never compressed) or a
  passthrough branch (**HEIC hits `img.onerror` and ships full size**) - lowering the preset would
  halve the class that is not the problem, at a real quality cost. Not taken; every passthrough now
  logs its reason. Table and reasoning in section 5.2 of the page; (3)
  content-linked deletion: **account deletion DONE 2026-08-11** (`ownerId` recorded at upload,
  `DELETE /api/media/internal/users/:userId`, called by `deleteUser`; no backfill possible for older
  blobs), **message deletion deliberately NOT built** - forwarding copies the `MediaRef` and the
  server counts no references, so it would break other people's messages; the sweep takes it;
  (4) **DONE** - Redis runs `--maxmemory 1gb --maxmemory-policy volatile-lru` in both compose files
  (was `0`/`noeviction`; measured 2.29 MB, so a ceiling, not a budget, and `volatile-lru` is
  strictly safer than `noeviction`); (5) **DONE** - `013_queued_message_autovacuum.sql`, but the
  measurement says autovacuum was NEVER the cause (78 runs, 234 dead / 1173 live, 7.8 MB): the
  70 MB was one abandoned device, and the settings are insurance for the churn profile only;
  (6) `docker system prune` is NOT urgent (30 G of 125 G used) and NOT free - the CD deploys
  `:latest`, so it deletes the untagged previous images, i.e. the fast rollback path.
  **The 30-day GC is no longer SILENT** (2026-08-11): all four media
  surfaces now render an explicit expired state, see decision 3 at the top. What still needs the
  USER is the POLICY, not the rendering - a new device or a reinstall still sees no image older
  than 30 days, which is what makes the forecast survivable and may not be intended (section 6).

**Known and deliberately NOT a WP yet** (do not "fix" these by reflex):

- **Nothing tells the RECEIVER's user that a message was lost** (the residue of WP-LOSS-1, which is
  otherwise closed - both halves verified on Android 2026-08-11, see
  [mls-protocol > both halves verified on hardware](docs/wiki/protocols/mls-protocol.md)). The
  device knows: it logs `LOST frame` and solicits the diff. The user is told nothing, because the
  repair usually succeeds and a banner for every transient gap would be noise. Deliberate, and
  revisit it only with evidence that a loss went unrepaired.
- **A device only asks for history when something TELLS it to.** The four triggers are a decrypt
  failure, a fresh join with no local store, being elected as a responder and finding the peer holds
  more (`peer-holds-more`), and a reconnect re-soliciting an existing marker. So a device holding
  SOME of a conversation, missing older messages and never failing to decrypt carries no marker and
  never asks - it converges only once something else has elected it. Narrower than it was (one
  election now leaves a durable marker that the reconnect seam and the 15-minute sweep keep working),
  but not closed. Do not "fix" it with a periodic unconditional solicitation: that is a broadcast on
  a timer, which is the exact shape this area was just cleared of.
- **`history_request` is deliberately NOT made durable** the way `welcome_request` is (Redis + FCM):
  a stored request drained hours later has no digest (60 s rendezvous TTL), so the responder falls
  back to the full-store dump the diff exists to remove, for a device that may need nothing - and the
  requester must reconnect to read anything anyway, which re-solicits. The related half: a missing
  Welcome BLOCKS a group, missing history only degrades it.
- **One MLS client in a SharedWorker**, shared by every tab (the successor to WP-MULTITAB-1). It
  would remove the class outright rather than gating each write path one at a time, and nothing
  type-checks that a new path went through the queue. Cost is why it is not the fix: the worker
  transport, startup, the PIN unlock and the Safari/mobile fallback where `SharedWorker` is absent
  all have to be redone. Evaluate relevance and cost before starting.

---

### CANARI - DURABLE RULES

One line per rule, with the page that carries the reasoning. If a rule needs a paragraph, the
paragraph belongs in `docs/wiki/` - put it there and leave the pointer here.

#### MLS state and keys -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [auth](docs/wiki/frontend/modules/auth.md)

Everything that touches the device key, the PIN, `mls.bin` or an unlock path is on those two pages.
The four traps worth seeing without opening one:

- An at-rest envelope change needs a reader for the previous format in the SAME commit - and that
  reader only buys the FORWARD direction. Backwards is a separate promise nobody makes by default:
  once a device has saved in the new format, every build older than that commit is a total loss of
  identity and groups for it. Say so at the commit, or a routine rollback destroys users. **The
  frontend must not be rolled back past `01bc0a13`** (`mls.bin` byte-string encoding, WP-ANR-1).
- **serde HAS NO `Vec<u8>`**: the derived impls take the generic sequence path, so a `Vec<u8>` field
  is written as an array of integers and read back one CBOR header per byte - x45 slower and x2
  larger, measured. `mls-core/src/byte_compat.rs` is the fix; any NEW byte field must use it.
- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout.
- A status code is an ANSWER, a transport failure is not: only a 401/403 may log a user out, and
  `navigator.onLine` alone never proves reachability (a captive portal reports `true`).
- Offline unlock is only ever the paths that ALREADY skip the server check online (biometrics,
  vault); widening it to the PIN is a security change wearing a UX hat.

#### Community channels -> [chat](docs/wiki/frontend/modules/chat.md), [social-service](docs/wiki/services/social-service.md)

Deep links, system events, rosters and the channel/DM asymmetry are all on those two pages. The
three that must be seen without opening one:

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- "A refresh ran" and "the list is current" are two different facts; a loader that conflates them
  empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth.

#### MLS membership and routing -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [chat-delivery](docs/wiki/services/chat-delivery.md)

- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- A join is NOT evidence of a gap: the message store and the seen-frame ledger are keyed by USER, so
  a rotated identity rejoins every group while the browser still holds every message.
- A durable marker must carry the EVIDENCE that justified it, or nothing can ever revisit the
  diagnosis; one written without evidence is legacy - drop it, do not replay it.
- **A MARKER IS DISCHARGED BY ANYTHING THAT FALSIFIES ITS OWN EVIDENCE, NOT ONLY BY THE ANSWER IT
  WAS WAITING FOR** - and because the evidence differs per reason, the discharges do too. Two peers
  both awaiting history were each other's only possible responder, and the guard that (rightly)
  forbids a waiting device from vouching for completeness was implemented as SILENCE, so neither
  could ever clear: a fixed point the convergence argument never covered, because it reasons about
  the DATA and assumes someone is entitled to vouch. An empty symmetric difference falsifies
  `peer-holds-more` outright - the peer demonstrably no longer holds more - so that marker is
  retired by the measurement itself whatever the responder's own state, while `unreadable-frames`
  survives it, a frame neither device holds being still lost and answerable only by a third.
  Verified live on prod 2026-08-11 (WP-HISTBANNER-1). Residual and DELIBERATE: an
  `unreadable-frames` marker never self-clears, so every state edge re-solicits for the life of the
  conversation - bounded, zero-message, and the only alternative is a false completeness claim.
- **A CLAIM THAT A STRING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT
  MECHANISM GONE.** "Nouvelle tentative automatique" was written off as a lie left by the deleted
  retry ladder; the 15-minute `AWAITING_SWEEP_INTERVAL_MS` sweep is a different mechanism and still
  honours it exactly. One grep would have refuted the claim before it was written.
- A LIVENESS clock must be written by the thing whose liveness it measures. `updatedAt` answers "when
  was this row last written" and was asked "when was this device last seen" - so a peer's sync kept
  nine dead devices alive forever (WP-GHOST-1). Same shape as an epoch verdict answering a generation
  question: a column is only evidence for the question it was written to answer.
- **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE - RE-MEASURE
  BEFORE REUSING IT.** WP-GHOST-1's "a device with no key package" was carried forward, in this file,
  as the plan for a 29 499-row prod queue; it matches ZERO of those rows, because all 52 devices with
  a queue hold a valid key package. The two incidents share a symptom (frames going to a device that
  will never read them) and nothing else. A predicate is evidence about the population it was
  measured on; one `GROUP BY` with the predicate as a column refutes or confirms it in seconds.
- **A CORRECT GC WITH NO REPORT IS FOUND BY HAND, A DAY LATE.** Everything about the storm queue was
  working as designed - inside the retention window, valid key package, autovacuum running - so
  nothing complained while one device took 39 MB and thirty times the platform's whole traffic. The
  missing piece was never a rule, it was a LOOK. And the report must carry the evidence that
  separates the causes it cannot itself distinguish (here `KeyPackage.createdAt`: a live device
  falling behind is a client bug, a stale one is debris), or it sends the reader to the wrong fix.
- A device good enough to be MESSAGED must be at least as valid as one good enough to be INVITED. The
  invitation path checks the key package, the fan-out does not - and the gap is where the ghosts live.
- **WHEN A RESOURCE KEEPS REFILLING, DELETING IT IS NOT THE FIX - REVOKE WHATEVER KEEPS NAMING IT AS
  A DESTINATION.** The 2 073-row debris queue was emptied by REVOKING the dead browser generation, not
  by a sweep: a DELETE leaves the six routing memberships standing, so the next message re-queues and
  the count starts over - which the hourly report had already caught happening once. The revoke drops
  the memberships, the key packages and the queue together and records the fact in `revoked_device`.
  The GC predicate this seemed to want would have had to tell "a generation the user replaced" from
  "a device that is merely offline", a judgement the server cannot make and the user already made.
- An error says what it says: "this generation is consumed" is NOT "I already have this message".
  Keep the evidence that distinguishes them (the frame's own bytes) - and never let a native layer
  answer `Ok(None)` where the shared classifier could have decided. **This rule was written here and
  then broken for months by `mls-core` itself** (2026-08-10): a layer that cannot make a distinction
  must not make it, and the guard is `same_epoch_ratchet.rs`, not a comment. A test that asserts the
  swallow will happily protect the bug - this one did.
- **A device that has not noticed its own gap will vouch for its store.** `announceComplete` is the
  only claim that clears a proven marker, and the guard against making it wrongly (`actions.ts:1044`,
  "am I awaiting history myself?") is only as good as the claimant's own detection. A silent failure
  upstream does not merely lose data on that device - it promotes it to a trusted witness for
  everyone else's repair.
- **A responder is elected at RANDOM among all online devices except the requester's own**
  (`messaging.service.ts:1372-1382`), so any check on a repair must record WHICH device answered.
  Two runs of one check can exercise two different code paths on two different machines, and the
  greener verdict is the one that says less.
- EPOCH and GENERATION are different axes, and so are their repairs: a commit replay heals an epoch
  gap and can do nothing for a ratchet one (`TooDistantInTheFuture`), which only a new epoch clears.
  A verdict computed over one axis must never answer a question asked about the other - `epoch >=
  activeEpoch` after applying ZERO commits is "there was nothing to replay", never "it is healed".
- A wrapper string carries BOTH markers (`GAP_QUEUED:<group>:<the real OpenMLS error>`), so the order
  of a substring classifier is a decision, not a formality.

#### Outbound delivery -> [chat](docs/wiki/frontend/modules/chat.md), [mobile](docs/wiki/frontend/mobile.md)

The queue, its barrier, the token rules and the native mirror are on those two pages. The three to
carry in the head:

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- A tab is "read-only" only where something CHECKS: leadership gated the socket, not the queue, so
  the follower encrypted anyway. And gating a writer freezes its state - whoever inherits the role
  must reload it, or it resumes exactly as far behind as the tab it replaced had moved on.
- The inbound drain lowers `isDraining` only when the message callback RETURNS, so every await inside
  it is a potential freeze of all inbound traffic - and the recovery seams re-acquire the MLS mutex
  the drain already holds, so awaiting one there is a DEADLOCK, not a slow path. A repair whose
  result nobody reads (a re-add, a Welcome, an external join) must be STARTED, never awaited - and it
  must log how it settles. `DeferredRecovery` on the Welcome path is the same lesson, learnt earlier.
- **A MUTUAL-EXCLUSION WINDOW NEEDS ONE ENTRY POINT FOR AWAITING, OR ITS FREEZES ARE INVISIBLE
  ONE AT A TIME.** Two awaits inside the drain had already frozen all inbound traffic and each was
  fixed where it stood, so the third was free to do it again - nothing typed "this await is inside
  the exclusion". `drain()` now has exactly one way to await (`guarded`), which names the phase, the
  group and the message, and keeps reporting because the ELAPSED time is the diagnosis. It
  deliberately does NOT cancel: the freeze loses nothing durable, whereas the alternative the WP
  proposed - moving the flush behind `isDraining = false` - lets a second drain call
  `beginBulkIngest` across a live `endBulkIngest`, and `bulkIngestPhases` being a STACK that would
  clear the UI buffer without flushing, i.e. WP-ECHO-1 by construction. Report the freeze, do not
  trade it for a loss.
- `requestAnimationFrame` NEVER fires in a hidden document, so it can never be the only resolver of
  anything a background path awaits - and a "yield" that can hang is a deadlock, not a delay. Race it
  with a `MessageChannel` message; a timer fallback is clamped to ~1 Hz in the background.
- A deadline's SCOPE is part of its meaning: one budget over a paginated catch-up is a budget the
  devices that most need it can never meet, and an all-or-nothing pull makes each failure bigger than
  the last. Per page, ingested and ACKed as it lands - partial progress must be kept. Verified on
  hardware 2026-08-11 (WP-PENDING-1): 1 100 sends into a parked phone, two pages, a `Drain start`
  between them and two ACK steps server-side. **A verification of a STRUCTURAL fix must not claim
  the ORIGINAL failure**: the run's backlog was well inside the old 10 s budget, so it establishes
  partial progress and nothing about the timeout - say which, or the next reader believes more than
  was measured. [chat-delivery](docs/wiki/services/chat-delivery.md).
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- A UI buffer placed IN FRONT of a persistence call is a persistence bug, not a rendering choice:
  it returns early, so the write never runs, and a buffer that can be cleared without flushing loses
  it for good. `addMessageToChat`'s bulk-ingest return did exactly this to the sender's own message
  (WP-ECHO-1). Buffer AFTER the durable write, and make every discard log what it dropped.
- The mirror is READ as well as written: a file one side rewrites wholesale silently deletes
  whatever the other side appended, so every such pair needs an adoption pass, not just a drain.
- **A PER-ITEM API MAKES THE PER-ITEM COST INVISIBLE, AND THE LOOP IS WRITTEN WHERE NOBODY CAN SEE
  IT.** The background drain called a single-message entry point once per queued message, and each
  call re-read and re-wrote the WHOLE 2.7 MB MLS keystore - `O(N x |file|)` inside a 60 s OS
  deadline (WP-ANR-1). Nothing in either signature said "this is expensive to call twice". When a
  loop crosses an FFI/JNI boundary, the batch belongs on the SHARED side of it: one load, one save,
  per-entry results - which also puts the logic somewhere a host `cargo test` can reach.
- **BOUND THE WORK THAT CONSUMES AN IRREVERSIBLE RESOURCE, NOT THE WORK THAT COSTS TIME.** Capping a
  drain by how many messages it POSTs is the wrong axis: encrypting consumes a ratchet generation
  whether the frame is ever sent or not, so a cap on the POSTs still runs the sender past the peer
  and ends in `TooDistantInTheFuture`, which no retry repairs. The cap goes on the ENCRYPT; the
  surplus is not touched at all. A wall-clock budget is then only the safety net, never the plan.
- **THE RECORD OF WHAT IS STILL OWED IS ONLY AS DURABLE AS ITS LAST WRITE.** The outbox mirror was
  rewritten once, at the end of the drain, so a kill in the middle re-sent everything already
  delivered. Ask of any "remove it when done" bookkeeping what a kill between two writes costs, and
  make that a bounded number rather than the whole backlog.
- **A REPAIR THAT RECORDS ITS OWN OUTPUT AS NEW INPUT HAS NO FIXED POINT.** A replay is not a send:
  re-noting one into `recentSends` under a fresh id and a fresh timestamp defeated the expiry AND
  the dedup at once, so a five-minute decaying buffer became a permanent playlist and a bounded
  repair became a standing broadcast (WP-RETRANSMIT-1, ~430 frames/min for 13 min on prod). Ask of
  every self-healing loop what makes it STOP, and make that the thing a test pins.
- **A REPAIR LADDER MUST BE ORDERED BY WHAT EACH RUNG CAN FIX, NEVER BY WHAT EACH COSTS - and a rung
  that can fix NOTHING is deleted, not demoted.** Cheap-first is only sound when the cheap rung has a
  real chance, and the way to check is to read its TRIGGER: `signalDecryptFailure` had one call site,
  the rewound-sender branch, so the peer it asked was by construction the peer that could not answer
  - it re-encrypts at the same rewound ratchet. Measured twice on prod: 1, then 5, 15 and 25 payloads,
  none delivered. Its only success mode was the sender burning past our high-water mark on its own,
  i.e. recovery by exhaustion. **So the whole ladder is gone (2026-08-10)**: `decrypt_failed`,
  `retransmitRecentSends`, `recentSends` and the `isRetransmission` flag are deleted, and the
  history diff - which reads the peer's DURABLE store and names messages by id - is the ONE repair.
  A repair addressed by TIME is a broadcast, because a window cannot name its target, and it can only
  be as durable as what it reads.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** One
  question ("what am I missing, and who has it") was answered by NINE independent durations across
  three files, two of them retry ladders driving the same request, so the traffic was their product.
  The rule that replaced them: one request per STATE EDGE, the durable `awaitingHistory` marker makes
  a second one a no-op, and each diff exchange strictly reduces the symmetric difference, so the
  empty diff - the only thing entitled to clear the marker - is reached by construction rather than
  by budget. A duration is legitimate only when it schedules NO traffic: `REQUEST_TIMEOUT_MS` exists
  solely to notice an attempt went unanswered, and `INITIAL_SOLICIT_DELAY_MS` is an epoch-ordering
  constraint, not a backoff. Ask of every timer what it would mean if it were wrong; if the answer is
  "more traffic", it is load-bearing and it should not be.
- **BUT THE DURABLE STATE IS IDEMPOTENCE ONLY FOR THE QUESTION IT WAS WRITTEN TO ANSWER, AND THE TWO
  QUESTIONS CAN DIFFER ONLY IN LIFETIME.** The rule above was applied one line too far: the guard
  became `if (isAwaitingHistory(...)) return` in front of the loss trigger. The marker answers "is
  this group short of history" (durable, cleared only by an empty diff); it was asked "have I already
  asked" (30 s). So on any group that had EVER been broken the marker was already standing when the
  next frame was lost, and the one trigger that fires on the loss itself never fired again - twelve
  `LOST frame` lines and ZERO solicitations on prod, the 15-minute sweep left pretending to be the
  mechanism. "Is an attempt outstanding" has exactly one witness, `isSolicitInFlight` (scheduled, or
  inside the response window). Same family as `updatedAt` and the epoch-verdict rule, with the twist
  that both answers were TRUE - only the questions differed. `setupMessageHandler.lostFrame.test.ts`.
- A cause is not a label: `pending-offline` meant both "the request never left" and "it left and
  nobody answered", and the string named the first, so a silent peer was reported as an empty room.
  Two causes under one label is a WRONG answer, not a vague one - it points the user at the wrong fix.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md), [auth](docs/wiki/frontend/modules/auth.md) (native prompts)

Tokens, the one-way-colour sweep, the portalled dropdown, Svelte's whitespace trim and the native
prompt fields are all on those pages. What must not be forgotten between them:

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens - and the 31 the
  sweep left are DELIBERATE (switch thumbs, colour-picker handles, always-dark call/lightbox chrome,
  the white plate behind a QR). Do not "fix" them.
- Nothing types a string as user-visible, so no compiler enforces Paraglide - and no user-facing
  string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time). Default
  to Paraglide for ANY new user-visible string without being asked, on the first draft, not as a
  follow-up fix - a `showConfirm(...)` message and its custom button label were shipped as raw
  French literals (WP-SAFELINK-1), copying the shape of that store's own ~21 other call sites,
  none of which are Paraglide either; that existing pattern is not a precedent to extend.
- Re-run `bun run paraglide:compile` before `bun run test` after any build.
- **AN INDEX INTO AN ARRAY YOU DO NOT OWN IS STATE THAT GOES STALE, AND `slice` PAST THE END IS
  SILENT.** `ChatArea` renders `messageGroups.slice(windowStart, …)` and recomputed `windowStart`
  only when the conversation KEY changed - while `loadHistoryForConversation` REPLACES
  `conversation.messages` with a 60-message page on every click and every reconnect. A long list
  shrinking under a window computed against it left the start past the end, and `slice` answered
  `[]`: header, avatar and composer with a void under them, no error, no skeleton, no empty state
  (WP-EMPTYVIEW-1, seen on prod with 598 messages stored and zero rendered). Same family as the
  feed-retry defect - a remount "fixed" it, so it read as data loss and was not. The fix is never to
  make the stored index correct; it is for the READ side to clamp against the current length
  (`utils/chat/renderWindow.ts`), so the invariant "a non-empty list yields a non-empty window"
  holds by construction rather than by whoever remembers to recompute. Ask of any cached index what
  invalidates it, and prefer a derived clamp over a recompute you have to remember.
- **A promise that has REJECTED stays rejected, so an `{#await}` over one sits in `{:catch}` for the
  life of the component** - nothing re-enters `{:then}` but a new promise, i.e. a remount. State a
  RETRY writes must therefore be read from OUTSIDE the thing that failed: the feed read
  `postsOverride` only inside `{:then}`, so "Reessayer" fetched the posts (200 in 326 ms, measured)
  and had nowhere to render them, while leaving the page and coming back worked - which reads as a
  network fault and is not one. A retry whose result is only consulted on the success path of the
  failed attempt cannot work by construction. Not unit-testable here (the defect is purely WHERE the
  template reads its state, and there is no component-rendering setup) - `check-feed-retry.mjs`.
- A synchronous "unknown" PLACEHOLDER is indistinguishable from an answer once it is stored, so
  anything that later resolves the real value loses to it - and a module-level cache re-renders
  nothing when it warms, so whether a user ever sees the truth depends on cache timing. Return the
  absence (`peekUserDisplayName` -> `null`, or an explicit `*Resolved` flag), never the label.
- **PORTALLING A DROPDOWN BREAKS ITS ACCESSIBLE RELATIONSHIP AS WELL AS ITS POSITIONING, AND
  NOTHING WARNS.** `aria-expanded` on a trigger whose panel is no longer its descendant announces
  "expanded" and names nothing - it needs an `id` + `aria-controls`. And the right role is a
  DISCLOSURE, never `role="menu"`: the menu role promises arrow keys, Home/End and typeahead, so
  claiming it for a set of navigation links describes an interaction the component does not honour.
  What a disclosure does owe is Escape, closing AND returning focus to the trigger - the outside
  click backdrop only serves a pointer. [architecture](docs/wiki/frontend/architecture.md).
- **TWO COPIES OF A DIALOG DO NOT STAY IDENTICAL, THEY STAY PLAUSIBLE.** The lightbox and the PDF
  reader each looked right alone and disagreed on what no single-file review can see: a raw
  `aria-label="Fermer"` beside `m.common_close_label()`, plus `"Suivant"` and `"Image {n}"`, and a
  `z-[300]` beside a `z-300`. `shared/FullScreenViewer.svelte` now owns the portal, backdrop, card,
  header, close, safe areas, focus trap and Escape (WP-VIEWER-1). It deliberately does NOT own the
  content area: `lockTouch` (`touch-action: none`) is right for one bitmap and would kill the
  one-finger scroll a PDF is READ with, and a prop choosing between the two layouts would put the
  knowledge of both viewers into the component meant to know neither.
  [posts](docs/wiki/frontend/modules/posts.md).
- A shared GESTURE is shared as arithmetic, not as a component: `pinchZoom.ts` carries both models -
  the global translate for one bitmap, the anchor for a paged column - and they are NOT
  interchangeable. `zoomAboutPivot` RESETS rather than clamps at the minimum scale, because a clamp
  leaves a photo wherever the gesture ended whenever the maths lands inside the bounds, and "unzoom
  puts it back" is the one thing a user may assume.
- French inclusive writing and elided forms defeat a TLD-shape heuristic for "this looks like a
  domain" (`.es`/`.it`/`.re`/`.ne` collide with "auteur.rice"/"cher.e.s"-style endings) - an exact
  WHITELIST of real hosts sidesteps the ambiguity entirely instead of trying to out-narrow it
  (WP-LINK-1).

#### The public head, and the two adapters -> [frontend/seo](docs/wiki/frontend/seo.md), [nginx](docs/wiki/infrastructure/nginx.md)

The whole model - the injected head, the two escapers, the sitemap, the adapter split and the
fallback shell - is on those two pages, plus `BUILD_WEB` in
[frontend/architecture](docs/wiki/frontend/architecture.md). The four that cost a live outage:

- A crawler on this site sees NO content: Googlebot renders, but as an anonymous visitor, so what
  it renders is the login screen. The injected `<head>` is the whole indexable surface, and the
  SITEMAP is the entire link graph.
- CLOUDFLARE REPLACES the body of an origin 5xx with its own 16-byte page, so an `error_page`
  without `=` reaches nobody behind the tunnel. Measured 2026-08-05; hence `=200`.
- nginx does not TRUNCATE an oversized upstream header, it 502s - SvelteKit's
  `Link: rel=modulepreload` is ~7.5 KB against a 4 KB default `proxy_buffer_size`.
- A deploy being green proves the containers started, never that the site answers: probe the public
  URL for each SHAPE of path (root, an app route, a prerendered file, a dynamic endpoint).

#### Server-side fetches -> [chat-delivery](docs/wiki/services/chat-delivery.md), [nginx](docs/wiki/infrastructure/nginx.md)

The link-preview pipeline, the SSRF guard, the favicon cascade and the undici seam are on that page.
The three that generalise beyond it:

- An `<img src>` at a third party inside an E2E conversation tells that host who read and when.
  Proxying it is not a nicety - and the proxy is also the only thing checking the bytes are an image.
- `new URL(href, base)` RESOLVES hostile input rather than throwing - `javascript:` and `data:`
  survive as absolute URLs - so a try/catch around the parse guards nothing. Check the SCHEME.
- Serving a file is not serving it correctly: check the header, not the status code (nginx
  `mime.types` has no `.mjs`, so every ES-module asset went out as octet-stream).
- A safety check with an unrelated failure mode from the fetch it would ride along with needs its
  OWN endpoint, not a field bolted onto the existing response: `getLinkSafety` is decoupled from
  `getLinkPreview` precisely so a page with a broken `<title>` (which makes the preview throw)
  cannot take the Safe Browsing verdict down with it (WP-SAFELINK-1). And a check with no cache
  guidance from the upstream API for the COMMON case (Google gives a `cacheDuration` only for a
  flagged match, never for "clean") still needs an explicit, own TTL - inventing a number rather
  than caching it forever or not at all.

#### Contracts the compiler does not check -> [development](docs/wiki/development.md)

Every unchecked seam - Tauri command names, plugin ACLs, `push_context.json`, `mlsWorkerProtocol.ts`,
`LoginErrorCode` - is enumerated there. Two to keep in the head:

- A cross-process contract is only as good as its test: pin the PATHS as well as the field names,
  or a writer on one OS fills a directory nothing ever reads.
- Never let a capability probe swallow its own failure, and never branch on an error MESSAGE.
- **A DISTRIBUTION IS NOT A DIAGNOSIS: BEFORE BLAMING A CAUSE, CHECK WHETHER THE MECHANISM THAT
  WOULD HAVE PREVENTED IT IS ALREADY RUNNING.** "p90 4.25 MB, i.e. unmodified phone photos" named a
  cause from a shape and planned an x5-10 lever on it; `compressImage` was already on every upload
  path and a 9 MP photo costs 245 KB through it, so the lever was worth nothing and the real bytes
  (video, and HEIC through `img.onerror`) were never looked for. The measurement that settles it is
  cheap - run the app's OWN transform over a representative input and compare to what is on disk.
- **A DISTINCTION CARRIED IN PROSE IS A DISTINCTION EXACTLY ONE CALL SITE WILL MAKE.** `410 Gone`
  became `new Error('MEDIA_PURGED_BY_RETENTION')`, so telling "expired for ever" from "the download
  failed" meant `String.includes` at each consumer - and of four media surfaces exactly one did it:
  one rendered the raw token to the user in red, one drew a generic broken image, one spun for ever.
  The classification belongs at the THROW, as a type (`MediaPurgedError` + one `isMediaPurgedError`).
  Corollary for any audit: **one surface handling a case is not "the case is handled"** - enumerate
  the consumers of the seam, never just the ones that mention it.
- **A CONNECTION POOL MAKES `BEGIN` AND `COMMIT` TWO DIFFERENT CONVERSATIONS.** `tauri-plugin-sql`
  opens SQLite through sqlx's `Pool::connect` (default `max_connections = 10`), so each `execute` is
  its own acquisition and a three-call `BEGIN`/INSERT/`COMMIT` can touch three connections - leaving
  a transaction open on one of them for good, which then fails every later writer with `database is
  locked`. Proven on device by issuing two concurrent `BEGIN`s and having both succeed. Serialising
  in JS orders the sections but cannot bind them to a connection, which is why `runExclusive` looked
  right and was not. **A statement is the largest unit of atomicity available**: one multi-row
  `INSERT` (`db/sqliteBatch.ts`), never a loop inside a transaction - and a chunked batch is only
  safe because the rows are `INSERT OR REPLACE` under a caller-held key, so a re-run converges.
  [mobile > there is NO multi-statement transaction here](docs/wiki/frontend/mobile.md).
- A plugin in `Cargo.toml` is not a plugin the app may CALL: Tauri v2 gates every plugin COMMAND
  behind `capabilities/`, and an ungranted one builds, ships and installs, then rejects on a real
  device. EVENTS are not gated - which is how `deep-link` worked warm and was dead cold for as long
  as the grant was missing. `tauriCapabilities.test.ts` is the guard.
- **A mocked repository never parses SQL**, so a query builder's output is unverified until a real
  Postgres sees it - and TypeORM does NOT preserve the order selects were declared in, so `DISTINCT`
  written into a `.select()` string lands mid-list once an `.addSelect()` follows (`.distinct(true)`
  is the only safe spelling). Where a test cannot reach, the DEPLOY LOG is the test.
- **Two frontend builds writing `build/` at once ship an app that cannot boot, and every gate is
  green.** SvelteKit's per-build `__sveltekit_<id>` names a global the HTML writes and the chunks
  read; mixed, `kit.start()` throws `Cannot read properties of undefined (reading 'data')` and a
  phone sits on the splash forever. `bun run build` now ends with
  `scripts/check-bundle-consistency.mjs`. Never run an Android/iOS build next to anything else that
  builds the frontend - `beforeBuildCommand` IS `bun run build`.
- A batch of maintenance jobs must catch and log PER JOB. Sharing one try/catch means the first
  failure hides every job after it, and a GC that silently does nothing is indistinguishable from a
  GC with nothing to do. **The same holds for any observer list, and a COMMENT claiming the
  subscribers are independent is not independence** - `endBulkIngest` awaited them in one bare loop,
  so a failing checkpoint would have taken the UI's render buffer down with it (WP-RETRANSMIT-1).
  Isolation is a `try` per subscriber, or it does not exist.

#### Mobile and native -> [frontend/mobile](docs/wiki/frontend/mobile.md)

Push transports, the App Group, the NSE, the decrypt ladder and the update target are all on that
page. The five to carry, plus one status line:

- An app extension has its OWN data container: a path that is right in the app process is silently
  wrong in the NSE, and the App Group is the only shared storage.
- Background decrypt applies no commit, so a silent commit push leaves the next message unreadable -
  that is the epoch gap, not a bug to retry through.
- A Play-signed install and the GitHub-signed APK cannot update each other, and switching sides
  needs an uninstall that wipes `mls.bin` - so the update target is a RUNTIME fact, never a constant.
- `minClientVersion` is the ONLY thing that interrupts a user now; raising it before the store
  rollout has reached devices locks everyone out behind a button leading to the old version.
- Only user-VISIBLE native strings stay French; everything read while debugging is English.
- A path restriction written for iOS has NO effect on Android: the App Link claim lives in a
  different file per platform and `assetlinks.json` has no notion of a path, so the lists are
  GENERATED from one source. A host with no path attribute claims the whole host.
- A CSS custom property consumed at TWO nesting depths applies its correction TWICE if both
  consumers independently subtract the same inset: `.app-layout` re-pinned itself to
  `--app-viewport-height` even though its own ancestor chain was already correctly shrunk by that
  same variable structurally (`padding-top`), leaving a gap the height of the status bar (WP-KBD-1).
  The fix is not making the second consumer's math right - it is deleting the second consumer.
- Edge-to-edge on Android is NOT guaranteed by `env(safe-area-inset-*)` alone: whether the OS
  populates it depends on OS-enforced defaults (`targetSdk` 35+ on Android 15+) that some OEMs
  (seen on Xiaomi/HyperOS) do not honor consistently for a WebView. Call `enableEdgeToEdge()`
  explicitly in `onCreate` rather than relying on version-gated enforcement to make the insets this
  app's CSS already assumes everywhere actually show up.
- **`fetch` IS NOT `fetch` in the WebView**: `hooks.client.ts` replaces `window.fetch` with the Tauri
  HTTP plugin's, which is a NETWORK client and rejects every non-`http(s)` scheme with
  `scheme <x> not supported` - a bare rejection that reads as a dead network. The routing rule must
  name what the plugin CAN do, never the exceptions: written as an exception list it missed `blob:`,
  and since saving an attachment reads its object URL back, EVERY download on both platforms failed
  while the ACL, the save dialog and `fs.writeFile` were all correct. `utils/fetchRouting.ts`, pure
  and tested. `XMLHttpRequest` is not patched - a passing XHR beside a failing `fetch` is the
  fingerprint.
- **A RELATIVE `/api/` PATH IS DEAD ON MOBILE, AND IT FAILS AS A SUCCESS.** The WebView's origin is
  `tauri.localhost`, so Tauri resolves the path as an ASSET, misses, and falls back to `index.html`
  - **200 with an HTML body**, so `res.ok` is `true` and only `res.json()` throws, inside whatever
  `catch` happens to be there. Seen on A1 2026-08-11 in the app's own log (`[tauri::manager] Asset
  api/mls/security/pin-status/... not found; fallback to index.html`). Three call sites had it and
  the third was destructive: `handlePinReset` read that `res.ok` as "the server cleared the
  verifier" and went on to wipe the device's MLS state, losing the history while the verifier stayed
  registered - the WP-DIRECTBOOT-1 shape again, a "cannot read" taken for a "not there" with a
  destructive branch behind it. Always a base from `utils/apiUrl.ts` (`coreUrl`/`socialUrl`/
  `gatewayUrl`/`deliveryUrl`) or `historyBaseUrl`; `apiUrl.absolute.test.ts` is the guard.
- A WEBVIEW HAS NO DOWNLOAD MANAGER: `<a download>` is a silent no-op on Android and iOS alike
  (Tauri installs neither a `DownloadListener` nor a `WKDownloadDelegate`), and the click still
  "succeeds", so there is no exception and no log - eleven buttons shipped dead. Everything saving a
  file goes through `$lib/utils/fileDownload.ts`. Never ask for a DIRECTORY on mobile (Android's SAF
  has only a document picker), and remember `fs:default` is READ-ONLY - the plugin being named in
  the capability file grants no write.
- A decision reachable from the CLEARTEXT push fields must never sit behind the decrypt ladder: an
  early return on "could not decrypt" silently swallows every action that never needed the plaintext
  (WP-NOTIF-1). And parity between the platforms is not parity of declarations - iOS was correct here
  and Android was not, differing only in WHERE an early return sat.
- A native thread has NO JAVA FRAMES on its stack, so `FindClass` from a JNI-attached Rust thread
  only reaches boot-classpath FRAMEWORK classes (`android.webkit.CookieManager`), never an
  app-bundled class - not `MainActivity`, not an AndroidX library class like
  `CustomTabsIntent`. Calling one of those reliably needs Tauri's own plugin-invocation path
  (`@TauriPlugin`/`Plugin(activity)`), which already runs with the right classloader context - not
  a raw `JNI_OnLoad`-cached `JavaVM` and a hand-rolled `attach_current_thread` (WP-OIDC-TAB-1).
- **A DEPENDENCY CAN MAKE YOUR PROCESS START IN A STATE YOU NEVER DESIGNED FOR, and the source
  manifest will not show it.** `tauri-plugin-notification` merges a `directBootAware` receiver on
  `LOCKED_BOOT_COMPLETED`, so Canari runs before the first unlock after every reboot; read the
  MERGED manifest. In that window a file `exists()` false, `SharedPreferences` loads empty AND
  CACHES that for the life of the process, and a Keystore alias is present but unreadable - three
  ways for "cannot read" to be mistaken for "not there". **A destructive repair must therefore be
  gated on knowing the state is really broken**, or a temporary condition becomes a permanent loss:
  `getOrCreateKey` deleted an intact key and regenerated it, orphaning the push secret for good
  (WP-DIRECTBOOT-1, fixed and VERIFIED on hardware 2026-08-11: same pid across the unlock, zero
  rejected secrets, and a real authenticated fetch forced by emptying the avatar cache).
  Only the notification CHANNELS can be created pre-unlock - they live in the
  system, not in our storage.
- A plain system-browser launch (`openUrl`) is an ORPHANED activity on Android: it opens in a
  separate task the calling app has no relationship to, so nothing on either side can dismiss it
  once the flow that needed it is done. A Chrome Custom Tab launched via `CustomTabsIntent`
  shares the LAUNCHING APP'S OWN TASK, which is what lets the OS close it automatically the
  instant that task's activity resumes to the foreground (confirmed via
  `dumpsys activity activities`: the tab's `ActivityRecord` shared the app's task id before
  login, and was gone from the task's history entirely after the deep-link return) - the
  right fix for "a login tab is left behind" is never a dismiss call, it is putting the tab in
  the right task to begin with.
- **A PAUSE MUST HAVE A SYMMETRIC RESUME, and a circuit breaker must never cut the wire to its own
  reset.** `pauseConnection` stopped both watchdogs on every background; nothing re-armed them, so
  one background/foreground cycle left a phone with no timer able to notice a dead socket. Then the
  reconnect circuit latched open with only the login paths able to close it - while the watchdog,
  the one thing whose job was to notice, reached through `scheduleReconnectImpl`, which the latch
  turns off. Ask of every breaker WHO closes it, and check that party is not itself disabled by it.
  Corollary that made this invisible: an app can be fully alive on HTTP and dead on its socket, so
  "the network works" is never evidence the connection does.
- `getCurrent()` answers "the last deep link this PROCESS was handed", never "the app was just
  started by one" - the Rust plugin holds it for the life of the process, so every re-read must be
  deduplicated. **And STATE WHOSE JOB IS TO SURVIVE AN EVENT MUST NOT LIVE WHERE THAT EVENT DESTROYS
  IT**: the guard was a module variable, which a WebView reload wipes, so the reload replayed a
  15-minute-old launch URL (WP-RELOAD-DL-1). "Module variable" is a LIFETIME, not a detail - pick it
  against the event, here `sessionStorage`, which matches the plugin's own boundary.
- **A DESTRUCTIVE CONTROL EXPOSED TO THE USER NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A
  DENYLIST OF WHAT IT MUST AVOID.** WP-DEVICESTORAGE-1's "clear cache" in Settings (`deviceStorage.ts`)
  only ever calls `caches.delete()` on the three named Cache Storage buckets (media ciphertext,
  avatars, association logos) - it has no path to `mls.bin`, the message database, or the outbox
  mirror, because it never lists the app data directory at all. The measurement side is read-only
  and separate: `get_local_storage_usage` (Rust) buckets `{app_data_dir}` file sizes for DISPLAY
  only. A Settings-page button is easier for a user to hit by accident than a native OS "clear app
  data" dialog already is - same shape of risk as WP-DIRECTBOOT-1's `getOrCreateKey`.

**Android/iOS parity: CODE audited 2026-08-03 (v0.12.0, file by file), CONFIGURATION audited
2026-08-07.** Do not re-audit either - the table of every surface, what each is guarded by, and the
OS-imposed asymmetries that are NOT defects, is
[mobile > parity](docs/wiki/frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed).
**iOS cannot be tested for a long while (user, 2026-08-07), so parity is maintained BY
CONSTRUCTION**: one shared file wherever the platforms can share one, a test reading both trees
wherever they cannot. Every parity defect ever found has been in CONFIGURATION, never in code -
the `/auth/callback` capture (`56fc6129`), the missing `deep-link` ACL (WP-DEEPLINK-1, which broke
BOTH platforms), and `applinks:www.canari-emse.fr` claimed on iOS alone though `www` 301s and Apple
does not follow redirects (fixed 2026-08-07, now asserted by `appSiteAssociation.test.ts`).
**A no-op on one platform must say WHY**: "nothing to do" and "there is no API and nobody has
looked" are different, and only the first is evidence - the iOS cookie jar is the second, and is now
`check P`.

#### Release and CI -> [cicd](docs/wiki/cicd.md)

Signing, the bump script, the secrets and every compile-check trick are on that page. The three
that decide whether you believe a run:

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- A green run is not proof YOUR file compiled: the iOS pbxproj is hand-maintained, so grep the log
  for `SwiftCompile`/`CompileC` on the file. (iOS only - Gradle cannot skip a source set.)
- The CD regenerates `infrastructure/.env` from the repo secrets, so a value set over SSH lasts until
  the next deploy. A credential is only real once it is a GitHub secret AND named in `cd.yml`.
  **A THIRD place is just as mandatory and easy to forget: the service's own `environment:` block
  in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for parity) must also name the var
  explicitly** (`FOO: ${FOO:-}`) - `.env` having the value proves nothing about whether Compose
  passes it into the container. `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `cd.yml` and
  `.env.example` and was still absent from `docker exec ... env` on prod (WP-SAFELINK-1) because
  this third step was skipped; the endpoint answered 200 with a wrong, silently-fail-open verdict
  the whole time, not an error - `docker exec <container> env | grep FOO` is the only way to catch it.
- A generated file the repo COMMITS needs both halves or neither: the bump must patch it, and
  `.gitignore` must really keep it - a later `*.lock` silently overrode the `!` written above it,
  and a lock nothing bumps is corrected by whatever unrelated commit next runs cargo.
  **Worse than either half is a generated file that the FORMATTER also owns**: the Tauri plugin ACL
  outputs (`plugins/*/permissions/{autogenerated,schemas}/`) were written expanded by `build.rs` and
  folded back by the pre-commit formatter, so every Android build dirtied the tree and every commit
  undid it. They are gitignored now, like `gen/schemas/` already was; the SOURCE (`default.toml` and
  the `COMMANDS` list in `build.rs`) stays tracked. Before ignoring any generated file, delete it and
  rebuild - that is the only proof the generator really owns it.

#### Carte de la Vie Asso -> [carte-vie-asso](docs/wiki/carte-vie-asso.md)

The contract with the Portail, and every rendering trap (text sizing, the PDF anchor, the split
watermark, Preflight), are on that page. The three that decide the contract:

- A published carte is the poster RESOLVED (poster px + `stage`), never fractions and never a layout.
  The showcase decides nothing: what it is not told, it cannot copy.
- Association identity joins live; the displayed members are a snapshot, so a roster edit republishes.
- The two repos must agree on the FONTS, or every measured box is wrong.

#### Associations and agenda -> [social-service](docs/wiki/services/social-service.md)

- A second surface for an existing action mirrors the SERVER's rule, not the first surface's:
  the association page gates on `PROPOSE_EVENT` there, the server also lets any BDE
  `VALIDATE_EVENTS` holder edit any event - so that holder had the right and nowhere to use it.
- What a modal hides because it is redundant is a decision of the PAGE, never of `canEdit`.

#### Cotisations (Cercle) -> [cotisations](docs/wiki/cotisations.md)

The page carries the tier model, the webhook ladder and everything debugging the live link cost.
The two that are security, not plumbing:

- The tier XOR has ONE implementation, `UserTagService.revokeSiblingTierTags`, and a tag revoke MUST
  be scoped to `issuingAssocId` or it is a cross-tenant IDOR.
- A product entity carries `webhookSecret` and `/products/all` answers every logged-in user - same
  lesson as `Channel.masterSecret`. `toSafeProduct` is the one seam, and a guard is a decorator
  nothing type-checks, so assert the metadata.

#### Working in the Cercle repo -> `../le-cercle/AGENTS.md`, and the VEILLE loop above

That file is the contract for THAT repo - the per-action guard, the 403 rather than a redirect, the
empty signing key, the rollback that throws a success value, the date model, the `bun:sqlite` and
migration traps, the run-time config rule. Read it there; re-copying it here only makes the two
drift. One thing it cannot say from inside: a duplicate migration NUMBER is loud, not silent
(`exit(1)` before applying anything) - but only once both branches have merged, so check the highest
number on `main` before naming a file.

#### Sessions, in every app -> [sessions](docs/wiki/sessions.md)

Settled 2026-08-04 by WP-SESS-1 and WP-SESS-2, SHIPPED in all four apps. The whole model and every
rule it cost is on that page - read it before touching any login, cookie or rotation.

- A cookie whose content IS the identity it claims is not a credential, it is a form field.
- A replayed rotating token is TWO holders of one cookie: revoke the session - but only with a grace
  window, and settle the race in ONE conditional `UPDATE`, never read-then-write.
- An empty key can fail OPEN or CLOSED and you cannot guess which. Decide explicitly.
- Rotation makes DURABILITY part of the protocol: a client that loses the new token does not just
  fail to refresh, it gets revoked. Force the write where the rotation happens, and AWAIT it - on
  Android the cookie jar reaches disk only on `CookieManager.flush()`, and a kill with no lifecycle
  callback rewinds it one generation.
- A dead session is an ANSWER: never retry the request anonymously, or "you are logged out" renders
  as "there is nothing here". Reach the verdict in one place and announce it from there - every
  caller that re-decides is a path that can forget.
- A one-shot announcement and a late subscriber are a RACE: replay the verdict to whoever registers
  after it. A fallback only covers the race if it does everything the real handler does, which it
  never does - ours redirected without closing the PIN modal, so `/login` arrived unusable.

---

### SHARED GOTCHAS -> [development](docs/wiki/development.md), [cicd](docs/wiki/cicd.md)

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@`.
- **Postgres stores UTC and the prod host is `Europe/Paris` (CEST, +0200)**, so a DB timestamp is two
  hours behind the wall clock a test just wrote down - `18:09:47` in `queued_message` IS the
  `20:09:47` send. Both are CORRECT (`timedatectl` = CEST, `SHOW timezone` = UTC); do not "fix" the
  server clock, it would move the 03:30 backup cron and break every log correlation. Convert.
- MiConnect 2FA remembers the device for 8 h, so a later login only needs the code. If the CAS page
  stalls after Esup Auth accepts, go BACK to the browser tab and reload; ask the user rather than
  looping.
- A live credential is not a debugging input: reading the phone's cookie jar is refused, and the
  answer came from a probe that never touched the token. Reach for the observable, not the secret.
- Android Rust compiles from Windows: `NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125`, put
  `toolchains/llvm/prebuilt/windows-x86_64/bin` on PATH, `CC_aarch64_linux_android=aarch64-linux-android24-clang.cmd`,
  then `cargo check --target aarch64-linux-android`. It is the only local check of `#[cfg(android)]`
  code - and it proves compilation, never that a JNI `FindClass` resolves at runtime.
- Backend lint needs `npm install` in the app dir (bare `oxlint`/`oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- Never assert a wall clock in a test; two isolated browser contexts = two devices.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
