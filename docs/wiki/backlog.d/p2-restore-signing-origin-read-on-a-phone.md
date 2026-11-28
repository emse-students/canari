## Reading owed - P2 - the restore signing origin the app reads is the one Credential Manager sends

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

Built (2026-11-23): the restore plugin's `signing_origins` reads this APK's
`android:apk-key-hash:` origin, and the client mints a restore key only when the registration options'
`origins` include it ([account-restore](../account-restore.md#a-build-the-estate-does-not-vouch-for-is-known-before-any-key-2026-11-23)).
No gate runs the native read. What closes it, on the first pre-release that carries it: on the bench
Mi 9T (release asset installed with `adb`, upload-key signed), a cold start against dev logs
`[RESTORE] register not attempted: this build is signed as android:apk-key-hash:<origin>` at log level
and no `register skipped` warning, and that origin equals the one dev's core-service logged when it
refused the same APK on 2026-11-23; dev's log holds no new `registration refused ... origin` line. On
production, after the stable, core-service still logs `[RESTORE] key registered` for Play-installed
phones (a Play build whose read disagreed would register nothing, and only this count would show it).

**2026-11-23, [`1.8.0-alpha.3`](../device-verification.md#the-readings-of-2026-11-23-180-alpha3-the-form-booking-and-event-pushes-the-restore-on-the-upload-key-the-share-logos) (Mi 9T, dev): the dev half PASS, now that dev vouches for the upload-key origin (#3999).** The release APK installed with `adb` (no installer: `recordInstallerPackage: installed by (none - sideload)`), a cold start logged `CanariRestore: signingOrigins: 1 signer(s)`, `create: restore key created (cloudBackup=true)`, then in the page `[RESTORE] legacy origin refusal record dropped - the signer is read as a fact now`, `register: creating this install's key`, `POST /api/auth/restore/registration` 200 and `[RESTORE] register OK (cloudBackup=true)`. No `register skipped` warning, no `register not attempted` line (the build is vouched for, so nothing is skipped). Dev's core-service log was not read (no access from the bench), so "no new `registration refused ... origin` line" rests on the 200. **Left, and only this:** on production after the stable, core-service still logs `[RESTORE] key registered` for Play-installed phones.

**2026-11-25, `1.8.1-alpha.2` (Mi 9T, dev half, indirect): PASS.** Cold starts logged no `register skipped`, the registration options answered 200 each time, and dev's core-service logs hold no origin refusal. **Still owed:** the production half (a Play-installed phone's key registered after the stable).
