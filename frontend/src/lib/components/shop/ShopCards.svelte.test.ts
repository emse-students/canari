// @vitest-environment happy-dom
/** The shop cards: ONE membership card with the tiers inside, prices in the locale's money format. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationProduct } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { formatMoney } from '$lib/shop/money';

vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));

import MembershipCard from './MembershipCard.svelte';
import ProductCard from './ProductCard.svelte';

const product = (over: Partial<AssociationProduct>): AssociationProduct =>
  ({
    id: 'p',
    associationId: 'a',
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
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = '';
});

describe('MembershipCard', () => {
  it('is one card, a row per tier, a rise showing the due amount with the full price struck', () => {
    const rise = product({
      id: 'avec',
      name: 'Avec alcool',
      type: 'membership',
      amountCents: 3000,
      viewerDueCents: 1500,
      viewerTierRelation: 'higher',
    });
    const other = product({
      id: 'x',
      name: 'Autre palier',
      type: 'membership',
      amountCents: 4000,
      viewerDueCents: 4000,
      viewerTierRelation: 'higher',
    });
    cmp = mount(MembershipCard, { target: document.body, props: { tiers: [rise, other] } });
    flushSync();
    expect(document.querySelectorAll('[data-membership-card]')).toHaveLength(1);
    const rows = document.querySelectorAll('[data-tier-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-due]')?.textContent).toBe(formatMoney(1500, 'eur'));
    expect(rows[0].querySelector('[data-struck]')?.textContent).toBe(formatMoney(3000, 'eur'));
    expect(rows[1].querySelector('[data-struck]')).toBeNull();
    expect(rows[0].querySelectorAll('button')).toHaveLength(1);
    expect(document.body.textContent).toContain(m.shop_membership_rise_hint());
  });
});

describe('ProductCard', () => {
  it('shows a localized label for the top-up, never the snake_case key, and no 15.00 style price', () => {
    cmp = mount(ProductCard, {
      target: document.body,
      props: {
        product: product({
          name: 'balance_topup',
          type: 'balance_topup',
          amountCents: 1500,
          viewerDueCents: 1500,
        }),
      },
    });
    flushSync();
    const text = document.body.textContent ?? '';
    expect(text).toContain(m.shop_label_topup());
    expect(text).not.toContain('balance_topup');
    expect(text).toContain(formatMoney(1500, 'eur'));
    expect(text).not.toMatch(/\d\.\d{2}/);
  });
});

describe('formatMoney', () => {
  it('uses Intl: a decimal comma and a currency sign, never toFixed', () => {
    expect(formatMoney(1500, 'eur')).toMatch(/15[,.]00/);
    expect(formatMoney(1500, 'eur')).toMatch(/€|EUR/);
  });
});
