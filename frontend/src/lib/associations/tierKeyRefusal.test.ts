import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import {
  MEMBER_PRICE_TAG_NOT_A_TIER,
  TIER_KEY_YEAR_SHAPED,
  memberPriceTagRefusalMessage,
  tierKeyRefusalMessage,
  tierSaveRefusal,
} from './tierKeyRefusal';

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

describe('memberPriceTagRefusalMessage - a preferential price linked to no other tier', () => {
  it('says why, from the typed code', () => {
    expect(
      memberPriceTagRefusalMessage(
        new SocialApiError('server prose', MEMBER_PRICE_TAG_NOT_A_TIER, 400)
      )
    ).toBe(m.asso_cotisations_member_price_tag_not_a_tier());
  });

  it('answers null for anything else, never reading the prose', () => {
    const prose = 'memberPriceTag must name another cotisation tier of this association';
    expect(memberPriceTagRefusalMessage(new SocialApiError(prose, null, 400))).toBeNull();
    expect(memberPriceTagRefusalMessage(new Error(prose))).toBeNull();
  });
});

describe('tierSaveRefusal - one call for both tier forms', () => {
  it('answers the sentence and the code of either refusal a manager can fix', () => {
    expect(tierSaveRefusal(new SocialApiError('x', TIER_KEY_YEAR_SHAPED, 400))).toEqual({
      code: TIER_KEY_YEAR_SHAPED,
      message: m.asso_cotisations_tier_key_year_shaped(),
    });
    expect(tierSaveRefusal(new SocialApiError('x', MEMBER_PRICE_TAG_NOT_A_TIER, 400))).toEqual({
      code: MEMBER_PRICE_TAG_NOT_A_TIER,
      message: m.asso_cotisations_member_price_tag_not_a_tier(),
    });
  });

  it('is null for any other failure, so the form keeps its generic sentence', () => {
    expect(tierSaveRefusal(new SocialApiError('boom', 'OTHER', 400))).toBeNull();
    expect(tierSaveRefusal(new SocialApiError('boom', null, 500))).toBeNull();
    expect(tierSaveRefusal(new Error('boom'))).toBeNull();
  });
});
