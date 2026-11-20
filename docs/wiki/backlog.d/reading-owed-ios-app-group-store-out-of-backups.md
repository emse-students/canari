## Reading owed - iOS: the App Group's files live in a flagged store directory, and no App Group file is in a backup (iPhone 12)

target: 1.7.2

**What is built.** The fix of the P2 *"the iOS App Group root refuses the backup flag, so `mls.bin`
and the push secret still go into an iPhone backup"* (read on `1.7.2-alpha.1`, sitting S16). The
container root is no longer flagged: everything the app and its two extensions share lives in
`store/` inside it, flagged by whichever process creates it, and an older build's root files are
moved in at each process's first resolution (`backup_exclusion::open_store`). A refusal now keeps its
`NSError` (domain, code, description, underlying error, class) in the one verdict line. Mechanism:
[mobile](../frontend/mobile.md#the-app-group-a-store-directory-never-the-root-172).

**The reading that closes it**, on the bench iPhone 12, a build carrying the store, installed OVER
a `1.7.2-alpha.1` signed in with data (so the move has something to move):

1. Launch, then read the log (`python -m pymobiledevice3 syslog live`):
   `[BACKUP_EXCLUSION] 6/6 directories excluded from backups, flag read back: ...,
   AppGroup(group.fr.emse.canari)/store`, and no `[BACKUP_EXCLUSION]` line at ERROR - the verdict
   also fails when an entry of ours is still at the root. (The move's own line may be missing: the
   native bootstrap can resolve the store before the Rust logger exists; the verdict reads the root
   back either way.) Should an ERROR appear, it now names the `NSError` - copy it into the entry.
2. Receive a push with the app killed (the extension decrypts it: the store answers from the
   extension too), then open a share from Photos (the share extension's path), and check both reach
   the app as before.
3. `python -m pymobiledevice3 backup2 backup --full <dir>` (encryption off), then read `Manifest.db`:
   `select domain, relativePath from Files where domain like 'AppDomainGroup-group.fr.emse.canari'`.
   **PASS** when it lists no file at all (directory rows only, if any) - against 35 files on
   `1.7.2-alpha.1`. Delete the backup after reading.
4. Relaunch once: still 6/6, no move line, nothing at ERROR.

When it passes, record it in [device-verification](../device-verification.md) and delete this file
together with [the launch pass's own reading](reading-owed-ios-local-data-out-of-backups.md) if that
one passed in the same sitting.
