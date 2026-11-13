## Reading owed - the background Welcome's warm-process refusal rate

target: 1.7.0

1. **The warm mark is sticky, so the refusal may be the common case.** `live_manager_in_process` is set
   by the first foreground load and never cleared while the process lives, so a process in which the
   app was ever opened refuses EVERY background Welcome (`prepare refused reason=warm-process`) until
   Android kills it - which it often does not, for hours. The path is then effectively off whenever
   Android keeps the process; the newcomer is served by another member, the foreground, or its own
   external join. **Owed: measure the warm-process refusal rate** against the prepares that reach a
   stage, on the Mi 9T and in the field logs, before deciding whether a warm process needs its own path.
2. **The phone learns it is warm too late.** `processWelcomeRequestBackground`
   (`CanariFirebaseMessagingService.kt`) fetches the KeyPackage over HTTP and takes the Redis add-lock
   BEFORE the JNI prepare refuses `warm-process`: one wasted round trip and a held lock per push. A
   cheap JNI probe (`live_manager_in_process`) checked before the fetch removes it; the prepare's own
   check stays, since the compare-and-swap is the proof.
3. **The old-PIN recovery marks the process warm only at install.** The branch of `commands/mls.rs`
   that installs CALLER-SUPPLIED bytes (`mark_foreground_manager_loading`) marks the process when it
   installs them, not when the WebView read them. Bytes read before a cold stage write and installed
   after it build a manager without the stage, which then persists over it while the server may hold
   the commit. Closing it means marking the process warm before those bytes are read, or re-reading
   `mls.bin` under the lock at install.

Re-read 2026-11-11: the three are unchanged; the rate is a log read, and 2 and 3 are native changes
for their own pull request. Re-read again 2026-12-11.
