import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import { LYDIA_RESPONSABLE_REFUSAL, lydiaResponsableErrorText } from './lydiaResponsableRefusal';
import { LYDIA_CASHIER_REFUSAL, LYDIA_CASHIER_SOCIAL_REFUSAL } from './lydiaCashierCodes';

describe('lydiaResponsableErrorText', () => {
  it('gives every typed code its own sentence, never the server prose', () => {
    const texts = Object.values(LYDIA_RESPONSABLE_REFUSAL).map((code) => {
      const text = lydiaResponsableErrorText(new SocialApiError('English prose', code, 400));
      expect(text).not.toContain('English prose');
      return text;
    });
    expect(new Set(texts).size).toBe(texts.length);
  });
  it('a 403 has its own sentence, distinct from the generic one', () => {
    const forbidden = lydiaResponsableErrorText(new SocialApiError('no', null, 403));
    expect(forbidden).not.toBe(lydiaResponsableErrorText(new SocialApiError('no', null, 500)));
  });
  it('unknown codes and non-API errors fall to the generic sentence', () => {
    const generic = lydiaResponsableErrorText(new Error('x'));
    expect(lydiaResponsableErrorText(new SocialApiError('x', 'WHATEVER', 400))).toBe(generic);
  });
});

describe('lydiaResponsableErrorText after a number change (lot 3)', () => {
  it('says the new number was added and the old one still needs removing, not a generic failure', () => {
    const text = lydiaResponsableErrorText(
      new SocialApiError('x', 'LYDIA_CASHIER_REVOKE_UNCONFIRMED', 502)
    );
    expect(text).not.toBe(lydiaResponsableErrorText(new Error('x')));
    expect(text).not.toContain('LYDIA');
  });

  it('the number change refusals each have their own plain sentence', () => {
    const generic = lydiaResponsableErrorText(new Error('x'));
    const texts = [
      LYDIA_CASHIER_REFUSAL.RESPONSABLE_NUMBER_CHANGE_DISABLED,
      LYDIA_CASHIER_REFUSAL.RESPONSABLE_NUMBER_CHANGE_FORBIDDEN,
      LYDIA_CASHIER_REFUSAL.HOLDER_RIGHTS_MISSING,
      LYDIA_CASHIER_SOCIAL_REFUSAL.CLAIM_LOST,
      LYDIA_CASHIER_SOCIAL_REFUSAL.NUMBER_CHANGED,
    ].map((code) => {
      const text = lydiaResponsableErrorText(new SocialApiError('English prose', code, 409));
      expect(text, code).not.toBe(generic);
      expect(text).not.toMatch(/LYDIA_|English prose/);
      return text;
    });
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('an untrusted answer about the rights reads as rights not confirmed', () => {
    expect(
      lydiaResponsableErrorText(
        new SocialApiError('x', LYDIA_CASHIER_REFUSAL.READBACK_INVALID, 502)
      )
    ).toBe(
      lydiaResponsableErrorText(
        new SocialApiError('x', LYDIA_RESPONSABLE_REFUSAL.RIGHTS_INCOMPLETE, 502)
      )
    );
  });
});
