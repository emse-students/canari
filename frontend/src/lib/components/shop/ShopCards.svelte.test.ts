// @vitest-environment happy-dom
/**
 * The shop cards, mounted for real: ONE membership card with the tiers inside, prices in the
 * locale's money format, and the card itself gone (with its reason) when cotisations are
 * disabled - a real gap found during the #2546 reconciliation, since the old per-page template
 * kept rendering the card for an association with no cotisations to sell at all.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationProduct } from '$lib/associations/api';
import { formatAmount } from '$lib/forms/fillAnswers';
import { m } from '$lib/paraglide/messages';

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
    expect(rows[0].querySelector('[data-due]')?.textContent).toBe(formatAmount(1500, 'eur'));
    expect(rows[0].querySelector('[data-struck]')?.textContent).toBe(formatAmount(3000, 'eur'));
    expect(rows[1].querySelector('[data-struck]')).toBeNull();
    expect(rows[0].querySelectorAll('button')).toHaveLength(1);
  });

  it('HIDES THE TIER LIST AND SHOWS THE REASON when the association has disabled cotisations', () => {
    // The gap this reconciliation closed: `offeredTiers` already refuses a disabled association's
    // tiers, but the OLD per-page template still rendered `<MembershipCard>` whenever `tiers` was
    // non-empty, which it never is here - so nothing told a visitor WHY there was no card.
    const tier = product({
      id: 'd',
      type: 'membership',
      viewerTierRelation: 'none',
      cotisationDisabled: true,
    });
    cmp = mount(MembershipCard, {
      target: document.body,
      props: { tiers: [], cotisationDisabled: true, allProducts: [tier] },
    });
    flushSync();
    expect(document.querySelectorAll('[data-membership-card]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-tier-row]')).toHaveLength(0);
    const reason = document.querySelector('[data-cotisation-disabled]');
    expect(reason?.textContent).toBe(m.shop_cotisation_disabled());
  });

  it('blocks a members-only tier when the viewer’s cotisant standing is not yet known', () => {
    // `viewerIsCotisant` is optional on the type; `undefined` must read as "not confirmed a
    // member", never as "not confirmed NOT a member" - `=== false` let an unannotated tier's
    // button through live.
    const blocked = product({
      id: 'staff',
      type: 'membership',
      viewerTierRelation: 'higher',
      membersOnly: true,
      viewerIsCotisant: undefined,
    });
    cmp = mount(MembershipCard, { target: document.body, props: { tiers: [blocked] } });
    flushSync();
    const row = document.querySelector('[data-tier-row]')!;
    expect(row.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain(m.shop_members_only_hint());
  });
});

describe('ProductCard', () => {
  it('shows a localized label for the top-up, never the snake_case key, and the locale price', () => {
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
    expect(text).toContain(formatAmount(1500, 'eur'));
    // The base (French) locale writes a comma, never the ASCII dot a `toFixed(2)` always wrote.
    expect(text).not.toMatch(/\d\.\d{2}/);
  });

  it('blocks a members-only product when the viewer’s cotisant standing is not yet known', () => {
    cmp = mount(ProductCard, {
      target: document.body,
      props: {
        product: product({ membersOnly: true, viewerIsCotisant: undefined }),
      },
    });
    flushSync();
    expect(document.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain(m.shop_members_only_hint());
  });
});
