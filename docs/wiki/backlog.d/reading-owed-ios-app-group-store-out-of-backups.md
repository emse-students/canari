## Reading owed - iOS: the App Group's files live in a flagged store directory, and no App Group file is in a backup (iPhone 12)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built.** The fix of the P2 *"the iOS App Group root refuses the backup flag, so `mls.bin`
and the push secret still go into an iPhone backup"* (read on `1.7.2-alpha.1`, sitting S16). The
container root is no longer flagged: everything the app and its two extensions share lives in
`store/` inside it, flagged by whichever process creates it, and an older build's root files are
moved in at each process's first resolution (`backup_exclusion::open_store`, an allowlist of our
names; a name an older build wrote back after a downgrade wins over the store's copy, which is
removed for a mirror and quarantined once for a sole copy). A refusal now keeps its `NSError` (domain, code, underlying error, class) in the
one verdict line. Mechanism:
[mobile](../frontend/mobile.md#the-app-group-a-store-directory-never-the-root-172).

**The reading that closes it**, on the bench iPhone 12, a build carrying the store, installed OVER
a `1.7.2-alpha.1` signed in with data (so the move has something to move):

1. Launch, and catch the launch verdict the way S16 did: `syslog live` does not carry the Rust
   log, so poll the Rust log file (`Library/Application Support/fr.emse.canari/logs/Canari.log`,
   pulled over `house_arrest` with `pymobiledevice3 apps pull`) DURING the launch - the log plugin
   rotates it away within seconds ([S16](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)).
   **Expected:** `[BACKUP_EXCLUSION] 6/6 directories excluded from backups, flag read back: ...,
   AppGroup(group.fr.emse.canari)/store` and no `[BACKUP_EXCLUSION]` line at ERROR - the verdict
   also fails when an entry of ours or an unknown name is still at the root, or a move was refused.
   Should an ERROR appear, it names the `NSError`'s domain and code - copy it into the entry.
   **An `unknown` count on this first reading** most likely comes from Foundation's atomic writes.
   `write(to:options: .atomic)` and `NSData writeToFile:atomically:` first write a hidden
   temporary name next to the target (`.dat.nosync...` and the like), then rename it over the
   target. An older build interrupted mid-write leaves such a file at the root. It is not on the
   allowlist, so it is counted as unknown and never moved. Step 3's `Manifest.db` names it: an
   unknown entry sits at the root, outside the flagged store, so the backup carries it. Read that
   name before reading anything else into the count. The code is deliberately
   left alone: no name of this shape is added to the allowlist until a reading shows one. The
   notification extension's own opening line (`[CanariNSE] [BACKUP_EXCLUSION] ...`) IS in
   `syslog live`, when a push woke it first.
2. Receive a push with the app killed (the extension decrypts it: the store answers from the
   extension too), then open a share from Photos (the share extension's path), and check both reach
   the app as before.
3. `python -m pymobiledevice3 backup2 backup --full <dir>` (encryption off), then read `Manifest.db`:
   `select domain, relativePath from Files where domain like 'AppDomainGroup-group.fr.emse.canari'`.
   **PASS** when it lists no file at all (directory rows only, if any) - against 35 files on
   `1.7.2-alpha.1`. Delete the backup after reading.
4. Relaunch once: still 6/6, nothing at ERROR.
5. Optional, the downgrade path: install `1.7.1` over it, open it once, reinstall this build, and
   read one WARN `... entries came back from an older build`, then INFO at the next launch; the
   App Group still holds no file in a new `backup2`. With a sign-out in `1.7.1` before the
   reinstall, the opening line also reads `an older build's sign-out carried: n removed, 0 failures`.

When it passes, record it in [device-verification](../device-verification.md) and delete this file
together with [the launch pass's own reading](reading-owed-ios-local-data-out-of-backups.md) if that
one passed in the same sitting.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`, iPhone 12): step 3 PASS, the rest not recorded.** A full `backup2`: `AppDomain-fr.emse.canari` and `AppDomainGroup-group.fr.emse.canari` hold 0 files (35 on `1.7.2-alpha.1`). A killed-app push decrypted (step 2, push half). The extension domains of the manifest were not examined. **Left:** the 6/6 launch line, the share extension's path, the relaunch and the downgrade path; the extension domains' files.

**2026-11-21, on `1.7.3-alpha.1` (build 100700301), iPhone 12: steps 3 and 4 PASS, and step 1's
verdict.** `[BACKUP_EXCLUSION] 6/6 ... flag read back` on two launches, with no ERROR; an unencrypted
full backup's `Manifest.db` holds only directory rows for the app domains and none of the App Group's
files (35 on `1.7.2-alpha.1`). **Still owed:** the first launch after the update over an older build
(the move's WARN, step 1), the share extension's path and the push half of step 2, and the downgrade
path (step 5).

**2026-11-21, `1.7.3-alpha.3` (build `100700303`), iPhone 12, dev, account `canari-test-gamma`: the first launch after an update PASS, the relaunch PASS, the share extension PASS.** The sitting started from a clean state: the app was uninstalled (`pymobiledevice3 apps uninstall`, so the App Group container is removed too) and `1.7.2-alpha.1` (build `100700201`, the last build before the store, `1.7.2-alpha.2` carrying it) installed from TestFlight "Previous Builds", signed in through the MiConnect local login, the PIN unlocked, a message sent in an existing dev group. Then `1.7.3-alpha.3` was installed over it through TestFlight (the app terminated first) and launched with the Rust log pulled in a loop over `house_arrest` (`apps pull`) during the launch, plus `syslog live` running.
- **First launch after the update, PASS.** One line, no `[BACKUP_EXCLUSION]` line at ERROR in any of the 15 pulls: `[BACKUP_EXCLUSION] 6/6 directories excluded from backups, flag read back: Library/Application Support, Library/WebKit, Library/Preferences, Library/Cookies, Library/HTTPStorages, AppGroup(group.fr.emse.canari)/store`. That verdict also fails when an entry of ours is still at the App Group root, so it shows nothing of ours was left at the root. The store's own opening line (`... root: n moved, n absent, ...`, `StoreOpening::report`) was NOT in any of the 15 pulls: it is written at the process's first store resolution, before the pulled log file starts, so the move's own count is unread (OWED, only an earlier-attached logger or the extension's line can show it). `syslog live` carried no `BACKUP_EXCLUSION` line, as the entry says.
- **Data intact, PASS.** The session survived the update with no sign-in and no PIN prompt; the group's whole history (including the message sent on `1.7.2-alpha.1`) was there, and a new message sent on alpha.3 went out.
- **Relaunch, PASS (step 4).** Terminated and relaunched: the same `6/6` line, nothing at ERROR.
- **Share extension from Photos, PASS.** A photo (an image already in the library) shared from the Photos sheet with the Canari app icon: the extension ran, posted its "Choose the conversation" notice, a hold on its Notification Center row then a tap opened the app on the "Send to..." picker, a conversation picked, "1 file pending" staged and sent: the image arrived as a bubble. The sheet's own conversation cells (the share suggestions) were NOT tapped, so that path is still unread.
- **Not taken in this sitting:** the killed-app push (step 2's push half, passed on S18), the `backup2` domains (step 3, passed on S18, not repeated), the downgrade path (step 5), the extension's own `[CanariNSE] [BACKUP_EXCLUSION]` opening line.
- **Side observation, no defect claimed:** a message typed into the composer on `1.7.2-alpha.1` and not sent was gone after the update (a draft, not a sent message).
