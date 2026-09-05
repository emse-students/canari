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

/**
 * How much of a rendered payload a line may carry before it is cut.
 *
 * The observer that reads these lines keeps 300 characters of each, so a payload allowed to run
 * longer would push the tag's own sentence out of view on the reader that needs it most.
 */
const MAX_PAYLOAD = 240;

/**
 * A payload as TEXT, because a second console argument is readable in exactly one place.
 *
 * `console.debug(msg, payload)` hands DevTools an object it can expand - and hands every OTHER
 * reader of the same stream the four characters `Object`. The cross-client harness captures console
 * output over CDP and stores `[blocks.isBlockedWith] Object`; so does a copied console dump, and so
 * does the Android relay. That is a line whose subject cannot be recovered, which can therefore be
 * neither explained nor fixed, and a line its reader learns to skip is the one that hides the next
 * defect. Measured 2026-09-05: seven DEL rows carried it as unexplained dirt, and the campaign's own
 * note about it asserts that "its payload is the ANSWER, which is the useful half" - a claim no
 * reader of the capture could check, because the answer was never in the text.
 *
 * IDS SHRINK ON THE WAY OUT AND THAT IS NOT THIS FUNCTION'S DOING. `installConsoleIdTruncation`
 * condenses long hex runs and UUIDs in STRING arguments only, so rendering here is also what puts a
 * payload's identifiers under the same rule as every other log line in the app.
 */
function render(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  // An Error's own text, never `{}`: `JSON.stringify(new Error('x'))` serialises no own enumerable
  // property and would report an empty object about a failure.
  if (payload instanceof Error) return `${payload.name}: ${payload.message}`;
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === 'bigint') return `${value}n`;
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    });
    // `undefined` comes back for a function, a symbol or a bare `undefined` - none of which
    // JSON can express, and all of which `String` can.
    if (text === undefined) return String(payload);
    return text.length > MAX_PAYLOAD
      ? `${text.slice(0, MAX_PAYLOAD)}… (${text.length} chars)`
      : text;
  } catch {
    // A getter that throws, or a Proxy that refuses: the line is still worth printing.
    return String(payload);
  }
}

/** Logs a debug-level entry with an optional payload. */
function d(tag: string, payload?: unknown): void {
  if (typeof window === 'undefined') return;
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.debug(`[${ts}] [${tag}]`);
    return;
  }
  // THE OBJECT IS PASSED AS WELL FOR AN ERROR ALONE, because the stack is the one thing the text
  // cannot carry and the one thing a developer opens an error for. Everything else is rendered and
  // not repeated: a payload printed twice is a line twice as wide for no second reader.
  if (payload instanceof Error) {
    console.debug(`[${ts}] [${tag}] ${render(payload)}`, payload);
    return;
  }
  console.debug(`[${ts}] [${tag}] ${render(payload)}`);
}

export const Log = { d } as const;
