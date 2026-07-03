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
