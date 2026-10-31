import { Logger } from '@nestjs/common';
import type { AxiosRequestConfig } from 'axios';
import { socialUrl } from '../internal/service-urls';

const logger = new Logger('SocialInternalClient');

/** Axios config with the shared internal secret for social-service internal routes. */
export function internalSocialRequestConfig(): Pick<
  AxiosRequestConfig,
  'headers' | 'maxRedirects'
> {
  const secret = process.env.INTERNAL_SECRET?.trim() ?? '';
  if (!secret) {
    logger.warn('INTERNAL_SECRET is not set - internal social-service calls will fail');
  }
  return {
    maxRedirects: 0,
    headers: secret ? { 'X-Internal-Secret': secret } : {},
  };
}

/**
 * The internal form-submission route on social-service, as a whole URL.
 *
 * A PATH, NOT A URL, IS WHAT KEPT A SECOND ADDRESS ALIVE HERE. These helpers used to return
 * `/api/internal/...` and leave the origin to the caller, so every call site pasted
 * `getSocialServiceBase()` in front of one - a second way to say where social-service is, beside
 * `socialUrl()`, spelling the prefix by hand in both. Returning the finished URL is what makes the
 * seam the only answer, and what lets the guard beside it be absolute.
 */
export function internalSubmissionUrl(
  submissionId: string,
  suffix?: 'provider-confirm' | 'cancel-pending'
): string {
  const base = `internal/forms/submissions/${encodeURIComponent(submissionId)}`;
  return socialUrl(suffix ? `${base}/${suffix}` : base);
}

/** Internal route to resolve boutique product charge details for saved-card PaymentIntents. */
export function internalProductChargeContextUrl(): string {
  return socialUrl('internal/products/charge-context');
}

/** Internal route listing a user's associations (current + former) for profile display. */
export function internalUserAssociationsUrl(userId: string): string {
  return socialUrl(`internal/users/${encodeURIComponent(userId)}/associations`);
}

/** Internal route reading an association's payment-account fields (Stripe and Lydia ids and flags). */
export function internalPaymentAccountUrl(associationId: string): string {
  return socialUrl(`internal/associations/${encodeURIComponent(associationId)}/payment-account`);
}

/**
 * Docker-network route a VERIFIED boutique confirm callback is handed to, as a trigger: social-service
 * settles the attempt row from Lydia's own answer (`ProductsService.handlePurchaseCompleted`).
 * X-Internal-Secret guarded.
 */
export function productPurchaseCompletedUrl(productId: string): string {
  return socialUrl(`associations/products/${encodeURIComponent(productId)}/purchase-completed`);
}

/**
 * Internal route answering the decrypted Lydia Business private token of the association holding a
 * `vendor_token`, to verify a callback with. Under `/api/internal/`, which nginx does not route
 * (`location /` serves the app shell for it), and X-Internal-Secret guarded on top.
 */
export function internalLydiaCallbackKeyUrl(): string {
  return socialUrl('internal/associations/lydia-callback-key');
}

/**
 * Internal route answering WHICH association holds a `vendor_token`, and whether its onboarding is
 * marked complete - a read, nothing else, for the log line of an unsigned business webhook. Under
 * `/api/internal/` like the key route, the token in the body so no access log records it.
 */
export function internalLydiaBusinessOfVendorTokenUrl(): string {
  return socialUrl('internal/associations/lydia-business-of-vendor-token');
}

/** Internal route releasing the products withheld while payments were disabled (provider switched on). */
export function providerActivatedUrl(): string {
  return socialUrl('internal/payments/provider-activated');
}
