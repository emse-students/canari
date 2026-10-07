import { describe, expect, it } from 'vitest';
import { cardPaymentCopy, supportsSavedCards } from './paymentProviderCopy';
import { m } from '$lib/paraglide/messages';

describe('cardPaymentCopy', () => {
  it('speaks Stripe wallets only for Stripe', () => {
    expect(cardPaymentCopy('stripe').label).toBe(m.form_card_payment_label());
    expect(cardPaymentCopy('lydia').label).not.toBe(m.form_card_payment_label());
    expect(cardPaymentCopy('lydia').description).not.toBe(m.form_card_payment_desc());
  });

  it('says nothing provider-specific while the provider is unknown or disabled', () => {
    for (const provider of [null, 'disabled'] as const) {
      const copy = cardPaymentCopy(provider);
      expect(copy.description).toBeNull();
      expect(copy.label).not.toBe(m.form_card_payment_label());
    }
  });
});

describe('supportsSavedCards', () => {
  it('is true for Stripe alone', () => {
    expect(supportsSavedCards('stripe')).toBe(true);
    expect(supportsSavedCards('lydia')).toBe(false);
    expect(supportsSavedCards('disabled')).toBe(false);
    expect(supportsSavedCards(null)).toBe(false);
  });
});
