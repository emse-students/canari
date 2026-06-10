import { Logger } from '@nestjs/common';
import type { AxiosRequestConfig } from 'axios';

const logger = new Logger('SocialInternalClient');

/** Base URL for server-to-server calls to social-service. */
export function getSocialServiceBase(): string {
  return (
    process.env.FORM_URL ||
    process.env.FORM_SERVICE_URL ||
    'http://social-service:3014'
  ).replace(/\/$/, '');
}

/** Axios config with the shared internal secret for social-service internal routes. */
export function internalSocialRequestConfig(): Pick<
  AxiosRequestConfig,
  'headers' | 'maxRedirects'
> {
  const secret = process.env.INTERNAL_SECRET?.trim() ?? '';
  if (!secret) {
    logger.warn(
      'INTERNAL_SECRET is not set - internal social-service calls will fail',
    );
  }
  return {
    maxRedirects: 0,
    headers: secret ? { 'X-Internal-Secret': secret } : {},
  };
}

/** Builds the path for an internal form submission API call. */
export function internalSubmissionPath(
  submissionId: string,
  suffix?: 'mark-paid' | 'cancel-pending',
): string {
  const base = `/api/internal/forms/submissions/${encodeURIComponent(submissionId)}`;
  return suffix ? `${base}/${suffix}` : base;
}

/** Internal route to resolve boutique product charge details for saved-card PaymentIntents. */
export function internalProductChargeContextPath(): string {
  return '/api/internal/products/charge-context';
}

/** Docker-network route to fulfill a boutique purchase after PaymentIntent success. */
export function productPurchaseCompletedPath(productId: string): string {
  return `/api/associations/products/${encodeURIComponent(productId)}/purchase-completed`;
}
