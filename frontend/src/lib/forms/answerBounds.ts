import { m } from '$lib/paraglide/messages';
import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
import { describeApiRefusal, refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { productGridDefinitionMessage } from './productGridEditor';
import { productGridRefusalMessage } from './productGridFill';

/**
 * THE BOUNDS OF A FORM AND OF AN ANSWER, AND THE SENTENCE FOR EACH CODED REFUSAL OF A FORM.
 *
 * Equal to `libs/contracts/form-answers.json`, which `answerBounds.test.ts` reads, and mirrored by
 * social-service's `forms/answer-bounds.ts`, whose spec reads the same file - the two cannot
 * drift. The page announces a bound before anyone sends (the textarea's `maxlength` and counter)
 * and words a refusal from its CODE: the server's sentence is English and for the log, and a
 * French reader met it verbatim on the fill page until 2026-11-06 (D6 of the forms audit).
 */

/** The questions one form may hold, and so the keys one answer may carry. */
export const FORM_MAX_QUESTIONS = 100;
/** The characters of one text answer - the textarea's `maxlength` and the counter's bound. */
export const ANSWER_MAX_TEXT_LENGTH = 2000;
/** The options one multi-select answer may tick. */
export const ANSWER_MAX_SELECTIONS = 50;
/** The rows one grid may declare. */
export const GRID_MAX_ROWS = 50;
/** The characters of a guest's last or first name, when a public form asks (`guestIdentity.ts`). */
export const GUEST_NAME_MAX_LENGTH = 100;
/** The characters of a guest's e-mail, when a public form asks. */
export const GUEST_EMAIL_MAX_LENGTH = 254;

export const FORM_NOT_OPEN_YET = 'FORM_NOT_OPEN_YET';
export const FORM_CLOSED = 'FORM_CLOSED';
export const FORM_FULL = 'FORM_FULL';
export const FORM_ANSWER_MISSING = 'FORM_ANSWER_MISSING';
export const FORM_ANSWER_TOO_LONG = 'FORM_ANSWER_TOO_LONG';
export const FORM_ANSWER_TOO_MANY_SELECTIONS = 'FORM_ANSWER_TOO_MANY_SELECTIONS';
export const FORM_ANSWER_NOT_AN_OPTION = 'FORM_ANSWER_NOT_AN_OPTION';
export const FORM_GRID_ANSWER_INVALID = 'FORM_GRID_ANSWER_INVALID';
export const FORM_COMBINATION_UNAVAILABLE = 'FORM_COMBINATION_UNAVAILABLE';
export const FORM_SIGN_IN_REQUIRED = 'FORM_SIGN_IN_REQUIRED';
export const FORM_FILE_NEEDS_ACCOUNT = 'FORM_FILE_NEEDS_ACCOUNT';
export const FORM_GRID_DUPLICATE_LABEL = 'FORM_GRID_DUPLICATE_LABEL';
export const FORM_GRID_TOO_MANY_ROWS = 'FORM_GRID_TOO_MANY_ROWS';
export const FORM_TOO_MANY_QUESTIONS = 'FORM_TOO_MANY_QUESTIONS';
export const FORM_GUEST_IDENTITY_MISSING = 'FORM_GUEST_IDENTITY_MISSING';
export const FORM_GUEST_IDENTITY_NOT_ASKED = 'FORM_GUEST_IDENTITY_NOT_ASKED';
/** A price grid splits a multiple-choice question into several groups (refused at save). */
export const FORM_GRID_MULTIPLE_CHOICE_SPLIT = 'FORM_GRID_MULTIPLE_CHOICE_SPLIT';
/** The form does not let its answers be changed (the switch is off, or it is anonymous). */
export const FORM_ANSWER_EDIT_OFF = 'FORM_ANSWER_EDIT_OFF';
/** An edit changed a question that touches the price; `itemId` names it. */
export const FORM_ANSWER_LOCKED = 'FORM_ANSWER_LOCKED';
/** The answer was cancelled or has expired: nothing left to change. */
export const FORM_ANSWER_NOT_EDITABLE = 'FORM_ANSWER_NOT_EDITABLE';
/** No answer of the reader's under this id. */
export const FORM_ANSWER_NOT_FOUND = 'FORM_ANSWER_NOT_FOUND';
/** A manager deleted an answer whose payment was received: refund or cancel it instead. */
export const FORM_ANSWER_PAID = 'FORM_ANSWER_PAID';

/**
 * The sentence for a form's CODED refusal, or `null` when the code is none of a form's (the
 * caller then tries the next mapper, and ends on its own generic line). Classified by the code,
 * never by the message.
 */
export function formCodeMessage(code: string | null): string | null {
  switch (code) {
    case FORM_NOT_OPEN_YET:
      return m.form_refusal_not_open_yet();
    case FORM_CLOSED:
      return m.form_refusal_closed();
    case FORM_FULL:
      return m.form_refusal_full();
    case FORM_ANSWER_MISSING:
      return m.form_refusal_answer_missing();
    case FORM_ANSWER_TOO_LONG:
      return m.form_refusal_answer_too_long({ max: ANSWER_MAX_TEXT_LENGTH });
    case FORM_ANSWER_TOO_MANY_SELECTIONS:
    case FORM_ANSWER_NOT_AN_OPTION:
    case FORM_GRID_ANSWER_INVALID:
      return m.form_refusal_answer_invalid();
    case FORM_COMBINATION_UNAVAILABLE:
      return m.form_refusal_combination_unavailable();
    case FORM_SIGN_IN_REQUIRED:
      return m.form_view_error_login_required();
    case FORM_FILE_NEEDS_ACCOUNT:
      return m.form_refusal_file_needs_account();
    case FORM_GRID_DUPLICATE_LABEL:
      return m.form_builder_grid_duplicate_label();
    case FORM_GRID_TOO_MANY_ROWS:
      return m.form_builder_grid_too_many_rows({ max: GRID_MAX_ROWS });
    case FORM_TOO_MANY_QUESTIONS:
      return m.form_builder_too_many_questions({ max: FORM_MAX_QUESTIONS });
    case FORM_GUEST_IDENTITY_MISSING:
      return m.form_refusal_guest_identity_missing();
    case FORM_GUEST_IDENTITY_NOT_ASKED:
      // The page sends only what the form asks: the form changed under an open page.
      return m.form_refusal_guest_identity_changed();
    case FORM_GRID_MULTIPLE_CHOICE_SPLIT:
      return m.form_refusal_grid_multiple_choice_split();
    case FORM_ANSWER_EDIT_OFF:
      return m.form_refusal_answer_edit_off();
    case FORM_ANSWER_LOCKED:
      return m.form_refusal_answer_locked();
    case FORM_ANSWER_NOT_EDITABLE:
    case FORM_ANSWER_NOT_FOUND:
      return m.form_refusal_answer_not_editable();
    case FORM_ANSWER_PAID:
      return m.form_refusal_answer_paid();
    default:
      // A priced grid's coded refusal (`PRODUCT_GRID_*`): an answer's, else a definition's at save.
      return productGridRefusalMessage(code) ?? productGridDefinitionMessage(code);
  }
}

/**
 * THE ONE SENTENCE A REFUSED FORM SUBMIT READS AS, member and guest pages alike: a form's coded
 * refusal, else a payment refusal (`providerRefusalMessage`), else what the status alone says,
 * else `fallback`. Never the server's prose.
 */
export function formSubmitRefusalMessage(err: unknown, fallback: string): string {
  return (
    formCodeMessage(refusalCode(err)) ??
    providerRefusalMessage(err) ??
    describeApiRefusal(refusalStatus(err), m.form_refusal_action_submit()) ??
    fallback
  );
}

/** A grid row as the editor holds it (`{ id, value }`) or as it is stored (the label). */
type EditorRow = string | { value?: string };

/** The label of a grid row, whichever shape holds it. */
function rowLabel(row: EditorRow): string {
  return typeof row === 'string' ? row : (row.value ?? '');
}

/**
 * The labels that occur more than once among a grid's non-empty `labels` - what the editor marks
 * inline. Compared exactly, as the server does: the row label IS the answer's key (D4).
 */
export function duplicateLabels(labels: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const label of labels) {
    if (!label) continue;
    if (seen.has(label)) twice.add(label);
    seen.add(label);
  }
  return twice;
}

/** The row labels of an editor grid, empty rows included (the payload drops those). */
export function gridRowLabels(rows: readonly EditorRow[] | undefined): string[] {
  return (rows ?? []).map(rowLabel);
}

/**
 * Why the server would refuse these questions at save (`assertFormItemsShape`), as a sentence -
 * or null when it would not. Checked before the save so the organiser reads it where they type,
 * the server's coded refusal staying the one that decides.
 */
export function formItemsProblem(
  items: readonly {
    type?: string;
    label?: string;
    rows?: readonly EditorRow[];
    options?: readonly { label?: string }[];
  }[]
): string | null {
  if (items.length > FORM_MAX_QUESTIONS) {
    return m.form_builder_too_many_questions({ max: FORM_MAX_QUESTIONS });
  }
  for (const item of items) {
    if (item.type !== 'matrix_single' && item.type !== 'matrix_multiple') continue;
    const rows = gridRowLabels(item.rows).filter(Boolean);
    if (rows.length > GRID_MAX_ROWS)
      return m.form_builder_grid_too_many_rows({ max: GRID_MAX_ROWS });
    // As `toFormItemsPayload` sends them: a blank column is dropped, a label is sent as typed.
    const columns = (item.options ?? []).filter((o) => o.label?.trim()).map((o) => o.label!);
    const [duplicate] = [...duplicateLabels(rows), ...duplicateLabels(columns)];
    if (duplicate !== undefined) {
      return m.form_builder_grid_duplicate_label_named({ duplicate, label: item.label ?? '' });
    }
  }
  return null;
}
