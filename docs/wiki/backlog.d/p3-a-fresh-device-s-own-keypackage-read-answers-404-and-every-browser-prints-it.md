## P3 - A fresh device's own KeyPackage read answers 404, and every browser prints it red (DEV-1, `1.4.1-alpha.3`, 2026-10-25)

target: 1.9.0

`awaitOwnKeyPackagePublished` (`BaseMlsService.ts`) reads `fetchDeviceKeyPackage(self)` before an
external join, and on a device that has not published yet the delivery service answers 404 with its
typed reason. The client reads it correctly as "absent" and waits for the round - but the browser
prints `Failed to load resource: ... 404` at `error` level on EVERY fresh device, which no needle may
forgive (a 404 elsewhere on that path is a real loss). Wanted: the own-publication read answers
`200 {held:false}`, an answer and not a failure. The same endpoint serves a PEER's package to
`processPendingInvitations`, whose typed 404 (`deviceKeyPackage.ts`) must not change, so the fix is a
read of one's own publication rather than a new status on the shared one; old clients that read the
404 get a [legacy-compatibility](../legacy-compatibility.md) row with its removal date. Until it lands
the DEV rows stay `PASS-DIRTY` on this line, named.

**Seen again on DEV-6 of `1.4.1-alpha.6` (2026-10-26)**, on the second minted device. The 404 is
that device's read of ITS OWN package: the URL names its own device id. It is not a read of the
revoked first device's package. It is followed by
`[MLS] externalJoin b8ea5710... finds NO KeyPackage published for this device (absent) and no round
running - starting the round` at `warn`, which is the same item. It is not a separate finding about
revoked devices.
Re-read 2026-11-11: still real - no own-publication read exists; the shared route still answers the typed 404. Re-read again 2026-12-11.
