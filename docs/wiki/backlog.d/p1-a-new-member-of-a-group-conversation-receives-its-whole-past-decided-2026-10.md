## P1 - A new member of a group conversation receives its whole past; decided 2026-10-21 that they must not

target: 1.7.0

The adding device pushed its whole local store to the invitee (`sendFullHistoryBundle`, up to 5
years), which no decision ever chose. 6 of 15 live group conversations had admitted 24 later members by
2026-10-21. Decided by the user: a newcomer reads nothing from before their arrival (WhatsApp, Signal),
and the remove-then-re-add rule of 2026-10-14 stays. Step C (the push withholds the invitee's span,
the receiver drops its own) is on `main`. **Step A shipped (#2270, merged 2026-10-22, in every stable since; re-read 2026-11-11):** every
history answer, the push included, is addressed to the asking device and filtered on its own
windows. **The two server holes shipped too (#2800, merged 2026-10-31 with #2791):** a link joiner's
arrival is dated at the member's Add, not at their ask, and the history stream drops the span before
arrival
([history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)).
`minClientVersion` past A is MET (the floor is `1.6.6`, read on `GET /api/version` 2026-11-11).
**Option B is built and merged (#3775, on dev since `1.7.0-alpha.9`):** every ask carries an X25519 key minted for it
inside its MLS-signed frame, and every answer to it is sealed with HPKE in `mls-core`
(`history_seal.rs`), or not sent at all, and opens only with the asker's secret, bound to the conversation, the ask, the
asker and the answerer (user and device)
([history-answer-addressing](../protocols/history-answer-addressing.md#sealing-the-answer-to-the-asker---option-b-2026-11-17)).
**DECIDED by the user, 2026-10-22:** a reply quoting a pre-arrival message SHOWS a newcomer the quoted
text; nothing is built for it
([history-answer-addressing](../protocols/history-answer-addressing.md#decided-a-quote-of-an-earlier-message)).

**Owed, in order:**

1. **The rig row GRP-ADDR-1 on dev (option B serves it)** (about an hour, three web seats): member
   A's new device asks, newcomer C (added after M1..Mn, and a link joiner who waited before the Add) is
   online; C logs no `[HISTORY_BUNDLE] ... received` for A's answer and holds nothing before its
   arrival; A's new device logs its chunks `addressed to ..., sealed` and restores M1..Mn; nothing logs
   `REFUSED` ([what proves it](../protocols/history-answer-addressing.md#what-proves-the-seal)).
   **Read 2026-11-18 on dev, `1.7.0-alpha.11`, sitting S4: `PASS` but for the last clause**
   ([readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)).
   A group of the owner, `beta` and `delta`; M1..M3; `gamma` added; M4; then the owner's web seat W3
   minted as a new device. Newcomer `gamma` held M4 only, before and after, and logged no bundle for
   the new device's answer (its own ask was answered `sealed`, "every message selected ... was
   withheld"); W3 restored M1..M4, and every answer it was sent was `addressed to ..., sealed`. Which
   device answered W3 in THIS group was not captured. **The clause "nothing logs `REFUSED`" FAILED:** W3
   logged five error-level `REFUSED` lines for join pushes in five OTHER groups, filed as
   [p2-a-new-device-refuses-the-join-push-of-groups-it-was-admitted-to-unsolicited](p2-a-new-device-refuses-the-join-push-of-groups-it-was-admitted-to-unsolicited.md)
   (`1.7.1`, not shown a regression). Not staged: the LINK joiner who waited before the Add.
2. **The join push is not sealed** - it answers no ask, so no key of the newcomer's reaches the inviter.
   The residual was a server misrouting the push of a RETURNING member to a member admitted after
   that member's first arrival. **Owner, 2026-11-17: closed in `1.7.0`.** Built and merged (#3777, on dev since `1.7.0-alpha.9`), with the offline newcomer's fix, read `PASS` on both phones (entry deleted 2026-11-18, [every half read](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)).
   The push carries the state and no message. The newcomer asks for its messages and its register with
   a keyed digest, whose answers are sealed
   ([history-answer-addressing](../protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17)).
   What remains is the rig row GRP-ADDR-1 above.
3. The [LEGACY] half of option B goes once the floor passes the stable that seals:
   [p3-a-history-answer-is-sealed-or-refused-once-the-floor-seals](p3-a-history-answer-is-sealed-or-refused-once-the-floor-seals.md)
   (`1.8.0`).
