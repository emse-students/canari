## P2 - Community key groups: no periodic leaf refresh and no revoked-device removal yet (2026-10-22, re-decided 2026-10-23)

target: 1.9.0

Conversations refresh their leaves and drop revoked devices
([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh)). Two halves are deferred for
key groups, and they are NOT the same question:

- **The refresh.** Seeds rotate on departures only since 2026-10-22 (`graineOutboundVerdict`), and
  a refresh is not one, so it would not mint a seed by itself. Its cost is that each refresh moves
  the epoch: every sender's next send REDISTRIBUTES its seed (one frame per sender per refresh), and
  a redistributed session takes the reused caps (50 messages, 24 h FROM ITS MINT), so a session past
  a day rotates. One refresh per active device per week keeps every sender's session under a day
  old in a busy community. Owed before it is turned on: a redistribution that does not tighten the
  caps for a refresh-only epoch move (or caps counted from the redistribution), and the rotation rate
  re-measured with it.
- **The revoked device's leaf - BUILT 2026-10-27, shipped (the 400 fix, #2670, since `v1.5.1`; re-read 2026-11-11).** The key-group roster pass now asks
  `POST mls/groups/:groupId/revoked-leaves` which of the leaves it keeps belong to a revoked device
  and removes exactly those by device, staged on the published branch
  ([mls-protocol](../protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)).
  Owed: its run on dev, and the row that revokes a device of a community member and reads the key
  group's tree afterwards. **Its first dev run found every request refused 400** (the identity ran
  through the generic 128 bound, which every real identity exceeds) - fixed 2026-10-28, owed that
  run again on the fix
  ([mls-protocol](../protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)). It runs on every community load; the revoking device itself does not
  trigger a pass (not built). **Its scope is limited by the
  binding** (a key group's device rows); widening it is a schema change, approved 2026-10-27 and
  BUILT as its own draft pull request (`dm_revoked_device_groups`, chat-delivery migration 041,
  written by the revocation's purge), reaching production only with the user's yes at the stable.
