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

/** Two digits of a minute or a second, three of a millisecond. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * The prefix every console line gets, and the two clocks in it are not the same fact.
 *
 * **THE COLD-START TARGET IS UNDER ONE SECOND AND THESE LINES WERE ACCURATE TO ONE SECOND.** The
 * production export of 2026-09-16 puts `Initialised in WEB mode`, `Verifying PIN...`,
 * `MLS state loaded from IndexedDB` and `Initialising MLS (vault device key path)...` all on the
 * same `[13:32:42]`. A budget cannot be spent against a ruler whose smallest division IS the
 * budget. Worse, the lines that carried no clock at all - `[MLS] key package census`,
 * `[MLS] generateKeyPackage via worker`, every `[API]` line - could not be placed against the ones
 * that did.
 *
 * The WALL CLOCK, at millisecond precision, is what lines a log up with a network waterfall, a
 * server log, or a second device's export. Built by hand rather than by `toLocaleTimeString`, which
 * gives neither the milliseconds nor the same format on two machines.
 *
 * **THERE IS NO `+Nms` OFFSET SINCE 2026-09-20, AND ITS REMOVAL WAS THE CONDITION IT SHIPPED
 * UNDER** (user, 2026-09-18: it is switched off when the cold-start work closes, having read
 * `+428270ms` seven minutes into a session). It printed `performance.now()` on every line because
 * **nothing in a console export says when the page began**, so the distance between the navigation
 * and the app's first word could not be measured any other way - and that distance was 69% of the
 * 2026-09-18 boot.
 *
 * It is gone because that measurement now has an instrument of its own: `markBoot('app-first-line')`
 * records exactly the same quantity, as one number rather than a subtraction the reader performs on
 * every line, and it reported 331-485 ms across three production readings on 2026-09-20. **A second
 * instrument for a question one already answers is noise on every line the application ever
 * prints** - which is the whole objection the user raised. The boot bench is
 * {@link installBootBenchDevTools}, read with `window.__canariBootBench.get()`.
 * [cold-start](../../../../docs/wiki/frontend/cold-start.md).
 */
function logPrefix(): string {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once, never stored, never mutated
  const now = new Date();
  const clock = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.${pad(now.getMilliseconds(), 3)}`;
  return `[${clock}]`;
}

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
 * Installs the one rule every console line obeys: a millisecond timestamp in front of it, and long
 * identifiers condensed inside it. String arguments are condensed via {@link truncateLogIds}; the
 * others (objects, errors) pass through unchanged. Idempotent: wraps the console only once
 * regardless of how many times it is called.
 *
 * Covers every web log from a single entry point - `[API]`, `[WS]`, `appendLog`, `[RUST::INFO]`… -
 * without touching the dozens of call sites. Installed from `hooks.client.ts`, the earliest client
 * seam there is, so it is in place before anything has spoken.
 *
 * THE PREFIX IS ITS OWN ARGUMENT, never concatenated onto the first one. `console.log(obj)` is a
 * legitimate call and prepending a string to it would turn an inspectable object into text; passing
 * the prefix separately leaves every argument exactly as its caller wrote it. This is safe here
 * because nothing in this codebase uses a `%s`/`%c` format string, where the first argument is a
 * specifier rather than a value.
 *
 * WHAT IT CANNOT REACH IS A WORKER. Each worker has its own global console and never runs this
 * file, so `mlsKeyPackage.worker` and its siblings still print unstamped. They are the one place a
 * reader must fall back to ordering.
 */
export function installConsoleIdTruncation(): void {
  if (installed) return;
  installed = true;

  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const;
  for (const method of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void =>
      original(logPrefix(), ...args.map((a) => (typeof a === 'string' ? truncateLogIds(a) : a)));
  }
}
