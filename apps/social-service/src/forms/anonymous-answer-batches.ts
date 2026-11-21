import { randomInt } from 'crypto';
import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ProductGridLine } from './product-grid-contract';
import type { RespondentIdentity } from './respondent-identity';
import { lockFormSeats } from './seat-hold';
import { FORM_WINDOW_OPEN, formWindowState } from './form-window';

/**
 * AN ANONYMOUS FORM'S ANSWERS ARE STORED IN BATCHES (migration 178, forms.md "An anonymous form's
 * answers are released in batches").
 *
 * What is stored must not pair an account with an answer - and that includes what the database
 * keeps about each write, not only the columns this service declares. The registry
 * (`form_respondents`) is written when the person answers, because it is what refuses a second
 * answer; the answer itself waits in `form_answers_held`, and moves into `submissions` together with
 * the other answers waiting on its form, in ONE write and in a random order. So every released
 * answer is one of a group of at least `ANONYMOUS_BATCH_SIZE`, and the group, not the person, is all
 * a stored row can be traced to.
 *
 * WHEN A BATCH IS RELEASED - a predicate over durable state, never a timer:
 * - `ANONYMOUS_BATCH_SIZE` answers wait: the submit that brings the count there releases them right
 *   after its own transaction commits, in a transaction of their own under the form's lock - never in
 *   the one that wrote a registry row, so no released row shares a write with one. Should that
 *   release fail, the batch stays held and the next submit, a close, a manager's read or the hourly
 *   sweep (which also looks for a full batch) releases it.
 * - the form no longer takes answers (closed, past its end date, not open yet, or archived): every
 *   waiting answer is released, however few. Below the batch size they JOIN the answers released on
 *   the form's latest release day (those are rewritten in the same write and keep that date, which the
 *   new ones take too), so the last group is not smaller than the batch size unless the form never
 *   had that many answers at all - and then the group is every answer it has, which is the most any
 *   design can give when the reader also holds the list of who answered.
 *
 * An answer is dated with the day its batch was released, never the day it was given: a day inside
 * a batch would split the group again.
 */
export const ANONYMOUS_BATCH_SIZE = 5;

const logger = new Logger('AnonymousAnswerBatches');

/** One anonymous answer as it waits: its content, nothing that names or dates it. */
export interface HeldAnswer {
  formId: string;
  answers: Record<string, unknown>;
  lines: ProductGridLine[] | null;
  priceLockedItemIds: string[] | null;
  respondentIdentity: RespondentIdentity | null;
}

/** Why a release ran, for its log line only. */
export type ReleaseReason = 'batch' | 'form-closed';

/**
 * How these lines name the form: they do not. A release runs inside a respondent's submit, and no
 * log line pairs a person with an anonymous form (forms.md); the count is what the line is for.
 */
const TAG = 'an anonymous form';

/**
 * Stores one anonymous answer to wait for its batch. Called inside the submit's transaction, under
 * the form's lock, after the registry insert that refuses a second answer.
 */
export async function holdAnonymousAnswer(manager: EntityManager, held: HeldAnswer): Promise<void> {
  await manager.query(
    `INSERT INTO form_answers_held ("formId", answers, lines, "priceLockedItemIds", "respondentIdentity")
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)`,
    [
      held.formId,
      JSON.stringify(held.answers ?? {}),
      held.lines === null ? null : JSON.stringify(held.lines),
      held.priceLockedItemIds === null ? null : JSON.stringify(held.priceLockedItemIds),
      held.respondentIdentity === null ? null : JSON.stringify(held.respondentIdentity),
    ]
  );
}

/** How many answers of this form wait for their batch. */
export async function heldAnswerCount(manager: EntityManager, formId: string): Promise<number> {
  const rows: { n: string }[] = await manager.query(
    'SELECT count(*) AS n FROM form_answers_held WHERE "formId" = $1',
    [formId]
  );
  return Number(rows[0]?.n ?? 0);
}

/** A uniformly random permutation (Fisher-Yates over a cryptographic source). */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Releases the form's waiting answers when the rule above says so, and answers how many moved.
 * The CALLER holds the form's lock (`lockFormSeats`) inside the transaction `manager` runs in, so no
 * submit adds to the batch while it moves. `final` is "the form takes no more answers".
 */
export async function releaseHeldAnswersUnderLock(
  manager: EntityManager,
  formId: string,
  final: boolean
): Promise<number> {
  const held: { id: string }[] = await manager.query(
    'SELECT id FROM form_answers_held WHERE "formId" = $1',
    [formId]
  );
  if (held.length === 0) return 0;
  if (!final && held.length < ANONYMOUS_BATCH_SIZE) {
    logger.debug(`[FORMS] ${TAG}: ${held.length} answer(s) wait for their batch`);
    return 0;
  }
  // Below the batch size, the last answers join the latest released group and take its date.
  const joinsLatest = held.length < ANONYMOUS_BATCH_SIZE;
  const [{ day }]: { day: string }[] = await manager.query(
    `SELECT (COALESCE(
       ${joinsLatest ? '(SELECT max("createdAt") FROM submissions WHERE "formId" = $1)' : 'NULL'},
       date_trunc('day', now() AT TIME ZONE 'UTC')
     ))::text AS day`,
    joinsLatest ? [formId] : []
  );
  let rewritten = 0;
  if (joinsLatest) {
    // The group they join is written again in THIS transaction, so it and the new answers are one
    // write; the values do not change.
    const result: [unknown[], number] = await manager.query(
      `UPDATE submissions SET "updatedAt" = "updatedAt"
        WHERE "formId" = $1 AND "createdAt" = $2::timestamp`,
      [formId, day]
    );
    rewritten = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }
  const order = shuffled(held.map((row) => row.id));
  // Inserted in the shuffled order, so neither the physical order nor anything else of the write
  // follows the order the answers were given in.
  await manager.query(
    `INSERT INTO submissions ("formId", "userId", answers, lines, "priceLockedItemIds",
                              "respondentIdentity", "totalPaid", "paymentStatus", "paymentMethod",
                              "createdAt", "updatedAt", "paymentRequestedAt")
     SELECT h."formId", NULL, h.answers, h.lines, h."priceLockedItemIds", h."respondentIdentity",
            0, 'free', NULL, $2::timestamp, $2::timestamp, $2::timestamp
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n)
       JOIN form_answers_held h ON h.id = o.id
      ORDER BY o.n`,
    [order, day]
  );
  await manager.query('DELETE FROM form_answers_held WHERE id = ANY($1::uuid[])', [order]);
  logger.log(
    `[FORMS] ${TAG}: ${held.length} answer(s) released` +
      (final ? ' (the form takes no more answers)' : '') +
      (joinsLatest ? `, joining ${rewritten} released before` : '')
  );
  return held.length;
}

/**
 * Releases the form's waiting answers if the form no longer takes answers (or a full batch waits),
 * in a transaction of its own under the form's lock. Idempotent: a second call finds nothing.
 * Called when a manager closes the form, before a manager reads or exports its answers, and by the
 * hourly sweep for a form whose end date came (`AnonymousAnswerReleaseScheduler`).
 */
export async function releaseHeldAnswers(
  manager: EntityManager,
  formId: string,
  now: Date = new Date()
): Promise<number> {
  // Nothing waits (every named form, and most reads): no transaction and no lock on the form row.
  if ((await heldAnswerCount(manager, formId)) === 0) return 0;
  return manager.transaction('READ COMMITTED', async (m) => {
    await lockFormSeats(m, formId);
    const rows: { opensAt: Date | null; closedAt: Date | null; deletedAt: Date | null }[] =
      await m.query('SELECT "opensAt", "closedAt", "deletedAt" FROM forms WHERE id = $1', [formId]);
    const form = rows[0];
    if (!form) return 0;
    const final = !!form.deletedAt || formWindowState(form, now) !== FORM_WINDOW_OPEN;
    return releaseHeldAnswersUnderLock(m, formId, final);
  });
}

/**
 * The forms whose waiting answers are due: a full batch (its submit's release failed), or a form
 * that no longer takes answers - an end date that came, an opening moved later, an archive. Read by
 * the sweep; each is then released in its own transaction, which judges it again under the lock.
 */
export async function formsWithDueHeldAnswers(manager: EntityManager): Promise<string[]> {
  const rows: { formId: string }[] = await manager.query(
    `SELECT h."formId"
       FROM form_answers_held h
       JOIN forms f ON f.id = h."formId"
      GROUP BY h."formId", f."deletedAt", f."closedAt", f."opensAt"
     HAVING count(*) >= $1
         OR f."deletedAt" IS NOT NULL
         OR (f."closedAt" IS NOT NULL AND f."closedAt" <= now())
         OR (f."opensAt" IS NOT NULL AND f."opensAt" > now())`,
    [ANONYMOUS_BATCH_SIZE]
  );
  return rows.map((row) => row.formId);
}
