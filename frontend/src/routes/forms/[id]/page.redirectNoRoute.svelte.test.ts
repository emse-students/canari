// @vitest-environment happy-dom
/**
 * A FORM'S `?redirect=` IS OF UNKNOWN ORIGIN - a printed poster's QR code carries one - SO A PATH
 * THIS BUILD HAS NO PAGE FOR MUST STILL LEAD SOMEWHERE (SvelteKit 3, #2613).
 *
 * Kit 3's `goto` rejects a path no route matches. The Back button handed `redirect` to `goto`, so a
 * dead one made Back do nothing; it now goes through `gotoAppPath`, which loads such a path as a
 * document (the server on the web, the embedded build on a phone), and routes a live one as before.
 * A navigation that rejects is logged, never dropped as an unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$app/state', () => route);
const nav = vi.hoisted(() => ({ goto: vi.fn(async (_href: string, _opts?: unknown) => {}) }));
vi.mock('$app/navigation', () => nav);
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  getCalendarEventLinkedToForm: () => Promise.resolve({ linkedEvent: null }),
  getAssociation: () => Promise.reject(new Error('unused')),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Soiree',
      description: '',
      items: [],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      hiddenItemIds: [],
      maySubmit: true,
    }),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  nav.goto.mockClear();
  vi.restoreAllMocks();
});

async function openWithRedirect(redirect: string) {
  route.page.url = new URL(`https://canari.test/forms/f1?redirect=${encodeURIComponent(redirect)}`);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

function clickBack() {
  const back = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.common_back()
  )!;
  back.click();
}

describe("a form's Back, led by its ?redirect=", () => {
  it('routes a page this build has', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await openWithRedirect('/associations/bde');
    clickBack();
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/associations/bde', {}));
    expect(assign).not.toHaveBeenCalled();
  });

  it('loads a path with no page as a document instead of doing nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await openWithRedirect('/a-page-this-build-lost');
    clickBack();
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        new URL('/a-page-this-build-lost', window.location.href).href
      )
    );
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('logs a navigation that rejects instead of leaving it unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    nav.goto.mockRejectedValueOnce(new Error('a navigation that failed'));
    await openWithRedirect('/associations/bde');
    clickBack();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('leaving the form'),
        expect.any(Error)
      )
    );
  });
});
