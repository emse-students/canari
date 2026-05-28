/**
 * Yields so the browser can paint and handle input between heavy MLS catch-up steps.
 * Does not move work off-thread - WASM / Tauri crypto still runs on the main path,
 * but the event loop gets a chance to run between queue items.
 */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}
