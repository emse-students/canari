## P1 - the repair of a rewound sender lands on a coin flip, the ask cadence is identical either way, and a peer 21 messages behind was told "same state - nothing to do" (measured 2026-09-08, ten runs across three builds)

target: 1.8.0

HEAL-repair heals 3 times in 10 because the server elects a random online member, one of three holds
the messages, and the walk stops on a peer's AGREEMENT. Open: specify the state the fix remembers
(WHAT, for HOW LONG, what discharges it - the repair landing) and exclude an agreeing peer while the
asker holds frames it cannot read. **Re-read 2026-10-09, STILL OPEN and NOT changed: the fix is a design
whose state is not specified (WHAT is remembered, for HOW LONG, what discharges it), the cause is measured
only on the local rig (ten runs), and production's half cannot be read from the server** - 32 h of
`[HISTORY_REQ]` held 423 `NO_PEER_ONLINE` against 54 `FORWARDED`, which is a population of askers with no
peer online, not the coin flip. What would settle it: a harness `HEAL-repair` batch with the asker's
election log beside it, then the exclusion-on-agreement change with its state written first. The
measurement, the root cause and the two refuted causes (not to be re-opened) are in [history-reconciliation](../protocols/history-reconciliation.md#heal-repair-lands-on-a-coin-flip-the-measurement-and-the-root-cause-2026-09-08).
