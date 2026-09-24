/**
 * True when running inside the Tauri WebView (desktop/mobile), false in an ordinary browser tab.
 *
 * Kept dependency-free, in its own module: `apiUrl.ts` (service base URLs) needs it and
 * `openExternal.ts` (link handling, which re-exports it for its existing callers) sits behind
 * `checkLinkSafety.ts`, which itself imports from `apiUrl.ts` - defining it there instead would
 * have closed that loop into a circular import.
 */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}
