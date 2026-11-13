## Reading owed - Graine v2: the unsigned-row count, the rig re-run and one native refusal

target: 1.7.0

v1 proves nothing about who wrote a salon message or where; the table is
[channel-encryption §7](../protocols/channel-encryption.md#7-what-the-server-can-still-do-stated-rather-than-implied),
the design [§21](../protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)
(all three decisions of 2026-09-28: the whole of it, a relayed endorsement, the DMs included).
**EVERYTHING TO BUILD IS BUILT (re-verified against `main` 2026-10-14)**: the reader R1 (G2-0 to
G2-4b), the verified MLS sender that covers the DMs (G2-1b, web and native), the writer G2-5
(`v1.0.3`), the refusal of an arriving v1 seed G2-5b (`v1.2.6`), and the server's refusal of an
unsigned row ([§21.8](../protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13),
#1802). Settled: the floor is `1.2.7` since 2026-10-17, past `1.2.6`, so no admitted build accepts a
v1 seed any more; and GRAINE-AUTH-4 is a unit test, not a rig row
(no mutating dev hook). **The chantier closes when the three rows below are done**; what is left
after that is a dated shim, and it lives in [legacy-compatibility](../legacy-compatibility.md) alone.

| What is owed | Blocked on |
| --- | --- |
| The count re-run (§21.8's SQL: 0 unsigned rows), §21.8 being in production since `v1.2.7` (#1802) | nothing: owed now |
| The rig: GRAINE-AUTH-1..3 and -6 re-run (the runner changed, `rows.mjs` flags them) and -7 first run, all on one estate carrying #1802 ([board](../cross-client-testing-archive-1-4-0.md#20---graine---an-author-that-is-proven)) | a running local estate (none was up on 2026-10-14, so nothing was run) |
| One reading on a device of the native v1-seed refusal lines (Kotlin `REFUSED N v1 seed(s)`, the NSE's `openSeedFrame: REFUSED v1 seed(s)`), compiled and never run ([§21.7](../protocols/channel-encryption.md#217-an-arriving-v1-seed-is-refused-wp-g2-5b---the-floor-reached-the-writer-2026-10-11)) | a pre-floor v1 frame replayed to a phone, the only path that reaches them |

The v1 reader, the nullable `signature` column and the edit trust level of
[§21.5b](../protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05) (G2-6b) all go
together when production counts 0 unsigned rows (373 on 2026-10-14; revisit 2027-10-13), in
[legacy-compatibility](../legacy-compatibility.md). Not Graine work, noted where it was found: `listMessages`
with a `before` cursor omits edit and reaction rows made after the cursor, which matters only if a
channel ever gets an older-page load.

What v2 does not close: the server can still admit a device it controls or publish a false device key
(BasicCredential's limit, §21).
