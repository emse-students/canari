## Reading owed - iOS: nothing local travels to another phone, every store excluded from backups at launch (iPhone 12)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built.** At every launch, before the WebView, `backup_exclusion.rs` sets and reads back
`NSURLIsExcludedFromBackupKey` on `Library/Application Support` (the SQLite stores, `mls.bin`, the
at-rest markers), `Library/WebKit` (IndexedDB, LocalStorage), `Library/Preferences`,
`Library/Cookies`, `Library/HTTPStorages` and the App Group's `store/` directory (not the container's
root, which refuses the flag: [its own reading](reading-owed-ios-app-group-store-out-of-backups.md)).
Reported 2026-11-20:
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

**2026-11-20, S16 (`1.7.2-alpha.1`, [readings](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)): FAIL.** Steps 1 and 3: `[BACKUP_EXCLUSION] AppGroup(group.fr.emse.canari) not excluded from backups: setResourceValue refused`, then `5/6 directories excluded - NOT excluded: AppGroup(group.fr.emse.canari)` at ERROR, at each of three launches (the line is caught by polling the Rust log file over `house_arrest` during the launch: the log plugin rotates it away within seconds, and `syslog live` does not carry it). Step 2: the app container passes (16 files, all under `Documents/`), the App Group holds 35 files, `mls.bin` and `push_secret.txt` among them. Fixed by moving the App Group's files into a flagged `store/` ([its reading](reading-owed-ios-app-group-store-out-of-backups.md)); this reading stays owed until 6/6.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`): the manifest half PASS** (the app domain and the App Group hold 0 files); the `6/6` launch line and the relaunch were not recorded, so the reading stays owed for them. Detail in [the App Group entry](reading-owed-ios-app-group-store-out-of-backups.md).

**2026-11-21, on `1.7.3-alpha.1` (build 100700301), iPhone 12: steps 1, 2 and 3 PASS.** The launch
line `[BACKUP_EXCLUSION] 6/6 ... flag read back` on two launches, with no ERROR; an unencrypted full
backup's `Manifest.db` holds only directory rows for the app domains and none of the App Group's
files (the control on `1.7.2-alpha.1` held 35). **Still owed before this file goes:** the clean-up
it names on a pass (the per-file passes deleted, the reading recorded in device-verification), done
together with [the App Group entry](reading-owed-ios-app-group-store-out-of-backups.md), whose
first-launch move, share-extension, push and downgrade halves are not read yet.
