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
  /** 502: Lydia created the Business but did not confirm its private token; nothing was linked. */
  KEY_UNVERIFIED: 'LYDIA_BUSINESS_KEY_UNVERIFIED',
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
    case LYDIA_ONBOARDING_REFUSAL.KEY_UNVERIFIED:
      return m.asso_lydia_key_unverified_error();
  }
}
