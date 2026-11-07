## P3 - An ask whose seat holds no device row never expires (review of #2894)

`expireUnansweredAsks` is fed by the stale `pending` device rows the hourly purge finds
(`runStalePendingCleanup`, `app.controller.ts`), so an awaiting seat holding NO device row in the
group - its devices revoked, say, while a later device of the person, which never got a row, keeps
asking - is never found and never withdrawn. Not extended in #2894: whether a device with no row that
still sends `welcome_request` renews the ask is not recorded anywhere, so a seat-age rule could expire
an ask that is live. Owed: one production count of awaiting seats with no device row
(`dm_group_members` with `"awaitingAdmission"` and no `device_group_memberships` row of that user in
that group); if 0, delete this section; otherwise record the ask's renewal on the seat and expire on
it - [mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).
