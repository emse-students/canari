import type { Component } from 'svelte';
import { CreditCard, Wallet, ShoppingBag, Handshake } from '@lucide/svelte';
import type { AssociationProduct } from '$lib/associations/api';

/** Fallback icon for a partnership card with no custom `iconUrl`. */
export const PARTNERSHIP_FALLBACK_ICON: Component = Handshake;

/** Fallback icon for a product card with no custom `iconUrl`, chosen by product type. */
export function productFallbackIcon(type: AssociationProduct['type']): Component {
  return type === 'membership' ? CreditCard : type === 'balance_topup' ? Wallet : ShoppingBag;
}

/**
 * The human name of a card brand, for "Visa •••• 4242".
 *
 * ONE TABLE. It was written in `PaymentModal` and again in `SettingsPaymentsSection`, so adding a
 * brand in the place you happened to be looking left the other screen printing a capitalised slug.
 * Anything not listed falls back to the slug with its first letter raised, which is right for the
 * brands Stripe names plainly and wrong for none of them badly.
 */
export function paymentBrandLabel(brand: string): string {
  const labels: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
  };
  return labels[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}
