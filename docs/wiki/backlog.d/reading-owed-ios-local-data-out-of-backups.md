## Delete the per-file backup passes the launch pass made redundant (the reading passed 2026-11-22)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

The reading of [nothing local travels to another phone](../frontend/mobile.md#nothing-local-travels-to-another-phone-2026-11-20) passed on `1.7.3-alpha.5` (iPhone 12,
[readings](../device-verification.md#the-iphone-12-readings-of-2026-11-22-173-alpha5-the-backup-domains-the-banners-the-reactions-the-replay-bar-the-outage-drill)):
`6/6 directories excluded from backups` at three cold launches, no line at ERROR, and a full `backup2` holding no file in the app's, the App Group's or either extension's domain.

**What is left is the code the reading releases:** `native_cache::exclude_from_backup` and its callers,
`CanariExcludeNativeCacheFilesFromBackup`, the NSE's `excludeFromBackup` and the share manifests' per-file calls,
with the tests that name them. Not closed by the reading: whether Quick Start honours the flag (two iPhones and a
transfer; the bench has one), so the app's own detection of a copied install stays the answer to that.
