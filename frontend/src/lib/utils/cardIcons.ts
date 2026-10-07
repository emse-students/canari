import type { Component } from 'svelte';
import { CreditCard, Wallet, ShoppingBag, Handshake } from '@lucide/svelte';
import type { AssociationProduct } from '$lib/associations/api';

/** Fallback icon for a partnership card with no custom `iconUrl`. */
export const PARTNERSHIP_FALLBACK_ICON: Component = Handshake;

/** Fallback icon for a product card with no custom `iconUrl`, chosen by product type. */
export function productFallbackIcon(type: AssociationProduct['type']): Component {
  return type === 'membership' ? CreditCard : type === 'balance_topup' ? Wallet : ShoppingBag;
}
