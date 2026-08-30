import type {
  ConnectAccountStatus,
  ConnectAccountStatusResponse,
} from './payment-provider.interface';

/** Minimal Stripe Account shape used for status derivation (testable without SDK). */
export type StripeAccountStatusInput = {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    pending_verification?: string[] | null;
    disabled_reason?: string | null;
  } | null;
};

/**
 * Maps a Stripe Connect account snapshot to a treasurer-facing status.
 * `pending` means the association finished onboarding and Stripe is reviewing.
 */
export function deriveStripeConnectStatus(account: StripeAccountStatusInput): ConnectAccountStatus {
  const disabledReason = account.requirements?.disabled_reason?.trim() || null;
  if (disabledReason) {
    return 'restricted';
  }
  if (account.charges_enabled) {
    return 'active';
  }
  const currentlyDue = account.requirements?.currently_due ?? [];
  const pendingVerification = account.requirements?.pending_verification ?? [];
  if (!account.details_submitted || currentlyDue.length > 0) {
    return 'onboarding_required';
  }
  if (pendingVerification.length > 0 || account.details_submitted) {
    return 'pending';
  }
  return 'onboarding_required';
}

/** Builds the API payload from a Stripe Account retrieve result. */
export function buildStripeConnectStatusResponse(
  account: StripeAccountStatusInput
): ConnectAccountStatusResponse {
  return {
    status: deriveStripeConnectStatus(account),
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
    currentlyDue: account.requirements?.currently_due ?? [],
    pendingVerification: account.requirements?.pending_verification ?? [],
    disabledReason: account.requirements?.disabled_reason?.trim() || null,
  };
}
