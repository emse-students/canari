import { randomInt, randomUUID } from 'crypto';
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
 * answer; the answer itself is held apart in `form_answers_held`, and moves into `submissions`
 * together with the other answers waiting on its form, in ONE statement and in a random order. So
 * every released answer is one of a group of at least `ANONYMOUS_BATCH_SIZE`, and the group, not the
 * person, is all a stored row can be traced to.
 *
 * WHEN ANSWERS ARE RELEASED - a predicate over durable state, never a timer (`ReleaseMode`):
 * - `ANONYMOUS_BATCH_SIZE` answers wait: released whatever the form's state. The submit that brings
 *   the count there releases them right after its own transaction commits, in a transaction of their
 *   own under the form's lock - never the one that wrote a registry row. Should that fail, the next
 *   submit, a close, a manager's read or the hourly sweep releases them.
 * - fewer wait and the form takes no more answers (closed, past its end date, not open yet, or full):
 *   the short tail is released ONCE per form (`form_anonymous_tail_released`), joining the answers
 *   released in the form's latest release week. Later, a short tail stays held until a batch is full
 *   or the form is retired.
 * - the form is retired (archived or deleted): everything waiting is released, joining as above.
 *
 * Joining means the joined group is DELETED and written again, with new random ids, in the SAME
 * shuffled insert as the new answers: one write, one date, and no physical order of old then new.
 * An answer is dated with the WEEK its group was written (`anonymousAnswerWeekSql`), never the day
 * it was given.
 */
export const ANONYMOUS_BATCH_SIZE = 5;

/**
 * THE ONLY CLOCK AN ANONYMOUS ANSWER KEEPS: the start of the ISO week of `instant` - Monday 00:00,
 * on the UTC wall clock the `submissions` columns (`timestamp`, no zone) are written in (owner,
 * 2026-11-22, charter principle 1). A DAY was the precision before, and a day on which one person
 * answered was a group of one the manager could put a name on; a week holds the batches of several
 * days. Every write of an anonymous answer's dates goes through this ONE expression - the release
 * (`RELEASED_ROW`) and the join of a short tail - and migration 181 cut the rows stored before it
 * with the same `date_trunc('week', ...)`.
 */
export function anonymousAnswerWeekSql(instant = "now() AT TIME ZONE 'UTC'"): string {
  return `date_trunc('week', ${instant})`;
}

/**
 * {@link anonymousAnswerWeekSql} applied to a value already READ: the Monday 00:00 starting the week
 * of a stored `timestamp`. The driver hands a `timestamp` (no zone) back as that wall clock in the
 * process's zone, so the local getters recover the stored wall clock exactly, whatever the zone. A
 * reader that SHOWS an anonymous answer's date (the export) passes it through this rather than trust
 * the stored value: a row the cut has not reached yet still reads as its week.
 */
export function anonymousAnswerWeekOf(stored: Date): Date {
  const sinceMonday = (stored.getDay() + 6) % 7; // getDay: Sunday 0 ... Saturday 6
  return new Date(stored.getFullYear(), stored.getMonth(), stored.getDate() - sinceMonday);
}

const logger = new Logger('AnonymousAnswerBatches');

/** One anonymous answer as it waits: its content, nothing that names or dates it. */
export interface HeldAnswer {
  formId: string;
  answers: Record<string, unknown>;
  lines: ProductGridLine[] | null;
  priceLockedItemIds: string[] | null;
  respondentIdentity: RespondentIdentity | null;
}

/**
 * What the form's state allows to be released: `open` - a full batch only; `closed` - also a short
 * tail, once per form; `retired` - everything.
 */
export type ReleaseMode = 'open' | 'closed' | 'retired';

/**
 * `releaseHeldAnswersUnderLock` called outside a transaction: its lock would be released at once
 * and its statements committed one by one, so two releases could both move the same answers.
 */
export class HeldAnswersOutsideTransactionError extends Error {
  constructor() {
    super('anonymous answers released outside a transaction: the form lock would not hold');
    this.name = 'HeldAnswersOutsideTransactionError';
  }
}

/**
 * What a release writes into each `submissions` column, as SQL over `o` (the new id) and `src` (the
 * held or joined row), `$3` being the release's week (`anonymousAnswerWeekSql`). Content is copied; everything that could name,
 * price or date the answer more precisely than its group is written as the anonymous constant.
 */
const RELEASED_ROW: Readonly<Record<string, string>> = {
  id: 'o.id',
  formId: 'src."formId"',
  userId: 'NULL',
  answers: 'src.answers',
  lines: 'src.lines',
  priceLockedItemIds: 'src."priceLockedItemIds"',
  respondentIdentity: 'src."respondentIdentity"',
  totalPaid: '0',
  paymentStatus: "'free'",
  paymentMethod: 'NULL',
  createdAt: '$3::timestamp',
  updatedAt: '$3::timestamp',
  paymentRequestedAt: '$3::timestamp',
};

/** The `submissions` columns a release writes (`RELEASED_ROW`). */
export const SUBMISSION_COLUMNS_A_RELEASE_WRITES: readonly string[] = Object.keys(RELEASED_ROW);

/**
 * The `submissions` columns a release leaves at their default (NULL): an anonymous answer never
 * carries them - no account, no guest, no payment, no grant, no edit (each refused on an anonymous
 * form). The integration spec compares the two lists with the table, so a column added to
 * `submissions` fails it until it is placed in one of them: a rewrite that silently dropped a new
 * column would lose it from every joined answer.
 */
export const SUBMISSION_COLUMNS_A_RELEASE_LEAVES_UNSET: readonly string[] = [
  'email',
  'stripeSessionId',
  'paymentRequestId',
  'paymentSettledBy',
  'lydiaOrderRef',
  'lydiaVendorToken',
  'cashExpiresAt',
  'cashReminderDueAt',
  'cashReminderNotifiedAt',
  'paymentCancelOrigin',
  'cotisationGrantedAt',
  'purchaseRecordedAt',
  'organiserNotifiedAt',
  'guestReceiptHash',
  'guestVisitorKey',
  'guestLastName',
  'guestFirstName',
  'guestEmail',
  'editedAt',
];

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
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The order rows are written in: `shuffled` in production; a spec passes a known one. */
export type InsertOrder = <T>(items: readonly T[]) => T[];

/**
 * Releases the form's waiting answers as `mode` allows, and answers how many moved. The CALLER holds
 * the form's lock (`lockFormSeats`) inside the transaction `manager` runs in - asserted, since a plain
 * manager would commit each statement apart and drop the lock at once.
 */
export async function releaseHeldAnswersUnderLock(
  manager: EntityManager,
  formId: string,
  mode: ReleaseMode,
  order: InsertOrder = shuffled
): Promise<number> {
  if (!manager.queryRunner?.isTransactionActive) throw new HeldAnswersOutsideTransactionError();
  const held: { id: string }[] = await manager.query(
    'SELECT id FROM form_answers_held WHERE "formId" = $1',
    [formId]
  );
  if (held.length === 0) return 0;
  const tail = held.length < ANONYMOUS_BATCH_SIZE;
  if (tail && mode === 'open') {
    logger.debug(`[FORMS] ${TAG}: ${held.length} answer(s) wait for their batch`);
    return 0;
  }
  if (tail && mode === 'closed') {
    const done: unknown[] = await manager.query(
      'SELECT 1 FROM form_anonymous_tail_released WHERE "formId" = $1',
      [formId]
    );
    if (done.length > 0) {
      logger.debug(
        `[FORMS] ${TAG}: ${held.length} answer(s) stay held - its short tail was released once`
      );
      return 0;
    }
  }
  // A short tail JOINS the latest group, which is written again with it: one write, one date. The
  // latest group's date is itself a week start, so the tail takes that week, never a newer one.
  const [{ week }]: { week: string }[] = await manager.query(
    `SELECT (COALESCE(
       ${tail ? `(SELECT ${anonymousAnswerWeekSql('max("createdAt")')} FROM submissions WHERE "formId" = $1)` : 'NULL'},
       ${anonymousAnswerWeekSql()}
     ))::text AS week`,
    tail ? [formId] : []
  );
  const joined: { id: string }[] = tail
    ? await manager.query(
        `SELECT id FROM submissions WHERE "formId" = $1 AND ${anonymousAnswerWeekSql('"createdAt"')} = $2::timestamp`,
        [formId, week]
      )
    : [];
  // Every row gets a NEW random id: a held row's id, or a joined row's old one, would let an old
  // version of either be matched to the row written now.
  const rows = order([...held, ...joined].map((row) => ({ source: row.id, id: randomUUID() })));
  await manager.query(
    `INSERT INTO submissions (${SUBMISSION_COLUMNS_A_RELEASE_WRITES.map((c) => `"${c}"`).join(', ')})
     SELECT ${Object.values(RELEASED_ROW).join(', ')}
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS o(source, id, n)
       JOIN LATERAL (
         SELECT h."formId", h.answers, h.lines, h."priceLockedItemIds", h."respondentIdentity"
           FROM form_answers_held h WHERE h.id = o.source
         UNION ALL
         SELECT s."formId", s.answers, s.lines, s."priceLockedItemIds", s."respondentIdentity"
           FROM submissions s WHERE s.id = o.source
       ) src ON true
      ORDER BY o.n`,
    [rows.map((row) => row.source), rows.map((row) => row.id), week]
  );
  if (joined.length > 0) {
    await manager.query('DELETE FROM submissions WHERE id = ANY($1::uuid[])', [
      joined.map((row) => row.id),
    ]);
  }
  await manager.query('DELETE FROM form_answers_held WHERE id = ANY($1::uuid[])', [
    held.map((row) => row.id),
  ]);
  if (tail) {
    await manager.query(
      `INSERT INTO form_anonymous_tail_released ("formId") VALUES ($1) ON CONFLICT DO NOTHING`,
      [formId]
    );
  }
  logger.log(
    `[FORMS] ${TAG}: ${held.length} answer(s) released (${mode})` +
      (joined.length > 0 ? `, written again with ${joined.length} released before` : '')
  );
  return held.length;
}

/** The release mode a form's stored state gives, read under its lock. Null: the form is gone. */
async function releaseModeOf(
  manager: EntityManager,
  formId: string,
  now: Date
): Promise<ReleaseMode | null> {
  const rows: {
    opensAt: Date | null;
    closedAt: Date | null;
    deletedAt: Date | null;
    maxSubmissions: number | null;
    taken: string;
  }[] = await manager.query(
    `SELECT f."opensAt", f."closedAt", f."deletedAt", f."maxSubmissions",
            (SELECT count(*) FROM submissions s WHERE s."formId" = f.id)
          + (SELECT count(*) FROM form_answers_held h WHERE h."formId" = f.id) AS taken
       FROM forms f WHERE f.id = $1`,
    [formId]
  );
  const form = rows[0];
  if (!form) return null;
  if (form.deletedAt) return 'retired';
  // A FULL form takes no more answers either (an anonymous form is free: every answer holds a seat).
  const full = !!form.maxSubmissions && Number(form.taken) >= form.maxSubmissions;
  return full || formWindowState(form, now) !== FORM_WINDOW_OPEN ? 'closed' : 'open';
}

/**
 * Releases what the form's state allows, in a transaction of its own under the form's lock.
 * Idempotent: a second call finds nothing to move. Called after a submit, when a manager closes the
 * form or reads or exports its answers, and by the hourly sweep (`AnonymousAnswerReleaseScheduler`).
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
    const mode = await releaseModeOf(m, formId, now);
    return mode ? releaseHeldAnswersUnderLock(m, formId, mode) : 0;
  });
}

/** Why the sweep found a form's waiting answers due. */
export type DueReason = 'full-batch' | 'retired' | 'not-open' | 'full-form';

/**
 * The forms whose waiting answers are due, and why: a full batch (its submit's release failed), an
 * archived form, a form whose window is not open (an end date that came, an opening moved later), a
 * full form. A form whose short tail was already released once is not due for a tail again. Each is
 * then released in its own transaction, which judges it again under the lock.
 */
export async function formsWithDueHeldAnswers(
  manager: EntityManager
): Promise<{ formId: string; reason: DueReason; held: number }[]> {
  const rows: { formId: string; reason: DueReason; held: string }[] = await manager.query(
    `WITH w AS (
       SELECT h."formId", count(*) AS held
         FROM form_answers_held h GROUP BY h."formId"
     )
     SELECT w."formId", w.held,
            CASE
              WHEN w.held >= $1 THEN 'full-batch'
              WHEN f."deletedAt" IS NOT NULL THEN 'retired'
              WHEN t."formId" IS NOT NULL THEN NULL
              WHEN (f."closedAt" IS NOT NULL AND f."closedAt" <= now())
                OR (f."opensAt" IS NOT NULL AND f."opensAt" > now()) THEN 'not-open'
              WHEN f."maxSubmissions" IS NOT NULL
               AND (SELECT count(*) FROM submissions s WHERE s."formId" = f.id) + w.held
                   >= f."maxSubmissions" THEN 'full-form'
            END AS reason
       FROM w
       JOIN forms f ON f.id = w."formId"
       LEFT JOIN form_anonymous_tail_released t ON t."formId" = w."formId"`,
    [ANONYMOUS_BATCH_SIZE]
  );
  return rows
    .filter((row) => row.reason !== null)
    .map((row) => ({ formId: row.formId, reason: row.reason, held: Number(row.held) }));
}
