# MLS re-audit 2026-07 - plan and progress

Living plan for the deep MLS re-architecture started 2026-07-03. This document is the
cross-machine source of truth (the working notes live outside the repo and do not travel via git).

**Related living docs:** `AUDIT-MLS-2026-06.md`, `MLS_DESYNC_PREVENTION.md`, `MLS_RECOVERY_LADDER.md`,
`docs/wiki/mls-protocol.md`.

## Why

A two-device DM trace showed a returning device (D1) emit a valid epoch-2 Welcome yet stay at
epoch 1, misread it as "forked (commit rejected)", `forget_group`, then loop
"re-added Nx in vain - fix needed client-side". A whole ladder of destructive recovery fires for a
banal case. Goal: fix the roots and collapse the ladder, keeping strict MLS philosophy and maximum
availability. Server may become the absolute source of truth (ordering/metadata/ciphertext only,
never keys/plaintext -> no privacy change; clients still cryptographically verify every commit).

## Two root causes (confirmed in code)

1. **Epoch regression via context state round-trip.** The live MLS state lives only on the main
   thread, but `mlsKeyPackage.worker` and `mlsCrypto.worker` return a FULL state blob reloaded into
   the live client (`reloadClientFromState` / `reloadClientFromPlainState`, WebMlsService.ts) with no
   epoch-monotonicity guard. The mls-lock (`mlsPerGroupScheduler.ts`, non-reentrant, line ~97) is
   cooperative: queued messages honor it (`drain`), Welcome processing self-manages it
   (`setupMessageHandler` ~266), but the inviter-side `handleWelcomeRequest -> addMember`
   (`actions.ts`) runs UNLOCKED. So `add_member` (merge-immediate, `mls-core/src/lib.rs:740`)
   advances the live client to epoch N+1 during the held-lock window of `generateKeyPackage`, whose
   stale epoch-N snapshot is then reloaded -> live epoch regresses -> false "fork".
2. **ADD/REMOVE asymmetry.** REMOVE = validate-then-merge (stage, merge after server accept, clear on
   reject) = no fork (`mls-core/src/lib.rs:549,597`). ADD = merge-immediate (`:740`) -> a
   server-rejected ADD leaves the client ahead with no clean rollback = the other half of the forks.

Everything else is symptom: ~20 client recovery mechanisms, ~8 call `forgetGroup`. Clusters B
(epoch-gap -> forget) and C (fork -> forget) fire mostly on FALSE divergence from causes 1 and 2.

## Target architecture

Server linearizes commits - already present: `activeEpoch` per group + Redis
`mls:commitlock:{groupId}` + strict gate `baseEpoch == activeEpoch` in `validateCommit`
(chat-delivery `messaging.service.ts`). Client applies in order; on a gap it fetches and replays the
missing ordered commits (rung 1, non-destructive); it only re-Welcomes when its epoch is below the
retained floor (rung 2). `forget_group` is called only in rung 2.

**Server facts (chat-delivery):** retention = 90 days (`RETENTION_WINDOW_MS`) => rung1/rung2
boundary. Commits are persisted in Postgres `queued_message` per-device and purged on ack + hourly
cron; Redis stream `history:{groupId}` EXCLUDES commits. Gap to fill (Phase 2): no epoch-indexed
replayable commit log -> BUILD one `(groupId, epoch) -> commitBytes` + `GET commits?sinceEpoch=N`.
Keep `add-lock` (fundamental). Drop `reset-epoch` (legacy), dead bootstrap endpoints, `reboot-lock`,
and the routine reboot/CAS successor machinery.

**External join replaces the successor mechanism (Phase 4).** The successor/reboot machinery solves a
liveness/membership deadlock (a device never Welcomed, no reachable member to Welcome it) - orthogonal
to epoch gaps, so the commit-log does NOT retire it. openmls 0.8.1 (`frontend/mls-core/Cargo.toml`)
supports external commits natively; groups are already created with `ratchet_tree_extension=true`;
`GroupInfo` is extracted-then-dropped at `mls-core/src/lib.rs:545,593,732`. Need `export_group_info` +
`join_by_external_commit` in mls-core + WASM wrappers, plus a server endpoint that stores the latest
GroupInfo per group and serves it ONLY to devices of already-authorized members (gate via
`HeaderAuthGuard` + membership), and accepts the external commit. Confirm exact 0.8.1 signatures at
compile time.

## The 6 phases

- **Phase 0 - epoch monotonicity (root cause 1).** Contexts never replace live group state with a
  staler blob; the epoch is a hard non-decreasing invariant per group across every context
  (foreground WASM + native background = strictest).
- **Phase 1 - one commit regime (root cause 2).** ADD moves to validate-then-merge like REMOVE.
  COLLAPSES with Phase 0.1 into one primitive (see below).
- **Phase 2 - rung 1 replay backbone.** Server ordered commit-log `(groupId,epoch)` + `sinceEpoch`
  endpoint; rewrite the client gap handler to fetch+apply, never forget. Collapses clusters B and C.
  Server DB migration lands here.
- **Phase 3 - collapse cluster A.** Merge the redundant re-add triggers (welcome_request cadence 60s /
  SYNC_WATCHDOG 5s / unknown-group buffer 10s) into ONE rung-1 trigger.
- **Phase 4 - external join.** Replace successor/CAS/reboot with native external commits; rung 2 =
  clean re-Welcome only beyond 90 days; retire legacy endpoints. Server DB (GroupInfo) migration here.
- **Phase 5 - docs + tests.** Update `docs/wiki/mls-protocol.md`, the 3 MLS docs, and the tests per
  phase (ACK policy, desync/recovery contracts).

Keep guards (correct, non-destructive): already-member skip, anti-livelock, post-Welcome cooldown,
NoMatchingKeyPackage retry.

## Progress

**Phase 0 (done + verified):** `swapClientMonotonic` in `WebMlsService.ts` - a reload can never lower
a group's epoch nor drop a live group; both reload callers respect the refusal (KP worker regenerates
on the live client if its snapshot went stale; catch-up keeps the live client). `bun run check` clean.
This already neutralizes the trace's exact regression.

**Piece B (done + verified):** write-if-newer IDB persistence. Monotonic snapshot version tagged at
the synchronous snapshot moment, carried on the bytes via a `WeakMap` (so off-thread Argon2 cannot
reorder it), enforced by an IDB read-modify-write in `saveMlsStateEncrypted` that refuses any blob
whose version is not strictly newer than the stored `MLS_STATE_VERSION_KEY`. Reseeded from the stored
version at load so a fresh session never emits a stale-looking version. Fixes the persistence-layer
variant of root cause 1: a slow encrypted flush (`mlsStatePersister`, worker Argon2) overwriting a
fresher concurrent write (`generateKeyPackage`, main-thread Argon2) and regressing the persisted epoch
on reload. Touched only `utils/hex.ts` + `WebMlsService.ts` (persister/registry/restore paths already
flow tagged bytes or write untagged with no concurrency). Web-only (Tauri uses filesystem +
`mls_bin_write_lock`). Tests: `hex.mlsVersion.test.ts` (8). `bun run check` clean; persister/services
tests green. Verifications V1 (welcome_request outside the locked drain), V2 (native push-decrypt is
ephemeral, no `mls.bin` write), V3 (ratchet tree exported post-merge - Option B makes merge-immediate
unnecessary) all confirmed against code.

**Piece A + Phase 1 (done + verified):** one staged commit regime (chosen Option B - unify ADD+REMOVE).
`runCommitTransaction(groupId, stageFn, opts)` in `BaseMlsService` is the single primitive behind
every structural commit: under the MLS lock it stages (no merge), reads the pre-merge epoch
(`freshEpoch`), `validateCommitEpoch`, then merges + broadcasts on accept (and exports the post-merge
ratchet tree for an ADD Welcome) or clears + throws on reject. The public verbs `addMember` /
`addMembersBulk` / `removeMember` / `removeMemberDevice` all funnel through it. `sendCommit` and the now
obsolete `commitBaseEpochForValidation` (+ its module/test) are deleted. Rust `add_members_bulk` /
`add_member` are stage-only (dropped the immediate merge + the tree from their return);
`export_ratchet_tree_for` added; internal merge-immediate callers (`bootstrap_dead_conversation`,
mobile `create_welcome_background`) merge explicitly after staging. WASM mirrors (add returns
`[commit, welcome, added, skipped]`, new `export_ratchet_tree`); native Tauri mirrors (`ajouter_membre`
retired, `ajouter_membres_bulk` 4-tuple, new `exporter_ratchet_tree` command). Call-sites migrated
(`actions.ts` pending/welcome-request, `groupCreation.ts` x3, `recovery.ts` reboot): the Welcome is now
sent only AFTER the commit is accepted, so a rejected ADD no longer delivers a Welcome to a forked
epoch and no longer triggers destructive fork recovery (benign retry instead). Result: root cause 2
closed - a server-rejected ADD never advances the local epoch. Tests: `cargo test` mls-core green
(new `pending_commit` ADD stage/abort cases), `cargo clippy` clean; `bun run check` clean; full vitest
474 green (call-site suites rewritten to the staged contract); `cargo check`/`clippy` src-tauri green.
Docs updated: `mls-protocol.md`, `MLS_DESYNC_PREVENTION.md` (tactic 4 rewritten), `ARCHITECTURE.md`.
No user-facing strings -> no i18n change.

**Piece C (done + verified):** epoch-monotonic reload invariant extended to the native path.
`MlsManager::reload_is_monotonic(&self, candidate)` in mls-core - the Rust mirror of the TS
`swapClientMonotonic`: refuse a reload when any live group would disappear or move to a lower epoch.
Applied in `recharger_mls_au_resume` (`src-tauri`): the foreground-resume reload from `mls.bin` now
compares the candidate against the live manager under the lock and keeps the live state (returns
`false`) on regression, instead of clobbering it unconditionally. This closes the native half of root
cause 1 (a stale `mls.bin` could previously lower a live group's epoch on resume). The two guards
(TS `swapClientMonotonic`, Rust `reload_is_monotonic`) are cross-referenced in comments and kept in
sync; the web path already had its guard from Phase 0. Tests: `reload_monotonic.rs` (3 - regress /
missing-group / equal). `cargo test` + `cargo clippy` mls-core green; `cargo check` src-tauri green;
`bun run check` clean. No user-facing strings -> no i18n change.

Phase 0 is now complete (Pieces A, B, C + the 3 verifications).

**Phase 2 (done + verified):** rung-1 replay backbone. New Postgres table `mls_commit_log`
`(groupId, baseEpoch)` unique + `commit` (base64) + entity/migration `007`, retention ~1 year +
per-group size cap (hourly `pruneExpiredCommitLog` cron). Decisions taken: (1) folded the commit
path into ONE atomic `POST /api/mls/commit` - the client sends the commit bytes with the validate
call (`submitCommit`), the server validates the epoch under the lock, stores `(groupId, baseEpoch,
commit)` atomically with the advance, then fans out via the existing `sendMessage` (retired the
separate /send-for-commits, `broadcastCommit`, and the dead `sendValidatedCommit`); (2) long
retention for maximum availability; (3) rung-1 replay now, rung-2 kept as fallback, trigger-merge
deferred to Phase 3. New `GET /api/mls/commits/:groupId?sinceEpoch=N` (membership-gated, returns
ordered commits + `activeEpoch` + `belowFloor`). Client: `attemptCommitReplay` (`commitReplay.ts`)
fetches + re-applies missed commits on an epoch gap in `setupMessageHandler`; only a below-floor or
unapplicable commit past the escalation threshold falls to the destructive rung-2 forget +
re-Welcome. This collapses clusters B/C for the common gap case (a device simply behind now replays
instead of dropping state), and makes the crash-between-submit-and-merge window recoverable.
Known edge (deferred): replaying THIS device's own commit after a crash-before-merge fails in OpenMLS
and degrades to rung-2; a persisted pending-commit would close it. Tests: `commitReplay.test.ts` (3),
`messaging.commit-log.spec.ts` (5, server), updated `setupMessageHandler.test.ts`; `bun run check`
clean, full vitest 477 green, server jest 34 green, chat-delivery `tsc` clean. Docs updated
(`mls-protocol.md`, `MLS_RECOVERY_LADDER.md` step 4, `MLS_DESYNC_PREVENTION.md`). Nginx unchanged
(`/api/mls/*` wildcard already routes the new GET). No user-facing strings -> no i18n change.

**Phase 3 (done + verified):** collapsed cluster A - the three redundant re-add triggers
(unknown-group 10 s buffer timer / `requestReAdd` 60 s self-rearming timer / SYNC_WATCHDOG 5 s poll)
are now ONE mechanism. Detection is separated from action behind a single seam, `requestReAdd`,
which Phase 4 will swap for a native external-commit self-join. Decisions taken: (1) the SYNC_WATCHDOG
is the SOLE cadence owner; (2) Phase 3 is detection-only - the welcome_request + reboot action stays
intact behind the seam. Changes: `requestReAdd` no longer arms a private timer - it is a one-shot
action that self-throttles via an in-memory cooldown (`lastReAddAt`, RECOVERY_TIMEOUT_MS) and folds
the escalation decision inline (reboot past the persistent wall-clock deadline, else one
welcome_request); the watchdog drives cadence by enumerating live conversations UNION the persistent
`mls_not_ready_since` registry (new `enumerateNotReadyGroups` - covers pre-conversation unknown
groups) and calling the seam every poll (the cooldown throttles). `handleUnknownGroup` drops its 10 s
timer and duplicated successor logic: on the first frame it fires the seam once (immediate
welcome_request) and buffers (buffer no longer carries a timer; dropped on Welcome, frames also stay
server-side as fallback). The STUCK_EPOCH_GAP watchdog branch (Phase 2 rung-1/rung-2) is untouched.
`cancelReAdd` now also clears the cooldown; `resetReAddCooldowns` is called at session setup.
Tests: `rebootDeadline.test.ts` (new, 4), rewritten `requestReAdd`/unknown-group cases;
`bun run check` clean, full vitest 481 green, ESLint clean. Client-only - no DB, no native, no
user-facing strings -> no i18n change.

**Phase 4a (done + verified):** native external-commit self-join added, legacy reboot/CAS kept as
fallback (the retirement is Phase 4b). openmls 0.8.1 confirmed at compile time: `export_group_info`
(with ratchet tree -> self-contained) + `join_by_external_commit` (returns a group already at base+1
with the commit staged; on epoch-reject the group is discarded and rebuilt from a fresher GroupInfo -
this self-service retry replaces the CAS). mls-core (`export_group_info`, `join_by_external_commit`)
+ WASM wrappers + native Tauri commands (`exporter_group_info`, `rejoindre_par_commit_externe`);
mobile background unchanged (push-decrypt is ephemeral, no re-add path). Server: new `mls_group_info`
table (latest GroupInfo per group) + entity/migration `008`; `GET`/`POST /api/mls/group-info/:groupId`
(membership-gated, monotonic write-if-newer by epoch). Client: `refreshGroupInfo` runs after every
accepted commit in `runCommitTransaction` (a new group's first member-add is itself a commit, so the
base always exists once the group has a peer); `externalJoin(groupId)` = fetch GroupInfo -> build
external commit -> `submitCommit` at the GroupInfo's base epoch (excluding own device) -> merge on
accept, or `forgetGroup` + retry with a fresher GroupInfo on reject. The recovery seam `requestReAdd`
tries `externalJoin` FIRST; the welcome_request + reboot path stays as the fallback for when no
GroupInfo is available (or the caller is not an authorized member). Tests: `external_join.rs` (2,
mls-core round-trip), `messaging.group-info.spec.ts` (7, server), `BaseMlsService.externalJoin.test.ts`
(5, orchestration/retry), recovery seam success/fallback. `bun run check` clean, full vitest 487 green,
server jest green, cargo test/clippy green across mls-core/mls-wasm/src-tauri. Nginx unchanged
(`/api/mls/*` wildcard). No user-facing strings -> no i18n change.

**Phase 4b (done + verified):** the successor/reboot machinery is fully retired - external join
(Phase 4a) is the sole self-service recovery, with welcome_request kept as a thin fallback for
groups that have no stored GroupInfo yet. Shipped as three green commits:
- **4b/1** (`c7004e92`): recovery.ts shrank ~950 -> ~230 lines. `requestReAdd` is now externalJoin ->
  welcome_request fallback (no reboot, no successor creation, no per-group timer). Deleted reboot /
  performReboot / joinSuccessor / inviteMembers / findAncestorWithMembers / checkGroupSuccessors /
  migrateConversation + REBOOT_DEADLINE_MS + rebootsInFlight. Manual-repair callers (groupCreation,
  useConversations) and the 5-min successor health-check (sessionWatchdogs/sessionAuth) rewired.
- **4b/2** (`cd7cf1cf`): removed successor RESOLUTION and the reboot-lock/CAS plumbing across client
  and server. Client: delete resolveTerminalGroup + isAncestorInLineage (call-sites - handleWelcome,
  discovery, welcome_request handler, outbox, DM dedup - use the group id directly); remove the dead
  acquireRebootLock / releaseRebootLock / claimGroupSuccessor / clearPendingWelcomeRequests plumbing.
  Server: drop the reboot-lock endpoints, the claimSuccessor CAS endpoint, the getUserGroups
  successor-chain resolution, the welcome_request successor redirect, and the
  successorId/successorClaimedByDeviceId columns.
- **4b/3** (this commit): migration `009` drops the two successor columns (the chains were already
  flattened - predecessors are deletedAt tombstones with members on the terminal, purged by the
  existing 90-day cron). Docs updated.

Data safety: no bespoke purge - the flatten was already done at claimSuccessor time; the column drop
is idempotent (`DROP COLUMN IF EXISTS`) and dev `synchronize` mirrors it.

**Phase 4c (dead-code sweep, done + verified):** removed the two inert residues left by Phases 1/4b.
(1) Fork detection - `parseForkedEpoch`/`isSenderForkError` (groupActions.ts) deleted; the staged-commit
regime never throws the `server epoch:.., sent:..` marker, so every caller branch (processPendingInvitations,
handleWelcomeRequest, kickStaleLeaf) was dead. `recoverForkedGroup` is KEPT - it is still driven live by
the STUCK_EPOCH_GAP watchdog branch; only the sessionAuth `makeRecoverForkedGroup` wiring into actions.ts
went away. (2) `successorId` residue - the server dropped the column in 4b, so every client `g.successorId`
was permanently null: deleted `resolveActiveGroupTarget`/`collectKnownSuccessorIds`, simplified
`findActiveDirectGroupForPeer` to `string | null`, dropped `isKnownSuccessor` from `decideAbsentGroupFate`,
collapsed the successor branches in `initializeConnection`/`setupMessageHandler`/`actions` discovery+pending,
removed `successorId` from `UserGroupRow`/`GroupMeta` (+ the API mappers), and dropped the now-orphaned
outbox `reassign`/`reassignOutboxConversation` (IStorage + sqlite + indexeddb) and `groupNotReadyForMs`
(both orphaned when 4b removed `migrateConversation`/the reboot deadline). Stale reboot/successor comments
across the recovery-flow files were corrected. Tests updated to the post-successor contract. Green gate:
`bun run check` 0 errors, vitest 465, ESLint clean, server jest 41. No Rust, no DB migration, no i18n
(TS + comments only).

**The MLS re-architecture (Phases 0-4) is complete.** Root causes 1 (epoch regression) and 2 (ADD/REMOVE
asymmetry) are closed; recovery is rung-1 commit replay + rung-2 self-service external join; the
reboot/CAS/successor machinery is gone.

**Follow-up (2026-07-07) - external-join UX gaps found in the 2-device validation.** The core desync
is fixed (no forks / forget / re-add loops; bidirectional messaging works; the fresh device self-joined
via external commit). Two gaps in the external-join path were then fixed:
- Bug 1: external join did not promote the conversation `lifecycle` to `active`, so the UI sat in
  "syncing" until a reload. Fixed in `recovery.ts` (external-join success) + `actions.ts`
  `discoverMissingGroups` (a group already present in the local WASM is created `active`).
- Bug 2: external join delivered no pre-join history (the history bundle only fired on the
  welcome_request / add path that external join bypasses; the joiner's catch-up cannot decrypt
  pre-join epochs). New `history_request` control frame mirrors the welcome_request transport
  (delivery `POST /api/mls/history-request` -> single online responder picked server-side, relayed
  via the gateway's generic `isWelcomeRequest` control flag, inner `type` drives behaviour) -> the
  member resends the shared `sendFullHistoryBundle` (history-only, no re-add); the joiner sends it
  after a successful external join. No gateway change. `handleHistoryRequest` guards to active local
  members. The two history mechanisms stay distinct and non-competing: self catch-up (decrypt what
  the current keys allow, for reconnection) vs peer history bundle (re-encrypt pre-join history for a
  newcomer, single shared sender, now triggered on both the external-join and welcome_request paths,
  which are mutually exclusive per join).
Gates green: `bun run check` (0 errors), vitest 468, chat-delivery `tsc` + jest 41.

## Phase 0 remaining - elaborated plan

**KEY INSIGHT:** the mls-lock critical section == the validate-then-merge unit (stage -> validate on
server -> merge/clear; nothing may interleave between stage and merge). So Phase 0.1 (lock discipline)
and Phase 1 (ADD -> validate-then-merge) COLLAPSE into one primitive - do them together.

- **Piece A - `runCommitTransaction(groupId, stageFn)`** on `IMlsService`: acquire mlsLock -> stage
  commit (add_members_bulk / remove WITHOUT merge) -> `POST /api/mls/commit` (validateCommit) ->
  accept: `merge_pending_commit` / reject: `clear_pending_commit` -> release. Network preamble stays
  UNLOCKED; only the commit tx is locked. Rust: make `add_members_bulk` stage-only (remove the
  immediate merge at `mls-core/src/lib.rs:740-742`) and export the ratchet tree from the STAGED commit
  (or reconstruct server-side at fanout) so removing merge-immediate does not break joins. merge/clear
  already exposed (`mls-wasm/src/lib.rs:497-507`). Migrate `actions.ts` call-sites:
  `handleWelcomeRequest`, `processPendingInvitations`, `kickStaleLeaf`. Touches mls-wasm + mls-core,
  `{Web,Tauri,Base}MlsService.ts`, `actions.ts`, `mlsDesyncPrevention.ts`.
- **Piece B - versioned persistence (write-if-newer):** monotonic local counter bumped per mutation,
  persisted beside the blob; `saveMlsStateEncrypted` becomes an IDB read-modify-write that only writes
  if `version > stored`. No plaintext groupId/epoch at rest (privacy). Files: `utils/hex.ts`,
  `mlsStatePersister.ts`. Web-only concern (Tauri persists to filesystem, not browser IDB; web
  tab-leader is a single writer).
- **Piece C - Rust-core invariant + native (strictest, mobile):** shared
  `fn reload_is_monotonic(current, candidate) -> bool` in mls-core used by WASM AND native; mirror
  `swapClientMonotonic` in `TauriMlsService.ts`; apply the guard at every native background
  reload/persist site (`src-tauri` + native core).

**3 verifications before coding:** (1) `welcome_request` dispatch is OUTSIDE the locked drain (else
`runCommitTransaction` deadlocks - the mutex is non-reentrant) - read
`setupMessageHandler`/`systemMessageHandler`; (2) native reload/persist path - does background
push-decrypt persist state back? (believed read-only/ephemeral - verify `src-tauri/src/lib.rs`);
(3) openmls 0.8.1 can export the ratchet tree from a staged commit.

**Order next:** Piece B -> the 3 verifs -> Piece A (the big one) -> Piece C. Tests: B = IDB
write-if-newer skips stale; A = interleave KP-gen + addMember asserts no regression +
`recoveryLadder.contract` / `desyncPrevention.contract` green + `cargo test` mls-core stage-only;
C = `cargo test reload_is_monotonic` + native smoke. NO server DB migration in Phase 0 (migrations
land Phase 2 commit-log + Phase 4 GroupInfo). Zero UI change in Phase 0.

## Standing constraints for every phase

- Integrate DB migrations, the frontend/UI/backend link, and the Android/Apple native paths in each
  relevant phase.
- Project rules: no fallbacks (fix the root), English comments, ASCII text (straight quotes/hyphens,
  keep the ellipsis char), update wiki + Paraglide FR/EN i18n + tests as part of each change, work on
  `main`, clean `apps/*/dist` before push (the pre-push hook replays compiled specs), and the frontend
  pre-commit hook re-stages ALL dirty frontend (isolate unrelated WIP before committing).
