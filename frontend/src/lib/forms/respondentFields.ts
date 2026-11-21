import { m } from '$lib/paraglide/messages';
import {
  CAMPUSES,
  FORMATIONS,
  campusLabel,
  formationLabel,
  type Campus,
  type Formation,
} from '$lib/profile/miconnectProfile';
import type { Submission } from './api';

/**
 * THE RESPONDENT'S ACCOUNT FIELDS A FORM JOINS TO EACH ANSWER (owner, 2026-11-16) - the client half
 * of `apps/social-service/src/forms/respondent-identity.ts`.
 *
 * The editor shows ONE set of ticks ("Qui a repondu", built on the guest block of 2026-11-06): the
 * names, the e-mail, "Promo et formation", "Statut eleve / personnel", "Campus". The server stores
 * it as two lists, because a member of a named form and someone the form cannot read from an
 * account are served differently:
 *
 * - `respondentFields` - JOINED from a member's account at submit time (never typed, never sent by
 *   this page: the server reads the account), on a named form only;
 * - `guestFields` - ASKED of a guest (a public form) and of every respondent of an anonymous form,
 *   who is joined to no account. An anonymous form never asks a name or an e-mail.
 *
 * The respondent is told, before sending, which fields will reach the organiser (principle 1 of
 * the charter, docs/principes.md).
 *
 * ONE exception on an anonymous form (owner, 2026-11-21: "Oui, en option, avec avis"): the
 * organiser may have a MEMBER's "Promo et formation" read from the account instead of declared -
 * certified, and announced before sending. It is the box `cursusFromAccount`, saved as
 * `respondentFields: ['cursus']` beside `guestFields` still asking the cursus (a guest has no
 * account and declares it). Never the name, the status or the campus.
 */

/** Every choice the editor offers, in the order it and the respondent notice show them. */
const RESPONDENT_CHOICES = [
  'lastName',
  'firstName',
  'email',
  'cursus',
  'status',
  'campus',
  'cursusFromAccount',
] as const;
export type RespondentChoice = (typeof RESPONDENT_CHOICES)[number];

/** What an account can give (no e-mail: Canari keeps none for a member). */
const ACCOUNT_FIELDS = ['lastName', 'firstName', 'cursus', 'status', 'campus'] as const;
export type AccountField = (typeof ACCOUNT_FIELDS)[number];

/** What is asked as a question when no account can be read, beside a guest's names and e-mail. */
const DECLARED_FIELDS = ['cursus', 'status', 'campus'] as const;
export type DeclaredField = (typeof DECLARED_FIELDS)[number];

/** Student through a cursus, staff through a post. */
const RESPONDENT_STATUSES = ['student', 'staff'] as const;
export type RespondentStatus = (typeof RESPONDENT_STATUSES)[number];

/** The formation a respondent with no cursus declares. Mirrors the server's `NO_FORMATION`. */
export const NO_FORMATION = 'none';

/** One cursus, as an answer keeps it. */
interface RespondentCursus {
  promo: number | null;
  formation: string | null;
}

/** What an answer stores about its respondent (`submissions.respondentIdentity`). */
export interface RespondentIdentity {
  source: 'account' | 'declared';
  lastName?: string | null;
  firstName?: string | null;
  cursus?: RespondentCursus[];
  status?: RespondentStatus[];
  campus?: string | null;
  /** The keys read from the account in a snapshot that also holds declared ones (the server's). */
  fromAccount?: AccountField[];
  /**
   * The asked declared fields a store build older than the questions could not send: the server
   * took its answer without them (`predatesDeclaredFields`), and the list reads them as such.
   */
  notDeclared?: DeclaredField[];
}

/** The list a stored value holds, canonical in `vocabulary` order. */
function pick<T extends string>(
  stored: readonly string[] | null | undefined,
  vocabulary: readonly T[]
): T[] {
  return vocabulary.filter((f) => stored?.includes(f));
}

/** The declared fields a form asks (from `guestFields`). */
export function askedDeclaredFields(stored: readonly string[] | null | undefined): DeclaredField[] {
  return pick(stored, DECLARED_FIELDS);
}

/** The account fields a form joins (from `respondentFields`, served empty on an anonymous form). */
export function joinedAccountFields(stored: readonly string[] | null | undefined): AccountField[] {
  return pick(stored, ACCOUNT_FIELDS);
}

/**
 * The editor's ticks, from a stored form: what it joins and what it asks, as one set. A form saved
 * before the account fields joined the two names and asked guests separately; both show here, and
 * the next save applies the one set to both (a guest is then asked what a member gives). On an
 * anonymous form a joined cursus is its own box (`cursusFromAccount`), the cursus staying asked.
 */
export function editorChoicesOf(form: {
  anonymous?: boolean | null;
  respondentFields?: readonly string[] | null;
  guestFields?: readonly string[] | null;
}): RespondentChoice[] {
  const joined = form.respondentFields ?? [];
  const all: string[] = [...joined, ...(form.guestFields ?? [])];
  if (form.anonymous && joined.includes('cursus')) all.push('cursusFromAccount');
  return pick(all, RESPONDENT_CHOICES);
}

/**
 * Which choices a form can offer: an anonymous form asks no name nor e-mail and may read the cursus
 * from the account; the e-mail is a guest's.
 */
export function offeredChoices(isPublic: boolean, anonymous: boolean): RespondentChoice[] {
  if (anonymous) return [...DECLARED_FIELDS, 'cursusFromAccount'];
  return RESPONDENT_CHOICES.filter((c) =>
    c === 'cursusFromAccount' ? false : c !== 'email' || isPublic
  );
}

/** Whether an anonymous form reads its members' cursus from the account (`respondentFields`). */
export function joinsCursusFromAccount(form: {
  anonymous?: boolean | null;
  respondentFields?: readonly string[] | null;
}): boolean {
  return form.anonymous === true && (form.respondentFields ?? []).includes('cursus');
}

/**
 * What a MEMBER of an anonymous form is asked to declare: the form's declared fields without the
 * cursus when the form reads it from the account - one field, one source. A guest declares it all
 * (`askedDeclaredFields`).
 */
export function askedOfMember(form: {
  anonymous?: boolean | null;
  respondentFields?: readonly string[] | null;
  guestFields?: readonly string[] | null;
}): DeclaredField[] {
  const asked = askedDeclaredFields(form.guestFields);
  return joinsCursusFromAccount(form) ? asked.filter((f) => f !== 'cursus') : asked;
}

/**
 * The two lists a save sends, from the editor's one set: joined from a member's account on a named
 * form; asked of a guest on a public form and of everyone on an anonymous one. A choice the form
 * cannot offer is never sent.
 */
export function respondentSettingsPayload(
  choices: readonly string[],
  form: { isPublic: boolean; anonymous: boolean }
): { respondentFields: AccountField[]; guestFields: RespondentChoice[] } {
  const offered = pick(choices, offeredChoices(form.isPublic, form.anonymous));
  // The join needs the cursus ticked too: a guest of the form is asked it, and the box without it
  // would join a field nobody ticked.
  const joinsCursus = offered.includes('cursusFromAccount') && offered.includes('cursus');
  return {
    respondentFields: form.anonymous
      ? joinsCursus
        ? ['cursus']
        : []
      : pick(offered, ACCOUNT_FIELDS),
    guestFields: form.anonymous
      ? pick(offered, DECLARED_FIELDS)
      : form.isPublic
        ? offered.filter((c) => c !== 'cursusFromAccount')
        : [],
  };
}

/** The label of one choice, for the editor and the respondent notice alike. */
export function respondentChoiceLabel(choice: RespondentChoice): string {
  switch (choice) {
    case 'lastName':
      return m.form_guest_identity_last_name();
    case 'firstName':
      return m.form_guest_identity_first_name();
    case 'email':
      return m.form_guest_identity_email();
    case 'cursus':
      return m.form_respondent_field_cursus();
    case 'status':
      return m.form_respondent_field_status();
    case 'campus':
      return m.form_respondent_field_campus();
    case 'cursusFromAccount':
      return m.form_respondent_field_cursus_from_account();
  }
}

/** The localized word of a status. */
export function statusLabel(status: RespondentStatus): string {
  return status === 'student'
    ? m.form_respondent_status_student()
    : m.form_respondent_status_staff();
}

/** The localized word of a stored campus; a value this build does not know is shown as stored. */
function campusWord(campus: string): string {
  return (CAMPUSES as readonly string[]).includes(campus) ? campusLabel(campus as Campus) : campus;
}

/** The localized word of a stored formation; "none" reads as such. */
export function formationWord(formation: string): string {
  if (formation === NO_FORMATION) return m.form_respondent_no_cursus();
  return (FORMATIONS as readonly string[]).includes(formation)
    ? formationLabel(formation as Formation)
    : formation;
}

/** What a respondent typed of the declared fields; empty strings until answered. */
export interface DeclaredValues {
  formation: string;
  /** A number input binds a number once typed, a string while empty. */
  promo: string | number;
  status: string;
  campus: string;
}

/** An empty declaration: the page's starting state, and its state after "answer again". */
export function emptyDeclaredValues(): DeclaredValues {
  return { formation: '', promo: '', status: '', campus: '' };
}

/** The bounds of a declared entry year (the server's). */
export const DECLARED_PROMO_MIN = 1900;
export const DECLARED_PROMO_MAX = 2100;

/** What is wrong with one asked declared field, or null - said on the field, before sending. */
export function declaredProblem(field: DeclaredField, values: DeclaredValues): string | null {
  switch (field) {
    case 'cursus': {
      if (!values.formation) return m.form_guest_identity_required();
      if (values.formation === NO_FORMATION) return null;
      const promo = Number(values.promo);
      if (
        String(values.promo).trim() === '' ||
        !Number.isInteger(promo) ||
        promo < DECLARED_PROMO_MIN ||
        promo > DECLARED_PROMO_MAX
      ) {
        return m.form_respondent_promo_invalid();
      }
      return null;
    }
    case 'status':
      return values.status ? null : m.form_guest_identity_required();
    case 'campus':
      return values.campus ? null : m.form_guest_identity_required();
  }
}

/** The first asked declared field with a problem, or null when every one is answered. */
export function firstDeclaredProblem(
  asked: readonly DeclaredField[],
  values: DeclaredValues
): DeclaredField | null {
  return asked.find((f) => declaredProblem(f, values) !== null) ?? null;
}

/** The wire properties of the submit body: only the asked fields. */
export function declaredPayload(
  asked: readonly DeclaredField[],
  values: DeclaredValues
): {
  declaredFormation?: string;
  declaredPromo?: number;
  declaredStatus?: string;
  declaredCampus?: string;
} {
  const cursus = asked.includes('cursus');
  return {
    ...(cursus ? { declaredFormation: values.formation } : {}),
    ...(cursus && values.formation !== NO_FORMATION ? { declaredPromo: Number(values.promo) } : {}),
    ...(asked.includes('status') ? { declaredStatus: values.status } : {}),
    ...(asked.includes('campus') ? { declaredCampus: values.campus } : {}),
  };
}

/** The options of the declared formation picker: every formation, then "no cursus". */
export function formationOptions(): { value: string; label: string }[] {
  return [
    ...FORMATIONS.map((f) => ({ value: f, label: formationLabel(f) })),
    { value: NO_FORMATION, label: m.form_respondent_no_cursus() },
  ];
}

/** The options of the declared status picker. */
export function statusOptions(): { value: string; label: string }[] {
  return RESPONDENT_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }));
}

/** The options of the declared campus picker. */
export function campusOptions(): { value: string; label: string }[] {
  return CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) }));
}

/**
 * Which identity columns the responses list draws - the server's `identityColumnsOf`: a field the
 * form joins or asks now, or one an answer carries from when it did.
 */
export function identityColumnsOf(
  form: {
    anonymous?: boolean | null;
    respondentFields?: readonly string[] | null;
    guestFields?: readonly string[] | null;
  },
  rows: readonly Pick<Submission, 'respondentIdentity'>[]
): DeclaredField[] {
  const now = new Set<string>([
    ...(form.anonymous ? [] : joinedAccountFields(form.respondentFields)),
    ...askedDeclaredFields(form.guestFields),
  ]);
  return DECLARED_FIELDS.filter(
    (f) =>
      now.has(f) ||
      rows.some(
        (r) =>
          r.respondentIdentity?.[f] !== undefined || r.respondentIdentity?.notDeclared?.includes(f)
      )
  );
}

/** One identity cell of a row, as the list shows it ("2024 ISMIN", "Eleve", "Gardanne"). */
export function identityCellText(
  identity: RespondentIdentity | null | undefined,
  field: DeclaredField
): string {
  if (identity?.notDeclared?.includes(field)) return m.form_respondent_not_declared();
  switch (field) {
    case 'cursus':
      return (identity?.cursus ?? [])
        .map((c) => [c.promo ?? '', c.formation ? formationWord(c.formation) : ''].join(' ').trim())
        .filter(Boolean)
        .join(', ');
    case 'status':
      return (identity?.status ?? []).map(statusLabel).join(', ');
    case 'campus':
      return identity?.campus ? campusWord(identity.campus) : '';
  }
}

/** Where an answer's cursus came from (the server's `cursusSourceOf`). */
export function cursusSourceOf(
  identity: RespondentIdentity | null | undefined
): 'account' | 'declared' | null {
  if (!identity) return null;
  if (identity.fromAccount?.includes('cursus')) return 'account';
  if (identity.cursus === undefined && !identity.notDeclared?.includes('cursus')) return null;
  return identity.source;
}

/**
 * Whether the list says where the cursus came from (the server's `showsCursusSource`): on an
 * anonymous form, once any answer carries one read from the account - certified and declared values
 * are never mixed silently in one column.
 */
export function showsCursusSource(
  form: { anonymous?: boolean | null },
  rows: readonly Pick<Submission, 'respondentIdentity'>[]
): boolean {
  return (
    form.anonymous === true && rows.some((r) => cursusSourceOf(r.respondentIdentity) === 'account')
  );
}

/** The word of a cursus source in the list ("compte" / "declare"); blank when the answer has none. */
export function cursusSourceText(identity: RespondentIdentity | null | undefined): string {
  const source = cursusSourceOf(identity);
  if (source === 'account') return m.form_respondent_source_account();
  if (source === 'declared') return m.form_respondent_source_declared();
  return '';
}

/** The responses list's identity filter: a value per criterion, '' for "every". */
export interface IdentityFilter {
  promo: string;
  formation: string;
  status: string;
}

/** No filter at all. */
export function emptyIdentityFilter(): IdentityFilter {
  return { promo: '', formation: '', status: '' };
}

/** The values each criterion can take among these rows, sorted (promos newest first). */
export function identityFilterValues(rows: readonly Pick<Submission, 'respondentIdentity'>[]): {
  promo: string[];
  formation: string[];
  status: RespondentStatus[];
} {
  const promos = new Set<string>();
  const formations = new Set<string>();
  const statuses = new Set<RespondentStatus>();
  for (const row of rows) {
    for (const c of row.respondentIdentity?.cursus ?? []) {
      if (c.promo !== null) promos.add(String(c.promo));
      if (c.formation) formations.add(c.formation);
    }
    for (const s of row.respondentIdentity?.status ?? []) statuses.add(s);
  }
  return {
    promo: [...promos].sort((a, b) => Number(b) - Number(a)),
    formation: [...formations].sort(),
    status: RESPONDENT_STATUSES.filter((s) => statuses.has(s)),
  };
}

/**
 * Whether a row passes the filter. Promo and formation are judged on ONE cursus entry together, as
 * a price is (someone in ICM 2024 and Autre 2020 is not "ICM 2020").
 */
export function matchesIdentityFilter(
  row: Pick<Submission, 'respondentIdentity'>,
  filter: IdentityFilter
): boolean {
  const identity = row.respondentIdentity;
  if (filter.status && !(identity?.status ?? []).includes(filter.status as RespondentStatus)) {
    return false;
  }
  if (!filter.promo && !filter.formation) return true;
  return (identity?.cursus ?? []).some(
    (c) =>
      (!filter.promo || String(c.promo) === filter.promo) &&
      (!filter.formation || c.formation === filter.formation)
  );
}

/**
 * What the respondent notice lists: the fields that will reach the organiser with this answer, the
 * joined ones of a named form. A form joining nothing lists nothing (no notice is drawn).
 */
export function transmittedFieldLabels(joined: readonly AccountField[]): string[] {
  return joined.map((f) => respondentChoiceLabel(f));
}
