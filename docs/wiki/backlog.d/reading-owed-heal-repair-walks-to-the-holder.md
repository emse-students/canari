## Reading owed - the repair of a rewound sender walks to the member that holds the messages (2026-11-17)

target: 1.7.0

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
