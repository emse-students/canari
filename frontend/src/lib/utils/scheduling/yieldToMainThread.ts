/**
 * Yields so the browser can paint and handle input between heavy MLS catch-up steps.
 * Does not move work off-thread - WASM / Tauri crypto still runs on the main path,
 * but the event loop gets a chance to run between queue items.
 *
 * THIS MUST RESOLVE IN A HIDDEN DOCUMENT, and that is a correctness requirement, not a nicety.
 * `requestAnimationFrame` never fires while a tab is in the background, and this helper is awaited
 * inside the inbound MLS pipeline - `runSaveEncrypted` opens with it, and that runs in `onDrainEnd`,
 * whose await sits in front of `isDraining = false`. On rAF alone a backgrounded tab therefore
 * stopped draining forever: the message decrypted, its UI flush stayed buffered, every later message
 * was enqueued without starting a drain, and nothing was logged. Measured on prod 2026-08-06 - a
 * hidden tab hung 26 s and released at the exact millisecond it was brought back to the foreground.
 *
 * So the frame and a fallback are RACED rather than chosen between. Choosing on
 * `document.visibilityState` would still hang whenever the tab is hidden after the callback is
 * queued, which is precisely what a user does: send, switch away, come back.
 *
 * The fallback is a `MessageChannel` round trip, not `setTimeout`: background tabs clamp timers to
 * roughly 1 Hz and clamp them far harder after a few minutes, so a timer-based yield would turn a
 * catch-up of a hundred messages into minutes of stalling. A port message is a real macrotask and is
 * not subject to that clamp. `setTimeout` remains only for environments with neither API.
 */
export function yieldToMainThread(): Promise<void> {
  const hasRaf = typeof requestAnimationFrame === 'function';
  const hasChannel = typeof MessageChannel === 'function';

  if (!hasRaf && !hasChannel) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      resolve();
    };

    if (hasRaf) requestAnimationFrame(() => settle());

    if (hasChannel) {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        settle();
      };
      channel.port2.postMessage(null);
    }
  });
}
