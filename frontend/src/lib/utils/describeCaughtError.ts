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
    // V8 opens the stack with `name: message` - EVERY line of a multi-line message - and Firefox and
    // Safari do not; that prefix is dropped whole, so the frame budget is spent on frames.
    const stack = caught.stack ?? '';
    const framesText = stack.startsWith(head) ? stack.slice(head.length) : stack;
    const frames = framesText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, DESCRIBED_STACK_FRAMES);
    const oneLineHead = head.replace(/\s*\n\s*/g, ' / ');
    return frames.length > 0 ? `${oneLineHead} | ${frames.join(' | ')}` : oneLineHead;
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
