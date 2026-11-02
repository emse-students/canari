/**
 * Resolves once the SvelteKit router exists: the root layout's `onMount` calls {@link markRouterReady}.
 *
 * `hooks.client.ts` runs BEFORE the router is created, and a `goto` issued then no-ops in silence. A
 * one-shot input that is CONSUMED when it is read (the iOS notification tap, taken from its file)
 * must therefore not be read before this resolves, or a page link is lost with nothing to retry it
 * (review of #2843, F4).
 */
let resolveReady: () => void = () => {};
let ready = false;

/** The promise every early consumer awaits. */
export const routerReady: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

/** Called by the root layout once mounted. Idempotent. */
export function markRouterReady(): void {
  if (ready) return;
  ready = true;
  console.log('[router] ready - deferred one-shot inputs may be taken');
  resolveReady();
}
