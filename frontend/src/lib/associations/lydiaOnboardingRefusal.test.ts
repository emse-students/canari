import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import {
  LYDIA_ONBOARDING_REFUSAL,
  lydiaOnboardingErrorText,
  lydiaOnboardingRefusalCode,
  lydiaOnboardingRefusalText,
} from './lydiaOnboardingRefusal';
import { m } from '$lib/paraglide/messages';

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
    expect(new Set(texts).size).toBe(3);
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
      new SocialApiError('Bad Gateway prose', null, 502),
      new SocialApiError('prose', 'SOMETHING_ELSE', 400),
      undefined,
    ]) {
      expect(lydiaOnboardingErrorText(err)).toBe(m.common_save_error());
    }
  });
});
