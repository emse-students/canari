## P2 - Graine rotates on every key-group epoch, so a growing community mints a seed per message (measured 2026-10-21)

target: 1.8.0

Every device joining a community's key group commits, and the outbound rotation rotated on any
epoch change. Production: 845 sessions for 1 698 messages, and 458 seeds in the largest community's
first 8 days. The history bundle carries every seed, about 330 bytes each in v2, so its 8 000-seed cap
is about 2.6 MB in one MLS message. Owed, in order:
(1) rotate on a REMOVAL or a NEW USER only - MERGED (#2263): a clean run per
key group kept in the MLS state by `mls-core` and judged by `graineOutboundVerdict`
([graine-removal-tracker](../protocols/graine-removal-tracker.md)). Owed: the rig rows and the
production ratio named on that page, and one read-only pass proving every stored external commit's
path leaf names its committer (the server now refuses one that does not). A new USER still rotates
(D5, decided 2026-10-22); a new device of a present user continues, by an Add or an external
commit alike; (2) the bundle bounded in bytes and paged is MERGED (#2255), owed one rig run of a
paged history answer ([channel-encryption §4.4](../protocols/channel-encryption.md#44-joining-and-what-a-share-link-is-worth));
(3) a key-group frame stored once per group, not once per seat (31 copies per
payload, 883 MB of the 1.5 GB queue): MERGED (#2260), for the next stable (user). It
ships the READERS with migration 034 and the writer OFF (`QUEUED_PAYLOAD_SHARED_WRITES=false`).
Migration 034 is applied in production; owed: a pull
request turning the writer on (`QUEUED_PAYLOAD_SHARED_WRITES`, still false) in a later release; then one re-measure of the queue's bytes
([chat-delivery](../services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
Reasoning and numbers:
[dm-vs-community-encryption](../protocols/dm-vs-community-encryption.md#where-each-system-can-improve).
