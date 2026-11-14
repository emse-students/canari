## P3 - EXIT-FORTIFY: closing the app on the Mi 9T logs `FORTIFY: pthread_mutex_lock called on a destroyed mutex` from the render thread

target: 1.7.0

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
