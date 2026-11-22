import { describe, expect, it } from 'vitest';
import { judgeAnswerFormat, type AnswerFormatRule } from './answerFormat';

/**
 * WHAT A FORMATTED SHORT ANSWER MAY SAY. `answer-format.spec.ts` on the server asserts the same
 * cases against its copy: a drift is a person told yes and refused.
 */
describe('judgeAnswerFormat', () => {
  const WHOLE: AnswerFormatRule = { format: 'number' };
  const BOUNDED: AnswerFormatRule = { format: 'number', min: 1, max: 10 };
  const DECIMAL: AnswerFormatRule = { format: 'number', allowDecimals: true };

  it.each([
    ['a whole number is stored as itself', WHOLE, '42', '42'],
    ['spaces around it are dropped', WHOLE, '  7 ', '7'],
    ['a leading zero is not kept', WHOLE, '007', '7'],
    ['a negative number is a number', WHOLE, '-3', '-3'],
    ['a decimal comma becomes a point', DECIMAL, '3,50', '3.5'],
    ['a decimal point is accepted', DECIMAL, '3.25', '3.25'],
    ['both bounds are inclusive', BOUNDED, '10', '10'],
    ['a zero stays a zero', WHOLE, '-0', '0'],
    ['a tiny decimal never becomes an exponent', DECIMAL, '0.0000001', '0.0000001'],
    ['trailing decimal zeros are dropped', DECIMAL, '2,500', '2.5'],
    ['a negative decimal keeps its sign', DECIMAL, '-0,50', '-0.5'],
  ])('%s', (_name, rule, typed, stored) => {
    expect(judgeAnswerFormat(rule, typed)).toEqual({ ok: true, value: stored });
  });

  it.each([
    ['words are not a number', WHOLE, 'oui', 'not_a_number'],
    ['a trailing unit is not a number', WHOLE, '12 kg', 'not_a_number'],
    ['two points are ambiguous, not a number', DECIMAL, '1.2.3', 'ambiguous_separator'],
    ['a thousands separator beside a decimal one', DECIMAL, '1,234.5', 'ambiguous_separator'],
    ['two commas', DECIMAL, '1,2,3', 'ambiguous_separator'],
    ['more digits than a double keeps', WHOLE, '1234567890123456', 'not_a_number'],
    ['a decimal on a whole-number question', WHOLE, '3,5', 'not_an_integer'],
    ['under the minimum', BOUNDED, '0', 'below_min'],
    ['over the maximum', BOUNDED, '11', 'above_max'],
  ])('%s', (_name, rule, typed, problem) => {
    expect(judgeAnswerFormat(rule, typed)).toEqual({ ok: false, problem });
  });

  it('judges a phone number by its digits, whatever separates them', () => {
    const phone: AnswerFormatRule = { format: 'phone' };
    for (const ok of ['06 12 34 56 78', '+33 6 12 34 56 78', '(04) 77.42.00.00', '0612345678']) {
      expect(judgeAnswerFormat(phone, ok)).toEqual({ ok: true, value: ok });
    }
    for (const bad of ['123', 'appelle moi', '06 12 34 56 78 90 12 34 56', '06-12-ab-56-78']) {
      expect(judgeAnswerFormat(phone, bad)).toEqual({ ok: false, problem: 'not_a_phone' });
    }
  });

  it('judges an e-mail by its shape, and stores it trimmed', () => {
    const email: AnswerFormatRule = { format: 'email' };
    expect(judgeAnswerFormat(email, ' ada@mines-stetienne.fr ')).toEqual({
      ok: true,
      value: 'ada@mines-stetienne.fr',
    });
    expect(judgeAnswerFormat(email, 'a@b.co.uk').ok).toBe(true);
    for (const bad of ['ada', 'ada@', '@mines.fr', 'a b@mines.fr', 'ada@mines', 'a@@b.fr']) {
      expect(judgeAnswerFormat(email, bad)).toEqual({ ok: false, problem: 'not_an_email' });
    }
  });

  it('accepts any text on a question with no format', () => {
    expect(judgeAnswerFormat({}, ' oui ')).toEqual({ ok: true, value: 'oui' });
    expect(judgeAnswerFormat({ format: 'text' }, 'x')).toEqual({ ok: true, value: 'x' });
  });
});
