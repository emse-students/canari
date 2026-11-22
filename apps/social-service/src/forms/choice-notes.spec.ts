import { Logger, ValidationPipe } from '@nestjs/common';
import { SubmitFormDto } from './dto/form.dto';
import { FORM_MAX_QUESTIONS } from './answer-bounds';
import { normaliseChoiceNotes, settleAnswerNotes } from './choice-notes';
import { answerText, commentText, noteKeyOwner, otherText } from './answer-text';

/**
 * THE COMMENT AND "AUTRE" TEXTS OF A CHOICE QUESTION: what a save may declare, what a submit keeps,
 * and how they read back. Owner decision 2026-11-21 (forms, 1.8.0).
 */
describe('choice notes', () => {
  beforeAll(() => {
    // The corrections are logged on purpose; a test reads their effect, not the log.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  const COLOUR = {
    id: 'q1',
    type: 'single_choice',
    allowComment: true,
    options: [
      { id: 'red', label: 'Rouge' },
      { id: 'other', label: 'Autre', other: true },
    ],
  };
  const TICKS = {
    id: 'q2',
    type: 'multiple_choice',
    options: [
      { id: 'a', label: 'A' },
      { id: 'o', label: 'Autre', other: true },
    ],
  };
  const ALL = new Set(['q1', 'q2']);

  describe('normaliseChoiceNotes (at save)', () => {
    it('keeps a comment and one "Autre" on a choice question', () => {
      expect(normaliseChoiceNotes([COLOUR])).toEqual([COLOUR]);
    });

    it('drops the comment of a question that is not a choice', () => {
      const [item] = normaliseChoiceNotes([{ id: 'q', type: 'long_text', allowComment: true }]);
      expect(item.allowComment).toBe(false);
    });

    it('drops an "Autre" mark off a non-choice question and a second one on a choice', () => {
      const [text] = normaliseChoiceNotes([
        { id: 't', type: 'short_text', options: [{ id: 'x', label: 'Autre', other: true }] },
      ]);
      expect(text.options?.[0].other).toBeUndefined();
      const [two] = normaliseChoiceNotes([
        {
          id: 'c',
          type: 'dropdown',
          options: [
            { id: 'x', label: 'Autre', other: true },
            { id: 'y', label: 'Autre bis', other: true },
          ],
        },
      ]);
      expect(two.options?.map((o) => o.other)).toEqual([true, undefined]);
    });
  });

  describe('settleAnswerNotes (at submit)', () => {
    const items = [COLOUR, TICKS];

    it('keeps the comment and the text typed beside a picked "Autre", trimmed', () => {
      const out = settleAnswerNotes(
        items,
        { q1: 'other', 'q1#other': '  Vert  ', 'q1#comment': ' merci ' },
        ALL
      );
      expect(out).toEqual({ q1: 'other', 'q1#other': 'Vert', 'q1#comment': 'merci' });
    });

    it('drops the "Autre" text when the answer picked something else', () => {
      const out = settleAnswerNotes(items, { q1: 'red', 'q1#other': 'Vert' }, ALL);
      expect(out).toEqual({ q1: 'red' });
    });

    it('finds the "Autre" among the ticks of a multiple choice', () => {
      const out = settleAnswerNotes(items, { q2: ['a', 'o'], 'q2#other': 'Autre chose' }, ALL);
      expect(out['q2#other']).toBe('Autre chose');
    });

    it('drops a comment on a question that takes none, and an empty one', () => {
      expect(settleAnswerNotes(items, { q2: ['a'], 'q2#comment': 'x' }, ALL)).toEqual({
        q2: ['a'],
      });
      expect(settleAnswerNotes(items, { q1: 'red', 'q1#comment': '   ' }, ALL)).toEqual({
        q1: 'red',
      });
    });

    it('keeps no text of a question that is not visible, nor of one that is not declared', () => {
      expect(
        settleAnswerNotes(items, { q1: 'other', 'q1#other': 'x', 'ghost#comment': 'y' }, new Set())
      ).toEqual({ q1: 'other' });
    });

    it('reads a key that is itself a declared question id as an ordinary answer', () => {
      const odd = { id: 'q#comment', type: 'short_text' };
      expect(settleAnswerNotes([odd], { 'q#comment': 'hello' }, new Set(['q#comment']))).toEqual({
        'q#comment': 'hello',
      });
    });

    it('drops a text that is not a string', () => {
      expect(settleAnswerNotes(items, { q1: 'red', 'q1#comment': 4 }, ALL)).toEqual({ q1: 'red' });
    });
  });

  describe('reading', () => {
    it('reads the "Autre" option as what was typed, one option or among several', () => {
      expect(answerText('other', COLOUR, undefined, null, 'Vert')).toBe('Autre: Vert');
      expect(answerText(['a', 'o'], TICKS, undefined, null, 'Bleu')).toBe('A, Autre: Bleu');
      expect(answerText('other', COLOUR)).toBe('Autre');
      expect(answerText('red', COLOUR, undefined, null, 'ignored')).toBe('Rouge');
    });

    it('reads the comment and the text of a record, empty when absent', () => {
      const record = { 'q1#comment': ' ok ', 'q1#other': 'Vert' };
      expect(commentText(record, 'q1')).toBe('ok');
      expect(otherText(record, 'q1')).toBe('Vert');
      expect(commentText({}, 'q1')).toBe('');
      expect(commentText(undefined, 'q1')).toBe('');
    });

    it('names the question a key belongs to', () => {
      expect(noteKeyOwner('q1#comment')).toEqual({ itemId: 'q1', kind: 'comment' });
      expect(noteKeyOwner('q1#other')).toEqual({ itemId: 'q1', kind: 'other' });
      expect(noteKeyOwner('q1')).toBeNull();
      expect(noteKeyOwner('#other')).toBeNull();
    });
  });

  describe('the answer DTO', () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const check = (answers: Record<string, unknown>) =>
      pipe.transform({ answers }, { type: 'body', metatype: SubmitFormDto });

    it('does not count the texts against the questions cap', async () => {
      const answers: Record<string, unknown> = {};
      for (let i = 0; i < FORM_MAX_QUESTIONS; i++) {
        answers[`q${i}`] = 'a';
        answers[`q${i}#comment`] = 'c';
      }
      await expect(check(answers)).resolves.toBeDefined();
      answers.extra = 'one too many';
      await expect(check(answers)).rejects.toBeDefined();
    });
  });
});
