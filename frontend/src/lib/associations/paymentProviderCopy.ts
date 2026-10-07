import { m } from '$lib/paraglide/messages';
import type { PaymentProviderId } from '$lib/associations/api';

/**
 * WHAT A SCREEN MAY SAY ABOUT HOW A PAYMENT IS TAKEN, BY THE PROVIDER THAT IS KNOWN.
 *
 * Canari has two payment ways: Lydia, shown to members as "Paiement Canari", and cash (user,
 * 2026-10-07). Stripe is leaving the product, so there is no Stripe wording and no provider
 * choice: the form editor shows ONE non-selectable online line. When the platform's active provider
 * is anything but Lydia (a leftover `stripe` on some estate, or `disabled`) the line says
 * explicitly that online payment is unavailable - never a default. While the provider is still
 * unknown (loading, or the load failed) the line is neutral and carries no description.
 */
export interface OnlinePaymentCopy {
  /** `available` only for Lydia; `unavailable` for stripe/disabled; `unknown` for null. */
  state: 'available' | 'unavailable' | 'unknown';
  label: string;
  /** `null` when nothing true can be said without knowing the provider. */
  description: string | null;
}

/** The online-payment row of a paid form's payment methods. Call at render time (Paraglide). */
export function onlinePaymentCopy(provider: PaymentProviderId | null): OnlinePaymentCopy {
  if (provider === 'lydia') {
    return {
      state: 'available',
      label: m.form_online_payment_label(),
      description: m.form_online_payment_desc(),
    };
  }
  if (provider === null) {
    return { state: 'unknown', label: m.form_online_payment_unknown_label(), description: null };
  }
  return {
    state: 'unavailable',
    label: m.form_online_payment_unavailable_label(),
    description: m.form_online_payment_unavailable_desc(),
  };
}

/**
 * Whether a payer may save a card for later. Stripe only: Lydia has no saved payment methods (every
 * purchase is its own interactive request, `docs/wiki/frontend/modules/payments.md`), and an
 * unknown provider is not a reason to offer one.
 */
export function supportsSavedCards(provider: PaymentProviderId | null): boolean {
  return provider === 'stripe';
}
