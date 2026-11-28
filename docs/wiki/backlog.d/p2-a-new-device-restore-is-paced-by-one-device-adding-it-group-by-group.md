## P2 - a new device's restore is paced by one member device adding it group by group

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped. 2026-11-26: moved to 1.8.3 - the instruments below are built, the levers wait on the log they produce._

**Measured 2026-11-24** (a new web device, prod `1.7.3`, 153 conversations, log of 13:44:11 to
13:46:34 local): history was still arriving when the log was exported.

- **The critical path is the Adds.** The device asked a member's Add for 153 groups within 44 s
  (13:44:21 to 13:45:05, `[READD] ... sendWelcomeRequest`), and the Welcomes came back at a steady
  ~2 per second until 13:46:06 (151 Welcomes; median 23.7 s, max 87.8 s from ask to Welcome). Every
  Add is a commit plus a Welcome built by the ONE online device of the account, one group at a time,
  and each conversation's history is asked only once its Welcome is processed. That alone is ~75 s.
- **The receiver is not the bottleneck, but it is not free.** 381 `history_bundle` frames, 5,082
  messages: 27.7 s of handler time in all (median 41 ms, p90 191 ms, max 1.0 s per frame). 360
  encrypted state checkpoints totalling 29.9 s - about 3 s in every 10 s of the restore - each one
  rewriting the WHOLE state, which grew from 0.12 MB to 5.4 MB (153 trees), so the cost per
  checkpoint grows as the restore goes on.
- **Chatter around it:** 266 `GET /api/users/batch` and 190 `GET /api/users/avatar-presence` in
  2 min 20 s.

**What to build, in order of gain.** (1) The answering device batches the Adds of one new device: one
pass committing into every group the device asks for, instead of one welcome request per group at a
60 s cadence - measured against this log's 75 s. (2) One checkpoint per drained burst rather than per
drain during a restore (the state is O(groups), and writing it per Welcome is O(groups^2) over a
restore). (3) The profile lookups coalesced across the restore.

**Read 2026-11-25, nothing built - each lever needs the dev measurement first** (a worker's pass,
from the code, not from a log):

- (2) is not a cadence knob. The persister already coalesces (one checkpoint in flight, ONE queued
  and shared by every caller, `mlsStatePersister.ts`), so 360 checkpoints means the Welcomes arrive
  slower than one checkpoint lasts. Each applied Welcome asks `persistNow` and its ack is WITHHELD
  until a covering checkpoint lands (`DrainAckHold`), and each conversation's history replay
  commits its markers only after a checkpoint (`withMlsBulkIngest`). Deferring checkpoints "while
  Welcomes are owed" therefore delays every Welcome's ack and every replay's markers; it is sound
  only with that ordering argued again, and its gain is unknown until the log separates the Welcome
  checkpoints from the replay ones.
- (3) has two possible causes the 2026-11-24 log does not separate: the profile coalescer's window
  is ONE event-loop turn (`stores/user.ts`, `enqueueProfileFetch`) and its cache lives 30 s, so 266
  calls over a 140 s restore are either one-turn windows of one or two ids (tiles mounting as each
  Welcome lands) or the same ids re-asked after the TTL. The first wants a window bound to the
  restore's own lifecycle, the second a longer-lived answer; the dev log's ids per call decide.
- (1) changes the answering device's Add lane (`serveWelcomeRequest`, one group at a time) and the
  KeyPackage claims of the new device - the riskiest of the three, and the largest gain.

**The reading that closes it:** the same restore (a new browser on an account of 150+ conversations)
on dev, logged: Welcomes for all groups within 30 s of sign-in, checkpoint time under 10 % of the
restore, and fewer `users/batch` calls than conversations.

**Built 2026-11-26 - the three lines that decide the three levers** (nothing changes behaviour; each
line is what the dev log was missing):

- **(1) The answering device's Adds.** Every accepted commit now writes
  `[COMMIT] <group>... accepted at epoch N - waited W ms for the MLS mutex, held H ms (checkpoint C ms,
  request R ms, A attempts)` (`commitHoldTiming.ts`, wired in `BaseMlsService.runCommitTransaction`).
  **What the code already says, read 2026-11-26:** each Add runs ALONE under the global MLS mutex -
  the stage, a checkpoint of the device's WHOLE state before the first request
  (`checkpointStageBeforeSend`, O(groups)), the request (the mutex is lent only to other groups'
  FRAMES, never to another commit - [mls-protocol](../protocols/mls-protocol.md#a-commit-waiting-on-the-network-lends-the-mls-lock-to-other-groups-frames)),
  the merge. So 153 asks are 153 holds in a row, and ~2 Welcomes a second is one hold of ~0.5 s.
  The line splits that hold: W growing down the restore is the queue, C the part that grows with the
  number of groups, R the network. **The lever it points at** is ONE transaction for the Adds of one
  device into K groups: K stages, ONE checkpoint covering every stage before any request leaves, the K
  requests, K merges - each group keeping its own settle, unknown and rebuild semantics exactly as
  one commit has them today, and a group refused or unknown leaving the others untouched. That
  changes the "one commit per hold" invariant of the mutex, so it is built only once C (and not R)
  is shown to dominate H, and it is reviewed adversarially as an MLS-core change.
- **(2) The checkpoints.** The checkpoint line now names who asked for it:
  `[MLS] Encrypted state checkpoint persisted. (83 ms) Asked by: applied x3, replay x1.` - `applied`
  is `persistNow` (a Welcome or commit applied), `replay` a history replay or restore window closing,
  `drain` a live drain closing, `flush` an explicit flush (`mlsStatePersister.ts`). The Welcome
  checkpoints and the replay ones are separated by reading that clause over the restore.
- **(3) The profile lookups.** Each `GET /api/users/batch` writes
  `[USER] profile batch: N id(s), R asked again after the cache expired` (`stores/user.ts`): N of 1-2
  with R = 0 is the one-turn window (the fix is a window bound to the restore), R close to N is the
  30 s TTL (the fix is a longer-lived answer).

**The dev measurement was attempted the same day and did not run:** the owner test account on dev is at
the per-user device cap (15/15), and the rig's purge (`purge-devices.mjs`) stopped on the scratch
profile's locked security card. Purge the abandoned mints by hand on that profile first, then
`bun newdevice.mjs --device W3 --keep-open` with a watcher on W1 (`bun logs.mjs --device W1 --raw`;
W1 has several tabs open, so close the extra ones first or the watcher refuses).

