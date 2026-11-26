import { Raw, type EntityManager, type FindOptionsWhere } from 'typeorm';
import { Submission } from './entities/submission.entity';

/**
 * HOW LONG AN ONLINE-PAYMENT `pending` SUBMISSION HOLDS ITS SEAT, from its own `paymentRequestedAt`
 * - the instant its CURRENT payment request was issued (migration 084). `createdAt` would be wrong
 * the moment `submit` reuses a live pending row for a new request: the hold must restart with it.
 *
 * The payment request's own lifetime is derived from it (`PAYMENT_REQUEST_LIFETIME_SECONDS`), so
 * the request stops being payable BEFORE the seat stops being held. Too short and a slow payer
 * cannot pay; too long and an abandoned checkout keeps a seat nobody will take. Before 2026-10-15
 * it was infinite: nothing released an online `pending` row at all.
 */
export const PENDING_PAYMENT_HOLD_SECONDS = 30 * 60;

/**
 * How long Lydia's request may be expired AFTER its deadline: its expiry runs on a sweep, measured
 * firing +79 s after a 60 s deadline and +61 s after a 120 s one (sandbox, 2026-10-15), plus the
 * callback's own latency. Two minutes covers both with room.
 */
export const PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS = 120;

/**
 * The lifetime `submit` asks the provider for (`expireAfterSeconds`, Lydia's `expire_time`, whole
 * seconds): the hold minus the sweep margin, 1680 s, so the request is dead by the time the seat is
 * released and a late payment stays the exception `markPaid` handles, not the ordinary case.
 */
export const PAYMENT_REQUEST_LIFETIME_SECONDS =
  PENDING_PAYMENT_HOLD_SECONDS - PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS;

/**
 * The `code` of the 409 a retry (or a cancel) gets while the request its answer is waiting on
 * cannot be shown dead or paid: issuing another would leave two payable requests for one answer.
 * The client words it through Paraglide (`paymentRefusal.ts`).
 */
export const PREVIOUS_PAYMENT_OPEN = 'PREVIOUS_PAYMENT_OPEN';

/**
 * The `code` of the 409 a SECOND submit gets on a single-answer form once the person already has an
 * answer that counts (`answerHoldingWhere`): paid, free, waiting for cash, paid over capacity, or
 * an online one still within its hold. Read from the submissions table under the form lock, never
 * from a client flag. The client words it through Paraglide (`paymentRefusal.ts`).
 */
export const ALREADY_ANSWERED = 'ALREADY_ANSWERED';

/**
 * The instant before which a `pending` row no longer holds a seat, as SQL on the DATABASE clock.
 *
 * The database clock, not the service's: `paymentRequestedAt` is written by the database's own `now()` into
 * a `timestamp` column, so comparing it with `now()` reads both sides through the same session time
 * zone, whatever zone the Node process runs in. The constant is interpolated, never a parameter, so
 * this fragment is the same text in a `find` and in the expiry `UPDATE` - ONE definition of
 * "still holding", whose two halves are `>` and `<=` of it.
 */
export const PENDING_HOLD_CUTOFF_SQL = `now() - make_interval(secs => ${PENDING_PAYMENT_HOLD_SECONDS})`;

/**
 * The statuses whose money has already landed: a second `markPaid` on them is a replay. `refunded`
 * (a confirmed TOTAL refund through Canari, migration 120) landed too: a late confirmation of that
 * payment must not make the answer paid again and take back the seat the refund freed.
 */
export const SETTLED_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'paid',
  'paid_over_capacity',
  'refunded',
]);

/**
 * The statuses of an online answer whose request the payer's return may still find PAID at the
 * provider (`confirmPayment`): waiting, or released with no seat (`expired`, `cancelled`) while a
 * payment made at the end of the hold had its callback lost. Anything settled is already decided.
 */
export const CONFIRMABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'expired',
  'cancelled',
]);

/**
 * The statuses a VERIFIED confirm callback still reads the row's own request for: the confirmable
 * ones plus `pending_cash`. An answer switched to cash (`switchToCash`, owner decision of
 * 2026-11-23) keeps naming the online request it left, settled dead at Lydia before the switch; a
 * confirmation of that request is therefore not expected, and if Lydia ever reads it paid all the
 * same, the money landed and is recorded (`markPaid`: the answer is paid online and its cash hold
 * ends) rather than lost behind a status nothing reads. A direct cash answer names no request, so
 * it is never read. The payer's return (`confirmPayment`) keeps the narrower set: a page's poll of a
 * cash answer asks Lydia nothing.
 */
export const CALLBACK_CONFIRMABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  ...CONFIRMABLE_PAYMENT_STATUSES,
  'pending_cash',
]);

/**
 * What a payment request IS, as core-service's `payments/request-state` classified it at the
 * provider boundary (`CheckoutRequestStateKind` there; Lydia 0 / 1 / 5 / 6, measured on the
 * sandbox). `declined` (the payer refused) and `cancelled-or-expired` are FINAL and leave nothing
 * payable: the answer is released so the payer can retry. `unknown` - any code core has not
 * measured, or a wire value this service does not know - is never paid and never settled.
 */
export type RequestState = 'open' | 'paid' | 'declined' | 'cancelled-or-expired' | 'unknown';

const REQUEST_STATES: ReadonlySet<string> = new Set([
  'open',
  'paid',
  'declined',
  'cancelled-or-expired',
]);

/** The states after which the request can never be paid: the answer waiting on it is released. */
export const SETTLED_REFUSED_REQUEST_STATES: ReadonlySet<RequestState> = new Set([
  'declined',
  'cancelled-or-expired',
]);

/**
 * Reads core's `state` field into the type. Anything this service does not know - an older core
 * answering `closed` during a deploy, a typo, a missing field - is `unknown`: refused, never guessed.
 */
export function toRequestState(wire: unknown): RequestState {
  return typeof wire === 'string' && REQUEST_STATES.has(wire) ? (wire as RequestState) : 'unknown';
}

/**
 * The shape of a Lydia `request_uuid`: 32 hex digits, no dash (measured on the sandbox,
 * 2026-10-15) - the same pattern core-service's `payments/request-state` accepts (`SESSION_ID_RE`).
 * A historic row still holds a `cs_...` id there, which core refuses with a 400, so
 * `confirmPayment` reads it first and never sends one.
 */
export const LYDIA_REQUEST_UUID_RE = /^[0-9a-f]{32}$/i;

/**
 * The submissions that hold a seat on a form, as a TypeORM `where` (an OR of five rows).
 *
 * A `pending` row holds one only while it is younger than the hold, and that is decided HERE, from
 * the row, so a count is right whether or not the expiry job has run. So does a `payment_due` row -
 * a waiting answer promoted on a paid form, owing its online payment (`waitlist.ts`) - by the same
 * hold, counted from its promotion. A `waiting` row holds NONE: the waiting list never counts toward
 * capacity. `extra` narrows every branch the same way (one submitter, one submission id).
 */
export function seatHoldingWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission>[] {
  return [
    { ...extra, formId, paymentStatus: 'paid' },
    { ...extra, formId, paymentStatus: 'free' },
    livePendingWhere(formId, extra),
    { ...extra, formId, paymentStatus: 'pending_cash' },
    livePaymentDueWhere(formId, extra),
  ];
}

/**
 * The submissions that ARE a person's answer on a single-answer form: every seat-holding row, plus
 * `paid_over_capacity` - the money landed, so a second submit would be a second charge for one
 * answer even though no seat was given - and `waiting`: a place in line is an answer too, so one
 * person is never twice on the list nor both on it and registered. A `cancelled` or `expired` row (a
 * request declined, cancelled or expired) is not an answer: the person may answer again.
 */
export function answerHoldingWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission>[] {
  return [
    ...seatHoldingWhere(formId, extra),
    { ...extra, formId, paymentStatus: 'paid_over_capacity' },
    { ...extra, formId, paymentStatus: 'waiting' },
  ];
}

/**
 * The one answer the form page shows among a person's answer rows (`answerHoldingWhere`, newest
 * first): money landed (`SETTLED_PAYMENT_STATUSES`) first, then any other decided status (`free`,
 * `pending_cash`), and an online `pending` last - it is the only one a retry may replace, so
 * showing it over a paid row offers a retry the server refuses. Newest first within each rank.
 */
export function pickShownAnswer<T extends { paymentStatus: string }>(
  newestFirst: readonly T[]
): T | undefined {
  const rank = (row: T) =>
    SETTLED_PAYMENT_STATUSES.has(row.paymentStatus)
      ? 0
      : row.paymentStatus === 'pending' || row.paymentStatus === 'payment_due'
        ? 2
        : 1;
  return newestFirst.reduce<T | undefined>(
    (best, row) => (best === undefined || rank(row) < rank(best) ? row : best),
    undefined
  );
}

/** An online `pending` submission still younger than the hold: the one branch with a clock in it. */
export function livePendingWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission> {
  return {
    ...extra,
    formId,
    paymentStatus: 'pending',
    paymentRequestedAt: Raw((column) => `${column} > ${PENDING_HOLD_CUTOFF_SQL}`),
  };
}

/**
 * The hold cutoff on the WALL clock (`clock_timestamp()`), not the transaction's start (`now()`): for
 * a decision taken inside a transaction that may have WAITED (on a lock) or CALLED OUT (to Lydia)
 * since it began, whose answer must be "does the hold still run at this instant". Same interval,
 * same comparison as {@link PENDING_HOLD_CUTOFF_SQL}; only `switchToCash` reads it.
 */
export const PENDING_HOLD_CUTOFF_CLOCK_SQL = `clock_timestamp() - make_interval(secs => ${PENDING_PAYMENT_HOLD_SECONDS})`;

/**
 * {@link livePendingWhere} judged at THIS instant ({@link PENDING_HOLD_CUTOFF_CLOCK_SQL}): a
 * `pending` row still within its hold now, however long the transaction asking has run.
 */
export function livePendingAtClockWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission> {
  return {
    ...extra,
    formId,
    paymentStatus: 'pending',
    paymentRequestedAt: Raw((column) => `${column} > ${PENDING_HOLD_CUTOFF_CLOCK_SQL}`),
  };
}

/**
 * A `payment_due` submission - promoted from the waiting list, owing its online payment - still
 * younger than the online hold, counted from its promotion (`paymentRequestedAt`): the same clock
 * and the same cutoff as {@link livePendingWhere}, so a promoted payer has exactly the window of a
 * fresh one (owner, 2026-11-23: "the existing payment window applies").
 */
export function livePaymentDueWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission> {
  return {
    ...extra,
    formId,
    paymentStatus: 'payment_due',
    paymentRequestedAt: Raw((column) => `${column} > ${PENDING_HOLD_CUTOFF_SQL}`),
  };
}

/**
 * Takes the form's row lock, which is what serialises every decision about its seats.
 *
 * A count followed by a write is a race unless something orders the writers: two submits, or two
 * late payments, could both read "one seat left" and both take it. Every path that counts seats and
 * then takes one (`submit`, `markPaid`) calls this FIRST in its transaction, so the form row is the
 * one lock they queue on, always taken before any submission row (one order, no deadlock). The
 * transaction must be READ COMMITTED: the count that follows has to see what the previous holder
 * committed, and a REPEATABLE READ snapshot would be taken before the wait.
 */
export async function lockFormSeats(manager: EntityManager, formId: string): Promise<void> {
  await manager.query('SELECT 1 FROM forms WHERE id = $1 FOR UPDATE', [formId]);
}

/**
 * Puts the rows the organiser must act on first: a payment that landed over capacity is owed a
 * refund, and at the bottom of a long list it would be found by nobody. Stable, so the order the
 * caller asked for holds inside each half.
 */
export function overCapacityFirst<T extends { paymentStatus: string }>(rows: T[]): T[] {
  return [
    ...rows.filter((row) => row.paymentStatus === 'paid_over_capacity'),
    ...rows.filter((row) => row.paymentStatus !== 'paid_over_capacity'),
  ];
}

/**
 * HOW LONG A "RESERVER MA PLACE" HOLD KEEPS ITS SEAT (owner, 2026-11-17: ten minutes, like the online
 * payment's hold in spirit but shorter - a person filling a form, not paying). Counted from the row's
 * own `heldAt` by every seat count (`countSeatsTaken`), so an expired hold frees its seat with no
 * sweep; the sweep (`expireLapsedSeatHolds`) only deletes the dead rows and promotes the waiting list.
 */
export const SEAT_HOLD_SECONDS = 10 * 60;

/** The SQL predicate "this hold is still live", on the same `now()` the other hold counts read. */
export const LIVE_SEAT_HOLD_SQL = `"heldAt" > now() - make_interval(secs => ${SEAT_HOLD_SECONDS})`;

/** The `code` of the 409 refusing a hold on a form that cannot hold one (anonymous, not capped). */
export const SEAT_HOLD_NOT_AVAILABLE = 'SEAT_HOLD_NOT_AVAILABLE';

/**
 * The seats other people hold behind the button: the live holds of the form, never `exceptUserId`'s
 * own (a person's hold is their own seat, not one they compete with).
 */
export async function countLiveSeatHolds(
  manager: Pick<EntityManager, 'query'>,
  formId: string,
  exceptUserId?: string | null
): Promise<number> {
  const rows = (await manager.query(
    `SELECT count(*)::int AS n FROM form_seat_holds
      WHERE "formId" = $1 AND ${LIVE_SEAT_HOLD_SQL} AND ($2::text IS NULL OR "userId" <> $2)`,
    [formId, exceptUserId ?? null]
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Every seat taken on a form as a newcomer counts them: the rows that hold one (`seatHoldingWhere`)
 * plus the live holds of everybody but `exceptUserId`. The ONE count the capacity checks of a submit, a
 * resume, a switch to cash and a promotion read, so a hold is honoured the same way by all of them.
 */
export async function countSeatsTaken(
  manager: EntityManager,
  formId: string,
  exceptUserId?: string | null
): Promise<number> {
  const answers = await manager.count(Submission, { where: seatHoldingWhere(formId) });
  return answers + (await countLiveSeatHolds(manager, formId, exceptUserId));
}
