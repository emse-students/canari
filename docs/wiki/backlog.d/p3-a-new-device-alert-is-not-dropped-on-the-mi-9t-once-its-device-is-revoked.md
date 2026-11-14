## DEFECT read - a new-device alert is NOT dropped on the Mi 9T once its device is revoked

target: 1.7.0

**What is built:** a new-device alert is dropped once its device is revoked (2026-11-12; [mls-protocol](../protocols/mls-protocol.md))


**Read 2026-11-14 on the Mi 9T (`1.6.12`, which carries #3386): the drop does NOT happen.** W1 (the bench account's desktop client) revoked the 13:28 Windows device through the panel (its row identified by its start time; the Mi's own device and W1's own carry other ids and were not touched). The server then answers `GET /api/mls/devices/:user/:device/revoked` with `{"revoked":true}` for the alert's device id (the id embeds its creation time, 12:28:50Z). The Mi still holds the alert in its stored `pending` list after a forced restart, a SPA navigation to `/notifications` and a full reload; the row showed after the reload and stayed 30 s; no `[DEVICE_NOTICE] alert dropped:` line appeared on the SPA open (console hook installed first) and no `[MLS] revocation check` warning either, so `dropNoticesOfRevokedDevices` either did not run or its `isRevoked` returned false without a line. The row was absent once, 8 s after the restart, and back after the reload: not explained.

**Next:** log at the entry of `dropAlertsOfRevokedDevices` (the early return when no MLS service or session is registered says nothing today) and read which branch the Mi takes; then fix at the cause. target: 1.7.0
