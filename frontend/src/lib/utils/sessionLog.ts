/**
 * Logs a session entry to the browser/device console. On Tauri, `attachConsole` in the layout
 * forwards these to adb logcat.
 *
 * **IT NO LONGER STAMPS THE LINE, AND THAT IS THE FIX RATHER THAN A LOSS.** It used to prepend
 * `new Date().toLocaleTimeString()` - a SECOND-resolution clock, on a project whose cold-start
 * target is under one second, and only on the lines that happened to come through here. Every other
 * console line in the app carried no time at all, so the two could not be placed against each
 * other. `installConsoleIdTruncation` now stamps all of them, in milliseconds, from the earliest
 * client seam there is; see {@link installConsoleIdTruncation} for why there are two clocks in it.
 *
 * What survives here is the NAME: a line that goes through `appendLog` is part of the session
 * narrative a person reads, as opposed to a `Log.d` debug line. Nothing enforces that distinction,
 * so it is a convention and this docblock is where it is written down.
 *
 * **IT LIVES IN A MODULE THAT IMPORTS NOTHING.** It was defined in `globalChatSingleton`, which
 * builds the whole chat session when it loads - so `mediaTouch` importing it for one log line put
 * `globalChatSingleton -> useMessaging -> media -> mediaBlobCache -> mediaTouch` in a cycle, and
 * the dev server failed at random with `MediaService` read before initialization (measured
 * 2026-09-28, on `main` as well). `globalChatSingleton` re-exports it, so its callers are unchanged.
 */
export function appendLog(msg: string): void {
  console.log(msg);
}
