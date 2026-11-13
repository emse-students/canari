// @vitest-environment happy-dom
/**
 * A buyer the https return left in the phone's browser has no session on /shop: the page says the
 * payment went to Lydia and offers the app (the same notice the login page shows a form payer).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const state = vi.hoisted(() => ({ url: new URL('https://canari.test/shop') }));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
    state: {},
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), replaceState: vi.fn() }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => null }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => false }));

import Page from './+page.svelte';

let cmp: ReturnType<typeof mount> | null = null;
async function render(url: string) {
  state.url = new URL(url);
  cmp = mount(Page, { target: document.body });
  for (let i = 0; i < 6; i++) await tick();
  flushSync();
}
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = '';
});

describe('/shop without a session after a purchase return', () => {
  it('says where the payment went and offers the app', async () => {
    await render(
      'https://canari.test/shop?purchase_success=1&productId=p1&checkout_id=c1&association_id=a1'
    );
    const note = document.querySelector('[data-payment-return]');
    expect(note?.textContent).toContain(m.form_payment_handed_heading());
    expect(note?.querySelector('a')?.getAttribute('href')).toContain('checkout_id=c1');
  });

  it('says nothing on a plain visit', async () => {
    await render('https://canari.test/shop');
    expect(document.querySelector('[data-payment-return]')).toBeNull();
  });
});
