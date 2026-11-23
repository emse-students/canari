## Reading owed - P2 - the restore signing origin the app reads is the one Credential Manager sends

target: 1.8.0

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
