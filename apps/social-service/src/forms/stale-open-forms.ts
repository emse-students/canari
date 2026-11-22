import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { associationArchivedSql } from '../associations/association-archived';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';

/**
 * THE QUESTION PUT TO A FORM LEFT OPEN (owner, 2026-11-21; docs/wiki/frontend/modules/forms.md, "The
 * question put to a form left open"): a published form with no closing date and no new answer for
 * {@link STALE_OPEN_FORM_DAYS} days is asked about ONCE - "Ce formulaire est toujours ouvert. Le
 * fermer ?" - to its owner and its `MANAGE_FORMS` holders.
 *
 * WHY 21: read off production on 2026-11-21 (21 forms, 721 answers), the longest gap between two
 * answers of a form that went on living was 17 days (p99 of that form 13.8, every other form under
 * 13). Fourteen days would have asked it in the middle of its own rhythm; twenty-one never asks a
 * form inside the rhythm it has shown.
 *
 * ALL OF THE STATE IS TWO COLUMNS OF `forms` (migration 180), and THE SWEEP'S CLAIM IS ITS ONLY
 * WRITE: {@link STALE_OPEN_CLAIM_SQL} locks ONE due form `FOR UPDATE SKIP LOCKED` and stamps
 * `staleAskedAt`, in the SAME transaction as the form's bell rows, so two replicas or a re-run
 * cannot ask a form twice and a process dying mid-way loses no question.
 * - ASKED ONCE: a form whose `staleAskedAt` is set is never asked again by the passing of time.
 * - RE-ARMED ONLY BY AN ANSWER: it is asked again only when an answer arrived on or after the day of
 *   the last question (day granularity, UTC: an anonymous form stores the UTC DAY of its answers, so a
 *   same-day answer must count) AND the form is then silent for the whole window again. "Garder
 *   ouvert" therefore silences it until a new answer arrives, which is the only evidence that the
 *   form lives; it needs no state of its own for the sweep (`staleKeptAt` only hides the question).
 * - CLOSING, OR SETTING A DATE, ends it: both leave `closedAt` set, which is not the predicate, and
 *   both clear the memory (`staleAskedAt`, `staleKeptAt`), so a form reopened later is a new form to
 *   this question and the bell rows of the earlier one (they name the earlier `staleAskedAt`) stay
 *   hidden.
 *
 * WHAT "SILENT" MEANS: the newest of the form's creation, its last edit and its last answer. A
 * manager editing a form is a sign of life; a form nobody ever answered counts from its last touch,
 * so a draft published today is not asked about on its first day.
 */
export const STALE_OPEN_FORM_DAYS = 21;

const logger = new Logger('StaleOpenForms');

const short = (id: string) => id.slice(0, 8);

/** The newest answer row of form `f` (a precise time, or the day for an anonymous form). */
const LAST_ANSWER_SQL = `(SELECT max(s."createdAt") FROM submissions s WHERE s."formId" = f.id)`;

/**
 * THE PREDICATE, over form alias `f`, with `$1` the instant to judge at and `$2` the window in days:
 * published, not deleted, no closing date, already opened, its association not archived, silent for
 * the whole window, and never asked or answered since the last question.
 */
const STALE_OPEN_WHERE = `f."deletedAt" IS NULL
     AND f.status = 'published'
     AND f."closedAt" IS NULL
     AND (f."opensAt" IS NULL OR f."opensAt" <= $1::timestamptz)
     AND NOT ${associationArchivedSql('f."associationId"')}
     AND GREATEST(f."createdAt", f."updatedAt", ${LAST_ANSWER_SQL})
           <= $1::timestamptz - make_interval(hours => 24 * $2::int)
     AND (f."staleAskedAt" IS NULL
          OR ${LAST_ANSWER_SQL} >= date_trunc('day', f."staleAskedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * The forms the question is due for, read only - what the day-one count and the specs read. The claim
 * below is the same predicate, so this answers exactly what the next sweep would claim.
 */
export const STALE_OPEN_DUE_SQL = `SELECT f.id, f.title, f."ownerId", f."associationId"
   FROM forms f
  WHERE ${STALE_OPEN_WHERE}
  ORDER BY f."createdAt"`;

/**
 * Claims ONE due form (`$3`): stamps `staleAskedAt` with `$1`, on the row it locks (`SKIP LOCKED`: a
 * form another replica holds is theirs). Run INSIDE the transaction that also writes the form's bell
 * rows, so the question is asked if and only if its notice exists: a process dying between the two
 * loses neither (the whole transaction rolls back, and the next sweep finds the form due again).
 */
export const STALE_OPEN_CLAIM_SQL = `WITH due AS (
   SELECT f.id
     FROM forms f
    WHERE f.id = $3::uuid AND ${STALE_OPEN_WHERE}
    FOR UPDATE OF f SKIP LOCKED)
 UPDATE forms f SET "staleAskedAt" = $1::timestamptz
   FROM due
  WHERE f.id = due.id
 RETURNING f.id, f.title, f."ownerId", f."associationId"`;

/** One form the question was just claimed for. */
export interface ClaimedStaleForm {
  id: string;
  title: string;
  ownerId: string;
  associationId: string | null;
}

/**
 * The TypeORM answer of an `UPDATE ... RETURNING`: `[rows, affectedCount]`, where a `SELECT` answers
 * the rows alone - read by shape, as `openings/opening-reminders.ts` does.
 */
function rowsOf<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return result as T[];
}

/** The ids of the forms the question is due for at `at`, oldest first - read only, nothing claimed. */
export async function dueStaleOpenFormIds(
  db: Pick<EntityManager, 'query'>,
  at: Date,
  days: number = STALE_OPEN_FORM_DAYS
): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(await db.query(STALE_OPEN_DUE_SQL, [at, days]));
  return rows.map((r) => r.id);
}

/**
 * Claims one form at `at`, or answers `null` when it is no longer due or another replica holds it.
 * Idempotent: a second call claims nothing. `db` is the manager of the caller's transaction.
 */
export async function claimStaleOpenForm(
  db: Pick<EntityManager, 'query'>,
  formId: string,
  at: Date,
  days: number = STALE_OPEN_FORM_DAYS
): Promise<ClaimedStaleForm | null> {
  const [claimed] = rowsOf<ClaimedStaleForm>(
    await db.query(STALE_OPEN_CLAIM_SQL, [at, days, formId])
  );
  logger.log(`[STALE-OPEN] claim form=${short(formId)} at=${at.toISOString()} taken=${!!claimed}`);
  return claimed ?? null;
}

/**
 * Who hears the question: for an ASSOCIATION's form, the members holding `MANAGE_FORMS` and nobody
 * else - its creator who does not hold it is not a manager (owner, 2026-11-14, `managesForm`) and
 * could not answer the question; for a PERSONAL form, its owner. The bell row's gate re-asks the
 * same predicate (`BELL_ROW_GATE.form_stale_open`).
 */
export async function staleOpenRecipients(
  db: Pick<EntityManager, 'query'>,
  form: Pick<ClaimedStaleForm, 'ownerId' | 'associationId'>
): Promise<string[]> {
  if (!form.associationId) return [form.ownerId];
  const rows = rowsOf<{ userId: string }>(
    await db.query(
      `SELECT m."userId" FROM association_members m
        WHERE m."associationId" = $1 AND (m.permissions & $2::int) <> 0
        ORDER BY m."userId"`,
      [form.associationId, AssociationPermissionFlag.MANAGE_FORMS]
    )
  );
  return rows.map((r) => r.userId);
}

/**
 * The question is STILL PUT to a form - asked, not answered since, still open - as SQL over form
 * alias `f`: the one definition the manager list's "Fermer ?" card and the bell row's gate share, so
 * the card and the bell clear together. Answered by closing (`closedAt` set), by a date (the same),
 * or by "Garder ouvert" (`staleKeptAt` at or after `staleAskedAt`).
 */
export function staleOpenAskedSql(f: string): string {
  return `(${f}."staleAskedAt" IS NOT NULL AND ${f}."closedAt" IS NULL
     AND ${f}.status = 'published' AND ${f}."deletedAt" IS NULL
     AND (${f}."staleKeptAt" IS NULL OR ${f}."staleKeptAt" < ${f}."staleAskedAt"))`;
}

/** Of `formIds`, those the question is still put to (the managers' list draws a card for them). */
export async function formsAskedStillOpen(
  db: Pick<EntityManager, 'query'>,
  formIds: string[]
): Promise<Set<string>> {
  if (formIds.length === 0) return new Set();
  const rows = rowsOf<{ id: string }>(
    await db.query(
      `SELECT f.id FROM forms f WHERE f.id = ANY($1::uuid[]) AND ${staleOpenAskedSql('f')}`,
      [formIds]
    )
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * "Garder ouvert": records that a manager read the question and left the form open. Conditional on
 * the question being put (never stamps a form nobody asked about), idempotent, and answers whether
 * it changed anything.
 */
export async function keepFormOpen(
  db: Pick<EntityManager, 'query'>,
  formId: string,
  at: Date
): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await db.query(
      `UPDATE forms f SET "staleKeptAt" = $2::timestamptz
        WHERE f.id = $1 AND ${staleOpenAskedSql('f')} RETURNING f.id`,
      [formId, at]
    )
  );
  logger.log(`[STALE-OPEN] keep open form=${short(formId)} changed=${rows.length}`);
  return rows.length > 0;
}
