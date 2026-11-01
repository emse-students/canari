import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import {
  LYDIA_ONBOARDING_REFUSAL,
  lydiaOnboardingErrorText,
  lydiaOnboardingOutcomeUnknown,
  lydiaOnboardingRefusalCode,
  lydiaOnboardingRefusalText,
} from './lydiaOnboardingRefusal';
import { m } from '$lib/paraglide/messages';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';

describe('Lydia onboarding refusals are classified by code, never by message', () => {
  it('reads the 409 of a re-run and the 502 of an unconfirmed key by their codes', () => {
    expect(
      lydiaOnboardingRefusalCode(
        new SocialApiError('english prose', 'LYDIA_ACCOUNT_ALREADY_LINKED', 409)
      )
    ).toBe(LYDIA_ONBOARDING_REFUSAL.ALREADY_LINKED);
    expect(
      lydiaOnboardingRefusalCode(
        new SocialApiError('english prose', 'LYDIA_BUSINESS_CREATED_UNLINKED', 502)
      )
    ).toBe(LYDIA_ONBOARDING_REFUSAL.CREATED_UNLINKED);
  });

  it('ignores the prose: the server sentence with another code, or none, is not a re-run', () => {
    const prose = 'A Lydia Business is already linked to this association';
    expect(lydiaOnboardingRefusalCode(new SocialApiError(prose, null, 409))).toBeNull();
    expect(lydiaOnboardingRefusalCode(new SocialApiError(prose, 'OTHER', 409))).toBeNull();
    expect(lydiaOnboardingRefusalCode(new Error(prose))).toBeNull();
    expect(lydiaOnboardingRefusalCode(undefined)).toBeNull();
  });

  it('gives each code its own sentence, none of them the server English', () => {
    const texts = Object.values(LYDIA_ONBOARDING_REFUSAL).map(lydiaOnboardingRefusalText);
    expect(new Set(texts).size).toBe(4);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain('already linked to this association');
    }
  });

  it('the no-retry sentence for an orphan Business is not the generic one', () => {
    const orphan = new SocialApiError('x', 'LYDIA_BUSINESS_CREATED_UNLINKED', 502);
    expect(lydiaOnboardingErrorText(orphan)).toBe(m.asso_lydia_created_unlinked_error());
    expect(lydiaOnboardingErrorText(orphan)).not.toBe(m.common_save_error());
  });

  it('a code-less or unknown error shows the generic Paraglide sentence, never its message', () => {
    for (const err of [
      new Error('Internal server error from somewhere'),
      new SocialApiError('Bad Request prose', null, 400),
      new SocialApiError('prose', 'SOMETHING_ELSE', 400),
      undefined,
    ]) {
      expect(lydiaOnboardingErrorText(err)).toBe(m.common_save_error());
    }
  });

  it('an UNKNOWN outcome - client deadline, no answer, a code-less 5xx, the typed 504 - says check before retrying', () => {
    for (const err of [
      new RequestDeadlineError('write', 75_000, 'POST', '/api/payments/onboarding', 200),
      new TransportFailureError(new TypeError('Failed to fetch')),
      new SocialApiError('Gateway Time-out', null, 504),
      new SocialApiError('Bad Gateway', null, 502),
      new SocialApiError('x', 'LYDIA_BUSINESS_CREATE_UNCONFIRMED', 504),
    ]) {
      expect(lydiaOnboardingOutcomeUnknown(err)).toBe(true);
      expect(lydiaOnboardingErrorText(err)).toBe(m.asso_lydia_onboarding_unconfirmed_error());
      expect(lydiaOnboardingErrorText(err)).not.toBe(m.common_save_error());
    }
  });

  it('a typed answer is NOT an unknown outcome: the orphan, the re-run, the unreadable account, a 4xx', () => {
    for (const err of [
      new SocialApiError('x', 'LYDIA_BUSINESS_CREATED_UNLINKED', 502),
      new SocialApiError('x', 'LYDIA_ACCOUNT_ALREADY_LINKED', 409),
      new SocialApiError('x', 'PAYOUT_ACCOUNT_UNREADABLE', 503),
      new SocialApiError('x', null, 400),
      new Error('x'),
    ]) {
      expect(lydiaOnboardingOutcomeUnknown(err)).toBe(false);
    }
  });
});
