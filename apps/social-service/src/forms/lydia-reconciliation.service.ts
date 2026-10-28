import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Submission } from './entities/submission.entity';
import { Form } from './entities/form.entity';
import { FormsService } from './forms.service';
import type { RequestState } from './seat-hold';
import { readVerifiedRequestState, type VerifiedRequestRead } from './verified-request-state';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { ProductsService } from '../associations/products.service';
import { AssociationsService } from '../associations/associations.service';
import { CHECKOUT_EXPIRY_MARGIN_MS, productCheckoutLookup } from '../associations/product-checkout';
import {
  classifyCoreCallFailure,
  LYDIA_REFUSALS_FINAL,
  type LydiaRefusalsFinal,
} from '../common/core-payment-error';

/**
 * Most rows one sweep reads at Lydia, per kind. A bound on one tick's work (one `request/state` read
 * each, up to 90 s apiece), far above what a 5-minute tick meets: this platform issues a few
 * requests a day, and a row leaves the selection as soon as its read gave an answer (class docblock).
 */
export const RECONCILE_BATCH = 50;

/**
 * How long the FORM half may spend reading before it stops starting new reads: it runs inside the
 * expiry tick, ahead of the expiry, so its length is the expiry's delay. One read already started
 * may finish (up to 90 s), so the expiry waits at most this plus one read - well inside the
 * 5-minute tick. Rows left unread are expired as before, and said so at ERROR.
 */
export const FORM_SWEEP_BUDGET_MS = 60_000;

/**
 * THE DEPLOY SWITCH OF THE SWEEP: `LYDIA_RECONCILE_ENABLED=true`, and nothing else, lets it ask
 * Lydia anything. Rendered per estate by `infrastructure/deploy/render-env.sh`
 * (`compute_lydia_reconcile_enabled`): `true` on dev, `false` on production until the amount format
 * Lydia signs in a `request/state` answer is measured on a sandbox Business (docs/wiki/lydia-api.md
 * section 7). An unset or misspelt value is OFF. Read on every sweep, so a test can flip it.
 */
export function isLydiaReconcileEnabled(): boolean {
  return process.env.LYDIA_RECONCILE_ENABLED === 'true';
}

/** What one row's reconciliation did. Exceptions are counted apart, as `errors`. */
export type ReconcileOutcome =
  | 'settled'
  | 'released'
  | 'unchanged'
  | 'skipped-unverified'
  | 'refused'
  | 'unavailable';

/** The counts one summary line reports, per kind. */
export interface ReconcileCounts {
  examined: number;
  settled: number;
  released: number;
  unchanged: number;
  skippedUnverified: number;
  /** Reads Lydia refused: closed when the code is known final, else retried and accused. */
  refused: number;
  unavailable: number;
  errors: number;
}

const zero = (): ReconcileCounts => ({
  examined: 0,
  settled: 0,
  released: 0,
  unchanged: 0,
  skippedUnverified: 0,
  refused: 0,
  unavailable: 0,
  errors: 0,
});

const COUNT_KEY: Record<ReconcileOutcome, keyof ReconcileCounts> = {
  settled: 'settled',
  released: 'released',
  unchanged: 'unchanged',
  'skipped-unverified': 'skippedUnverified',
  refused: 'refused',
  unavailable: 'unavailable',
};

/**
 * A boutique attempt whose settlement WRITE failed after its read (a deadlock, the database, a tag
 * grant): the attempt stays `open` and is read again next tick - a database problem, never a
 * verdict about the attempt. `lydiaSaidPaid` says whether the read it followed was a verified PAID,
 * so the tick's one line can say money is waiting to be recorded.
 */
export class CheckoutSettlementFailed extends Error {
  constructor(
    readonly lydiaSaidPaid: boolean,
    readonly checkoutId: string,
    /** The write's own error, kept whole: its stack is appended below. */
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CheckoutSettlementFailed';
    if (cause instanceof Error && cause.stack)
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
  }
}

/**
 * What one boutique read decided, before anything is closed: `keep` leaves the row as the read
 * left it (settled, already settled, or to be read again next tick), `expire` closes it as unproven,
 * `cancel` cancels its request at Lydia and then closes it.
 */
interface CheckoutVerdict {
  outcome: ReconcileOutcome;
  next: 'keep' | 'expire' | 'cancel';
  why?: string;
}

/** The accused attempts one ERROR names; the rest are counted. */
const ACCUSED_NAMED_MAX = 20;

/** One boutique tick's retries: calls with no answer, attempts accused (id -> cause), warned open. */
function newTick() {
  return { noAnswer: 0, accused: new Map<string, string>(), warnedOpen: new Set<string>() };
}

/**
 * THE RECONCILIATION LYDIA'S DOCUMENTATION ASKS FOR: every request whose callback never came is
 * read at Lydia (`request/state`) once it has ENDED, and settled from that answer - so a payment
 * whose confirm callback was lost, and whose payer never came back to the return page, is still
 * recorded. Covers both kinds of row that wait on a Lydia request: a form answer `pending` online,
 * and a boutique attempt `open` (docs/wiki/lydia-api.md "Reconciliation").
 *
 * WHEN A ROW IS DUE - THE REQUEST'S OWN LIFETIME, NOT A CHOSEN CLOCK. Canari sends every request an
 * `expire_time` (`PAYMENT_REQUEST_LIFETIME_SECONDS` for a form, `PRODUCT_REQUEST_LIFETIME_SECONDS`
 * for a product) and Lydia expires it on a sweep a little after (measured up to +79 s): past
 * the request's end plus that margin, the request can no longer change, so ONE read answers for
 * good - paid, declined, or cancelled/expired. For a form that instant is the hold cutoff
 * (`FormsService.pendingHoldCutoff`, read ONCE per tick and shared with the expiry); for a product
 * it is `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`.
 *
 * ONE WRITER OF `paid`, AND IT IS NOT HERE. A paid form answer goes through `FormsService.markPaid`
 * (form lock, row lock, re-checked to still name the uuid read); a paid attempt through
 * `ProductsService.applyRequestState` -> `settlePaidCheckout` (row lock, `paid` once). A release
 * goes through the very function the payer's return uses. So the sweep races the callback and the
 * return on the same locks, and two settlers of one payment record it once.
 *
 * AN ANSWER IS ACTED ON ONCE; NO ANSWER IS RETRIED. A row is examined only while its own status
 * still says it waits (`pending`, `open`).
 * - A form answer is read once: whatever the read did, the expiry that runs right after the sweep,
 *   on the SAME cutoff, moves what is left `pending` to `expired`.
 * - A boutique attempt leaves `open` as soon as its read gave a FINAL answer: settled or released
 *   from a verified state; cancelled AT LYDIA then closed when Lydia verifiably says it is still
 *   open past its end (`cancelStillOpenCheckout`; a cancel answering "already processed" is read
 *   once more at once - still open then, it is closed); closed `expired` at ERROR when the answer
 *   cannot be acted on: a mismatch, unsigned, no usable key (a key that does not open answers
 *   `no-key`), an unknown state, and a refusal whose Lydia code is MEASURED final on an issued
 *   request - an ALLOWLIST, `LYDIA_REFUSALS_FINAL`, EMPTY for the read and the cancel until such a
 *   measurement exists - via `expireUnprovenCheckout`.
 * - CLOSING IS NOT FREE. Nothing reads a closed attempt again: if its request was in fact PAID and
 *   its confirm callback was lost, the payment is recorded by nothing (the payer's return asks only
 *   of an open attempt). That is why closing needs a final answer, and why every refusal NOT on the
 *   allowlist is retried: a refusal can be a state of Lydia (a Business temporarily blocked, a
 *   revoked provider token) as much as a word about the request.
 * - Everything else leaves the attempt `open`, read again next tick: no answer (no response, a
 *   timeout, a 5xx, a 408/429, a verdict this service does not know), core answering about itself
 *   (a 401/403, its 503 when payments are off or Lydia is not configured), a refusal whose code is
 *   not known final, a cancel that did not go through, and a settlement WRITE that failed after a
 *   verified read - above all a verified PAID, which is never closed. ONE line per tick per cause
 *   (`sweepProductCheckouts`): a WARN for no answer, an ERROR for the failed writes, and an ERROR
 *   that ACCUSES the attempts left open on an answer that is not final, with their cause - said
 *   when that list CHANGES, not every tick, its size carried by the hourly `refused=` bucket.
 * - While such a cause lasts its attempts are re-read each tick. When more than `RECONCILE_BATCH`
 *   are due, the ones accused on the previous tick go LAST, so newer rows are reached (in process
 *   memory: fairness and reporting, never idempotence - a restart forgets it and costs one line). A
 *   bound on retries needs durable state (a column, so a migration, the user's decision) -
 *   deliberately not built.
 *
 * NOTHING UNVERIFIED IS ACTED ON. The read asks core to verify Lydia's signature with the Business
 * key over the row's OWN amount (`readVerifiedRequestState`). A mismatch is logged at ERROR and
 * settles nothing. The one unsigned answer acted on is a boutique attempt read by its order_ref that
 * Lydia answers NOT FOUND (core's verdict `unsigned`: an error answer carries no signature): no
 * request exists, no money moved - it is closed `cancelled`, exactly as the return closes it.
 */
@Injectable()
export class LydiaReconciliationService {
  private readonly logger = new Logger(LydiaReconciliationService.name);
  private counts = { forms: zero(), products: zero() };
  /** The boutique retries of the running tick, for its aggregated lines (`sweepProductCheckouts`). */
  private tick = newTick();
  /**
   * What the previous tick left open on an answer that is not final, id -> cause, and which
   * attempts it warned still OPEN at Lydia: what the next tick's lines are compared against, and
   * which attempts go last when the batch is full. In memory - reporting and fairness only.
   */
  private standing = new Map<string, string>();
  private warnedOpen = new Set<string>();
  /** Whether the previous tick found more boutique attempts due than one batch reads. */
  private backlogged = false;
  /** The Lydia refusal codes a read closes an attempt on (`LYDIA_REFUSALS_FINAL`); a test subclass overrides it. */
  protected readonly refusalsFinal: LydiaRefusalsFinal = LYDIA_REFUSALS_FINAL;

  constructor(
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    @InjectRepository(ProductCheckout) private readonly checkoutRepo: Repository<ProductCheckout>,
    private readonly formsService: FormsService,
    private readonly productsService: ProductsService,
    private readonly associationsService: AssociationsService
  ) {}

  /**
   * Reads at Lydia every online form answer still `pending` whose request ended by `cutoff` (the
   * tick's ONE hold cutoff, which the expiry after it uses too), newest first, at most
   * `RECONCILE_BATCH` and for at most `FORM_SWEEP_BUDGET_MS`, and settles each from a verified
   * answer. Runs in the expiry tick, BEFORE the expiry (`FormReminderScheduler`): every row selected
   * here is either settled or expired in the same tick, and no row the expiry moves was left out of
   * this selection by a later clock. Each row has its own `try`.
   */
  async sweepFormPayments(cutoff: Date): Promise<void> {
    // Switched off: no row selected, no call made (the scheduler said so once, at startup).
    if (!isLydiaReconcileEnabled()) return;
    const due = await this.submissionRepo
      .createQueryBuilder('s')
      .where(`s."paymentStatus" = 'pending'`)
      .andWhere(`s."stripeSessionId" ~* '^[0-9a-f]{32}$'`)
      // An instant, as the expiry compares it (`FormsService.expireStalePendingPayments`).
      .andWhere(`s."paymentRequestedAt" <= CAST(:cutoff AS timestamptz)`, { cutoff })
      .orderBy('s.paymentRequestedAt', 'DESC')
      .limit(RECONCILE_BATCH + 1)
      .getMany();
    if (due.length > RECONCILE_BATCH) {
      // The expiry that follows in this tick moves the rest to `expired` UNREAD: a payment among
      // them is recorded only by its callback or its payer's return. Never expected at this volume.
      this.logger.error(
        `[RECONCILE] more than ${RECONCILE_BATCH} form answers ended in one tick - the oldest are ` +
          `expired without a read at Lydia`
      );
    }
    const deadline = Date.now() + FORM_SWEEP_BUDGET_MS;
    const batch = due.slice(0, RECONCILE_BATCH);
    for (const [index, row] of batch.entries()) {
      if (Date.now() >= deadline) {
        // The expiry waits on this loop: the rest is expired unread, as a lost callback always was.
        this.logger.error(
          `[RECONCILE] form sweep spent its ${FORM_SWEEP_BUDGET_MS / 1000} s - ` +
            `${batch.length - index} ended answer(s) are expired without a read at Lydia`
        );
        return;
      }
      await this.count('forms', () => this.reconcileSubmission(row), `submission ${row.id}`);
    }
  }

  /**
   * Reads at Lydia every boutique attempt still `open` whose request has ended and whose Business
   * holds a key to verify with, OLDEST first, at most `RECONCILE_BATCH`. An attempt its read
   * answered leaves `open` (`reconcileCheckout`); one read without an answer, or whose settlement
   * write failed, stays for the next tick (see the class docblock for what that does and does not
   * bound). What stayed is said in ONE line per tick per cause: a WARN for the reads that got no
   * answer, an ERROR for the writes that failed, naming every one and which Lydia said PAID. An attempt of
   * a Business with no key is not read at all (`openWithoutKey` counts them for the summary), and
   * stays for its buyer's next attempt or its confirm callback.
   */
  async sweepProductCheckouts(): Promise<void> {
    if (!isLydiaReconcileEnabled()) return;
    const previous = { standing: this.standing, warnedOpen: this.warnedOpen };
    // Enough rows that a full batch of attempts NOT accused last tick is reached, if there is one.
    const due = await this.dueCheckouts()
      .andWhere(this.businessKeyExists(true))
      .orderBy('c.expiresAt', 'ASC')
      .limit(RECONCILE_BATCH + previous.standing.size + 1)
      .getMany();
    let order = due;
    const backlogged = due.length > RECONCILE_BATCH;
    if (backlogged !== this.backlogged) {
      // Said when the backlog starts and when it ends, never each tick while it lasts.
      if (backlogged) {
        this.logger.warn(
          `[RECONCILE] more than ${RECONCILE_BATCH} boutique attempts are due (those left open on an ` +
            `answer that is not final included) - the newest, after those, wait for a later tick; ` +
            `said again when the backlog ends`
        );
      } else {
        this.logger.log(`[RECONCILE] boutique backlog over: every due attempt fits one tick again`);
      }
      this.backlogged = backlogged;
    }
    if (backlogged) {
      // A full batch: what the previous tick left open on an answer that is not final goes LAST,
      // so a standing cause does not hold the newer rows back (class docblock).
      order = [
        ...due.filter((row) => !previous.standing.has(row.id)),
        ...due.filter((row) => previous.standing.has(row.id)),
      ];
    }
    this.tick = newTick();
    // Not read this tick: what was said of them still stands, so it is not said again.
    for (const row of order.slice(RECONCILE_BATCH)) {
      const cause = previous.standing.get(row.id);
      if (cause !== undefined) this.tick.accused.set(row.id, cause);
      if (previous.warnedOpen.has(row.id)) this.tick.warnedOpen.add(row.id);
    }
    const failed: CheckoutSettlementFailed[] = [];
    for (const row of order.slice(0, RECONCILE_BATCH)) {
      await this.count(
        'products',
        () => this.reconcileCheckout(row),
        `checkout ${row.id}`,
        (err) => {
          if (!(err instanceof CheckoutSettlementFailed)) return false;
          failed.push(err);
          return true;
        }
      );
    }
    const { noAnswer, accused, warnedOpen } = this.tick;
    this.standing = accused;
    this.warnedOpen = warnedOpen;
    if (noAnswer > 0) {
      this.logger.warn(
        `[RECONCILE] boutique: ${noAnswer} call(s) got no answer this tick (core or Lydia ` +
          `unreachable, a 5xx, a timeout, an unknown verdict) - left open, read again next tick`
      );
    }
    const changed =
      accused.size !== previous.standing.size ||
      [...accused].some(([id, cause]) => previous.standing.get(id) !== cause);
    if (changed && accused.size > 0) {
      const named = [...accused]
        .slice(0, ACCUSED_NAMED_MAX)
        .map(([id, cause]) => `${id} (${cause})`);
      const more =
        accused.size > ACCUSED_NAMED_MAX ? ` and ${accused.size - ACCUSED_NAMED_MAX} more` : '';
      this.logger.error(
        `[RECONCILE] boutique: ${accused.size} attempt(s) left open on an answer that is not final ` +
          `- ${named.join('; ')}${more} - read again next tick; said again when this list changes ` +
          `(${previous.standing.size} before)`
      );
    } else if (changed) {
      this.logger.log(
        `[RECONCILE] boutique: no attempt is left open on an answer that is not final any more ` +
          `(${previous.standing.size} before)`
      );
    }
    if (failed.length > 0) {
      const paid = failed.filter((f) => f.lydiaSaidPaid).map((f) => f.checkoutId);
      const others = failed.filter((f) => !f.lydiaSaidPaid).map((f) => f.checkoutId);
      this.logger.error(
        `[RECONCILE] boutique: ${failed.length} settlement write(s) FAILED this tick after a verified ` +
          `read (first: ${failed[0].message})` +
          (paid.length > 0
            ? ` - Lydia answered PAID for ${paid.length}, NOT recorded yet: ${paid.join(', ')}`
            : '') +
          (others.length > 0 ? ` - other failed writes: ${others.join(', ')}` : '') +
          ` - left open, settled again next tick`,
        failed[0].stack
      );
    }
  }

  /** How many ended boutique attempts stay `open` because their Business holds no key (a gauge). */
  async openWithoutKey(): Promise<number> {
    return this.dueCheckouts().andWhere(this.businessKeyExists(false)).getCount();
  }

  /**
   * How many boutique attempts the last tick left open on an answer that is not final (a gauge):
   * refused reads AND core faults (401/403, its 503), which the counts file as `unavailable`.
   */
  standingAccused(): number {
    return this.standing.size;
  }

  /** The counts since the last call, which resets them: one summary line's worth. */
  takeCounts(): { forms: ReconcileCounts; products: ReconcileCounts } {
    const taken = this.counts;
    this.counts = { forms: zero(), products: zero() };
    return taken;
  }

  /**
   * Settles ONE form answer from a verified read of its request. Exposed for the tests that race it
   * against the payer's return on a real database. What it does not settle stays `pending` for the
   * expiry that follows it in the tick.
   */
  async reconcileSubmission(row: Submission): Promise<ReconcileOutcome> {
    const sessionId = row.stripeSessionId as string;
    const what = `submission ${row.id} (request ${sessionId})`;
    const form = await this.formRepo.findOne({
      where: { id: row.formId },
      select: { id: true, associationId: true },
    });
    // The payee whatever provider is active: a payment in flight is still read after payments
    // are switched off - the same account a verified callback is checked against.
    const payee = form?.associationId
      ? await this.associationsService.getLydiaPayeeAccountId(form.associationId)
      : null;
    if (!payee) {
      this.logger.warn(`[RECONCILE] ${what}: its form pays into no Lydia account - not read`);
      return 'skipped-unverified';
    }
    if (!(row.totalPaid > 0)) {
      this.logger.error(`[RECONCILE] ${what}: pending online with no amount - not read`);
      return 'skipped-unverified';
    }
    let read: VerifiedRequestRead;
    try {
      read = await readVerifiedRequestState({ sessionId }, payee, row.totalPaid);
    } catch (err: unknown) {
      this.logger.warn(
        `[RECONCILE] ${what}: request/state unavailable (${errorText(err)}) - left for the expiry`
      );
      return 'unavailable';
    }
    const verified = this.verified(what, read, row.totalPaid);
    if (!verified) return read.verification === 'refused' ? 'refused' : 'skipped-unverified';
    const { state } = verified;
    if (state === 'paid') {
      const { ok } = await this.formsService.markPaid(row.id, sessionId, true);
      this.logger.log(
        `[RECONCILE] ${what}: PAID at Lydia (verified, ${row.totalPaid} cents) - ${
          ok ? 'recorded' : 'a retry replaced the request meanwhile, nothing written'
        }`
      );
      return ok ? 'settled' : 'unchanged';
    }
    if (state === 'declined' || state === 'cancelled-or-expired') {
      const released = await this.formsService.releaseSettledRefusedRow(
        row.id,
        sessionId,
        state,
        '[RECONCILE]'
      );
      return released ? 'released' : 'unchanged';
    }
    if (state === 'open') {
      this.logger.error(
        `[RECONCILE] ${what}: still OPEN at Lydia past the expire_time Canari sent it - left for the expiry`
      );
    } else {
      this.logger.warn(
        `[RECONCILE] ${what}: in a state nothing here settles (${state}, code ${verified.raw}) - left for the expiry`
      );
    }
    return 'unchanged';
  }

  /**
   * Reconciles ONE boutique attempt (see the class docblock for which answers close it and which
   * leave it for the next tick). Throws `CheckoutSettlementFailed` when a write after a verified
   * read failed: the attempt is then NOT closed. Exposed like the above.
   */
  async reconcileCheckout(row: ProductCheckout): Promise<ReconcileOutcome> {
    const lookup = productCheckoutLookup(row);
    const what = `checkout ${row.id} (${'sessionId' in lookup ? `request ${lookup.sessionId}` : 'no request id, read by order_ref'})`;
    let verdict = await this.readCheckout(row, lookup, what);
    if (verdict.next === 'cancel') {
      let status: string;
      try {
        status = await this.productsService.cancelStillOpenCheckout(row, this.why(verdict));
      } catch (err: unknown) {
        // The cancel did not go through (or its close did not write): the request may still be
        // payable, so the attempt is NOT closed - the next tick reads it again, and a request the
        // cancel did reach then reads cancelled. (A refusal known final was closed by the call.)
        this.retry(row.id, 'cancel', err);
        return 'unavailable';
      }
      if (status !== 'open') return verdict.outcome;
      // "Already processed" at Lydia: read once more NOW. Still open after that is no state Lydia
      // can be in - an answer all the same, closed rather than cancelled again every tick.
      verdict = await this.readCheckout(row, lookup, what);
      if (verdict.next === 'cancel') {
        verdict = {
          outcome: 'unchanged',
          next: 'expire',
          why: 'Lydia says open, yet its cancel says already processed',
        };
      }
    }
    if (verdict.next === 'expire') {
      await this.settleOrThrow(false, row.id, () =>
        this.productsService.expireUnprovenCheckout(row, this.why(verdict))
      );
    }
    return verdict.outcome;
  }

  /** The reason a verdict's close is logged with. */
  private why(verdict: CheckoutVerdict): string {
    return `its reconciliation read: ${verdict.why ?? verdict.outcome}`;
  }

  /** The one read of an attempt and what it settled; `reconcileCheckout` does the `next`. */
  private async readCheckout(
    row: ProductCheckout,
    lookup: ReturnType<typeof productCheckoutLookup>,
    what: string
  ): Promise<CheckoutVerdict> {
    if (!(row.amountCents > 0)) {
      this.logger.error(`[RECONCILE] ${what}: open with no amount - not read`);
      return { outcome: 'skipped-unverified', next: 'expire', why: 'no amount to verify' };
    }
    let read: VerifiedRequestRead;
    try {
      read = await readVerifiedRequestState(lookup, row.vendorToken, row.amountCents);
    } catch (err: unknown) {
      // Not a final answer: counted in the tick's aggregated lines, read again next tick.
      this.retry(row.id, 'read', err);
      return { outcome: 'unavailable', next: 'keep' };
    }
    if (read.verification === 'unknown') {
      this.logger.debug(`[RECONCILE] ${what}: core gave no verdict this service knows`);
      this.tick.noAnswer += 1;
      return { outcome: 'unavailable', next: 'keep' };
    }
    if (read.verification === 'refused') {
      if (!this.refusalsFinal.read.has(read.providerCode)) {
        // A refusal can be a state of Lydia: retried and accused, never closed (class docblock).
        this.tick.accused.set(
          row.id,
          `read refused, error ${read.providerCode || 'without a code'}, not known final`
        );
        return { outcome: 'refused', next: 'keep' };
      }
      // A refusal measured final: logged by `verified`, then closed like a mismatch.
      this.verified(what, read, row.amountCents);
      return {
        outcome: 'refused',
        next: 'expire',
        why: `refused for good (error ${read.providerCode})`,
      };
    }
    // The one unsigned answer acted on: no request carries the order_ref (see the class docblock).
    if (read.verification === 'unsigned' && read.state === 'not-found' && 'orderRef' in lookup) {
      await this.settleOrThrow(false, row.id, () =>
        this.productsService.applyRequestState(row, 'not-found', read.raw)
      );
      return { outcome: 'released', next: 'keep' };
    }
    const verified = this.verified(what, read, row.amountCents);
    if (!verified) {
      return { outcome: 'skipped-unverified', next: 'expire', why: read.verification };
    }
    const { state } = verified;
    if (state === 'paid' || state === 'declined' || state === 'cancelled-or-expired') {
      const status = await this.settleOrThrow(state === 'paid', row.id, () =>
        this.productsService.applyRequestState(row, state, verified.raw)
      );
      // A `paid` another settler wrote first also reads as `settled` here (the row cannot tell who
      // wrote it): the hourly count may count one payment twice, the purchase record never.
      const intended =
        state === 'paid' ? status === 'paid' : status !== 'paid' && status !== 'open';
      if (intended) {
        this.logger.log(
          `[RECONCILE] ${what}: ${state} at Lydia (verified, ${row.amountCents} cents) - attempt now ${status}`
        );
        return { outcome: state === 'paid' ? 'settled' : 'released', next: 'keep' };
      }
      // Another settler wrote first (the callback or the return): nothing for this sweep to do.
      this.logger.debug(`[RECONCILE] ${what}: ${state} at Lydia, attempt already ${status}`);
      return { outcome: 'unchanged', next: 'keep' };
    }
    if (state === 'open') {
      // Said once while it lasts: a cancel that keeps failing reaches this every tick, and the
      // tick's aggregated ERROR accuses that case.
      const line = `[RECONCILE] ${what}: still OPEN at Lydia past the expire_time Canari sent it - cancelling it there, then closing it`;
      // Last tick's warning, or this tick's first read before an "already processed" re-read.
      if (this.warnedOpen.has(row.id) || this.tick.warnedOpen.has(row.id)) this.logger.debug(line);
      else this.logger.warn(line);
      this.tick.warnedOpen.add(row.id);
      return { outcome: 'unchanged', next: 'cancel', why: 'still open at Lydia past its end' };
    }
    this.logger.warn(
      `[RECONCILE] ${what}: in a state nothing here settles (${state}, code ${verified.raw}) - closing it`
    );
    return { outcome: 'unchanged', next: 'expire', why: `state ${state}` };
  }

  /**
   * Files a read or a cancel that did not go through for the tick's aggregated lines, by the ONE
   * classifier of core's answers (`classifyCoreCallFailure`): no answer is counted for the WARN;
   * core answering about itself, or a refusal (a cancel's, here), is ACCUSED with its cause.
   */
  private retry(checkoutId: string, call: 'read' | 'cancel', err: unknown): void {
    const failure = classifyCoreCallFailure(err);
    this.logger.debug(
      `[RECONCILE] checkout ${checkoutId}: ${call} did not go through (${errorText(err)})`
    );
    if (failure.kind === 'no-answer') {
      this.tick.noAnswer += 1;
    } else if (failure.kind === 'core-fault') {
      this.tick.accused.set(
        checkoutId,
        `${call}: core answered HTTP ${failure.status} about itself`
      );
    } else {
      this.tick.accused.set(
        checkoutId,
        `${call} refused, error ${failure.providerCode || 'without a code'}, not known final`
      );
    }
  }

  /** Runs a settlement write; a failure becomes `CheckoutSettlementFailed`, the row left open. */
  private async settleOrThrow<T>(
    lydiaSaidPaid: boolean,
    checkoutId: string,
    write: () => Promise<T>
  ): Promise<T> {
    try {
      return await write();
    } catch (err: unknown) {
      throw new CheckoutSettlementFailed(lydiaSaidPaid, checkoutId, err);
    }
  }

  /** The rows of `product_checkouts` still open whose request has ended (see the class docblock). */
  private dueCheckouts() {
    return this.checkoutRepo
      .createQueryBuilder('c')
      .where(`c.status = 'open'`)
      .andWhere(
        `c."expiresAt" <= now() - make_interval(secs => ${CHECKOUT_EXPIRY_MARGIN_MS / 1000})`
      );
  }

  /**
   * Whether the Business an attempt was issued to (its `vendorToken` snapshot) holds a stored key -
   * the same lookup core-service's verification makes (`lydiaCallbackKey`), asked in SQL so an
   * attempt that cannot be verified costs no call at all.
   */
  private businessKeyExists(exists: boolean): string {
    return `${exists ? '' : 'NOT '}EXISTS (SELECT 1 FROM associations a
      WHERE a."lydiaAccountId" = c."vendorToken" AND a."lydiaBusinessKeyCiphertext" IS NOT NULL)`;
  }

  /** The read's state when its signature verified, else null and the logged reason it is not. */
  private verified(
    what: string,
    read: VerifiedRequestRead,
    expectedAmountCents: number
  ): { state: RequestState | 'not-found'; raw: string } | null {
    if (read.verification === 'verified') return { state: read.state, raw: read.raw };
    if (read.verification === 'refused') {
      this.logger.error(
        `[RECONCILE] ${what}: the read was REFUSED by Lydia (error ${read.providerCode || 'without a code'}) - nothing settled`
      );
    } else if (read.verification === 'no-key') {
      this.logger.warn(
        `[RECONCILE] ${what}: core holds no usable Business key to verify Lydia's answer with - nothing settled`
      );
    } else if (read.verification === 'mismatch') {
      this.logger.error(
        `[RECONCILE] ${what}: Lydia's answer (${read.state}, code ${read.raw}) does NOT verify over ` +
          `${expectedAmountCents} cents with the Business key - another amount, another key, or not ` +
          `Lydia; nothing settled`
      );
    } else {
      this.logger.warn(
        `[RECONCILE] ${what}: Lydia's answer (${read.state}, code ${read.raw}) is ${read.verification}, ` +
          `not verified - nothing settled`
      );
    }
    return null;
  }

  /**
   * Runs one row's reconciliation in its own `try`, counts what it did, and answers the outcome
   * (undefined on a failure). A failure `aggregate` claims is left to the caller's one line per
   * tick; any other is logged here, per row.
   */
  private async count(
    kind: 'forms' | 'products',
    run: () => Promise<ReconcileOutcome>,
    what: string,
    aggregate: (err: unknown) => boolean = () => false
  ): Promise<ReconcileOutcome | undefined> {
    const counts = this.counts[kind];
    counts.examined += 1;
    try {
      const outcome = await run();
      counts[COUNT_KEY[outcome]] += 1;
      return outcome;
    } catch (err: unknown) {
      counts.errors += 1;
      if (!aggregate(err)) {
        this.logger.error(`[RECONCILE] ${what}: reconciliation FAILED: ${errorText(err)}`);
      }
      return undefined;
    }
  }
}

/** An error's message, for a log line. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
