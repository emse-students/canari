## P2 - a new device's restore is paced by one member device adding it group by group

target: 1.8.0

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

**The reading that closes it:** the same restore (a new browser on an account of 150+ conversations)
on dev, logged: Welcomes for all groups within 30 s of sign-in, checkpoint time under 10 % of the
restore, and fewer `users/batch` calls than conversations.
