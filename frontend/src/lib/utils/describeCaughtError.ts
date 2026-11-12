/** How many stack frames a described error keeps: enough to name the throwing module, short enough for one log line. */
export const DESCRIBED_STACK_FRAMES = 3;

/**
 * One readable line for a value a `svelte:boundary` (or any `catch`) received.
 *
 * WHY. The chat boundary wrote `` `${e}` ``, and the in-app log of a crashed Android 1.6.6 read
 * `ChatArea error recovered: [object Object]` - the one line that should have named the defect named
 * nothing (2026-11-12). A caught value is `unknown`: an `Error` (its name, message and the first
 * frames of its stack say where), a plain object (its JSON says what), or anything else (its string).
 */
export function describeCaughtError(caught: unknown): string {
  if (caught instanceof Error) {
    const head = `${caught.name}: ${caught.message}`;
    const frames = (caught.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      // V8 repeats `name: message` as the stack's first line; Firefox and Safari do not.
      .filter((line) => line && line !== head)
      .slice(0, DESCRIBED_STACK_FRAMES);
    return frames.length > 0 ? `${head} | ${frames.join(' | ')}` : head;
  }
  if (caught !== null && typeof caught === 'object') {
    try {
      return JSON.stringify(caught);
    } catch (e) {
      return `unserialisable ${Object.prototype.toString.call(caught)} (${String(e)})`;
    }
  }
  return String(caught);
}
