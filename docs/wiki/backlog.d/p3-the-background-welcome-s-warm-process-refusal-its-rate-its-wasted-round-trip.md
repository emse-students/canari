## The background Welcome's warm-process refusal: two native changes

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

1. **The phone learns it is warm too late.** `processWelcomeRequestBackground`
   (`CanariFirebaseMessagingService.kt`) fetches the KeyPackage over HTTP and takes the Redis add-lock
   BEFORE the JNI prepare refuses `warm-process`: one wasted round trip and a held lock per push. A
   cheap JNI probe (`live_manager_in_process`) checked before the fetch removes it; the prepare's own
   check stays, since the compare-and-swap is the proof.
2. **The old-PIN recovery marks the process warm only at install.** The branch of `commands/mls.rs`
   that installs CALLER-SUPPLIED bytes (`mark_foreground_manager_loading`) marks the process when it
   installs them, not when the WebView read them. Bytes read before a cold stage write and installed
   after it build a manager without the stage, which then persists over it while the server may hold
   the commit. Closing it means marking the process warm before those bytes are read, or re-reading
   `mls.bin` under the lock at install.

**The rate reading is closed (2026-11-14, owner: read or deleted).** By construction a warm process
refuses EVERY background Welcome: `live_manager_in_process` is set by the first foreground load and
never cleared while the process lives, so on a warm process the refusal rate is 100 % and needs no
measure. The share of pushes that reach a warm process is a field number: `warm-process` appears in
no server log (the refusal is native and never reported), and a Mi 9T logcat of 37,893 lines
(2026-11-14, the app foreground and background for hours) held no `prepare` line and no Welcome push,
so the bench cannot give a denominator. Whether a warm process needs its own path is a design question
for the next native change, not a pending reading; 1 and 2 are native changes for their own pull
request.
