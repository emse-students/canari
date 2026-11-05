/**
 * Carries the Android push service's warnings and errors into the in-app log (2026-11-04).
 *
 * The FCM service (`CanariFirebaseMessagingService`, tag `CanariFCM`) logs to logcat, which no
 * member can export, so a tester's log said nothing about WHY a salon banner went up blind
 * ("Quelqu'un" / "Nouveau message dans #salon"). Its WARN and ERROR lines now also go to a bounded
 * file (`NativePushLog.kt`, `commands/native_push_log.rs`); `take_native_push_log` hands them over
 * and this writes each one as `[NATIVE_PUSH] <the service's own stamp> <W|E> <tag>: ...`. The
 * Android counterpart of `nseOutcomes.ts`.
 *
 * THROUGH THE CONSOLE, SO THROUGH THE SAME REDACTION: each line is written with `log`
 * (`appendLog`), which the console wrapper captures and passes through `redactLogLine` before it is
 * stored - a service line leaves the device under exactly the rules every other line does.
 *
 * Called at login, at every resume and before an export. Off Android the command answers an empty
 * list.
 */
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/** The prefix every carried line is written under - what a reader of an exported log greps. */
export const NATIVE_PUSH_TAG = '[NATIVE_PUSH]';

/**
 * Formats the taken lines for the log, plus one summary line counting them by level, so a log with
 * many of them is read from its summary first. Empty when nothing was taken.
 */
export function formatNativePushLines(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  let warnings = 0;
  let errors = 0;
  for (const line of lines) {
    // `<yyyy-MM-dd> <HH:mm:ss.SSS> <W|E> <tag>: ...` (`NativePushLogLine`).
    const level = line.split(' ', 3)[2];
    if (level === 'E') errors++;
    else if (level === 'W') warnings++;
  }
  return [
    ...lines.map((line) => `${NATIVE_PUSH_TAG} ${line}`),
    `${NATIVE_PUSH_TAG} ${lines.length} push-service line(s) since the last read: errors=${errors} warnings=${warnings}`,
  ];
}

/**
 * Takes the push service's lines and writes them through `log`. Never throws: a failed take is
 * itself logged, and the lines stay in the file for the next call.
 */
export async function drainNativePushLog(log: (line: string) => void): Promise<number> {
  if (!isTauriRuntime()) return 0;
  let lines: string[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    lines = await invoke<string[]>('take_native_push_log');
  } catch (e) {
    log(`${NATIVE_PUSH_TAG} the push service's log could not be taken: ${String(e)}`);
    return 0;
  }
  for (const line of formatNativePushLines(lines)) log(line);
  return lines.length;
}
