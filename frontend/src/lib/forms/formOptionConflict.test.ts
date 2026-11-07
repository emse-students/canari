import { describe, expect, it } from 'vitest';
import { conflictHint, editorOptionState, formConflictMessage } from './formOptionConflict';
import { FORM_OPTION_CONFLICTS, FORM_PUBLIC_GUEST_TIER_UNAVAILABLE } from './formOptionRules';
import { m } from '$lib/paraglide/messages';

const EMPTY = {
  anonymous: false,
  isPublic: false,
  requiresPayment: false,
  grantsCotisation: false,
  submitCondition: null,
  items: [],
};

describe('editorOptionState', () => {
  it('reads a grant only while payment is on, as the page saves it', () => {
    expect(editorOptionState({ ...EMPTY, grantsCotisation: true }).grantsCotisation).toBe(false);
    expect(
      editorOptionState({ ...EMPTY, requiresPayment: true, grantsCotisation: true })
    ).toMatchObject({ takesPayment: true, grantsCotisation: true });
  });

  it('counts a question shown by promo as a restricted audience, and one shown by an answer not', () => {
    const byPromo = { type: 'short_text', showIf: { promo: { values: [2026] } } };
    const byAnswer = { type: 'short_text', showIf: { answer: { questionId: 'q', optionIds: [] } } };
    expect(editorOptionState({ ...EMPTY, items: [byPromo] }).restrictsAudience).toBe(true);
    expect(editorOptionState({ ...EMPTY, items: [byAnswer] }).restrictsAudience).toBe(false);
    expect(editorOptionState({ ...EMPTY, submitCondition: {} }).restrictsAudience).toBe(true);
  });

  it('sees a file question', () => {
    expect(editorOptionState({ ...EMPTY, items: [{ type: 'file' }] }).hasFileQuestion).toBe(true);
  });
});

describe('formConflictMessage', () => {
  it('words every code the rule can return', () => {
    const codes = [...Object.keys(FORM_OPTION_CONFLICTS), FORM_PUBLIC_GUEST_TIER_UNAVAILABLE];
    const words = codes.map((code) => formConflictMessage(code as never));
    expect(words.every((w) => typeof w === 'string' && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(codes.length);
  });
});

describe('conflictHint', () => {
  it('is null for an open switch, and says every reason of a shut one', () => {
    expect(conflictHint([])).toBeNull();
    expect(conflictHint(['FORM_PUBLIC_COTISATION_GRANT', 'FORM_PUBLIC_FILE'])).toBe(
      `${m.form_option_conflict_public_grant()} ${m.form_option_conflict_public_file()}`
    );
  });
});
