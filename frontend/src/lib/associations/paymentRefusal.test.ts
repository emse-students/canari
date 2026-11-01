import { afterEach, describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { amountBoundsOf, holderCountOf, SocialApiError, socialRefusal } from './api';
import { membersOnlySaveRefusalMessage, providerRefusalMessage } from './paymentRefusal';
import { formatAmount } from '$lib/forms/fillAnswers';
import { setLocale } from '$lib/paraglide/runtime';

describe('providerRefusalMessage', () => {
  it('prefixes the provider reason with the sentence that says who refused', () => {
    const err = new SocialApiError('Ce lieu est bloque', 'PAYMENT_PROVIDER_REFUSED', 400);
    expect(providerRefusalMessage(err)).toBe(
      m.shop_payment_refused({ reason: 'Ce lieu est bloque' })
    );
  });

  it('words the still-open previous payment in the reader language, not the server English', () => {
    const err = new SocialApiError(
      'The previous payment request is still open.',
      'PREVIOUS_PAYMENT_OPEN',
      409
    );
    expect(providerRefusalMessage(err)).toBe(m.form_previous_payment_open());
  });

  it('words an association whose payments are not active, and one Lydia blocked, apart', () => {
    const notActive = new SocialApiError('Payments off', 'PAYMENTS_NOT_ACTIVATED', 409);
    const blocked = new SocialApiError('Blocked', 'PAYMENTS_BLOCKED', 409);
    expect(providerRefusalMessage(notActive)).toBe(m.shop_payments_not_activated());
    expect(providerRefusalMessage(blocked)).toBe(m.shop_payments_blocked());
    expect(m.shop_payments_not_activated()).not.toBe(m.shop_payments_blocked());
  });

  it('words an out-of-range amount from the typed bounds, not from the server prose', () => {
    const err = new SocialApiError('Lydia accepts ...', 'AMOUNT_OUT_OF_RANGE', 400, {
      minCents: 50,
      maxCents: 100000,
    });
    expect(providerRefusalMessage(err)).toBe(
      m.shop_payment_amount_range({ min: formatAmount(50), max: formatAmount(100000) })
    );
  });

  describe('the bounds read in the reader locale', () => {
    afterEach(() => setLocale('fr', { reload: false }));
    const err = () =>
      new SocialApiError('Lydia accepts ...', 'AMOUNT_OUT_OF_RANGE', 400, {
        minCents: 50,
        maxCents: 100000,
      });

    it('English reads an English amount, not the French one', () => {
      setLocale('en', { reload: false });
      const text = providerRefusalMessage(err()) ?? '';
      expect(text).toContain('€0.50');
      expect(text).toContain('€1,000.00');
      expect(text).not.toContain('0,50');
    });

    it('CONTROL: French reads the French amount', () => {
      setLocale('fr', { reload: false });
      const text = (providerRefusalMessage(err()) ?? '').replace(/\s/g, ' ');
      expect(text).toContain('0,50 €');
    });
  });

  it('words an unbounded maximum as a minimum only', () => {
    const err = new SocialApiError('x', 'AMOUNT_OUT_OF_RANGE', 400, {
      minCents: 100,
      maxCents: null,
    });
    expect(providerRefusalMessage(err)).toBe(m.shop_payment_amount_min({ min: formatAmount(100) }));
  });

  // The cash-grant and shop paths build their error in `socialRefusal`: the bounds survive it.
  it('reads the bounds of a refused response built by socialRefusal (shop, cash grant)', async () => {
    const res = new Response(
      JSON.stringify({ code: 'AMOUNT_OUT_OF_RANGE', message: 'x', minCents: 100, maxCents: 5000 }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
    expect(providerRefusalMessage(await socialRefusal(res))).toBe(
      m.shop_payment_amount_range({ min: formatAmount(100), max: formatAmount(5000) })
    );
  });

  it('amountBoundsOf keeps only whole-cent bounds', () => {
    expect(amountBoundsOf({ minCents: 50, maxCents: null })).toEqual({
      minCents: 50,
      maxCents: null,
    });
    expect(amountBoundsOf({ minCents: 50.5, maxCents: 100 })).toBeNull();
    expect(amountBoundsOf({ minCents: 50, maxCents: '100' })).toBeNull();
    expect(amountBoundsOf({ minCents: 50 })).toBeNull();
    expect(amountBoundsOf(null)).toBeNull();
  });

  // A tier delete refused because people still hold it: the count survives `socialRefusal`.
  it('reads the holder count of a refused tier delete, and only a whole positive one', async () => {
    const res = new Response(
      JSON.stringify({ code: 'TIER_HAS_HOLDERS', message: 'x', holderCount: 3 }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    );
    const err = await socialRefusal(res);
    expect(err.code).toBe('TIER_HAS_HOLDERS');
    expect(err.holderCount).toBe(3);
    expect(holderCountOf({ holderCount: 0 })).toBeNull();
    expect(holderCountOf({ holderCount: 1.5 })).toBeNull();
    expect(holderCountOf({ holderCount: '2' })).toBeNull();
    expect(holderCountOf(null)).toBeNull();
  });

  it('CONTROL: the range code with no bounds falls through to the generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('x', 'AMOUNT_OUT_OF_RANGE', 400))).toBeNull();
  });

  it('words a second answer on a single-answer form from its code', () => {
    const err = new SocialApiError('You have already answered this form.', 'ALREADY_ANSWERED', 409);
    expect(providerRefusalMessage(err)).toBe(m.form_already_answered());
  });

  it('words a held cotisation, and any other audience refusal, from its code', () => {
    expect(providerRefusalMessage(new SocialApiError('x', 'FORM_COTISATION_HELD', 403))).toBe(
      m.form_cotisation_held()
    );
    expect(providerRefusalMessage(new SocialApiError('x', 'FORM_NOT_OPEN_TO_YOU', 403))).toBe(
      m.form_view_not_open_to_you_title()
    );
  });

  it('words a condition both requiring and excluding a cotisation from its code', () => {
    expect(
      providerRefusalMessage(new SocialApiError('x', 'AUDIENCE_COTISATION_BOTH_MODES', 400))
    ).toBe(m.form_condition_cotisation_both_modes());
  });

  it("words a guest's ceiling of waiting answers from its code, never the server English", () => {
    const err = new SocialApiError(
      'This visitor already has 3 answers waiting for payment on this form.',
      'GUEST_PENDING_LIMIT',
      429
    );
    expect(providerRefusalMessage(err)).toBe(m.form_guest_pending_limit());
  });

  it("words a boutique attempt still open with the shop's own bound, not the form's 30 minutes", () => {
    const err = new SocialApiError(
      'The previous payment request for this product is still open.',
      'PREVIOUS_CHECKOUT_OPEN',
      409
    );
    expect(providerRefusalMessage(err)).toBe(m.shop_previous_checkout_open());
    expect(m.shop_previous_checkout_open()).not.toBe(m.form_previous_payment_open());
  });

  it('words "already purchased" and a double click from their codes, never the server English', () => {
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'You have already purchased this product',
          'PRODUCT_ALREADY_PURCHASED',
          409
        )
      )
    ).toBe(m.shop_already_purchased());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'You already hold a membership tier worth at least this one',
          'TIER_NOT_A_RISE',
          409
        )
      )
    ).toBe(m.shop_tier_not_a_rise());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'Your current membership tier cannot be compared with this one',
          'TIER_NOT_RANKABLE',
          409
        )
      )
    ).toBe(m.shop_tier_not_rankable());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          "This association's cotisations are disabled: the product cannot be sold.",
          'COTISATION_DISABLED',
          409
        )
      )
    ).toBe(m.shop_cotisation_disabled());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'This membership product grants no tag: it cannot be sold until it is repaired.',
          'MEMBERSHIP_PRODUCT_UNGRANTABLE',
          409
        )
      )
    ).toBe(m.shop_cotisation_disabled());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          "This product is reserved to the association's cotisants",
          'PRODUCT_COTISANTS_ONLY',
          403
        )
      )
    ).toBe(m.shop_members_only_hint());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'The payment account of this association changed while the purchase was opened.',
          'PAYMENT_ROUTING_CHANGED',
          409
        )
      )
    ).toBe(m.shop_payment_routing_changed());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'The pricing of this product changed while the purchase was opened.',
          'PURCHASE_PRICING_CHANGED',
          409
        )
      )
    ).toBe(m.shop_purchase_pricing_changed());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'A checkout of this product is already being opened.',
          'CHECKOUT_IN_PROGRESS',
          409
        )
      )
    ).toBe(m.shop_checkout_in_progress());
  });

  // A paid form's own refusals: never a product "already bought", never a membership the
  // submitter does not hold.
  it('words the two form tier refusals apart from the shop ones', () => {
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'You already hold the membership this form grants',
          'FORM_TIER_ALREADY_HELD',
          409
        )
      )
    ).toBe(m.form_tier_already_held());
    expect(
      providerRefusalMessage(
        new SocialApiError(
          'This form grants a membership tier that no longer exists',
          'FORM_TIER_NOT_SOLD',
          409
        )
      )
    ).toBe(m.form_tier_not_sold());
    expect(m.form_tier_already_held()).not.toBe(m.shop_already_purchased());
    expect(m.form_tier_not_sold()).not.toBe(m.shop_tier_not_rankable());
  });

  it('words a sale refused for a list or an institution by its typed code, in the reader language', () => {
    const refusal = new SocialApiError(
      'A list does not sell or collect money',
      'ASSOCIATION_KIND_DOES_NOT_SELL',
      403
    );
    expect(providerRefusalMessage(refusal)).toBe(m.asso_kind_does_not_sell());
    expect(providerRefusalMessage(refusal)).not.toContain('does not sell');
  });

  it('is null for any other failure, so each surface keeps its own generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('boom', null, 500))).toBeNull();
    expect(providerRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
    expect(providerRefusalMessage(new Error('PAYMENT_PROVIDER_REFUSED'))).toBeNull();
  });
});

describe('the archived association and the members-only save', () => {
  it('words a purchase from an archived association from its code', () => {
    expect(
      providerRefusalMessage(
        new SocialApiError('This association is archived.', 'ASSOCIATION_ARCHIVED', 409)
      )
    ).toBe(m.shop_association_archived());
  });

  it('words a members-only save with no cotisation mode from its code', () => {
    expect(
      membersOnlySaveRefusalMessage(
        new SocialApiError('Enable the cotisation.', 'MEMBERS_ONLY_WITHOUT_COTISATION', 400)
      )
    ).toBe(m.admin_members_only_without_cotisation());
  });

  it('CONTROL: any other save failure is left to the caller generic line', () => {
    expect(membersOnlySaveRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
    expect(membersOnlySaveRefusalMessage(new Error('MEMBERS_ONLY_WITHOUT_COTISATION'))).toBeNull();
  });
});
