# Graine rotates on a departure, not on every epoch - design (2026-10-22)

**Status: DESIGN ONLY, nothing is built. It is reviewed (opus) before any native code, and each
platform's code then goes to its own opus agent.** It answers the P2
[Graine rotates on every key-group epoch](../backlog.md#p2---graine-rotates-on-every-key-group-epoch-so-a-growing-community-mints-a-seed-per-message-measured-2026-10-21).
The measurement and the comparison with DMs are in
[dm-vs-community-encryption](dm-vs-community-encryption.md#communities).

## The problem, and why the identity-set check is not enough

`shouldRotateGraineSession` (`frontend/src/lib/utils/graine/sessionManager.ts:102-116`) mints a new
seed whenever the key group's epoch differs from the session's mint epoch. Every device that joins a
key group commits, so on production most rotations are Adds: one session per two messages
(2026-10-21). A rotation exists to keep a device that LEFT from reading what is sent after it left.
An Add does not need one.

The first proposal compared the leaf identity set recorded at mint with the current tree. Master
refused it on 2026-10-22, because it has a soundness gap in a key-rotation rule. A leaf that is added
and then removed between two sends is in neither set. That leaf held the seed, through the history
bundle or a repair. This is the realistic lost-phone case: the phone is added, used, lost, then
revoked. **A rotation rule has to see every commit between the mint and the send, or it must rotate.**

## The design

### 1. A summary of every processed commit, from `mls-core`

Today nothing surfaces what a commit contained, at any layer:

- `process_incoming_on_group` merges a `StagedCommitMessage` and returns `Ok(None)`
  (`frontend/mls-core/src/messaging.rs:386-407`);
- `merge_pending_commit_for` returns `()` (`members.rs:209-219`);
- the TS pipeline learns only that the epoch moved.

`mls-core` gains a summary built from the `StagedCommit` before it is merged:

```text
CommitSummary {
  epoch_before, epoch_after,
  authenticator_before, authenticator_after,     // openmls epoch authenticators
  removed: [{ identity: "userId:deviceId", signature_key }],
  added:   [{ identity, signature_key }],        // Add proposals + an external committer's own leaf
}
```

- **It is returned by NEW functions, and the existing signatures stay.**
  `process_incoming_message` is compiled against by `mls-cross-version` (`messaging.rs:117-120`), so
  it does not change.
- **One summary is produced per merge path:**
  - a received commit (single and batch);
  - our own commit (`merge_pending_commit_for`);
  - an external join (`join_by_external_commit`);
  - a Welcome install (`process_welcome`). A Welcome yields an install event (`epoch_after` and
    `authenticator_after` only), because the device saw nothing before it.
- **Why the authenticator.** An epoch number does not identify a group instance: a re-bootstrapped
  group restarts at 0. The epoch authenticator does identify it. It is what lets the tracker tell
  "the next epoch of the chain I saw" apart from "an epoch I did not see that has the same number".

### 2. A departure, defined

A commit is a **departure** when it removes a leaf whose `(identity, signature_key)` pair is not
re-added by the same commit.

- **An external rejoin is not a departure.** An external join removes every leaf that carries the
  joiner's signature key ([state machine](mls-graine-state-machine.md),
  [§22.2](channel-encryption.md#222-a-key-group-held-with-its-own-leaf-removed-is-not-held---fixed-2026-09-29)),
  so a device rejoining by external commit both removes and re-adds its own `(identity, key)`. The
  key material that held the seed is the same, and it is still a member.
- **A removal always rotates unless BOTH halves of the pair come back.** The same signature key
  re-added under a different identity is a departure, as is the same identity re-added under a
  different key.
- **A reinstalled device is a departure.** It keeps its device id but has a new signature key, so the
  pair differs.
- **A lost phone replaced by a new one is a departure.** It has a new device id.
- **A leaf update (a path update) is not a removal.**

### 3. The tracker: one clean run per key group

The tracker is held in Graine storage, not in the MLS state, one row per key group:

```text
GraineRemovalRun { groupId, runId, observedEpoch, observedAuthenticator }
```

`runId` names the current **clean run**: a chain of epochs, every transition of which was observed
through a summary and none of which was a departure. The tracker applies each summary in order:

| Event | Effect |
| --- | --- |
| A summary whose `authenticator_before` equals `observedAuthenticator`, with no departure | the run continues: `observedEpoch` and `observedAuthenticator` take the `_after` values |
| A summary with a departure | a NEW `runId`, with the `_after` values |
| A summary whose `authenticator_before` is not `observedAuthenticator` (a gap: some path moved the epoch without a summary) | a NEW `runId`, with the `_after` values |
| An install (a Welcome, an external join, or the creation of the group) | a NEW `runId` |
| No row | no run: every session rotates exactly as today |

A session minted inside a run records that `runId` (a new optional field of `StoredGraineSession`,
`frontend/src/lib/db/types.ts:275-329`). The predicate becomes:

- **Same epoch as the mint:** reuse, as today.
- **Epoch moved:** reuse only if ALL of these hold:
  - `session.runId === tracker.runId`;
  - the current epoch and authenticator equal the tracker's observed ones;
  - the community's history visibility is `shared`.
- **Otherwise:** rotate.
- The four other triggers are unchanged: no frame, no v2 secret, 100 messages, 7 days.

A run id is used instead of an epoch range (`cleanFrom..observedTo`) because a range compares epoch
NUMBERS, which alias across group instances. A run id cannot alias: any reset mints a new one.

**`joined` keeps rotate-on-add.** In a `joined` community, a newcomer must not open what was sent
before it arrived. Section 4 hands it the seed of the current session, and a seed opens EVERY index of
its session (`deriveMessageKey`: each index is derived from the seed, not ratcheted,
`crypto/graine.ts:49-65`). So `joined` keeps rotating on any epoch change. No production community
uses `joined` today (16 of 16 are `shared`).

### 4. Reuse across an Add re-distributes the same seed

**This is what an Add still costs, and it is not optional.** A newcomer reads its first message
because the Add rotated the sender's session, and the new seed's distribution frame travels on the
message itself ([§19](channel-encryption.md#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27),
[§20](channel-encryption.md#20-whoever-admits-a-newcomer-welcomes-them---decided-by-the-user-2026-09-27)).
That frame is an MLS message sealed at the MINT epoch, so a device added later cannot open it. A
reused session therefore distributes its existing seed again, at the current epoch:

- the same `sessionId`, seed, `firstIndex` and v2 endorsement;
- a new `distributionFrame`, and `distributionEpoch` set to the current epoch.

Receivers that already hold the session answer `already-held` (`frameHandler.ts:95-123`). The format
and every receiver are unchanged.

What this saves is the SEED count, which is what the history bundle and the 8000-seed cap grow with.
It does not save the distribution frame per Add. Addressing the re-distribution to the added devices
only is a later option: Graine's addressed answers already exist
([§23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).
It is left out of this design so that the first step changes no routing.

## The fail-safe argument

The new rule can only be WRONG in one direction: reusing a seed that a departed leaf holds. That
requires a departure between the mint and the send that the tracker did not see. Every way of not
seeing one ends the run:

- **A path that merges without a summary.** This covers the native background paths, which persist
  `mls.bin` outside TS:
  - the Add merge of the background Welcome (`mobile/background.rs:348-402`, the Kotlin
    `processWelcomeRequestBackground`, the iOS `canari_native_create_welcome_background`);
  - the background Welcome install (`background.rs:406-446`, `canari_native_process_welcome_background`).

  The next summary's `authenticator_before` will not match, so the next send rotates. That is
  today's behaviour.
- **A tracker written but an MLS state not checkpointed, or the reverse.** After a reload, the
  authenticators disagree, which is a gap, so the next send rotates.
- **A re-bootstrapped or reinstalled group.** Its install event, or its first summary, does not
  continue the chain.
- **A lost tracker row.** No row means no run, so the next send rotates.

The only way left to reuse wrongly is a summary that misreports a commit. The summary is built in
Rust from the `StagedCommit` openmls is about to merge, so it is tested there (WP1) against every
proposal shape:

- a Remove by reference;
- an external commit's own Remove;
- a self-update;
- several Removes in one commit.

**No wire change, no protocol change, no server change.** The summary and the tracker are local. The
re-distribution is an existing frame carrying an existing session. A client without this work rotates
exactly as today, and both kinds of client read each other's frames.

## Work packages

Each work package is a DRAFT pull request with an opus review before it is marked ready. The native
ones go to an opus agent each.

| WP | Where | What | Size |
| --- | --- | --- | --- |
| WP1 | `mls-core` (Rust) | `CommitSummary`, the departure predicate, the new summary-returning functions beside the existing ones, the epoch authenticator accessor; unit tests per proposal shape | M |
| WP2 | `mls-wasm` + `WebMlsService` | export the summary-returning process, batch and merge; surface the summary to TS | S |
| WP3 | Tauri (`commands/mls.rs`, `state.rs`) + `TauriMlsService` | the same for `recevoir_message_bytes`, `decrypt_messages_batch` and `confirmer_commit`. This covers desktop, the Android foreground and the iOS foreground; the background paths stay untouched (fail-safe) | S-M |
| WP4 | TS: the tracker + Graine storage (`sqlite.ts`, `indexeddb.ts`, `graineCodec.ts`, `types.ts`) | `GraineRemovalRun` persisted; the summary fed in at the key-group choke points (`routeDistributionFrame`, `stepDistributionGroup`, `catchUpDistributionGroup`, `attemptCommitReplay`, `runCommitTransaction`, `externalJoin`, Welcome install); `runId` on minted sessions | M |
| WP5 | TS: `sessionManager.ts` | the new predicate (shared only) and the re-distribution of a reused session after an epoch move | S |

WP1 comes first. WP2 and WP3 follow it, independently of each other. WP4 needs WP2 and WP3, and WP5
needs WP4. **WP4 touches storage files of the MLS persistence work owned by another session, so it
says which files before it starts.** Graine sessions gain one optional field, `runId`, and storage
gains one new table/store. A reader that predates the field ignores it, and rotates.

## Verification - what a compile does not prove

Every native WP is verified by compiling, which proves nothing about running. The readings owed:

1. **WP1:** `cargo test` in `mls-core`, one case per proposal shape, plus a cross-version case: the
   existing `process_incoming_message` output is unchanged.
2. **Web (local rig, W1 and W2):**
   - A community where W2 joins between two sends of W1. W1 logs a reuse
     (`[GRAINE] reused session ... across epoch a->b run r`) and a re-distribution, never a new
     session. W2 opens W1's next message from the re-distributed frame.
   - Then W2's device is revoked. W1's next send logs `[GRAINE] run reset reason=departure` and a
     new session.
3. **Mi 9T and iPhone:**
   - the same two readings in the foreground;
   - a background Welcome while the app is killed, then a send after it reopens. It must log
     `run reset reason=gap`, then a new session.
4. **Production, after a stable:** the seeds-per-message ratio, re-run with the query of 2026-10-21.
   It should return toward "senders x weeks". If it does not, a summary path is missing (the gap
   resets would show it).

The tracker's log lines are part of WP4. Each reset names its reason (`departure`, `gap`, `install`,
`none`), and each reuse names its run, so that a reading can tell the causes apart.
