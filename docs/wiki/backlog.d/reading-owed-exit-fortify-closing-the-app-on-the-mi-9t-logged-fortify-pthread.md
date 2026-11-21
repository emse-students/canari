## P3 - EXIT-FORTIFY: closing the app on the Mi 9T logs `FORTIFY: pthread_mutex_lock called on a destroyed mutex` from the render thread

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

**What was seen:** closing the app on the Mi 9T logged `FORTIFY: pthread_mutex_lock called on a
destroyed mutex`, recorded as a normal exit (`v1.3.1-alpha.5`, [device-readings](../device-readings-2026-10.md), "the stable gate", #2178).

**The reading, done on the Mi 9T 2026-11-14 (`1.6.12-alpha.2`, dev):** thirteen launches, each left
with two Back presses (`onDestroy: destroying the WebView (changingConfigurations=false,
finishing=true)`), logcat kept and the process's thread names read before each exit. **Six of the
thirteen logged the line**, `F libc` about 20 ms after `onDestroy` (18 ms on the first), echoed by `RustStdoutStderr`. The
thread is named on five of them: **`RenderThread` four times, `Chrome_InProcGpuThread` once** - the
UI and GPU threads of the WebView, still running when the process's `exit()` tears its mutexes down.
`dumpsys activity exit-info` records every one of the thirteen as `EXIT_SELF`, status 0, and **Play's
crash list carries nothing**: no crash or ANR issue in 28 days, crash rate 0.0000 on 2026-11-13
(`bun tools/play-vitals/vitals.mjs`).

**So it is not a crash, and it is still noise at level `F` on half the exits**, which the standing
rule does not accept. Owed: find what calls `exit()` while the WebView's render and GPU threads are
alive (the finishing `onDestroy` path), and end the process after them or let Android end it - then
the same thirteen exits show no `FORTIFY` line.

**Owed, moved here from the Root Back entry (fixed by #3544, merged):** `MainActivity.kt` is compiled by no PR gate, so on the Mi 9T after the next pre-release read that Back at a root tab with no history sends the app to the background (`moveTaskToBack`, log "moving the task to the background") and leaves the process alive, so the next launch is warm ([mobile](../frontend/mobile.md#back-at-a-root-tab-goes-to-the-background-owner-2026-11-14)). It also changes this entry's own reading: two Back presses no longer reach `onDestroy` from a root tab, so the FORTIFY line now needs another way out of the app.

**Mi 9T, 2026-11-16 (`1.7.0-alpha.2`): #3544 READ, FORTIFY unreachable from Back.** Four warm relaunches then Back at the root: `MainActivity: Back at the root with no history on API 36 - moving the task to the background`, the same pid kept, the launcher in focus, no `onDestroy`, 0 `FORTIFY` lines. The "Back at a root tab goes to the background" part of this entry is therefore closed; **what is left is a way out of the app that reaches `onDestroy` with the WebView's render thread alive** (an OS-initiated finish, not Back), and none was found that needs no swipe from a screen edge.

**Mi 9T, 2026-11-21 (`1.7.3-alpha.1`, sitting r173a2): the #3544 part PASS again.** Four cycles of
Back at a root tab, the pid the same throughout, each logging `MainActivity: Back at the root with no
history on API 36 - moving the task to the background`; 0 `onDestroy`, 0 `FORTIFY`. **Still owed:** a
way out of the app that reaches `onDestroy` with the WebView's render thread alive.
