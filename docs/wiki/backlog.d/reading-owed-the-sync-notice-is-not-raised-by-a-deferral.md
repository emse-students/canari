## Reading owed - P2 - "Synchronisation en attente" is no longer raised with the app open, on the Mi 9T

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

**Built (2026-11-26), verified by the JVM suite, `cargo test` and by COMPILING only**
([mobile](../frontend/mobile.md#the-pending-db-sweep-raises-its-notice-on-real-failures-only-2026-11-26)):
`MlsBackgroundWorker` no longer defers to the foreground or to `MlsStateLock`, and the "open the app"
notice is raised by three consecutive REAL sweep failures (`SweepFailureLedger`), never by
WorkManager's `runAttemptCount`. No test runs WorkManager, the shade or the JNI sweep.

**What closes it, on the bench Mi 9T, on the first pre-release that carries it:**

1. **App open.** With the app in front, receive several messages from another account over a few
   minutes, including one the push cannot decrypt (a DM one commit behind) so a refused frame
   enqueues the sweep. No "Synchronisation en attente" notification appears; logcat
   (`adb logcat -s CanariWorker`) holds `doWork: pending DB swept` at debug and no
   `giving up` line.
2. **App in the background.** Same, with the app sent to the background (not swiped away). Same
   result: real message lines only, no "Synchronisation en attente".
3. **App opened from the message.** Tap a message notification to open the app, receive two more
   messages, leave it open two minutes: no "Synchronisation en attente".

**Read on the Mi 9T, 1.8.2-alpha.7 (2026-11-26):** across background and foreground cycles no false "Synchronisation en attente" appeared. Still owed: the sweep path with a frame the MLS layer refuses (item 1's undecryptable DM), which the bench did not produce.

**Read on the Mi 9T, `1.8.2-alpha.8` (2026-11-26, [sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-mi-9t-the-v22-store-upgraded-a-picked-file-sent-the-person-filter-tous-in-a-salon)):** across an upgrade, two cold starts and seven trips to the system pickers no "Synchronisation en attente" appeared (none of the app's notifications in `dumpsys notification`). The refused-frame sweep path is still not produced.
