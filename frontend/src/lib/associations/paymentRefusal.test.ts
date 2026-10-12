import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import { providerRefusalMessage } from './paymentRefusal';

describe('providerRefusalMessage', () => {
  it('prefixes the provider reason with the sentence that says who refused', () => {
    const err = new SocialApiError('Ce lieu est bloque', 'PAYMENT_PROVIDER_REFUSED', 400);
    expect(providerRefusalMessage(err)).toBe(
      m.shop_payment_refused({ reason: 'Ce lieu est bloque' })
    );
  });

  it('is null for any other failure, so each surface keeps its own generic line', () => {
    expect(providerRefusalMessage(new SocialApiError('boom', null, 500))).toBeNull();
    expect(providerRefusalMessage(new SocialApiError('x', 'OTHER', 400))).toBeNull();
    expect(providerRefusalMessage(new Error('PAYMENT_PROVIDER_REFUSED'))).toBeNull();
  });
});
