/**
 * Client-side hooks – runs once at app startup before any component renders.
 *
 * Patches `window.fetch` on Tauri to use the native HTTP plugin (bypasses
 * CORS, uses native TLS) so that ALL existing `fetch()` calls throughout the
 * codebase automatically go through the Rust HTTP client.
 */
if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
  import('@tauri-apps/plugin-http').then(({ fetch: tauriFetch }) => {
    window.fetch = tauriFetch as typeof window.fetch;
  });
}
