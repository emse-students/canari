import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';

/**
 * The typed refusals of `POST /api/payments/onboarding` (core-service `payment.controller.ts` and
 * `lydia-payment-provider.ts`). Classified at the THROW by `socialRefusal` as `SocialApiError.code`;
 * the screen reads the code and never the server's English sentence.
 */
export const LYDIA_ONBOARDING_REFUSAL = {
  /** 409: a Business is already linked - a second `business/create` would replace it silently. */
  ALREADY_LINKED: 'LYDIA_ACCOUNT_ALREADY_LINKED',
  /**
   * 502: Lydia created the Business but nothing linked it (its key unconfirmed, Lydia or
   * social-service unreachable). A retry would create a SECOND Business, so the text says not to.
   */
  CREATED_UNLINKED: 'LYDIA_BUSINESS_CREATED_UNLINKED',
  /** 503: the payout account could not be read first; nothing was created, a retry is safe. */
  PAYOUT_ACCOUNT_UNREADABLE: 'PAYOUT_ACCOUNT_UNREADABLE',
} as const;

export type LydiaOnboardingRefusalCode =
  (typeof LYDIA_ONBOARDING_REFUSAL)[keyof typeof LYDIA_ONBOARDING_REFUSAL];

const KNOWN: ReadonlySet<string> = new Set(Object.values(LYDIA_ONBOARDING_REFUSAL));

/** The onboarding refusal an error carries, or `null` for anything else (never a guess from prose). */
export function lydiaOnboardingRefusalCode(err: unknown): LydiaOnboardingRefusalCode | null {
  if (err instanceof SocialApiError && err.code !== null && KNOWN.has(err.code)) {
    return err.code as LydiaOnboardingRefusalCode;
  }
  return null;
}

/** The sentence for an onboarding refusal code, in the reader's language. */
export function lydiaOnboardingRefusalText(code: LydiaOnboardingRefusalCode): string {
  switch (code) {
    case LYDIA_ONBOARDING_REFUSAL.ALREADY_LINKED:
      return m.asso_lydia_already_linked_error();
    case LYDIA_ONBOARDING_REFUSAL.CREATED_UNLINKED:
      return m.asso_lydia_created_unlinked_error();
    case LYDIA_ONBOARDING_REFUSAL.PAYOUT_ACCOUNT_UNREADABLE:
      return m.asso_lydia_account_error();
  }
}

/**
 * The sentence for ANY onboarding failure: a known code's own text, else the generic Paraglide
 * save error - never the server's prose, which is English and written for a log.
 */
export function lydiaOnboardingErrorText(err: unknown): string {
  const code = lydiaOnboardingRefusalCode(err);
  return code === null ? m.common_save_error() : lydiaOnboardingRefusalText(code);
}
