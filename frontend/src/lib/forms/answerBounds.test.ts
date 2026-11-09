import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import * as bounds from './answerBounds';
import {
  ANSWER_MAX_SELECTIONS,
  ANSWER_MAX_TEXT_LENGTH,
  FORM_FULL,
  FORM_GRID_ANSWER_INVALID,
  FORM_MAX_QUESTIONS,
  GRID_MAX_ROWS,
  formCodeMessage,
  formSubmitRefusalMessage,
} from './answerBounds';

describe('form answer bounds', () => {
  it('equals libs/contracts/form-answers.json, the server reads the same file', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'libs', 'contracts', 'form-answers.json'), 'utf8')
    );
    expect(FORM_MAX_QUESTIONS).toBe(contract.maxQuestions);
    expect(ANSWER_MAX_TEXT_LENGTH).toBe(contract.maxTextLength);
    expect(ANSWER_MAX_SELECTIONS).toBe(contract.maxSelections);
    expect(GRID_MAX_ROWS).toBe(contract.maxGridRows);
    expect(bounds.GUEST_NAME_MAX_LENGTH).toBe(contract.maxGuestNameLength);
    expect(bounds.GUEST_EMAIL_MAX_LENGTH).toBe(contract.maxGuestEmailLength);
    const exported = bounds as unknown as Record<string, unknown>;
    for (const code of Object.values(contract.codes as Record<string, string>)) {
      expect(exported[code]).toBe(code);
      // Every code the server may answer has a sentence: none falls through to English.
      expect(formCodeMessage(code)).toBeTruthy();
    }
  });
});

describe('formSubmitRefusalMessage (D6)', () => {
  it('words a coded refusal from its code, never from the server sentence', () => {
    const err = new SocialApiError('Form is full', FORM_FULL, 400);
    expect(formSubmitRefusalMessage(err, 'fallback')).toBe(m.form_refusal_full());
  });

  it('words a forged grid answer as a reload, not as English', () => {
    const err = new SocialApiError('Answer for field X is not', FORM_GRID_ANSWER_INVALID, 400);
    expect(formSubmitRefusalMessage(err, 'fallback')).toBe(m.form_refusal_answer_invalid());
  });

  it("words a priced grid's answer refusal through the same entry point (WP-G2)", () => {
    const empty = new SocialApiError('Grid order is empty', 'PRODUCT_GRID_EMPTY', 400);
    expect(formSubmitRefusalMessage(empty, 'fallback')).toBe(m.form_refusal_grid_empty());
    const closed = new SocialApiError('Cell is closed', 'PRODUCT_GRID_CELL_CLOSED', 400);
    expect(formSubmitRefusalMessage(closed, 'fallback')).toBe(m.form_refusal_grid_changed());
  });

  it('falls back to the caller line for an uncoded 400, and never to its message', () => {
    const err = new SocialApiError('answers must contain at most 100 keys', null, 400);
    expect(formSubmitRefusalMessage(err, 'fallback')).toBe('fallback');
    expect(formSubmitRefusalMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
