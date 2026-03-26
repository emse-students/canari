import type { Handle } from '@sveltejs/kit';

// Static SPA (adapter-static / Tauri) — no server-side auth logic.
// Token management is handled entirely client-side via src/lib/stores/auth.ts.
export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event);
};
