# Graine rotates on a removal or a new user, not on every epoch (2026-10-22)

**Status: BUILT (draft pull request, 2026-10-22), not shipped.** The first draft of this page
(#2242: a TypeScript tracker in Graine storage fed by a commit summary at seven call sites) was
reviewed adversarially before any code, and two of its findings changed the design: the tracker
moved INTO `mls-core`, persisted in the MLS state, and the departure is "any removal" rather than "a
pair that did not come back". A third change came from the lead's threat-model review the same day:
a new USER still rotates. What was built is what this page describes; the review is
[below](#the-adversarial-review-of-the-first-draft-and-what-it-changed).

It answers the P2
[Graine rotates on every key-group epoch](../backlog.md#p2---graine-rotates-on-every-key-group-epoch-so-a-growing-community-mints-a-seed-per-message-measured-2026-10-21).
The measurement and the comparison with DMs are in
[dm-vs-community-encryption](dm-vs-community-encryption.md#communities).

## The problem, and why the identity-set check is not enough

Until this change the outbound rotation minted a new seed whenever the key group's epoch differed
from the session's mint epoch. Every device that joins a key group commits, so on production most
rotations were Adds: one session per two messages (2026-10-21). A rotation exists to keep a device
that LEFT from reading what is sent after it left. An Add of a device of somebody already present
does not need one.

The first proposal compared the leaf identity set recorded at mint with the current tree. Master
refused it on 2026-10-22: a leaf that is added and then removed between two sends is in neither set,
and that leaf held the seed, through the history bundle or a repair. This is the realistic lost-phone
case: the phone is added, used, lost, then revoked. **A rotation rule has to see every commit between
the mint and the send, or it must rotate.**

## The design, as built

### 1. A clean run per group, kept by `mls-core` in the MLS state

`frontend/mls-core/src/graine_run.rs`. Each group has at most one **run**:

```text
GraineRun { run_id (random 128 bits, hex), epoch_fingerprint }
```

A run names a chain of epochs of ONE group instance, every transition of which this manager merged
itself, none of which removed a leaf or brought in a new user. It is the durable, LOCAL record "no
removal was applied since": written by each device for itself, at its own merge, never shared.

- **Where it is written.** Every epoch transition of a group instance goes through one of two
  functions of this crate: a received commit (`process_incoming_on_group`, used by the single and the
  batch path) and our own commit (`merge_pending_commit_for`, which is now
  `merge_pending_commit_with_summary` with the summary dropped). Both read the tree and the staged
  commit BEFORE the merge, merge, and apply the summary to the run. This holds on every platform and
  in every process, the native background paths included, because they all run this crate.
- **Where it is kept.** `PersistedState.graine_runs`, `#[serde(default)]`, serialised in the same
  `mls.bin` by the same checkpoint as the tree it describes. "Tracker written, MLS state not" and its
  reverse cannot exist, so the kill-point readings of the first draft are gone with it.
- **What is compared.** An `epoch_fingerprint`: SHA-256 over a domain label, the group id, the epoch
  number and the epoch authenticator. The authenticator itself never leaves the crate; it is a secret
  meant for out-of-band comparison (RFC 9420 section 8.7). Two instances of one group at the same
  epoch NUMBER (a re-bootstrapped key group) have different fingerprints.
- **How it is read.** `MlsManager::graine_run(group_id)` (WASM `graine_run`, Tauri command
  `graine_run`, `IMlsService.graineRun`) returns `{ runId, epoch, epochFingerprint }` for the CURRENT
  epoch. A run whose fingerprint is not the current one (the group was moved by something that is
  not a merge here: a Welcome, an external join, a reload) is replaced on the spot by a new run that
  starts now. That is sound: a run claims nothing about what happened before it started, and a
  session minted under the old run carries the old id, so it cannot match.
- `forget_group` drops the group's run.

### 2. What ends a run

The summary of one merge (`CommitSummary`) is built from the staged commit and from the tree on both
sides of the merge. The run continues only when the commit started exactly where the run ended AND
none of these holds:

| Cause | Read from | Log |
| --- | --- | --- |
| The commit carried any Remove proposal - an external commit's removal of the joiner's OWN old leaf included | `StagedCommit::remove_proposals()`, before the merge | `run reset reason=departure` |
| A `(credential, signature key)` pair is in the tree before the merge and not after it - whatever removed it (an update that swaps a key or a credential needs no Remove proposal) | a counted diff of the two trees | `reason=departure` |
| An ADDED leaf of a NEW USER - the user its own credential names, read by device trust's `canonical_user_of` (ASCII-lowercased; a `user:device` or a legacy bare `user` credential names its user), had no leaf before the commit; a credential naming no user counts as new. The same for an Add and an external commit | the same diff | `reason=new-user` |
| The commit started from another epoch than the run's last one | `fingerprint_before` | `reason=gap` |
| No run existed | - | `reason=none` |

**A device that leaves and comes back ends the run, whatever it comes back as** (lead amendment (a),
2026-10-22). A same-key external rejoin removes the old leaf and adds a leaf with the same pair, so
the trees before and after look the same at that seat; the Remove proposal is what the run reads.
`mls-core/tests/graine_run.rs::an_external_rejoin_with_the_same_key_still_ends_the_run` pins it. The
price: external re-joins of known identities still rotate.

**A new USER rotates; a new DEVICE of a user already present does not** (lead amendment (b),
**decided by the user on 2026-10-22, D5**). ONE rule in ONE place:
`ROTATE_ON_NEW_USER` in `graine_run.rs`. The reason: each message key is derived from the seed, not
ratcheted, so a newcomer handed a seed minted before it arrived can derive every earlier index, and
the floor that hides them is enforced only by an honest client. Rotating on a new user keeps what a
newcomer can open to what was sealed after it arrived, under EITHER history setting. A new device of
a present user opens nothing that user's other devices could not already open, and device joins are
the measured bulk of the rotations. Turning the constant to `false` makes every Add continue the
run; nothing else reads it.

**The same rule holds for an external commit (decided under D5, 2026-10-22).** Key groups are joined
by external commit: a leaf naming a user who already has a leaf continues the run, a leaf naming a
user with none - or naming no user at all - ends it. The user is read from the leaf's own
credential by device trust's one reader, `canonical_user_of`: a `user:device` or a legacy bare
`user` credential ([legacy-compatibility](../legacy-compatibility.md)) names its user, anything else
names nobody. It is never read from server input; the server separately checks that the leaf names the caller
(`readCommitFrame` + `validateCommit`, `commit_identity_mismatch`).

**A batch applies every commit in order**, one merge at a time, so a departure in its middle ends
the run even when Adds follow it (`a_batch_with_a_departure_in_its_middle_...`).

**A summary that cannot be built never fails the merge.** The epoch has already moved; the run is
DROPPED instead (`observe_merge`, an ERROR line), which is the fail-safe direction. The JOINER of an
external commit never reaches that line: openmls 0.9 merges the commit inside `finalize`, so its
`merge_pending_commit_for` finds nothing pending and logs at debug, and its run starts at its first
read (`the_joiners_merge_of_its_own_external_commit_is_a_no_op_not_a_dropped_run`).

### 3. The outbound verdict

`graineOutboundVerdict(session, { run, now })` in `sessionManager.ts` replaces
`shouldRotateGraineSession`. Every session this device mints carries a sealed
`rotationAnchor = { runId, epochFingerprint, redistributed }` (`graineCodec.ts`, never a clear column):

| Verdict | When |
| --- | --- |
| `rotate` | no session; no anchor (minted before this change: one rotation per channel and sender, once); no frame; no v2 secret; a cap reached |
| `reuse` | `anchor.epochFingerprint === run.epochFingerprint`: the epoch it was last distributed at |
| `redistribute` | the epoch moved and `anchor.runId === run.runId`, and the session is within the REUSED caps |
| `rotate` | anything else: the run changed (removal, new user, gap) |

**The history setting is NOT an input.** The first draft reused only in `shared` communities and kept
rotate-on-add in `joined`. With the new-user rule a newcomer never receives a pre-arrival seed in
either setting, and the setting is the server's word: dropping it removes a server input from a
key-rotation decision.

**The caps.** A session never re-distributed keeps 100 messages and 7 days. A re-distributed one
(`anchor.redistributed`) has 50 messages and 24 hours FROM ITS MINT, and a session already past those
rotates instead of being re-distributed.

### 4. A reused session re-distributes the same seed

**This is what an Add still costs, and it is not optional.** A newcomer device reads its first
message because the seed's distribution frame travels on the message
([§19](channel-encryption.md#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27)),
and that frame is an MLS message sealed at an epoch the device was not in. So `redistribute` sends
the SAME session again at the current epoch - same `sessionId`, seed, `firstIndex` and v2
endorsement, a new `distributionFrame`, `distributionEpoch` set to the current epoch - distributed
BEFORE it is persisted, like a mint. Receivers that hold it answer `already-held`
(`frameHandler.ts`); the format and every receiver are unchanged. The log is
`[GRAINE] reused session <id> ... across epoch a->b run r, re-distributed`.

What this saves is the SEED count, which the history bundle and the 8 000-seed cap grow with. It does
not save the frame per Add. Addressing the re-distribution to the added devices only is a later
option ([§23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).

### 5. Against a compromised server: neutral

The change neither helps nor hurts against a server that controls the tree's membership: a device it
injects is a leaf, so it receives every future seed either way (a rotation on its join HANDS it a
fresh seed), and its access to the past comes from the history paths, not from rotation. An injected
NEW USER still rotates (new-user rule), and a removal it cannot hide from this device's own merges
still ends the run.

Seeds rotate on a removal or a new user; see the [backlog](../backlog.md) for the rotation policy.

## The adversarial review of the first draft, and what it changed

Each finding names what was wrong with the draft, or what still holds and why.

1. **The tracker belonged in the MLS state, not in Graine storage (DESIGN CHANGED).** The draft fed a
   TypeScript tracker from seven call sites and stored it in a second durable slot. Every missed call
   site was a gap (fail-safe, but a lost saving), and two durable slots needed the two kill-point
   readings. Every merge already goes through two functions of `mls-core`, on every platform and in
   the native background paths; the run is now written there and persisted in the same blob as the
   tree. The draft's WP2/WP3/WP4 summary plumbing is not needed; the summary exists in Rust only.
2. **The authenticator was to be stored outside MLS (CHANGED).** It is an MLS secret meant for
   out-of-band comparison. Only a domain-separated hash of it leaves the crate, and the session keeps
   it in the sealed half of its row.
3. **"A pair that comes back is no departure" was blind to a leave-and-return (CHANGED, lead amendment
   (a)).** Any Remove proposal now ends the run, whatever came back in the same commit.
4. **A newcomer under `joined` would have been handed a pre-arrival seed (CHANGED, lead amendment
   (b)).** The draft relied on `joined` keeping rotate-on-add and on the server's word for the
   setting. A new user now rotates in every community, and the setting is no longer read.
5. **A leaf added and removed between two sends (HOLDS).** Both commits are merged here, the Remove
   ends the run (`a_device_added_then_removed_between_two_reads_ends_the_run`).
6. **A removal applied while offline (HOLDS).** The catch-up applies the missed commits one by one
   through the same functions, single or batch; a device too far behind re-joins, which is a new
   group instance, hence a new run.
7. **A commit received out of order (HOLDS).** MLS refuses it (the epoch-gap fast-fail or a past
   epoch); nothing is merged, so nothing is observed.
8. **A returning device and multiple devices of one user (HOLDS).** A leaf is a device
   (`userId:deviceId`): removing one device of a user who keeps another is a departure
   (`removing_one_device_of_a_user_who_keeps_another_is_a_departure`); a reinstall comes back under
   a new key and its old leaf's removal is a departure (`a_rejoin_under_a_new_key_is_a_departure`).
9. **A restore or a downgrade (depends on queue item 9a).** A restored `mls.bin` carries the run as
   of that state, consistent with its tree; the commits it then catches up on are observed
   (`a_state_saved_before_a_departure_and_caught_up_afterwards_ends_the_run`). This item relies on
   the replay cursor and the checkpoint agreeing, which is what 9a ([backlog](../backlog.md)) makes
   true. A build that predates the field drops it on its next write: no run, so it rotates.
10. **A joiner still gets what the history policy grants (HOLDS).** A new device of a present user
    gets the re-distributed seed from index 0, which its user's other devices already opened. A new
    user never sees a reused seed. The history bundle is untouched.
11. **A commit processed between the run read and the seal (HOLDS, same as before).** The run is read
    before anything is sealed, so a commit landing in between can only make the anchor OLDER than the
    frame; the next send judges the move again. A message sealed while a Remove is in flight is the
    same race the epoch rule had.
12. **External-commit joins (DECIDED under D5, review of #2263).** Judged by the same new-user rule
    as an Add, on the leaf's own credential with the canonical user half (`an_external_join_*` in
    `tests/graine_run.rs`: a present user's new device continues, a new user and a malformed
    identity end the run, `BOB` is `bob`). The server checks that the leaf names the caller
    (`mls-frame-epoch.spec.ts`, `messaging.commit-log.spec.ts`, checked against two external commits
    openmls itself produced).

## Verification - what a compile does not prove

Done in the pull request: `cargo test` in `mls-core` (`tests/graine_run.rs`, 19 cases: a device add
continues, a new user ends, the four external-join cases of item 12, the joiner's own merge is
a no-op, a Remove ends on both committer and receiver, the add-then-remove case,
a batch with a departure in its middle, a same-key rejoin, a new-key rejoin, persistence across a
reload, a restored older state catching up, a replaced instance, same-number aliasing, the summary
fields); `sessionManager.test.ts` (the verdict table, re-distribution, the failure that persists
nothing, the add-then-remove case at the send layer); `graineStore.test.ts` (the anchor is sealed and
all-or-nothing); chat-delivery `mls-frame-epoch.spec.ts` and `messaging.commit-log.spec.ts` (the
external commit's path leaf is read, and one naming another user or device is refused before the
membership gate).

**Owed before the server half is believed on production:** the path-leaf parse was checked against
two external commits openmls 0.9.1 produced, not against stored rows. One read-only pass over the
`PublicMessage` rows of the commit log - every one should parse to a leaf naming its committer's
`userId:deviceId` - settles that no shipped client trips `commit_identity_mismatch`.

**Owed, rig rows (local estate, W1, W2, W3; GRAINE rows of
[cross-client-testing](../cross-client-testing.md)):**

- **GRAINE-ROT-1, a device join.** W2's user adds a second device between two sends of W1. W1 logs
  `[GRAINE] reused session ... re-distributed`, never `new outbound session`, whether the device came
  in by an Add or by the key group's external commit. The new device opens W1's next message.
- **GRAINE-ROT-2, a new user.** W3 (a user not yet in the community) joins between two sends of W1.
  W1 logs `run reset reason=new-user` and a new session.
- **GRAINE-ROT-3, a revocation.** A device of W2 is revoked. W1's next send logs
  `run reset reason=departure` and a new session.
- **GRAINE-ROT-4, the lost-phone case, exactly.** Between two sends of W1, a second device of W2's
  user is added, used (it receives the seed), then revoked. W1's second send logs a reset and a new
  session.
- **GRAINE-ROT-5, offline catch-up.** W1 is offline while a device of W2 is added and then removed;
  W1 reconnects and sends. It must mint.
- **GRAINE-ROT-6, a re-bootstrap to the same epoch.** A key group reset and rebuilt without one device
  until it reaches the epoch number of a session minted before the reset. That session is not reused.

**Owed, devices (Mi 9T and iPhone):** the join and revocation readings in the foreground; a
background Welcome while the app is killed, then a send after it reopens (the background merge runs
`mls-core` too, so the run should CONTINUE across a device join - a `reason=gap` there means a path
outside these two functions moved the epoch, worth a line in the report); a Remove that arrives while
the app is killed, then a send after it reopens: it must rotate.

**Owed, production, after a stable:** the seeds-per-message ratio, re-run with the query of
2026-10-21 (845 sessions for 1 698 messages), and the per-(salon, sender) message rates. The ratio should fall toward "senders x active days". If it does not, the reset
reasons say why: many `reason=gap` means an epoch is moved outside the two merge functions; many
`reason=departure` means external rejoins dominate (the reset line names `external=`).
