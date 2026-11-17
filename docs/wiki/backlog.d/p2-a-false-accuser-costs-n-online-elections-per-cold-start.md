## P2 - a device that accuses frames falsely walks the whole online membership at every cold start (#3762)

target: 1.7.0

**What changed.** Since #3762, an ask raised by a frame this device cannot read carries
`incomplete: true`. Every member that holds nothing the asker lacks answers
`history_cannot_repair`, and the asker elects another member at once, until the server answers
`no_peer_online` ([the fix](../protocols/history-reconciliation.md#the-fix-the-walk-advances-on-an-answer-built-2026-11-17)).
That is right for a device that really lacks messages. A device that accuses frames it has
already read (the TAB-3b shape:
[the cold-start re-accusation](p2-a-cold-start-re-accuses-frames-it-already-read-because-the-ratchet-advance.md))
has a complete store, so EVERY member agrees and the walk visits all of them.

**The figures, from the code (review of #3762, 2026-11-17; not measured).** Per hard-killed cold
start of the accusing device, per group holding a re-accused frame, with N_online members online and
M devices in the group:

| | before #3762 | after #3762 |
| --- | --- | --- |
| elections (`history_request`) | 1 | up to N_online |
| group broadcasts | 1 (`history_state`) | up to 2·N_online (`history_state` + `history_cannot_repair` per step) |
| decrypts across the group | about M | about 2·N_online·M |

For a salon with 100 devices, all online, that is about 20 000 decrypts for one cold start, instead of
about 100. The bound holds because the set lives in memory and only grows within a session. But the
cost grows with the square of group size, and TAB-3b adds re-accused frames at every hard kill.

**The measurement owed.** The cross-client harness on a large salon (the largest the rig can seat,
noted with M and N_online), a device hard-killed and cold-started five times, on a build before #3762
and on one after it. For each cold start, count the `[HISTORY_RECONCILE]` elections, the
`history_state` and `history_cannot_repair` frames, and the decrypts summed over every seat. The
result fills the table above with measured numbers, or shows the TAB-3b accusation does not reach
this path.

**Candidate architectural answers. A cap on the walk and a timer are NOT among them**, because either
would also stop the walk of a device that really is incomplete.
1. **Remove the false evidence at its source.** Make the ratchet advance and its seen-mark one
   atomic write, so a frame read before a kill is never accused again
   ([the TAB-3b entry](p2-a-cold-start-re-accuses-frames-it-already-read-because-the-ratchet-advance.md)).
   With no false accusation, there is no false proof to walk on.
2. **Make the end of a walk final for its roster and its evidence.** This copies the shape of
   WP-HOLD-NOTHING ([channel-encryption section 24](../protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)).
   A walk that ended on `no_peer_online` is recorded durably against the fingerprints it was about and
   the roster that answered. A cold start that re-accuses the SAME fingerprints to the SAME roster
   walks nothing. A new fingerprint or a changed roster opens a new walk. This record answers "is this
   evidence already walked", not "have I already asked", so it stays clear of the durable-marker
   trap the reconciliation page records.
3. **Ask the holder first.** The `LOST frame` line already names the frame's sender, which is the
   member most likely to hold the message. If the election could prefer that device, the common case
   becomes one election, and the walk becomes the exception.
4. **Address the walk instead of broadcasting it.** `history_state` and `history_cannot_repair` are
   group broadcasts that every device decrypts in order to discard. An addressed leg would bring the
   M factor down to one per step.
