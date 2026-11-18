import { BadRequestException, Logger } from '@nestjs/common';
import { clientVersionAtLeast } from '../common/client-version';
import { SPACE_CAMPUSES, SPACE_FORMATIONS } from '../spaces/space.entity';
import type { IdentityExportLabels } from './export-labels';
import {
  FORM_GUEST_IDENTITY_MISSING,
  FORM_GUEST_IDENTITY_NOT_ASKED,
  formRefusal,
} from './answer-bounds';

/**
 * THE RESPONDENT'S ACCOUNT FIELDS A FORM JOINS TO EACH ANSWER (owner, 2026-11-16).
 *
 * An organiser chooses, PER FORM, which of "Nom", "Prenom", "Promo et formation", "Statut eleve /
 * personnel" and "Campus" travel with each answer - each optional. Built on the guest block of
 * 2026-11-06 (`guest-identity.ts`): ONE set of ticks in the editor, read two ways.
 *
 * - **Joined from the account** (`forms.respondentFields`, migration 174): a member answering a
 *   NAMED form. The values are read from core-service AT SUBMIT TIME, never from the request, and
 *   stored with the answer (`submissions.respondentIdentity`, `source: 'account'`) - a snapshot: the
 *   answer keeps what was true when it was given, whatever the profile says later.
 * - **Asked as a question** (`forms.guestFields`, extended): whoever the form cannot read from an
 *   account - a guest on a public form, and EVERY respondent of an anonymous form (an anonymous
 *   answer is joined to no account). Names and the e-mail stay the guest columns of migration 138;
 *   "Promo et formation", "Statut" and "Campus" are DECLARED (`source: 'declared'`). An anonymous
 *   form never asks a name or an e-mail (`FORM_ANONYMOUS_GUEST_IDENTITY`): it promised not to keep
 *   who answered.
 *
 * Principle 1 of the charter ("Vos messages sont a vous", docs/principes.md): nothing about the
 * respondent leaves their account unless the organiser asked for it AND the respondent was shown it
 * before sending. The respondent notice is drawn from the same list this module reads.
 */

const logger = new Logger('RespondentIdentity');

/** What a form may join from an account, in the order the page and the export show them. */
export const ACCOUNT_FIELDS = ['lastName', 'firstName', 'cursus', 'status', 'campus'] as const;
export type AccountField = (typeof ACCOUNT_FIELDS)[number];

/** What is DECLARED when no account can be read: asked as a question, stored with the answer. */
export const DECLARED_FIELDS = ['cursus', 'status', 'campus'] as const;
export type DeclaredField = (typeof DECLARED_FIELDS)[number];

/** The respondent's status: a cursus makes a student, a post (EMSE, ME, Alumni) makes staff (D2). */
export const RESPONDENT_STATUSES = ['student', 'staff'] as const;
export type RespondentStatus = (typeof RESPONDENT_STATUSES)[number];

/** A declared formation of nobody: a respondent with no cursus (staff) answers "none". */
export const NO_FORMATION = 'none';

/** The bounds of a declared entry year - the profile edit's typo guard (core `miconnect-profile`). */
export const DECLARED_PROMO_MIN = 1900;
export const DECLARED_PROMO_MAX = 2100;

/**
 * The first build that draws the declared questions ("A propos de vous") and names itself on a
 * submit (`X-Canari-Client-Version`). An answer from an older build - or one naming no build - to a
 * form that asks declared fields is taken WITHOUT them and marked {@link RespondentIdentity.notDeclared}
 * ([LEGACY], `docs/wiki/legacy-compatibility.md`): it cannot draw the questions, and an old client's
 * ordinary request is never refused.
 */
export const RESPONDENT_FIELDS_MIN_CLIENT_VERSION = '1.7.0';

/** Whether a submit comes from a build older than the declared questions (absent header included). */
export function predatesDeclaredFields(clientVersion: string | undefined): boolean {
  return clientVersionAtLeast(clientVersion, RESPONDENT_FIELDS_MIN_CLIENT_VERSION) !== true;
}

/** One cursus as an answer keeps it. */
export interface RespondentCursus {
  promo: number | null;
  formation: string | null;
}

/**
 * What an answer stores about its respondent (`submissions.respondentIdentity`): only the keys the
 * form joined or asked. `source` says whether the account gave them or the respondent typed them.
 * NULL on a guest's answer that declared nothing, and on every answer given before migration 174.
 */
export interface RespondentIdentity {
  source: 'account' | 'declared';
  lastName?: string | null;
  firstName?: string | null;
  cursus?: RespondentCursus[];
  status?: RespondentStatus[];
  campus?: string | null;
  /**
   * The declared fields the form asked that the respondent's build could not draw (a store build
   * older than {@link RESPONDENT_FIELDS_MIN_CLIENT_VERSION}): the organiser reads them as "not
   * declared", never as blank or as a value.
   */
  notDeclared?: DeclaredField[];
}

/** What core-service serves for one account (`internal/users/:id/respondent-identity`). */
export interface AccountIdentity {
  firstName: string | null;
  lastName: string | null;
  campus: string | null;
  posts: string[];
  cursusViews: RespondentCursus[];
}

/**
 * The part of an account social-service reads ITSELF from the shared `users` table (the same
 * database as core-service, read as the responses list always read names): what a form joins of
 * the names and the campus needs no other service.
 */
export type SharedAccountFields = Pick<AccountIdentity, 'firstName' | 'lastName' | 'campus'>;

/**
 * The account fields read from core-service instead: "Promo et formation" is every cursus through
 * `cursusViewsOf` (D32: the well-formed entries plus the legacy promo / formation pair when no entry
 * carries it), the ONE reconciliation pricing reads too, and the status is derived from those views
 * and the posts. Their columns are in the shared table; the RULE lives in core-service, and a
 * second spelling of it here could disagree with the price the same person is charged.
 */
const CORE_ACCOUNT_FIELDS: readonly AccountField[] = ['cursus', 'status'];

/** Whether a form's joins need core-service (a cursus or a status), or the shared table is enough. */
export function joinsNeedCore(joined: readonly AccountField[]): boolean {
  return joined.some((f) => CORE_ACCOUNT_FIELDS.includes(f));
}

/** The account fields a form joins by default, and every form before migration 174 joined. */
export const DEFAULT_ACCOUNT_FIELDS: AccountField[] = ['lastName', 'firstName'];

/** Keeps the known names of `stored` from `vocabulary`, each once, in vocabulary order. */
function canonical<T extends string>(
  stored: unknown,
  vocabulary: readonly T[],
  column: string,
  ignored: readonly string[] = []
): T[] {
  if (stored == null) return [];
  if (!Array.isArray(stored)) {
    logger.warn(`[FORMS] ${column} is not a list (${typeof stored}): read as empty`);
    return [];
  }
  const unknown = stored.filter(
    (f) => !(vocabulary as readonly unknown[]).includes(f) && !ignored.includes(f as string)
  );
  if (unknown.length > 0) {
    logger.warn(`[FORMS] ${column} holds unknown names ${JSON.stringify(unknown)}: dropped`);
  }
  return vocabulary.filter((f) => stored.includes(f));
}

/** The canonical account fields of a stored or sent `respondentFields`. */
export function accountFieldsOf(stored: unknown): AccountField[] {
  return canonical(stored, ACCOUNT_FIELDS, 'respondentFields');
}

/**
 * What a form joins from a member's account: nothing on an ANONYMOUS form (its answers name no
 * account), its canonical `respondentFields` otherwise.
 */
export function joinedAccountFields(form: {
  anonymous?: boolean | null;
  respondentFields?: unknown;
}): AccountField[] {
  return form.anonymous ? [] : accountFieldsOf(form.respondentFields);
}

/**
 * What a save stores in `forms.respondentFields`: the canonical list, and always the empty one on
 * an anonymous form - so the column never claims a join the form will not make.
 */
export function storedRespondentFields(input: unknown, anonymous: boolean): AccountField[] {
  return anonymous ? [] : accountFieldsOf(input);
}

/** The declared fields a form asks (`forms.guestFields`, whose names and e-mail are the guest's). */
export function askedDeclaredFields(stored: unknown): DeclaredField[] {
  return canonical(stored, DECLARED_FIELDS, 'guestFields', ['lastName', 'firstName', 'email']);
}

/**
 * The statuses an account holds: a student through any cursus, staff through any post. Both at
 * once is possible (D1, affiliations are cumulative); neither is an empty list.
 */
export function accountStatuses(account: AccountIdentity): RespondentStatus[] {
  const statuses: RespondentStatus[] = [];
  if (account.cursusViews.some((c) => c.promo !== null || c.formation !== null)) {
    statuses.push('student');
  }
  if (account.posts.length > 0) statuses.push('staff');
  return statuses;
}

/**
 * The snapshot of a member's answer on a named form: the joined fields, read from the account.
 * Always an object - `{ source: 'account' }` when the form joins nothing - so a NULL column means
 * only "given before migration 174" (whose names are read live, as they always were).
 */
export function accountSnapshot(
  joined: readonly AccountField[],
  account: AccountIdentity | SharedAccountFields | null
): RespondentIdentity {
  const snapshot: RespondentIdentity = { source: 'account' };
  const full = (field: AccountField): AccountIdentity | null => {
    if (!account) return null;
    if (!('cursusViews' in account)) {
      // `joinsNeedCore` routes a cursus or a status to core-service: reaching here is a caller bug.
      throw new Error(`accountSnapshot: ${field} joined from the shared table alone`);
    }
    return account;
  };
  for (const field of joined) {
    switch (field) {
      case 'lastName':
        snapshot.lastName = account?.lastName ?? null;
        break;
      case 'firstName':
        snapshot.firstName = account?.firstName ?? null;
        break;
      case 'cursus':
        snapshot.cursus = (full(field)?.cursusViews ?? []).map((c) => ({
          promo: c.promo ?? null,
          formation: c.formation ?? null,
        }));
        break;
      case 'status':
        snapshot.status = account ? accountStatuses(full(field)!) : [];
        break;
      case 'campus':
        snapshot.campus = account?.campus ?? null;
        break;
    }
  }
  return snapshot;
}

/** What an answer may carry of the declared fields, as the DTO receives them. */
export interface DeclaredIdentityInput {
  declaredFormation?: string;
  declaredPromo?: number;
  declaredStatus?: string;
  declaredCampus?: string;
}

/** Whether an answer carries any declared field, an empty one included. */
function carriesDeclared(input: DeclaredIdentityInput): boolean {
  return (
    input.declaredFormation !== undefined ||
    input.declaredPromo !== undefined ||
    input.declaredStatus !== undefined ||
    input.declaredCampus !== undefined
  );
}

function notAsked(field: string, formId: string): BadRequestException {
  logger.warn(`[FORMS] answer refused: ${field} declared but not asked form=${formId.slice(0, 8)}`);
  return formRefusal(FORM_GUEST_IDENTITY_NOT_ASKED, `This form does not ask for ${field}.`);
}

function missing(field: string, formId: string): BadRequestException {
  logger.log(`[FORMS] answer refused: ${field} missing form=${formId.slice(0, 8)}`);
  return formRefusal(FORM_GUEST_IDENTITY_MISSING, `This form asks for ${field}.`);
}

/**
 * What one answer DECLARES, judged against what the form asks: every asked field required and
 * valid, a field not asked refused (never silently dropped). Null when the form asks nothing - an
 * answer that asks nothing stores nothing.
 *
 * "Promo et formation" asks a formation of {@link SPACE_FORMATIONS} and an entry year, or
 * {@link NO_FORMATION} and no year (someone with no cursus - staff).
 */
export function declaredIdentityFor(
  asked: readonly DeclaredField[],
  input: DeclaredIdentityInput,
  formId: string,
  olderClient = false
): RespondentIdentity | null {
  if (asked.length === 0) {
    if (carriesDeclared(input)) throw notAsked('a declared field', formId);
    return null;
  }
  // A build older than the declared questions sends none of them: its answer is taken, the asked
  // fields marked as not declared. One that sends any is judged like every other (below).
  if (olderClient && !carriesDeclared(input)) {
    logger.log(
      `[LEGACY] answer to form=${formId.slice(0, 8)} from a build older than ` +
        `${RESPONDENT_FIELDS_MIN_CLIENT_VERSION}: ${asked.join(',')} taken as not declared`
    );
    return { source: 'declared', notDeclared: [...asked] };
  }
  const identity: RespondentIdentity = { source: 'declared' };

  if (asked.includes('cursus')) {
    const formation = input.declaredFormation;
    if (formation === undefined || formation === '') throw missing('cursus', formId);
    if (formation === NO_FORMATION) {
      if (input.declaredPromo !== undefined) throw notAsked('a promo without a formation', formId);
      identity.cursus = [];
    } else {
      if (!(SPACE_FORMATIONS as readonly string[]).includes(formation)) {
        throw missing('a known formation', formId);
      }
      const promo = input.declaredPromo;
      if (
        typeof promo !== 'number' ||
        !Number.isInteger(promo) ||
        promo < DECLARED_PROMO_MIN ||
        promo > DECLARED_PROMO_MAX
      ) {
        throw missing('promo', formId);
      }
      identity.cursus = [{ promo, formation }];
    }
  } else if (input.declaredFormation !== undefined || input.declaredPromo !== undefined) {
    throw notAsked('cursus', formId);
  }

  if (asked.includes('status')) {
    const status = input.declaredStatus;
    if (!status) throw missing('status', formId);
    if (!(RESPONDENT_STATUSES as readonly string[]).includes(status)) {
      throw missing('a known status', formId);
    }
    identity.status = [status as RespondentStatus];
  } else if (input.declaredStatus !== undefined) {
    throw notAsked('status', formId);
  }

  if (asked.includes('campus')) {
    const campus = input.declaredCampus;
    if (!campus) throw missing('campus', formId);
    if (!(SPACE_CAMPUSES as readonly string[]).includes(campus)) {
      throw missing('a known campus', formId);
    }
    identity.campus = campus;
  } else if (input.declaredCampus !== undefined) {
    throw notAsked('campus', formId);
  }

  return identity;
}

/**
 * The name an answer is listed and exported under. A guest's is what the guest typed (migration
 * 138); a member's is the SNAPSHOT when the answer has one - blank when the form did not join it;
 * an answer given before migration 174 has none and reads the account's name now, as every answer
 * always did (`live`, read only for those rows - `legacyNameIds`).
 */
export function respondentNames(
  row: {
    userId: string | null;
    guestFirstName?: string | null;
    guestLastName?: string | null;
    respondentIdentity?: RespondentIdentity | null;
  },
  live: ReadonlyMap<string, { firstName: string | null; lastName: string | null }>
): { firstName: string | null; lastName: string | null } {
  if (!row.userId) {
    return { firstName: row.guestFirstName ?? null, lastName: row.guestLastName ?? null };
  }
  const snapshot = row.respondentIdentity;
  if (snapshot) {
    return { firstName: snapshot.firstName ?? null, lastName: snapshot.lastName ?? null };
  }
  const person = live.get(row.userId);
  return { firstName: person?.firstName ?? null, lastName: person?.lastName ?? null };
}

/** The accounts whose answers predate the snapshot (no `respondentIdentity`): their names are read live. */
export function legacyNameIds(
  rows: readonly { userId: string | null; respondentIdentity?: RespondentIdentity | null }[]
): string[] {
  return [
    ...new Set(
      rows.filter((r) => r.userId && !r.respondentIdentity).map((r) => r.userId as string)
    ),
  ];
}

/**
 * Which identity columns an export or a list writes: a field the form joins or asks now, or one an
 * answer carries from when it did - never a column that cannot carry a value.
 */
export function identityColumnsOf(
  form: { anonymous?: boolean | null; respondentFields?: unknown; guestFields?: unknown },
  rows: readonly { respondentIdentity?: RespondentIdentity | null }[]
): DeclaredField[] {
  const now = new Set<string>([
    ...joinedAccountFields(form),
    ...askedDeclaredFields(form.guestFields),
  ]);
  return DECLARED_FIELDS.filter(
    (field) =>
      now.has(field) ||
      rows.some(
        (r) =>
          r.respondentIdentity?.[field] !== undefined ||
          r.respondentIdentity?.notDeclared?.includes(field)
      )
  );
}

/**
 * The identity cells of one exported answer, in the client's words. A member with two cursus reads
 * "2024; 2022" and "ICM; Autre", entry by entry; a field the answer does not carry is blank. A
 * status or a campus the client has no word for is written as stored and accused.
 */
export function identityCells(
  identity: RespondentIdentity | null | undefined,
  words: IdentityExportLabels
): { promo: string; formation: string; status: string; campus: string } {
  const cursus = identity?.cursus ?? [];
  const word = (value: string, known: string | undefined) => {
    if (known === undefined) logger.warn(`[FORMS] export: no word for "${value}", written raw`);
    return known ?? value;
  };
  const statusWord = (s: RespondentStatus) => (s === 'student' ? words.student : words.staff);
  const missing = (field: DeclaredField) => identity?.notDeclared?.includes(field) === true;
  return {
    promo: missing('cursus')
      ? words.notDeclared
      : cursus.map((c) => (c.promo === null ? '' : String(c.promo))).join('; '),
    formation: missing('cursus')
      ? words.notDeclared
      : cursus.map((c) => c.formation ?? '').join('; '),
    status: missing('status')
      ? words.notDeclared
      : (identity?.status ?? []).map(statusWord).join('; '),
    campus: missing('campus')
      ? words.notDeclared
      : identity?.campus
        ? word(identity.campus, words.campuses[identity.campus])
        : '',
  };
}
