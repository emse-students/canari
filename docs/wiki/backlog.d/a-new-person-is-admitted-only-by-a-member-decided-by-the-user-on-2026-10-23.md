## Reading owed - the uninvited-entry count on production and a waiting-seat ring on dev

target: 1.7.0

MERGED as #2358 (2026-10-24), the ask drawn as a card in the conversation by #2373: no automatic Add brings in a user absent from the adder's tree, web, native and the Android
background answer alike; a member is asked, as a line in that conversation, "X veut rejoindre la
conversation - Accepter / Refuser" (a PERSON, never a device: a member's device is added with no
ask since 2026-10-31), which replaces the group link's automatic admission (the server holds a link joiner outside, `awaitingAdmission`, until a
member's Add); and an entry no member made is written in the conversation and reported
(`[UNINVITED_ENTRY]`, with its `kind`) - see
[mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23). Migration 038 is applied in production; the floor is MET (re-read 2026-11-11: `minClientVersion` is `1.6.6`, #2358 is in every stable since `v1.5.0`), so "only by a member" now holds for every client allowed to connect and
its legacy entry closed on 2026-11-11 ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)); owed: the `[UNINVITED_ENTRY] kind=new-person` count on
production once the build serves both stores; of the four review findings, the removed member's surviving leaf closed with ADM-3, the relay routes with #2870, the joiner's second device with no device row with the account-seat flag (`UserGroupRow.awaitingAdmission`, 2026-11-01), and the waiting-seat exclusion of calls owes one ring on dev (below). The receiving side (#2815, a closed group refusing such a commit and freezing) was DISARMED on 2026-10-31 -
see [mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23); what it owes is in
[backlog.d](p1-the-admission-rule-fix-forward.md).
