import { m } from '$lib/paraglide/messages';
import { hasFileQuestion } from './fileQuestion';
import {
  conditionNamesProfile,
  FORM_OPTION_CONFLICTS,
  FORM_PUBLIC_GUEST_TIER_UNAVAILABLE,
  type FormConfigConflict,
  type FormOptionState,
} from './formOptionRules';

/**
 * The editor's side of the shared option rule (`formOptionRules.ts`): what the screen holds,
 * reduced to the booleans the rule reads, and each conflict in the reader's language.
 *
 * The derivation follows what the page SAVES, not what it shows: a price, a grid, cash or a grant
 * is sent only while payment is on (`matrixPayload`, `cotisationPayload`), so the switch decides.
 */
export function editorOptionState(form: {
  anonymous: boolean;
  isPublic: boolean;
  requiresPayment: boolean;
  grantsCotisation: boolean;
  submitCondition: object | null | undefined;
  items: ReadonlyArray<{ type?: string; showIf?: object | null }>;
  allowAnswerEdit: boolean;
}): FormOptionState {
  return {
    anonymous: form.anonymous,
    isPublic: form.isPublic,
    takesPayment: form.requiresPayment,
    grantsCotisation: form.requiresPayment && form.grantsCotisation,
    restrictsAudience:
      form.submitCondition != null || form.items.some((item) => conditionNamesProfile(item.showIf)),
    hasFileQuestion: hasFileQuestion(form.items),
    allowsAnswerEdit: form.allowAnswerEdit,
  };
}

/**
 * One conflict as a sentence that reads the same on either switch of its pair and on the save bar:
 * it names the form's kind and the option, never "this" or "that".
 */
export function formConflictMessage(code: FormConfigConflict): string {
  switch (code) {
    case 'FORM_ANONYMOUS_PAYMENT':
      return m.form_option_conflict_anonymous_payment();
    case 'FORM_ANONYMOUS_COTISATION_GRANT':
      return m.form_option_conflict_anonymous_grant();
    case 'FORM_ANONYMOUS_FILE':
      return m.form_option_conflict_anonymous_file();
    case 'FORM_ANONYMOUS_ANSWER_EDIT':
      return m.form_option_conflict_anonymous_answer_edit();
    case 'FORM_PUBLIC_AUDIENCE':
      return m.form_option_conflict_public_audience();
    case 'FORM_PUBLIC_COTISATION_GRANT':
      return m.form_option_conflict_public_grant();
    case 'FORM_PUBLIC_FILE':
      return m.form_option_conflict_public_file();
    case 'FORM_PUBLIC_GUEST_TIER_UNAVAILABLE':
      return m.form_option_conflict_public_guest_tier();
  }
}

/**
 * The hint of a shut switch: every reason, and only the real ones - or null when it is open. A
 * switch shut for two reasons says both, so the manager does not undo one and meet the next.
 */
export function conflictHint(codes: readonly FormConfigConflict[]): string | null {
  return codes.length === 0 ? null : codes.map(formConflictMessage).join(' ');
}

/**
 * The sentence for a server refusal carrying one of the option conflicts' codes, or `null` when the
 * code is none of them (the caller tries the next mapper). Classified by the code, never the prose.
 */
export function conflictCodeMessage(code: string | null): string | null {
  if (
    code === FORM_PUBLIC_GUEST_TIER_UNAVAILABLE ||
    (code != null && code in FORM_OPTION_CONFLICTS)
  ) {
    return formConflictMessage(code as FormConfigConflict);
  }
  return null;
}
