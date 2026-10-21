import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import { providerRefusalMessage } from './paymentRefusal';
import { formatPriceCents } from '$lib/utils/canariLinkPreviewFormat';

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
      m.shop_payment_amount_range({ min: formatPriceCents(50), max: formatPriceCents(100000) })
    );
  });

  it('words an unbounded maximum as a minimum only', () => {
    const err = new SocialApiError('x', 'AMOUNT_OUT_OF_RANGE', 400, {
      minCents: 100,
      maxCents: null,
    });
    expect(providerRefusalMessage(err)).toBe(
      m.shop_payment_amount_min({ min: formatPriceCents(100) })
    );
  });

  it('CONTROL: the range code with no bounds falls through to the generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('x', 'AMOUNT_OUT_OF_RANGE', 400))).toBeNull();
  });

  it('is null for any other failure, so each surface keeps its own generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('boom', null, 500))).toBeNull();
    expect(providerRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
    expect(providerRefusalMessage(new Error('PAYMENT_PROVIDER_REFUSED'))).toBeNull();
  });
});
