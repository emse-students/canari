import { Log } from '$lib/utils/Log';
import { isFormBlock } from './formBlocks';
import {
  respondentChoiceLabel,
  respondentSettingsPayload,
  type RespondentChoice,
} from './respondentFields';

/**
 * A QUESTION THE FORM ALREADY ANSWERS (owner, 2026-11-23) - the editor's non-blocking warning.
 *
 * Production saw a registration form asking "Nom", "Prenom", "Adresse mail" and "Promo" while it
 * already transmitted the respondent's names from the account: the respondent typed twice what the
 * organiser receives. The editor says so under such a question; it never blocks the save, since
 * the organiser may want the question anyway (a nickname, a name for a friend).
 *
 * The matching is deliberately dull: the label, trimmed, lower-cased, accent-folded and stripped of
 * trailing punctuation, must EQUAL one of a short list per field. Nothing fuzzier.
 */

/** The fields a label can duplicate: the editor's choices a form transmits. */
export type TransmittableField = Exclude<RespondentChoice, 'cursusFromAccount'>;

/** The folded labels of each field (see `fold`): written already folded, one list, no regex. */
const SYNONYMS: Record<TransmittableField, readonly string[]> = {
  lastName: ['nom', 'nom de famille', 'last name', 'lastname', 'surname', 'family name'],
  firstName: ['prenom', 'first name', 'firstname', 'given name'],
  email: ['mail', 'adresse mail', 'adresse e-mail', 'adresse email', 'e-mail', 'email', 'courriel'],
  cursus: ['promo', 'promotion', 'formation', 'filiere', 'cursus', 'promo et formation'],
  status: ['statut', 'status'],
  campus: ['campus', 'site'],
};

/** Lower-case, accents removed, trailing "?", ":", "*" and spaces dropped, inner spaces collapsed. */
export function foldQuestionLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s:?*.!]+$/, '')
    .trim();
}

/** The field a question label duplicates, or null. Order of `SYNONYMS` settles a shared word. */
export function duplicatedIdentityField(
  label: string | null | undefined
): TransmittableField | null {
  const folded = foldQuestionLabel(label ?? '');
  if (folded === '') return null;
  const fields = Object.keys(SYNONYMS) as TransmittableField[];
  return fields.find((f) => SYNONYMS[f].includes(folded)) ?? null;
}

/**
 * The fields THIS form transmits with every answer, from the editor's live settings: exactly what
 * a save would send (`respondentSettingsPayload`), kept only when it reaches every respondent.
 * A named form joins the member's account fields; on a public one a guest must be asked the same
 * field too, so an e-mail only a guest gives is not "already transmitted" (a member still has to
 * type it). An anonymous form transmits what it asks, never a name or an e-mail.
 */
export function transmittedFieldsOf(
  choices: readonly string[],
  form: { isPublic: boolean; anonymous: boolean }
): TransmittableField[] {
  const { respondentFields, guestFields } = respondentSettingsPayload(choices, form);
  const asked = guestFields.filter((f): f is TransmittableField => f !== 'cursusFromAccount');
  if (form.anonymous) return asked;
  const joined: TransmittableField[] = respondentFields;
  return form.isPublic ? joined.filter((f) => asked.includes(f)) : joined;
}

/**
 * Per question id, the label of the transmitted field its title duplicates. Blocks (text, image)
 * are no questions and are never flagged.
 */
export function identityDuplicates(
  items: readonly { id: string; type?: string; label?: string | null }[],
  transmitted: readonly TransmittableField[]
): Map<string, string> {
  const found = new Map<string, string>();
  if (transmitted.length === 0) return found;
  for (const item of items) {
    if (isFormBlock(item)) continue;
    const field = duplicatedIdentityField(item.label);
    if (field && transmitted.includes(field)) {
      found.set(item.id, respondentChoiceLabel(field));
    }
  }
  if (found.size > 0)
    Log.d('FormEditor', `${found.size} question(s) duplicate a transmitted field`);
  return found;
}
