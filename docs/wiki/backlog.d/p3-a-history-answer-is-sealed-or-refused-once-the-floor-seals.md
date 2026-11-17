## P3 - A history answer is sealed or refused once the floor seals (2026-11-17)

target: 1.8.0

Option B seals every addressed history answer to a key its ask carried
([history-answer-addressing](../protocols/history-answer-addressing.md#sealing-the-answer-to-the-asker---option-b-2026-11-17)).
Until every client seals, an asker accepts an UNSEALED answer to its keyed ask (said once per session,
`[LEGACY]`), and an answerer answers an ask with no key in clear
([legacy-compatibility](../legacy-compatibility.md#removal-once-minclientversion-passes-the-first-stable-that-seals---an-unsealed-history-answer-2026-11-17)).

**When:** `minClientVersion` reads the first stable carrying option B, or above, on BOTH estates
(`GET /api/version`), raised under the floor rule once both stores serve it.

**Then, one pull request (about an hour):** the receiver refuses an unsealed answer to a keyed ask at
error, like any answer that does not open; `historyAskId` treats an ask without `answerKey` as
malformed and answers nothing (D211's rule for `requestId`); `noteHistoryAsk` takes a secret, never
`null`, and the tests of the routing rules mint one; the legacy-compatibility entry goes. In the same
pull request, if the floor also carries the register ask: the warn that `noteRegisterAsked` says when
the fifth ask drops a marker is raised to error, and its legacy-compatibility entry goes
([legacy-compatibility](../legacy-compatibility.md#removal-once-minclientversion-passes-the-first-stable-carrying-it---the-bound-on-register-asks-2026-11-17)).
