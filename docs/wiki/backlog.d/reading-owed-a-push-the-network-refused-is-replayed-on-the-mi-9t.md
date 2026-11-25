## Reading owed - P2 - a DM push whose catch-up could not reach the server becomes its real text once the network is back, on the Mi 9T

target: 1.8.2

**Built (2026-11-25), verified by the JVM suite and by COMPILING only**
([mobile](../frontend/mobile.md#a-push-the-network-refused-is-held-and-replayed-2026-11-25)): the
catch-up's transport failure is `PushDecrypt.Unreachable`, the frame is held with its generic line's
instant, and a `NetworkType.CONNECTED` job (`HeldFrameWorker`) replays it on the push lane and
replaces the generic line. No test runs WorkManager, the shade or the JNI decrypt.

**What closes it, on the bench Mi 9T, on the first pre-release that carries it:**

1. **The replay.** A DM whose stored state is one commit behind (the peer commits - adds a device or
   renames the conversation - while the bench app is in the background), then a push of that DM
   arriving while the app's own requests cannot reach the server (for instance Private DNS pointed at
   a host that does not resolve; whether FCM still delivers then is part of the reading). The shade
   shows "Nouveau message"; the exported log holds `fetchCommitsFromBackend: Unreachable` and
   `hold: server unreachable -> frame held`, and NO `MlsBackgroundWorker enqueued` for that frame.
   Restore the network: the line becomes the real text, with NO second sound or vibration, and the log
   holds `doWork: replay UPGRADED`.
2. **The app opens first.** Same setup, but open the app before restoring the network, then restore it:
   no line is re-posted, and logcat holds `takenOverByApp` and, if a job ran, `doWork: nothing held`
   at debug - never a `replay UPGRADED`.
3. **The line is read first.** Same setup, swipe the generic line away, then restore the network: nothing
   is posted, logcat holds `doWork: replay GONE` at debug.
4. **No smart reply to a placeholder.** On the generic line of item 1, the notification offers
   "Répondre" and "Marquer comme lu" and NO suggested-reply chips; on a real line the chips are back.

A failure names the step: the hold (no `hold:` line), the job (no `doWork` after the network came
back), or the replace (two lines for one message).
