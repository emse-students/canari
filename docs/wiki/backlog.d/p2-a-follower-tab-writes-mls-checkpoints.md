## P2 - a follower tab writes MLS checkpoints, and the version guard refuses the leader's

Seen in the owner's web 1.6.9 log of 2026-11-10, read for the frozen-leader defect
([chat](../frontend/modules/chat.md#the-lead-goes-to-a-tab-that-can-serve-a-hidden-leader-hands-it-over-2026-11-10)): with the leader
silent in the export since 19:43 (hidden; its last batch is not in the file), the log - whose lines carry no tab tag, so this is an inference -
shows the FOLLOWER writing `[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed` and `[MLS] Encrypted
state checkpoint persisted` (20:04:36, beside its follower flush line), and earlier the same account's
tabs logged `MLS state write REFUSED: snapshot v23513 collides with the stored one` (17:35) and
`REFUSED as stale (v23514 < stored v23529) - the stored blob is another document's` (17:56, 17:57).
Two documents write `mls.bin`; the version guard holds, so nothing is lost on disk, but a follower
advancing and persisting its copy is the single-writer invariant broken on the READ side (a history
replay, a catch-up). Owed: which path ingests in a follower (the `[CATCHUP] batch history` of the same
reload is the first suspect), and whether a follower should persist at all - its copy is never the
one the leader reads.
