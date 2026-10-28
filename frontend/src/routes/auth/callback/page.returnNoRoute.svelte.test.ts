// @vitest-environment happy-dom
/**
 * A SIGN-IN THAT SUCCEEDED NEVER ENDS ON "THE EXCHANGE FAILED" BECAUSE OF WHERE IT WAS GOING
 * (SvelteKit 3, #2613).
 *
 * The callback's `returnTo` is the page the reader asked for before signing in - of unknown origin,
 * and possibly a page this build does not have (a link to a newer build's page). Kit 3's `goto`
 * rejects such a path, and the rejection landed in the callback's catch, which tells the reader
 * the code exchange failed after it had succeeded. It now goes through `gotoAppPath`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const nav = vi.hoisted(() => ({ goto: vi.fn(async (_href: string, _opts?: unknown) => {}) }));
vi.mock('$app/navigation', () => nav);
const auth = vi.hoisted(() => ({ returnTo: '/posts' }));
vi.mock('$lib/stores/auth', () => ({
  handleOidcCallback: vi.fn(async () => ({ id: 'u1' })),
  getOidcReturnTo: vi.fn(async () => auth.returnTo),
  OidcSignInError: class extends Error {},
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  nav.goto.mockClear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function signInReturningTo(returnTo: string) {
  auth.returnTo = returnTo;
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  window.history.replaceState({}, '', `/auth/callback?code=c-${returnTo}&state=s`);
  const app = mount(Page, { target: document.body });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

describe('the OIDC callback, going back where the reader was', () => {
  it('routes a page this build has, replacing the callback', async () => {
    await signInReturningTo('/calendar');
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/calendar', { replace: true }));
    expect(document.body.textContent).not.toContain(m.auth_callback_exchange_failed());
  });

  it('loads a page this build lacks as a document, and never says the exchange failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    await signInReturningTo('/a-newer-builds-page');
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/a-newer-builds-page'));
    expect(nav.goto).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(m.auth_callback_exchange_failed());
  });
});
