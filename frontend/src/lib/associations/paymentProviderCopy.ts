import { m } from '$lib/paraglide/messages';
import type { PaymentProviderId } from '$lib/associations/api';

/**
 * WHAT A SCREEN MAY SAY ABOUT HOW A PAYMENT IS TAKEN, BY THE PROVIDER THAT IS KNOWN.
 *
 * The form editor used to print Stripe's wallet sentence under every estate, so a Lydia platform
 * promised Apple Pay and a saved card it cannot offer. A provider's name or capability is spoken
 * only for that provider; `null` (not loaded yet, or the load failed) and `disabled` get the
 * neutral line and NO description - never a default, which is how Stripe copy reached Lydia.
 */
export interface CardPaymentCopy {
  label: string;
  /** `null` when nothing true can be said about the methods without knowing the provider. */
  description: string | null;
}

/** The "card" row of a paid form's payment methods. Call at render time (Paraglide). */
export function cardPaymentCopy(provider: PaymentProviderId | null): CardPaymentCopy {
  if (provider === 'stripe') {
    return { label: m.form_card_payment_label(), description: m.form_card_payment_desc() };
  }
  if (provider === 'lydia') {
    return {
      label: m.form_card_payment_label_lydia(),
      description: m.form_card_payment_desc_lydia(),
    };
  }
  return { label: m.form_card_payment_label_generic(), description: null };
}

/**
 * Whether a payer may save a card for later. Stripe only: Lydia has no saved payment methods (every
 * purchase is its own interactive request, `docs/wiki/frontend/modules/payments.md`), and an
 * unknown provider is not a reason to offer one.
 */
export function supportsSavedCards(provider: PaymentProviderId | null): boolean {
  return provider === 'stripe';
}
