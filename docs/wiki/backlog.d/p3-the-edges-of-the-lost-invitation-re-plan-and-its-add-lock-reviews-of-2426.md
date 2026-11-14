## P3 - The edges of the lost-invitation re-plan and its add lock (reviews of #2426, 2026-10-25)

target: 1.9.0

What the re-plan of a kept invitation leaves open ([mls-protocol](../protocols/mls-protocol.md#an-invitation-whose-kept-commit-did-not-land-is-re-planned-or-the-member-is-told-2026-10-25)). None is built.

- **A kept commit is settled only by a connection.** It is resubmitted when the socket opens again. If the socket stayed open through a lost HTTP answer, nothing settles it until the next reconnect, yet the `outcome-unknown` toast promises "once it is back". The candidate is to settle on the next commit or send in that group.
- **A 1:1 creation and a group's own-device Add carry no invitation.** If such a commit is kept and then lost, it is cleared silently. This reading comes from the code and was not measured:
  - The own devices are covered. The creator's user row is written BEFORE the commit (`registerMember` in `createNewGroup` and `startNewConversation`), so each own device recovers through its own `welcome_request`.
  - The 1:1 contact is NOT covered. It is registered only AFTER the merge (`performDirectAdd`), so no server row re-derives a lost Add, and the conversation is left with its creator alone.
- **The add-lock marker store keeps one marker per group, and a put-back overwrites** (`markAddLock` in `addLockMarkers.ts`; round-4 review of #2426). If an owed release goes unanswered, its put-back of `t1` can land after a concurrent acquire has marked `t2`. Then `t2`'s marker is lost, and if `t2`'s release is also lost, that lock waits out its 30 s TTL. The cost is a bounded delay with no safety impact. The candidate fix is one marker per token.
- **The markers live in the per-account store the tabs share, and on the heartbeat fallback two tabs can lead at once** (the same review). The leader-tab gate keeps a follower from acquiring. But where Web Locks are missing (WebKitGTK), the heartbeat election can briefly have two leaders. One tab's `claimAddLockMarker` could then send a release, naming the other tab's token, that frees that tab's LIVE lock mid-Add. This is the H1 class. It was read from the code and never observed. The candidate fix is to key each marker by page as well as by group.
- **The authorization audit of the group routes** found a pre-existing remainder on the add-lock door; it is tracked privately.
- **A re-plan that dies between its merge and its Welcomes sends no Welcome.** Its entry stays, and the next re-plan finds every device `already-in-tree`, so it concludes and sends none. The invitee then depends on their own `welcome_request`. The owed-Welcome record (`owed_welcome.rs`) covers only a settled merge, not this path.

Re-read 2026-11-11 (batch 12): still real - `markAddLock` still keeps one marker per group (`addLockMarkers.ts`); none of the six edges is built. Re-read again 2026-12-11.
