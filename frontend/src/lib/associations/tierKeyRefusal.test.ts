import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import { TIER_KEY_YEAR_SHAPED, tierKeyRefusalMessage } from './tierKeyRefusal';

describe('tierKeyRefusalMessage - a refused tier key is worded from its typed code', () => {
  it('says why a year-shaped key is refused', () => {
    expect(
      tierKeyRefusalMessage(new SocialApiError('server prose', TIER_KEY_YEAR_SHAPED, 400))
    ).toBe(m.asso_cotisations_tier_key_year_shaped());
  });

  it('answers null for anything else, never reading the prose', () => {
    const prose = 'Tier "2024-2025" cannot be named like an academic year (YYYY-YYYY)';
    expect(tierKeyRefusalMessage(new SocialApiError(prose, null, 400))).toBeNull();
    expect(tierKeyRefusalMessage(new SocialApiError(prose, 'SOMETHING_ELSE', 400))).toBeNull();
    expect(tierKeyRefusalMessage(new Error(prose))).toBeNull();
  });
});
