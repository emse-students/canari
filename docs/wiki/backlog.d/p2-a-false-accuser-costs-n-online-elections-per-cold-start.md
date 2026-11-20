## P2 - a device that accuses frames falsely walks the whole online membership at every cold start (#3762)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-17, scope cut: KEPT in `1.7.0` - a regression of `1.7.0`: the walk it describes is #3762's, merged 2026-11-17, after `v1.6.12` ([decisions](owner-decisions-of-2026-11-17.md))._

_2026-11-18, sitting S4: moved to `1.8.0` on the measurement below (the walk is #3762's, but the false
accusation that would start it did not fire in 17 hard-killed cold starts); the lead confirms or puts it back._

_2026-11-18 (lead, under the 1.7.0 scope cut's criteria): measured 0 false accusations in 17 cold starts (KILL-3 and the S4 sitting), so not a proven regression - a P2 that is not a regression goes to 1.7.1 ([decisions](owner-decisions-of-2026-11-17.md))._

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

**Measured 2026-11-18 on dev, `1.7.0-alpha.11` (after #3762), sitting S4 ([readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)): the false accusation did not reach this path, so the walk cost nothing.**
The largest group the rig holds: a four-account group with **M = 38** active device memberships
(`dm_device_group_memberships`), with W2, W3, W4 and W5 online beside the killed seat (and the Mi 9T's
app open on `/chat`), so N_online is 5 to 6. W1 (the owner's web seat) had its whole browser killed
(`killSeat(..., 'browser')`) the instant it SHOWED a frame of a four-message burst from W2 (the first
frame on odd runs, the last on even ones), then was relaunched, unlocked and left 75 s with the group
open. Five valid cold starts (a sixth killed before any frame showed is not counted):

| per cold start | before #3762 | after #3762, measured (5 runs) |
| --- | --- | --- |
| loss accusations (`frame never read here and unreadable for good`) | - | 0, 0, 0, 0, 0 |
| `LOST frame` lines | - | 0 each |
| elections: server `[HISTORY_REQ] FORWARDED` / `NO_PEER_ONLINE` for the group | 1 by the code | 0 each |
| `history_cannot_repair` answers / walk ends on the revived seat | - | 0 each |
| the group's history stream reads by the revived seat (`[HISTORY] user=... group=...`) | - | 1 to 3, its own catch-up of the 5-6 new entries |

Every revived W1 logged `[HISTORY_RECONCILE] no sweep - away 0 d, inside what the server keeps; every
group already audited` and drew its stored page; no ask was raised. With KILL-3's twelve runs on
`1.7.0-alpha.9` (also after #3762, "the revived seat accused no frame it had read (0)"), that is 17
hard-killed cold starts on builds carrying #3762 without one false accusation. **"Before #3762" could
not be measured on dev**: every build dev has served since `1.7.0-alpha.8` carries it, and the
"before" column is the code's single election. **Verdict: not a `1.7.0` blocker** - the cost in the
table above is real only when the TAB-3b accusation fires, which the bench no longer reproduces; the
entry moves to `1.8.0` beside [its cause](p2-a-cold-start-re-accuses-frames-it-already-read-because-the-ratchet-advance.md),
and answer 1 (one write for the advance and its mark) remains the one that removes both. **What would
reopen it:** one `frame never read here and unreadable for good` on a revived seat (the KILL rows assert
it), after which option 2 needs a durable walk record keyed by group, the accused fingerprints and the
roster that answered, with its migration of the client store and an adversarial review.

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
