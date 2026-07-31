/**
 * Truncation of long identifiers in logs, for a compact and readable display. Web replica of
 * the logic applied on the Android side by test_adb.py, so that logs from both platforms share
 * the same condensed format.
 */

/** Canonical UUID (8-4-4-4-12), case-insensitive. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Hex run of at least 16 characters (64-hex userId, keys, SHA-256 hashes...). */
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;

let installed = false;

/**
 * Reduces UUIDs and long hexadecimal runs (>= 16 characters) to their first 8 characters
 * followed by " ... ". Short hex values (epochs, counters, CSS colors) are left untouched.
 */
export function truncateLogIds(text: string): string {
  return text
    .replace(UUID_RE, (m) => m.slice(0, 8) + '…')
    .replace(LONG_HEX_RE, (m) => m.slice(0, 8) + '…');
}

/**
 * Installs a global identifier truncation on every `console.*` method. String arguments are
 * condensed via {@link truncateLogIds}; the others (objects, errors) pass through unchanged.
 * Idempotent: wraps the console only once regardless of how many times it is called.
 *
 * Covers every web log from a single entry point - `[API]`, `[WS]`,
 * `appendLog`, `[RUST::INFO]`… - without touching the dozens of call sites.
 */
export function installConsoleIdTruncation(): void {
  if (installed) return;
  installed = true;

  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const;
  for (const method of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void =>
      original(...args.map((a) => (typeof a === 'string' ? truncateLogIds(a) : a)));
  }
}
