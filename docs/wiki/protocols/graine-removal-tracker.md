# Graine rotates on a departure, not on every epoch - design (2026-10-22)

**Status: DESIGN ONLY, nothing is built. Revised 2026-10-22 after its opus review (REVISE; the core held: a clean run keyed on the epoch authenticator, rotation on any gap). It is reviewed (opus) before any native code, and each
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
- **An update that keeps the pair is not a departure. An update that changes it is.** A path update
  or an Update proposal that keeps the leaf's `(identity, signature_key)` changes only encryption
  keys. One that changes the identity or the signature key removes the old pair from the tree, so the
  summary reports it as `removed`, unless WP1 proves that Canari's validation refuses such an update
  before it is merged.
- **An external commit's Remove of somebody else's leaf is a departure.** The self-replacement rule
  covers only leaves that carry the JOINER's own pair. Any other leaf an external commit removes is
  reported as removed. WP1 either proves that such a commit is refused, or shows that it resets the
  run.

WP1's tests cover every shape:
- a Remove by reference proposed by a non-committer;
- a SelfRemove;
- ReInit;
- GroupContextExtensions;
- an Add and a Remove of different leaves in one commit;
- an external commit's own Remove, and an external commit that removes another leaf;
- an Update or path update that keeps the pair, and one that changes it;
- several Removes in one commit;
- a batch with a departure in the middle, applied in order.

**The batch API returns EVERY summary, in order, never only the last one.** A batch that returned
only its last summary would hide a departure in its middle.

### 3. The tracker: one clean run per key group

The tracker is held in Graine storage, not in the MLS state, one row per key group:

```text
GraineRemovalRun { groupId, runId, observedEpoch, observedAuthenticator }
```

The authenticators, both the tracker's and the session's below, are stored in the SEALED half of
the Graine row (`graineCodec.ts`), never in its clear columns.

`runId` names the current **clean run**: a chain of epochs, every transition of which was observed
through a summary and none of which was a departure. The tracker applies each summary in order:

| Event | Effect |
| --- | --- |
| A summary whose `authenticator_before` equals `observedAuthenticator`, with no departure | the run continues: `observedEpoch` and `observedAuthenticator` take the `_after` values |
| A summary with a departure | a NEW `runId`, with the `_after` values |
| A summary whose `authenticator_before` is not `observedAuthenticator` (a gap: some path moved the epoch without a summary) | a NEW `runId`, with the `_after` values |
| An install (a Welcome, an external join, or the creation of the group) | a NEW `runId` |
| A first summary when there is no row | a NEW `runId`, with the `_after` values |
| No row, and no summary yet | no run: every session rotates exactly as today |

Two new optional fields go on `StoredGraineSession` (`frontend/src/lib/db/types.ts:275-329`):

- **`mintAuthenticator`**, the epoch authenticator at the mint. Every session stores it.
- **`runId`**, the tracker's run at the mint. A session gets it only when the tracker is CURRENT at
  the mint, that is when the current authenticator equals `observedAuthenticator`. A session minted
  while the tracker is stale gets no `runId`, so it can never be reused across an epoch move.

The predicate compares AUTHENTICATORS in both branches, never epoch numbers alone:

- **Same epoch as the mint:** reuse only if the current authenticator equals
  `session.mintAuthenticator`. This closes an aliasing that today's rule has
  (`sessionManager.ts:108`, `distributionEpoch !==`). A group re-bootstrapped without a departed
  device can reach the session's epoch NUMBER again, and an equality on numbers then reuses the seed
  that the excluded leaf holds. A re-bootstrapped instance has a different authenticator at the same
  number.
- **Epoch moved:** reuse only if ALL of these hold:
  - `session.runId === tracker.runId`;
  - the current epoch and authenticator equal the tracker's observed ones;
  - the community's history visibility is `shared`.
- **Otherwise:** rotate.
- **The size and age caps:**
  - A session that has never been reused across an epoch move keeps today's caps: 100 messages and
    7 days.
  - A REUSED session, one re-distributed at least once, has tighter caps: 50 messages and 24 hours
    from its mint. See the residual below.
- The other two triggers are unchanged: no frame, and no v2 secret.

A run id is used instead of an epoch range (`cleanFrom..observedTo`) because a range compares epoch
NUMBERS, which alias across group instances. A run id cannot alias: any reset mints a new one.

**`joined` keeps rotate-on-add.** In a `joined` community, a newcomer must not open what was sent
before it arrived. Section 4 hands it the seed of the current session, and a seed opens EVERY index of
its session (`deriveMessageKey`: each index is derived from the seed, not ratcheted,
`crypto/graine.ts:49-65`). So `joined` keeps rotating on any epoch change. No production community
uses `joined` today (16 of 16 are `shared`).

**The visibility comes from the server, and so does the trust it carries.** A server that flips a
`joined` community to `shared` turns reuse on. A newcomer then opens the pre-arrival messages of the
current session, since `firstIndex` is 0 and every key is derived from the seed. This is the same
trust the history bundle already places in the server, which also decides from that setting whether
a whole history is sent.

The rule "a newcomer reads nothing from before it arrived" (the P1 decided on 2026-10-21) applies to
GROUP CONVERSATIONS, not to communities. **If it is ever extended to communities, reuse across an
Add must stop**, because that reuse is exactly a newcomer receiving a seed whose earlier indices it
can open.

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

## The named residual: a stolen seed lives longer (accepted 2026-10-22)

**Rotate-on-add bounded a stolen copy of the Graine store without anyone intending it.** On
production a session lived about two messages, because the next Add replaced it. A copy of a device's
seeds, taken without removing its leaf (a backup, a debug dump, a briefly borrowed unlocked phone),
was therefore worth almost nothing a few messages later. Reuse removes that accident. A seed now
lives until a departure or a cap. Key-group leaves never self-update (see the backlog P3 on the
109-seat group conversation), so nothing else shortens its life.

**Accepted by Master on 2026-10-22, under the user's mandate on MLS robustness, with the caps as the
stated bound.** The caps of a reused session are tightened so that the bound is a day and not a week.
The measurement behind them was taken on production, read-only, on 2026-10-22: 1,667 salon messages
in the last 30 days, counted per (salon, sender).

| Per (salon, sender) | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| messages in one week | 3 | 13 | 55 | 79 |
| messages in one day | 2 | 10 | 38 | 58 |

- **24 hours.** With it, a sender uses about one session per salon per active DAY. That is about
  387 sender-days in the 30 days, against about 830 sessions under rotate-on-add (one per two
  messages), so most of the saving survives. The exposure of a stolen copy drops from a week to a day.
- **50 messages.** This is above the p99 day (38), so the message cap almost never forces a rotation
  before the 24 hours do. It bounds a burst all the same.
- **A session that was never re-distributed keeps 100 messages and 7 days.** It has been live through
  no Add, so it carries no new exposure.

These numbers are re-measured with the same query after the stable (verification reading 6). If the
seed count does not come down, the 24 hours are the first thing to revisit, not the residual.

## The fail-safe argument

The new rule can only be WRONG in one direction: reusing a seed that a departed leaf holds. That
requires a departure between the mint and the send that the tracker did not see. Every way of not
seeing one ends the run:

- **A path that merges without a summary.** This covers the native background paths, which persist
  `mls.bin` outside TS:
  - the Add merge of the background Welcome (`install_staged_welcome` in `mobile/background.rs`,
    reached from the Kotlin `processWelcomeRequestBackground` only once the server accepted the
    commit; iOS has no such path since 2026-10-22);
  - the background Welcome install (`process_welcome_background_with_key` in `background.rs`, `canari_native_process_welcome_background`).

  The next summary's `authenticator_before` will not match, so the next send rotates. That is
  today's behaviour.

  **The invariant this rests on: a native background path is fail-safe only while it never processes
  a Remove without telling the tracker.** The paths that persist today process an Add (the Welcome a
  backgrounded phone creates) or an install. Either one moves the epoch unobserved, which ends the
  run. A future background path that processes a Remove would have to do one of two things:
  - feed its summaries to the tracker, in order;
  - leave the epoch moved unobserved, which is what ends the run today.

  Anything else is a change to this design. The Mi 9T reading includes a Remove that arrives while
  the app is killed (reading 4).
- **Which MLS instance, and which writer.** The predicate reads the epoch and the authenticator from
  the SAME MLS instance that then seals the re-distributed frame, in one step of the per-sender chain.
  A reload between the read and the seal is therefore impossible to miss. On the web, only the tab
  leader (`tabLeader.ts`) processes commits, so only the leader writes the tracker. A follower reads
  it and never writes it.
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
| WP1 | `mls-core` (Rust) | `CommitSummary`, the departure predicate (section 2), the new summary-returning functions beside the existing ones (a batch returns every summary, in order), the epoch authenticator accessor; tests per shape | M |
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

1. **WP1:** `cargo test` in `mls-core`. It covers:
   - one case per shape in section 2, including the batch with a departure in its middle;
   - a cross-version case: the existing `process_incoming_message` output is unchanged.
2. **WP4, TS kill points:**
   - a kill after the tracker write and before the MLS checkpoint;
   - a kill after the checkpoint and before the tracker write.

   Each must rotate at the next send, never reuse.
3. **Web (local rig, W1, W2 and W3):**
   - **Join.** In a community, W2 joins between two sends of W1. W1 logs a reuse
     (`[GRAINE] reused session ... across epoch a->b run r`) and a re-distribution, never a new
     session. W2 opens W1's next message from the re-distributed frame.
   - **Revocation.** W2's device is then revoked. W1's next send logs
     `[GRAINE] run reset reason=departure` and a new session.
   - **The lost-phone case, exactly.** Between two sends of W1, W3 is added, used (it receives the
     seed), and then revoked. W1's second send must log a reset and a new session.
4. **Mi 9T and iPhone:**
   - the join and revocation readings in the foreground;
   - a background Welcome while the app is killed, then a send after it reopens. It must log
     `run reset reason=gap`, then a new session;
   - a Remove that arrives while the app is killed, then a send after it reopens. It must rotate.
5. **A re-bootstrap to the same epoch (local estate).** A key group is reset and rebuilt without one
   device until it reaches the epoch number of a session minted before the reset. That session must
   NOT be reused: its `mintAuthenticator` differs.
6. **Production, after a stable:** the seeds-per-message ratio, re-run with the query of 2026-10-21,
   and the per-sender rates of the residual section, re-run with their query. The ratio should
   return toward "senders x days". If it does not, a summary path is missing; the gap resets would
   show it.

The tracker's log lines are part of WP4. Each reset names its reason (`departure`, `gap`, `install`,
`none`), and each reuse names its run, so that a reading can tell the causes apart.
