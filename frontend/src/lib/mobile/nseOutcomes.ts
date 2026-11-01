/**
 * Carries the iOS Notification Service Extension's outcome lines into the in-app log.
 *
 * The extension runs in its own process and could only `NSLog`, so a user's exported log said
 * nothing about whether a notification was decrypted, fell back to the generic text, ran out of
 * time or was killed (P1 of 2026-11-01, iPhone notifications showing no content). It now appends
 * one line of codes and numbers per notification to the App Group (`NseOutcomeLog` in
 * `NotificationService.swift`); `take_nse_outcomes` (`commands/nse_outcomes.rs`) hands them over,
 * sanitised to an allowlist of keys, and this writes each one as `[NSE_OUTCOME] {...}`.
 *
 * Called at login and at every resume. Off iOS the command answers an empty list.
 */
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/** The prefix every carried line is written under - what a reader of an exported log greps. */
export const NSE_OUTCOME_TAG = '[NSE_OUTCOME]';

/**
 * Formats the taken lines for the log, plus one summary line counting each outcome, so a log with
 * many notifications is read from its summary first. Empty when nothing was taken.
 */
export function formatNseOutcomes(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    let outcome = 'unparsed';
    try {
      const parsed = JSON.parse(line) as { outcome?: unknown; cause?: unknown };
      if (typeof parsed.outcome === 'string') {
        outcome =
          typeof parsed.cause === 'string' ? `${parsed.outcome}/${parsed.cause}` : parsed.outcome;
      }
    } catch {
      // The Rust side re-serialised every line, so this is not expected; counted, never dropped.
    }
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
  return [
    ...lines.map((line) => `${NSE_OUTCOME_TAG} ${line}`),
    `${NSE_OUTCOME_TAG} ${lines.length} notification(s) handled by the extension since the last read: ${summary}`,
  ];
}

/**
 * Takes the extension's outcome lines and writes them through `log`. Never throws: a failed take
 * is itself logged, and the lines stay in the App Group for the next call.
 */
export async function drainNseOutcomes(log: (line: string) => void): Promise<number> {
  if (!isTauriRuntime()) return 0;
  let lines: string[];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    lines = await invoke<string[]>('take_nse_outcomes');
  } catch (e) {
    log(`${NSE_OUTCOME_TAG} the extension's outcome log could not be taken: ${String(e)}`);
    return 0;
  }
  for (const line of formatNseOutcomes(lines)) log(line);
  return lines.length;
}
