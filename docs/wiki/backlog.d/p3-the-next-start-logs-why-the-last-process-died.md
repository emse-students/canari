## P3 - the next start logs why the last process died (ApplicationExitInfo)

target: 1.8.4

`[APPLOG] the previous session ended while on screen (killed or crashed)` cannot say which: the
1.8.2 log of a MiGallery handoff shows a death IN FRONT (the on-screen marker was set), which is not
an Android background reclaim. Read `ActivityManager.getHistoricalProcessExitReasons` at the next
start (Android 11+, in the native shell: reason, importance, status - no content) and write one line
the exported log keeps, so the next such death names its cause (an OOM, a native crash, a user stop, a
low-memory kill). The pure formatter goes in `fr.emse.canari.push` with a JVM test; the read in
`CanariApplication`. Not done in the noise batch: it needs a device reading to prove the line lands.
Context: [sessions](../sessions.md#one-tap-is-one-open-the-handoff-has-an-in-flight-guard-owners-log-of-2026-11-27-184).
