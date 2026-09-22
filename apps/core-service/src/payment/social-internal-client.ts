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
  suffix?: 'mark-paid' | 'cancel-pending'
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

/** Docker-network route to fulfill a boutique purchase after PaymentIntent success. */
export function productPurchaseCompletedUrl(productId: string): string {
  return socialUrl(`associations/products/${encodeURIComponent(productId)}/purchase-completed`);
}
