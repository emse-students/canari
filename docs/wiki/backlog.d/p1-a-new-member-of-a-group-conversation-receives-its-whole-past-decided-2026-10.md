## P1 - A new member of a group conversation receives its whole past; decided 2026-10-21 that they must not

target: 1.7.0

The adding device pushes its whole local store to the invitee (`sendFullHistoryBundle`, up to 5
years), which no decision ever chose. 6 of 15 live group conversations had admitted 24 later members by
2026-10-21. Decided by the user: a newcomer reads nothing from before their arrival (WhatsApp, Signal),
and the remove-then-re-add rule of 2026-10-14 stays. Step C (the push withholds the invitee's span,
the receiver drops its own) is on `main`. **Step A shipped (#2270, merged 2026-10-22, in every stable since; re-read 2026-11-11):** every
history answer, the push included, is addressed to the asking device and filtered on its own
windows. **The two server holes shipped too (#2800, merged 2026-10-31 with #2791):** a link joiner's
arrival is dated at the member's Add, not at their ask, and the history stream drops the span before
arrival
([history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)). Owed, in order: the rig row GRP-ADDR-1, with a link joiner who waited before the Add; `minClientVersion` past A is MET (the floor is `1.6.6`, read on `GET /api/version` 2026-11-11); option B, sealing the answer to the asker (X25519 in `mls-core`, an
ephemeral key carried inside the MLS-signed request). **DECIDED by
the user, 2026-10-22:** a reply quoting a pre-arrival message SHOWS a newcomer the quoted text;
nothing is built for it. Design and limits:
[history-answer-addressing](../protocols/history-answer-addressing.md#decided-a-quote-of-an-earlier-message),
[history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21).
