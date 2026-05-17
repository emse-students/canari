import { isTauri } from '@tauri-apps/api/core';

/** True on Tauri Android / iOS — Stripe Checkout must return via app deep link. */
export function isMobileTauri(): boolean {
  if (typeof window === 'undefined' || !isTauri()) return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function stripeDeepLink(path: 'success' | 'cancel', query: string): string {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `fr.emse.canari://stripe/${path}${q}`;
}

function webUrl(path: string): string {
  const base =
    (import.meta.env.VITE_FRONTEND_URL as string | undefined)?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
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

/** Stripe Checkout callbacks for paid event registration on a post. */
export function eventCheckoutCallbacks(
  postId: string,
  buttonId: string
): { successUrl: string; cancelUrl: string } {
  const q = `registered=${encodeURIComponent(buttonId)}&post_id=${encodeURIComponent(postId)}`;
  if (isMobileTauri()) {
    return {
      successUrl: stripeDeepLink('success', q),
      cancelUrl: stripeDeepLink('cancel', `post_id=${encodeURIComponent(postId)}`),
    };
  }
  return {
    successUrl: webUrl(`/posts?${q}`),
    cancelUrl: webUrl('/posts'),
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
