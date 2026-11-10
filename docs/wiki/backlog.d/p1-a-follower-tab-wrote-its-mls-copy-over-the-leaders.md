## P1 - a follower tab wrote its MLS copy over the leader's: built, the two-tab dev reading owed

Seen in the owner's web `1.6.9` log of 2026-11-10, read for the hidden-leader defect. A follower
tab's login replayed archives into its own ratchet copy and checkpointed it (`Encrypted state
checkpoint persisted` at 19:55:22, 19:55:41, 20:00:32, 20:03:44 and 20:04:36, after `Another tab is
active`), and the leader's own writes were refused behind it (`REFUSED as stale (v23514 < stored
v23529)`). **The version guard did not hold**: it orders by counter, and the follower's had run
further, so the disk held a copy behind the leader's commits.

Built: a document without the leader copy never writes MLS state (refused at the start and in the
IndexedDB transaction) and never decrypts an archive into its copy - the mechanism, the paths and the
tests are in [mls-protocol](../protocols/mls-protocol.md#a-follower-tab-wrote-its-mls-copy-over-the-leaders-2026-11-10).

Owed, then this file and its queue line are deleted:

- a two-tab reading on dev: the follower logs `[RESTORE] Follower tab - stored pages drawn` and no
  `checkpoint persisted`, the leader no `REFUSED as stale`, over a login and a conversation open in
  the follower;
- whether the owner's account carries a stale `mls.bin` from the follower writes of `1.6.9`: a load
  that met a frame it could not read after 2026-11-10 is the sign, and the existing recovery path
  (re-Welcome) is the repair.
