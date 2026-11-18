## P2 - a repair ask is absorbed by another device's exchange, and the walk never reaches the holder (reading of 2026-11-17; built as "the repair walks to the member that holds the messages")

target: 1.7.1

**What is built:** an ask raised by a frame this device cannot read carries `incomplete: true`; a
member that holds nothing the asker lacks answers `history_cannot_repair` instead of staying silent,
and that answer excludes it from every later ask until a repair lands
([history-reconciliation](../protocols/history-reconciliation.md#the-fix-the-walk-advances-on-an-answer-built-2026-11-17)).
Proven by unit tests only (`historyReconcile.test.ts`, `actions.historyRequest.test.ts`,
`systemMessageHandler.cannotRepair.test.ts`); the coin flip was measured on the rig, not in a test.

**The reading that closes it:** a harness `HEAL-repair` batch of ten runs on the pre-release, the
asker's trail beside the server's `[HISTORY_REQ]` lines. PASS: ten of ten HEALED, and on every run
where the first election reached a member other than the holder, the asker logs `holds nothing ...
lacks ... electing another` followed by `a repair landed`. A run ending on `every reachable member
(n) holds nothing` while the holder was online is a FAIL; if the holder itself sent
`history_cannot_repair`, the state key agreed falsely and the place to look is
`historyRangeStartFor` (the 01:07 anomaly of 2026-09-08).

**Read on `1.7.0-alpha.10`, 2026-11-17 ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)): FAIL, moved to `1.7.1`.** Four runs, none
HEALED: the asker (W2, `beta`) ended holding 5, 6, 7 and 7 of the 14 frames the rewound sender (W1)
sent, and no run logged the walk (`holds nothing ... electing another`, `a repair landed`). The ask
was absorbed by a concurrent exchange: `alpha`'s other device (the Mi 9T, as unable to read those
frames) asked W2 at the same moment, W2 answered it holds nothing it lacks, and then logged `was asked
30s ago at most - not asking again, that exchange is still the one that repairs this` at every later
lost frame - the holder, W1, was never asked for what W2 lacked. So "have I already asked" is
answered by an exchange that was about ANOTHER device's gap (the durable-state rule: state answers
only the question it was written for). Not a regression since `v1.6.12` (the walk is new, the
outcome is the old coin flip), hence `1.7.1` under the scope cut. The fix must key the
"already asked" state by what THIS device lacks, then the ten-run batch above closes it.
