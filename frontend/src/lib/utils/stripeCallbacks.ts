import { isTauri } from '@tauri-apps/api/core';
import { publicAppUrl } from '$lib/utils/publicAppUrl';

/** True on Tauri Android / iOS - Stripe Checkout must return via app deep link. */
export function isMobileTauri(): boolean {
  if (typeof window === 'undefined' || !isTauri()) return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function stripeDeepLink(path: 'success' | 'cancel', query: string): string {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `fr.emse.canari://stripe/${path}${q}`;
}

function webUrl(path: string): string {
  return publicAppUrl(path.startsWith('/') ? path : `/${path}`);
}

/** Stripe Checkout callbacks for paid form submissions. */
export function formCheckoutCallbacks(): { successUrl: string; cancelUrl: string } {
  if (isMobileTauri()) {
    return {
      successUrl: stripeDeepLink('success', 'session_id={CHECKOUT_SESSION_ID}'),
      cancelUrl: stripeDeepLink('cancel', 'session_id={CHECKOUT_SESSION_ID}'),
    };
  }
  return {
    successUrl: webUrl('/forms/success?session_id={CHECKOUT_SESSION_ID}'),
    cancelUrl: webUrl('/forms/cancel?session_id={CHECKOUT_SESSION_ID}'),
  };
}

/** Stripe Checkout callbacks for association shop product purchases. */
export function shopCheckoutCallbacks(productId: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const pid = encodeURIComponent(productId);
  if (isMobileTauri()) {
    return {
      successUrl: stripeDeepLink('success', `purchase_success=1&productId=${pid}`),
      cancelUrl: stripeDeepLink('cancel', 'purchase_cancel=1'),
    };
  }
  return {
    successUrl: webUrl(`/shop?purchase_success=1&productId=${pid}`),
    cancelUrl: webUrl('/shop?purchase_cancel=1'),
  };
}

/** Stripe Setup Checkout callbacks for saving a card on the profile page. */
export function profileSetupCallbacks(): { successUrl: string; cancelUrl: string } {
  if (isMobileTauri()) {
    return {
      successUrl: stripeDeepLink('success', 'payment_setup=success'),
      cancelUrl: stripeDeepLink('cancel', 'payment_setup=cancel'),
    };
  }
  return {
    successUrl: webUrl('/profile?payment_setup=success'),
    cancelUrl: webUrl('/profile?payment_setup=cancel'),
  };
}
