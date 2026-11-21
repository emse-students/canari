import { BadRequestException, Logger } from '@nestjs/common';
import {
  dropEmptyAnswers,
  normaliseAnswerFormats,
  settleAnswerFormats,
} from './answer-format-rules';
import { FORM_ANSWER_FORMAT_INVALID, FORM_FORMAT_RANGE_INVALID } from './answer-bounds';

/** The server's side of a short question's format: the save, the submit, the empty answers. */
describe('answer format rules', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  /** The typed refusal a call throws; fails the test when it does not throw. */
  function refusalOf(call: () => unknown): BadRequestException {
    let thrown: unknown;
    try {
      call();
    } catch (e) {
      thrown = e;
    }
    return thrown as BadRequestException;
  }

  const AGE = { id: 'age', type: 'short_text', format: 'number', min: 16, max: 99 };
  const PHONE = { id: 'tel', type: 'short_text', format: 'phone' };
  const FREE = { id: 'free', type: 'short_text' };
  const ALL = new Set(['age', 'tel', 'free']);

  describe('normaliseAnswerFormats (at save)', () => {
    it('keeps a number format with its bounds, and makes whole numbers explicit', () => {
      expect(normaliseAnswerFormats([AGE])).toEqual([{ ...AGE, allowDecimals: false }]);
    });

    it('drops the settings of a question that is not a short text', () => {
      const [item] = normaliseAnswerFormats([{ id: 'q', type: 'long_text', format: 'number' }]);
      expect(item).toEqual({ id: 'q', type: 'long_text' });
    });

    it('drops bounds and decimals from a phone format', () => {
      const [item] = normaliseAnswerFormats([{ ...PHONE, min: 1, allowDecimals: true }]);
      expect(item).toEqual(PHONE);
    });

    it('refuses a minimum above the maximum, typed', () => {
      const refusal = refusalOf(() => normaliseAnswerFormats([{ ...AGE, min: 50, max: 20 }]));
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(refusal.getResponse()).toMatchObject({
        code: FORM_FORMAT_RANGE_INVALID,
        itemId: 'age',
      });
    });

    it('leaves a question with no format settings untouched', () => {
      expect(normaliseAnswerFormats([FREE])).toEqual([FREE]);
    });
  });

  describe('settleAnswerFormats (at submit)', () => {
    const items = [AGE, PHONE, FREE];

    it('stores a number in its normalised spelling and leaves the rest alone', () => {
      const out = settleAnswerFormats(
        items,
        { age: ' 021 ', tel: '06 12 34 56 78', free: 'oui' },
        ALL
      );
      expect(out).toEqual({ age: '21', tel: '06 12 34 56 78', free: 'oui' });
    });

    it('refuses what does not fit, with the problem and the bounds', () => {
      const refusal = refusalOf(() => settleAnswerFormats(items, { age: '12' }, ALL));
      expect(refusal.getResponse()).toMatchObject({
        code: FORM_ANSWER_FORMAT_INVALID,
        itemId: 'age',
        problem: 'below_min',
        min: 16,
        max: 99,
      });
    });

    it('judges nothing on a blank answer or on a question the person cannot see', () => {
      expect(settleAnswerFormats(items, { age: '', tel: 'nope' }, new Set(['age']))).toEqual({
        age: '',
        tel: 'nope',
      });
    });
  });

  describe('dropEmptyAnswers', () => {
    it('stores a skipped question as absent, never as an empty string', () => {
      expect(dropEmptyAnswers({ a: '', b: [], c: null, d: 'x', e: 0, f: ['y'] })).toEqual({
        d: 'x',
        e: 0,
        f: ['y'],
      });
    });
  });
});
