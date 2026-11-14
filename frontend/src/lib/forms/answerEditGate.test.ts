import { describe, expect, it } from 'vitest';
import { answerEditPayload, offersAnswerEdit } from './answerEditGate';

describe('offersAnswerEdit', () => {
  const form = { allowAnswerEdit: true, anonymous: false };

  it('offers the change only on an estate that says it serves it', () => {
    expect(offersAnswerEdit(form, true, true)).toBe(true);
    // An older server (1.6.6 to 1.6.11) never says it: no "Modifier ma reponse", no GET to learn by a 404.
    expect(offersAnswerEdit(form, true, false)).toBe(false);
    // No server has answered yet: nothing is guessed.
    expect(offersAnswerEdit(form, true, null)).toBe(false);
  });

  it('never offers it on a form that does not allow it, an anonymous one, or signed out', () => {
    expect(offersAnswerEdit({ ...form, allowAnswerEdit: false }, true, true)).toBe(false);
    expect(offersAnswerEdit({}, true, true)).toBe(false);
    expect(offersAnswerEdit({ ...form, anonymous: true }, true, true)).toBe(false);
    expect(offersAnswerEdit(form, false, true)).toBe(false);
  });
});

describe('answerEditPayload', () => {
  it('sends the switch to an estate that serves it, whichever way it is set', () => {
    expect(answerEditPayload(true, true)).toEqual({ allowAnswerEdit: true });
    expect(answerEditPayload(true, false)).toEqual({ allowAnswerEdit: false });
  });

  it('sends nothing to an older estate, which would drop it', () => {
    expect(answerEditPayload(false, true)).toEqual({});
  });
});
