import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import { LYDIA_RESPONSABLE_REFUSAL, lydiaResponsableErrorText } from './lydiaResponsableRefusal';

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
});
