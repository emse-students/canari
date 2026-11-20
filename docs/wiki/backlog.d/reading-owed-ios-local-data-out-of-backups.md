## Reading owed - iOS: nothing local travels to another phone, every store excluded from backups at launch (iPhone 12)

target: 1.7.2

**What is built.** At every launch, before the WebView, `backup_exclusion.rs` sets and reads back
`NSURLIsExcludedFromBackupKey` on `Library/Application Support` (the SQLite stores, `mls.bin`, the
at-rest markers), `Library/WebKit` (IndexedDB, LocalStorage), `Library/Preferences`,
`Library/Cookies`, `Library/HTTPStorages` and the App Group container's root. Reported 2026-11-20:
a member's new iPhone arrived holding the stores without the `ThisDeviceOnly` key. The inventory
before the change, the mechanism and what stays unproven:
[mobile](../frontend/mobile.md#nothing-local-travels-to-another-phone-2026-11-20).

**The reading that closes it**, on the iPhone 12, a build carrying the pass, signed in with data:

1. Launch, then read the log (`python -m pymobiledevice3 syslog live`, or the app's exported log):
   `[BACKUP_EXCLUSION] 6/6 directories excluded from backups, flag read back: ...`, and no
   `[BACKUP_EXCLUSION]` line at ERROR.
2. `python -m pymobiledevice3 backup2 backup --full <dir>` (encryption off, about 40 s), then read
   `Manifest.db`: `select domain, relativePath from Files where domain like '%canari%'`. **PASS**
   when `AppDomain-fr.emse.canari` holds nothing under `Library/Application Support`,
   `Library/WebKit` or `Library/Preferences` (only `Documents/` and the bare directory rows may
   remain) and `AppDomainGroup-group.fr.emse.canari` holds no file at all. The 2026-11-20 manifest
   taken before the change is the control: it listed `mls.bin` twice, the SQLite stores and 159
   WebKit files. Delete the backup after reading.
3. Relaunch once and read the line again (the pass is idempotent: still 6/6, nothing at ERROR).

**When it passes**, the same pull request deletes the per-file passes it makes redundant
(`native_cache::exclude_from_backup` and its callers, `CanariExcludeNativeCacheFilesFromBackup`, the
NSE's `excludeFromBackup`, the share manifests' per-file calls) and records the reading in
[device-verification](../device-verification.md). **Not closed by it:** whether Quick Start honours
the flag (two iPhones and a transfer; the bench has one) - the app's own detection of a copied
install stays the answer to that.
