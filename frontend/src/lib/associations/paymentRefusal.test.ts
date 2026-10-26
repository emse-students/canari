import { afterEach, describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { amountBoundsOf, SocialApiError, socialRefusal } from './api';
import { providerRefusalMessage } from './paymentRefusal';
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

  it('CONTROL: the range code with no bounds falls through to the generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('x', 'AMOUNT_OUT_OF_RANGE', 400))).toBeNull();
  });

  it('words a second answer on a single-answer form from its code', () => {
    const err = new SocialApiError('You have already answered this form.', 'ALREADY_ANSWERED', 409);
    expect(providerRefusalMessage(err)).toBe(m.form_already_answered());
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
          'A checkout of this product is already being opened.',
          'CHECKOUT_IN_PROGRESS',
          409
        )
      )
    ).toBe(m.shop_checkout_in_progress());
  });

  it('is null for any other failure, so each surface keeps its own generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('boom', null, 500))).toBeNull();
    expect(providerRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
    expect(providerRefusalMessage(new Error('PAYMENT_PROVIDER_REFUSED'))).toBeNull();
  });
});
