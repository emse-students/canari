import { describe, expect, it } from 'vitest';
import { onlinePaymentCopy } from './paymentProviderCopy';
import { m } from '$lib/paraglide/messages';

describe('onlinePaymentCopy', () => {
  it('names Paiement Canari and the Lydia page for Lydia', () => {
    const copy = onlinePaymentCopy('lydia');
    expect(copy.state).toBe('available');
    expect(copy.label).toBe(m.form_online_payment_label());
    expect(copy.description).toBe(m.form_online_payment_desc());
  });

  it('says online payment is unavailable for a disabled provider', () => {
    for (const provider of ['disabled'] as const) {
      const copy = onlinePaymentCopy(provider);
      expect(copy.state).toBe('unavailable');
      expect(copy.label).toBe(m.form_online_payment_unavailable_label());
      expect(copy.description).toBe(m.form_online_payment_unavailable_desc());
    }
  });

  it('claims nothing while the provider is unknown', () => {
    const copy = onlinePaymentCopy(null);
    expect(copy.state).toBe('unknown');
    expect(copy.description).toBeNull();
    expect(copy.label).not.toBe(m.form_online_payment_label());
  });

  it('never speaks wallets or card networks in any state', () => {
    for (const provider of ['lydia', 'disabled', null] as const) {
      const copy = onlinePaymentCopy(provider);
      expect(`${copy.label} ${copy.description ?? ''}`).not.toMatch(
        /stripe|visa|mastercard|amex|wallet|apple pay|google pay/i
      );
    }
  });
});
