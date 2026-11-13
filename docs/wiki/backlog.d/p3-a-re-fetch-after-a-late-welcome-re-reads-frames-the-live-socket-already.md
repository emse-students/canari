## P3 - A re-fetch after a late Welcome re-reads frames the live socket already delivered (DUP-2, 2026-10-25)

target: 1.9.0

After a late Welcome (a joiner reached by a member's commit before it, [mls-protocol](../protocols/mls-protocol.md#a-joiner-whose-first-frame-beats-its-welcome-waits-for-it-dup-2-2026-10-25)),
the client re-fetches the frames it left behind as `unknown-group`. That re-fetch pulls every row the
server still holds for the group, including an epoch-4 application frame live delivery had read a
moment earlier and not yet acknowledged. MLS refuses the second read (`SecretReuseError`) and the
frame ledger ACKs it as `Duplicate delivery … silent ACK (SecretReuseError, already read by live
delivery)`. Read on `1.4.1-alpha.4` (dev.f49f499). Nothing is lost, but the duplicate comes from the
client itself, not from a lost ACK, so it is a defect, not a normal path: a decrypt spent to learn
what the client already knew. The mislabel the second read used to carry (`[FORK] not a fork … the
frame itself is damaged` at WARN) is fixed - classified as a spent generation in `messaging.rs` (#2466).
The re-read itself is not: the re-fetch should not ask for, or should not hand to MLS, a row the live
socket already delivered in this session. Not yet read: whether the re-fetch and the live drain share
any per-row identity (`queuedMessageId`) the re-fetch could skip on.

Re-read 2026-11-11 (batch 12): still real - the re-fetch still hands MLS rows the live socket delivered; the shared per-row identity is still unread. Re-read again 2026-12-11.
