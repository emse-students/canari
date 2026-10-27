import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';
import { closingRefusalMessage } from './purchaseClosing';

describe('closingRefusalMessage - a refused closing is worded from its typed code', () => {
  it.each([
    ['PURCHASE_ALREADY_CLOSED', () => m.asso_achats_close_already()],
    ['PURCHASE_NOT_CLOSABLE', () => m.asso_achats_close_not_closable()],
    ['PURCHASE_TIER_GONE', () => m.asso_achats_close_tier_gone()],
  ])('%s', (code, sentence) => {
    expect(closingRefusalMessage(new SocialApiError('server prose', code, 409))).toBe(sentence());
  });

  it('says the generic sentence for anything else, never the server prose', () => {
    expect(closingRefusalMessage(new SocialApiError('server prose', null, 500))).toBe(
      m.asso_achats_close_error()
    );
    expect(closingRefusalMessage(new Error('network'))).toBe(m.asso_achats_close_error());
  });
});
