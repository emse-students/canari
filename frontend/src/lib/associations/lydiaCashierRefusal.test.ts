import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import {
  LYDIA_CASHIER_REFUSAL,
  LYDIA_CASHIER_SOCIAL_REFUSAL,
  lydiaCashierErrorText,
} from './lydiaCashierRefusal';

/**
 * The codes the cashier screen never meets as its own (the Responsable's number change) or that
 * only a malformed request gets: each falls to the generic sentence.
 */
const NOT_OWN: readonly string[] = [
  LYDIA_CASHIER_REFUSAL.RESPONSABLE_NUMBER_CHANGE_FORBIDDEN,
  LYDIA_CASHIER_SOCIAL_REFUSAL.CONFIRMED_REQUIRED,
];
const ALL_CASHIER_CODES = [
  ...Object.values(LYDIA_CASHIER_REFUSAL),
  ...Object.values(LYDIA_CASHIER_SOCIAL_REFUSAL),
].filter((code) => !NOT_OWN.includes(code));

describe('lydiaCashierErrorText', () => {
  it('gives every cashier code its own plain sentence, never the server prose nor the code', () => {
    const texts = ALL_CASHIER_CODES.map((code) => {
      const text = lydiaCashierErrorText(new SocialApiError('English prose', code, 409));
      expect(text).not.toContain('English prose');
      expect(text).not.toMatch(/LYDIA_|access_/);
      return text;
    });
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('the codes that are not the cashier screen own codes fall to the generic sentence', () => {
    const generic = lydiaCashierErrorText(new Error('x'));
    for (const code of NOT_OWN) {
      expect(lydiaCashierErrorText(new SocialApiError('x', code, 409)), code).toBe(generic);
    }
  });

  it('an untrusted answer about the rights reads as rights not confirmed, never as done', () => {
    expect(
      lydiaCashierErrorText(new SocialApiError('x', LYDIA_CASHIER_REFUSAL.READBACK_INVALID, 502))
    ).toBe(lydiaCashierErrorText(new SocialApiError('x', 'LYDIA_CASHIER_RIGHTS_INCOMPLETE', 502)));
  });

  it('a removal Lydia did not confirm is told apart from a generic failure', () => {
    const unconfirmed = lydiaCashierErrorText(
      new SocialApiError('x', LYDIA_CASHIER_REFUSAL.REVOKE_UNCONFIRMED, 502)
    );
    expect(unconfirmed).not.toBe(lydiaCashierErrorText(new Error('x')));
  });

  it('the Lydia codes shared with the Responsable step are read too', () => {
    const generic = lydiaCashierErrorText(new Error('x'));
    for (const code of ['LYDIA_UNREACHABLE', 'LYDIA_CASHIER_PHONE_INVALID', 'LYDIA_NO_BUSINESS']) {
      expect(lydiaCashierErrorText(new SocialApiError('x', code, 400)), code).not.toBe(generic);
    }
  });

  it('a 403 has its own sentence; unknown codes and non-API errors fall to the generic one', () => {
    const generic = lydiaCashierErrorText(new Error('x'));
    expect(lydiaCashierErrorText(new SocialApiError('no', null, 403))).not.toBe(generic);
    expect(lydiaCashierErrorText(new SocialApiError('x', 'WHATEVER', 400))).toBe(generic);
  });
});
