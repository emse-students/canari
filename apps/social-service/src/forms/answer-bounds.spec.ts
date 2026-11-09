import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as bounds from './answer-bounds';
import {
  ANSWER_MAX_SELECTIONS,
  ANSWER_MAX_TEXT_LENGTH,
  assertFormItemsShape,
  FORM_GRID_ANSWER_INVALID,
  FORM_GRID_DUPLICATE_LABEL,
  FORM_GRID_TOO_MANY_ROWS,
  FORM_MAX_QUESTIONS,
  FORM_TOO_MANY_QUESTIONS,
  GRID_MAX_ROWS,
  isAcceptedAnswerValue,
  isQuestionAnswered,
  normaliseGridAnswer,
  PRODUCT_GRID_CELL_KEY_MAX,
  PRODUCT_GRID_MAX_CELLS,
  withNormalisedGridAnswers,
} from './answer-bounds';

/** The typed `code` a call refuses with, or null when it does not throw a coded 400. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    return (err.getResponse() as { code?: string }).code ?? null;
  }
}

const grid = (over: Record<string, unknown> = {}) => ({
  id: 'q_grid',
  label: 'Grille',
  type: 'matrix_single',
  required: true,
  rows: ['Vert', 'Noir'],
  options: [
    { id: 'c_s', label: 'S' },
    { id: 'c_m', label: 'M' },
  ],
  ...over,
});

describe('form answer bounds', () => {
  it('equals libs/contracts/form-answers.json', () => {
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'form-answers.json'),
        'utf8'
      )
    );
    expect(FORM_MAX_QUESTIONS).toBe(contract.maxQuestions);
    expect(ANSWER_MAX_TEXT_LENGTH).toBe(contract.maxTextLength);
    expect(ANSWER_MAX_SELECTIONS).toBe(contract.maxSelections);
    expect(GRID_MAX_ROWS).toBe(contract.maxGridRows);
    expect(PRODUCT_GRID_MAX_CELLS).toBe(contract.maxProductGridCells);
    expect(PRODUCT_GRID_CELL_KEY_MAX).toBe(contract.maxProductGridCellKey);
    expect(bounds.GUEST_NAME_MAX_LENGTH).toBe(contract.maxGuestNameLength);
    expect(bounds.GUEST_EMAIL_MAX_LENGTH).toBe(contract.maxGuestEmailLength);
    const exported = bounds as unknown as Record<string, unknown>;
    for (const code of Object.values(contract.codes as Record<string, string>)) {
      expect(exported[code]).toBe(code);
    }
  });

  describe('isAcceptedAnswerValue', () => {
    it('takes every shape a page sends, a grid included', () => {
      expect(isAcceptedAnswerValue('texte')).toBe(true);
      expect(isAcceptedAnswerValue(0)).toBe(true);
      expect(isAcceptedAnswerValue(['a', 'b'])).toBe(true);
      expect(isAcceptedAnswerValue({ Vert: 'c_s', Noir: ['c_s', 'c_m'] })).toBe(true);
    });

    it('refuses what is past a bound or nested deeper than a grid', () => {
      expect(isAcceptedAnswerValue('a'.repeat(ANSWER_MAX_TEXT_LENGTH + 1))).toBe(false);
      expect(isAcceptedAnswerValue(Array(ANSWER_MAX_SELECTIONS + 1).fill('a'))).toBe(false);
      expect(isAcceptedAnswerValue({ Vert: { deeper: 'x' } })).toBe(false);
      // A number row is a priced grid's shape; a map MIXING numbers and a survey's strings is none.
      expect(isAcceptedAnswerValue({ Vert: 3, Noir: 'c_s' })).toBe(false);
      const tooManyRows = Object.fromEntries(
        Array.from({ length: GRID_MAX_ROWS + 1 }, (_, i) => [`r${i}`, 'c'])
      );
      expect(isAcceptedAnswerValue(tooManyRows)).toBe(false);
      expect(isAcceptedAnswerValue(null)).toBe(false);
      expect(isAcceptedAnswerValue(Number.NaN)).toBe(false);
    });

    it('takes a priced grid quantities up to rows x columns cells, and nothing past it', () => {
      const cells = (n: number, key = (i: number) => `r${i}:c`) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), 1]));
      expect(isAcceptedAnswerValue({ 'vert:m': 2, 'noir:s': 0 })).toBe(true);
      expect(isAcceptedAnswerValue(cells(PRODUCT_GRID_MAX_CELLS))).toBe(true);
      expect(isAcceptedAnswerValue(cells(PRODUCT_GRID_MAX_CELLS + 1))).toBe(false);
      expect(isAcceptedAnswerValue({ ['a'.repeat(PRODUCT_GRID_CELL_KEY_MAX + 1)]: 1 })).toBe(false);
      expect(isAcceptedAnswerValue({ 'vert:m': Number.POSITIVE_INFINITY })).toBe(false);
    });
  });

  describe('isQuestionAnswered (D5: a required grid wants one row unless every row is asked)', () => {
    it('counts a grid answered by one row', () => {
      expect(isQuestionAnswered(grid(), { Vert: 'c_s' })).toBe(true);
      expect(isQuestionAnswered(grid(), { Vert: '' })).toBe(false);
      expect(isQuestionAnswered(grid(), undefined)).toBe(false);
    });

    it('wants every row when the question says so', () => {
      const every = grid({ requireEveryRow: true });
      expect(isQuestionAnswered(every, { Vert: 'c_s' })).toBe(false);
      expect(isQuestionAnswered(every, { Vert: 'c_s', Noir: 'c_m' })).toBe(true);
    });

    it('counts a zero as an answer (a scale starting at 0)', () => {
      expect(isQuestionAnswered({ id: 'q', type: 'linear_scale' }, 0)).toBe(true);
      expect(isQuestionAnswered({ id: 'q', type: 'short_text' }, '')).toBe(false);
    });
  });

  describe('normaliseGridAnswer', () => {
    it('drops the empty rows and keeps the answered ones', () => {
      expect(normaliseGridAnswer(grid(), { Vert: 'c_m', Noir: '' })).toEqual({ Vert: 'c_m' });
      expect(normaliseGridAnswer(grid(), { Vert: '', Noir: '' })).toBeUndefined();
    });

    it('refuses an undeclared row or column, a list on a single grid, a repeat', () => {
      expect(codeOf(() => normaliseGridAnswer(grid(), { Bleu: 'c_s' }))).toBe(
        FORM_GRID_ANSWER_INVALID
      );
      expect(codeOf(() => normaliseGridAnswer(grid(), { Vert: 'c_xl' }))).toBe(
        FORM_GRID_ANSWER_INVALID
      );
      expect(codeOf(() => normaliseGridAnswer(grid(), { Vert: ['c_s'] }))).toBe(
        FORM_GRID_ANSWER_INVALID
      );
      expect(codeOf(() => normaliseGridAnswer(grid(), 'c_s'))).toBe(FORM_GRID_ANSWER_INVALID);
      const multiple = grid({ type: 'matrix_multiple' });
      expect(normaliseGridAnswer(multiple, { Vert: ['c_s', 'c_m'], Noir: [] })).toEqual({
        Vert: ['c_s', 'c_m'],
      });
      expect(codeOf(() => normaliseGridAnswer(multiple, { Vert: ['c_s', 'c_s'] }))).toBe(
        FORM_GRID_ANSWER_INVALID
      );
    });

    it('leaves out a grid with no answered row and leaves every other answer alone', () => {
      expect(
        withNormalisedGridAnswers([grid(), { id: 'q_text', type: 'short_text' }], {
          q_grid: { Vert: '' },
          q_text: 'bonjour',
        })
      ).toEqual({ q_text: 'bonjour' });
    });

    it('refuses a row map on a question that is not a grid, and drops one on an undeclared key', () => {
      expect(
        codeOf(() =>
          withNormalisedGridAnswers([{ id: 'q_text', type: 'short_text' }], {
            q_text: { a: 'x' },
          })
        )
      ).toBe(FORM_GRID_ANSWER_INVALID);
      expect(
        withNormalisedGridAnswers([grid()], { q_gone: { Vert: '' }, q_grid: { Vert: 'c_s' } })
      ).toEqual({ q_grid: { Vert: 'c_s' } });
    });

    it('passes a priced grid answer through untouched, to its own rule in submit', () => {
      const answer = { 'vert:m': 2, 'noir:s': 0 };
      expect(
        withNormalisedGridAnswers([{ id: 'q_pg', type: 'product_grid' }], { q_pg: answer })
      ).toEqual({ q_pg: answer });
      // A number map on a question that is not a grid is still no answer of it.
      expect(
        codeOf(() =>
          withNormalisedGridAnswers([{ id: 'q_text', type: 'short_text' }], { q_text: answer })
        )
      ).toBe(FORM_GRID_ANSWER_INVALID);
    });

    it('keeps a row labelled after a prototype key as an own row, never as the prototype', () => {
      const proto = grid({ rows: ['__proto__', 'constructor'] });
      const kept = normaliseGridAnswer(proto, JSON.parse('{"__proto__":"c_s"}'))!;
      expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
      expect(Object.keys(kept)).toEqual(['__proto__']);
      expect(isQuestionAnswered({ ...proto, requireEveryRow: true }, kept)).toBe(false);
    });
  });

  describe('assertFormItemsShape (D4)', () => {
    it('refuses two rows or two columns of one label', () => {
      expect(codeOf(() => assertFormItemsShape([grid({ rows: ['Vert', 'Vert'] })]))).toBe(
        FORM_GRID_DUPLICATE_LABEL
      );
      expect(
        codeOf(() =>
          assertFormItemsShape([
            grid({
              options: [
                { id: 'a', label: 'M' },
                { id: 'b', label: 'M' },
              ],
            }),
          ])
        )
      ).toBe(FORM_GRID_DUPLICATE_LABEL);
    });

    it('does not judge the options of a question that is not a grid', () => {
      expect(() =>
        assertFormItemsShape([
          {
            id: 'q',
            type: 'single_choice',
            options: [{ label: 'Oui' }, { label: 'Oui' }],
          },
        ])
      ).not.toThrow();
    });

    it('refuses more rows or more questions than an answer may carry', () => {
      const rows = Array.from({ length: GRID_MAX_ROWS + 1 }, (_, i) => `r${i}`);
      expect(codeOf(() => assertFormItemsShape([grid({ rows })]))).toBe(FORM_GRID_TOO_MANY_ROWS);
      const many = Array.from({ length: FORM_MAX_QUESTIONS + 1 }, (_, i) => ({
        id: `q${i}`,
        type: 'short_text',
      }));
      expect(codeOf(() => assertFormItemsShape(many))).toBe(FORM_TOO_MANY_QUESTIONS);
      expect(() => assertFormItemsShape(many.slice(0, FORM_MAX_QUESTIONS))).not.toThrow();
    });
  });
});
