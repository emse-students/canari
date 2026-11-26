/**
 * Resolves once the SvelteKit router can take a navigation: the root layout's FIRST `afterNavigate`
 * calls {@link markRouterReady}.
 *
 * `hooks.client.ts` runs BEFORE the router is created, and a `goto` issued then no-ops in silence. A
 * one-shot input that is CONSUMED when it is read (the iOS notification tap, taken from its file)
 * must therefore not be read before this resolves, or a page link is lost with nothing to retry it
 * (review of #2843, F4).
 *
 * NOT THE LAYOUT'S `onMount`, which it used to be: the root mounts INSIDE the first navigation, before
 * SvelteKit marks itself started and before that navigation finishes. A `goto` issued from there
 * either re-enters the client's start-up path or aborts the first navigation, and one issued before it
 * reads a current URL that is still null (`Cannot read properties of null (reading 'pathname')`, a
 * cold-start tap on an admin notification, 2026-11-25). The first `afterNavigate` runs once that
 * navigation has settled, which is the fact every consumer needs.
 */
let resolveReady: () => void = () => {};
let ready = false;

/** The promise every early consumer awaits. */
export const routerReady: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

/** Called by the root layout once its first navigation has settled. Idempotent. */
export function markRouterReady(): void {
  if (ready) return;
  ready = true;
  console.log('[router] ready - deferred one-shot inputs may be taken');
  resolveReady();
}

/**
 * Resolves {@link routerReady} on the FIRST navigation that settles: the root layout passes
 * SvelteKit's `afterNavigate`, which must be called during component initialisation. Injected so a
 * test drives the real wiring with a fake `afterNavigate`.
 */
export function readyOnFirstNavigation(afterNavigate: (callback: () => void) => void): void {
  afterNavigate(() => markRouterReady());
}
