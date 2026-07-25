/**
 * Lightweight structured logger for the Canari frontend.
 *
 * Produces timestamped console.debug entries prefixed with a tag so
 * developers can filter traces in the browser DevTools by [tag].
 *
 * WHY: The project convention requires Log.d() at function entry points,
 * key decisions, and error branches. Centralizing the call site avoids
 * scattered console.debug / console.log calls and makes log format
 * consistent across the codebase.
 */

/** Logs a debug-level entry with an optional payload. */
function d(tag: string, payload?: unknown): void {
  if (typeof window === 'undefined') return;
  const ts = new Date().toISOString();
  if (payload !== undefined) {
    console.debug(`[${ts}] [${tag}]`, payload);
  } else {
    console.debug(`[${ts}] [${tag}]`);
  }
}

export const Log = { d } as const;
