// @vitest-environment happy-dom
/**
 * THE SHOP PAGE'S MEMBERSHIP CARD (user, 2026-10-26): one card with the tiers inside, none at all
 * for the holder of the highest tier, and a paid return that names what was bought.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { AssociationProduct } from '$lib/associations/api';

const state = vi.hoisted(() => ({
  products: [] as unknown[],
  url: new URL('https://canari.test/shop'),
}));

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
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listAllProducts: () => Promise.resolve(state.products),
  listAssociations: () =>
    Promise.resolve([
      { id: 'a1', name: 'Le Cercle', slug: 'cercle', description: '', logoUrl: null },
    ]),
  listAllPartnerships: () => Promise.resolve([]),
  confirmProductCheckout: () =>
    Promise.resolve({ checkoutId: 'c1', productId: 'topup', status: 'paid' }),
}));

import Page from './+page.svelte';

const product = (over: Partial<AssociationProduct>) =>
  ({
    id: 'p',
    associationId: 'a1',
    name: 'Product',
    description: null,
    amountCents: 1500,
    currency: 'eur',
    type: 'other',
    membersOnly: false,
    allowCustomAmount: false,
    variantKey: null,
    variantLevel: null,
    iconUrl: null,
    badgeText: null,
    ...over,
  }) as AssociationProduct;

let cmp: ReturnType<typeof mount> | null = null;
async function render() {
  cmp = mount(Page, { target: document.body });
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

beforeEach(() => {
  state.url = new URL('https://canari.test/shop');
});
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = '';
});

describe('shop page', () => {
  it('shows no membership card to the holder of the highest tier, and no snake_case top-up name', async () => {
    state.products = [
      product({ id: 'sans', type: 'membership', variantKey: 'sans', viewerTierRelation: 'lower' }),
      product({ id: 'avec', type: 'membership', variantKey: 'avec', viewerTierRelation: 'held' }),
      product({ id: 'topup', type: 'balance_topup', name: 'balance_topup', viewerDueCents: 1500 }),
    ];
    await render();
    expect(document.querySelector('[data-membership-card]')).toBeNull();
    expect(document.body.textContent).not.toContain('balance_topup');
    expect(document.body.textContent).toContain(m.shop_label_topup());
  });

  it('shows ONE membership card for a member of no tier, and only the rise for a lower holder', async () => {
    state.products = [
      product({ id: 'sans', type: 'membership', variantKey: 'sans', viewerTierRelation: 'held' }),
      product({
        id: 'avec',
        name: 'Avec alcool',
        type: 'membership',
        variantKey: 'avec',
        amountCents: 3000,
        viewerDueCents: 1500,
        viewerTierRelation: 'higher',
      }),
    ];
    await render();
    expect(document.querySelectorAll('[data-membership-card]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-tier-row]')).toHaveLength(1);
    expect(document.querySelector('[data-due]')?.textContent).toMatch(/15[,.]00/);
    expect(document.querySelector('[data-struck]')?.textContent).toMatch(/30[,.]00/);
  });

  it('shows no membership card at all, with its reason, once the association disables cotisations', async () => {
    // The gap this reconciliation closed: the OLD per-page template rendered `<MembershipCard>`
    // whenever any membership product existed, with no way to say WHY every row in it was refused.
    state.products = [
      product({
        id: 'sans',
        type: 'membership',
        variantKey: 'sans',
        viewerTierRelation: 'none',
        cotisationDisabled: true,
      }),
    ];
    await render();
    expect(document.querySelectorAll('[data-membership-card]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-tier-row]')).toHaveLength(0);
    expect(document.querySelector('[data-cotisation-disabled]')?.textContent).toBe(
      m.shop_cotisation_disabled()
    );
  });

  it('names the top-up on a paid return, without claiming the credit landed', async () => {
    state.products = [product({ id: 'topup', type: 'balance_topup', name: 'balance_topup' })];
    state.url = new URL(
      'https://canari.test/shop?purchase_success=1&checkout_id=c1&association_id=a1&productId=topup'
    );
    await render();
    expect(document.querySelector('[data-checkout-return="paid"]')?.textContent).toContain(
      m.shop_return_topup_paid()
    );
  });
});
