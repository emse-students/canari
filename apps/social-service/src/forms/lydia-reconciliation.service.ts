import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Submission } from './entities/submission.entity';
import { Form } from './entities/form.entity';
import { FormsService } from './forms.service';
import { PENDING_HOLD_CUTOFF_SQL, type RequestState } from './seat-hold';
import { readVerifiedRequestState, type VerifiedRequestRead } from './verified-request-state';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { ProductsService } from '../associations/products.service';
import { AssociationsService } from '../associations/associations.service';
import { CHECKOUT_EXPIRY_MARGIN_MS, productCheckoutLookup } from '../associations/product-checkout';

/**
 * Most rows one sweep reads at Lydia, per kind. A bound on one tick's work (one `request/state` read
 * each, up to a minute apiece), far above what a 5-minute tick meets: every row is due ONCE, when its
 * request ends, and this platform issues a few requests a day.
 */
export const RECONCILE_BATCH = 50;

/** What one row's reconciliation did. Exceptions are counted apart, as `errors`. */
export type ReconcileOutcome =
  | 'settled'
  | 'released'
  | 'unchanged'
  | 'skipped-unverified'
  | 'unavailable';

/** The counts one summary line reports, per kind. */
export interface ReconcileCounts {
  examined: number;
  settled: number;
  released: number;
  unchanged: number;
  skippedUnverified: number;
  unavailable: number;
  errors: number;
}

const zero = (): ReconcileCounts => ({
  examined: 0,
  settled: 0,
  released: 0,
  unchanged: 0,
  skippedUnverified: 0,
  unavailable: 0,
  errors: 0,
});

const COUNT_KEY: Record<ReconcileOutcome, keyof ReconcileCounts> = {
  settled: 'settled',
  released: 'released',
  unchanged: 'unchanged',
  'skipped-unverified': 'skippedUnverified',
  unavailable: 'unavailable',
};

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
 * good - paid, declined, or cancelled/expired. For a form that instant is `PENDING_HOLD_CUTOFF_SQL`
 * (the hold = lifetime + `PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS`); for a product it is `expiresAt` +
 * `CHECKOUT_EXPIRY_MARGIN_MS`. Before it, a read may answer `open`, which decides nothing and is
 * what the payer's return already polls.
 *
 * ONE WRITER OF `paid`, AND IT IS NOT HERE. A paid form answer goes through `FormsService.markPaid`
 * (form lock, row lock, re-checked to still name the uuid read); a paid attempt through
 * `ProductsService.applyRequestState` -> `settlePaidCheckout` (row lock, `paid` once). A release
 * goes through the very function the payer's return uses. So the sweep races the callback and the
 * return on the same locks, and two settlers of one payment record it once.
 *
 * IDEMPOTENT FROM THE ROW. A row is examined only while its own status still says it waits
 * (`pending`, `open`); every settlement moves it out of that status, so a second run - or a second
 * replica running the same tick - finds nothing left to do. The time condition only says WHEN a
 * read is final, never whether it was done.
 *
 * NOTHING UNVERIFIED IS ACTED ON. The read asks core to verify Lydia's signature with the Business
 * key over the row's OWN amount (`readVerifiedRequestState`). A mismatch is logged at ERROR and
 * settles nothing; no key, no signature or an unreadable request leave the row as it is. The one
 * exception is a boutique attempt read by its order_ref that Lydia answers NOT FOUND: an error answer
 * carries no signature, no request exists, no money moved - it is closed `cancelled`, exactly as the
 * return closes it.
 */
@Injectable()
export class LydiaReconciliationService {
  private readonly logger = new Logger(LydiaReconciliationService.name);
  private counts = { forms: zero(), products: zero() };

  constructor(
    @InjectRepository(Submission) private readonly submissionRepo: Repository<Submission>,
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    @InjectRepository(ProductCheckout) private readonly checkoutRepo: Repository<ProductCheckout>,
    private readonly formsService: FormsService,
    private readonly productsService: ProductsService,
    private readonly associationsService: AssociationsService
  ) {}

  /**
   * Reads at Lydia every online form answer still `pending` whose request has ended, newest first,
   * at most `RECONCILE_BATCH`, and settles each from a verified answer. Runs in the expiry tick,
   * BEFORE the expiry (`FormReminderScheduler`), so a row is read while it is still `pending` - after
   * the expiry it is `expired`, which nothing here reads again. Each row has its own `try`.
   */
  async sweepFormPayments(): Promise<void> {
    const due = await this.submissionRepo
      .createQueryBuilder('s')
      .where(`s."paymentStatus" = 'pending'`)
      .andWhere(`s."stripeSessionId" ~* '^[0-9a-f]{32}$'`)
      .andWhere(`s."paymentRequestedAt" <= ${PENDING_HOLD_CUTOFF_SQL}`)
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
    for (const row of due.slice(0, RECONCILE_BATCH)) {
      await this.count('forms', () => this.reconcileSubmission(row), `submission ${row.id}`);
    }
  }

  /**
   * Reads at Lydia every boutique attempt still `open` whose request has ended and whose Business
   * holds a key to verify with, newest first, at most `RECONCILE_BATCH`. An attempt of a Business
   * with no key cannot be verified: it is not read at all (`openWithoutKey` counts them for the
   * summary), and stays for its buyer's next attempt or its confirm callback.
   */
  async sweepProductCheckouts(): Promise<void> {
    const due = await this.dueCheckouts()
      .andWhere(this.businessKeyExists(true))
      .orderBy('c.expiresAt', 'DESC')
      .limit(RECONCILE_BATCH + 1)
      .getMany();
    if (due.length > RECONCILE_BATCH) {
      this.logger.warn(
        `[RECONCILE] more than ${RECONCILE_BATCH} boutique attempts are due - the oldest wait for the next tick`
      );
    }
    for (const row of due.slice(0, RECONCILE_BATCH)) {
      await this.count('products', () => this.reconcileCheckout(row), `checkout ${row.id}`);
    }
  }

  /** How many ended boutique attempts stay `open` because their Business holds no key (a gauge). */
  async openWithoutKey(): Promise<number> {
    return this.dueCheckouts().andWhere(this.businessKeyExists(false)).getCount();
  }

  /** The counts since the last call, which resets them: one summary line's worth. */
  takeCounts(): { forms: ReconcileCounts; products: ReconcileCounts } {
    const taken = this.counts;
    this.counts = { forms: zero(), products: zero() };
    return taken;
  }

  /**
   * Settles ONE form answer from a verified read of its request. Exposed for the tests that race it
   * against the payer's return on a real database.
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
    const read = await this.read(what, { sessionId }, payee, row.totalPaid);
    if (typeof read === 'string') return read;
    const { state } = read;
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
    return this.notSettled(what, state, read.raw);
  }

  /** Settles ONE boutique attempt from a verified read of its request. Exposed like the above. */
  async reconcileCheckout(row: ProductCheckout): Promise<ReconcileOutcome> {
    const lookup = productCheckoutLookup(row);
    const what = `checkout ${row.id} (${'sessionId' in lookup ? `request ${lookup.sessionId}` : 'no request id, read by order_ref'})`;
    if (!(row.amountCents > 0)) {
      this.logger.error(`[RECONCILE] ${what}: open with no amount - not read`);
      return 'skipped-unverified';
    }
    let read: VerifiedRequestRead;
    try {
      read = await readVerifiedRequestState(lookup, row.vendorToken, row.amountCents);
    } catch (err: unknown) {
      return this.unavailable(what, err);
    }
    // The one unsigned answer acted on: no request carries the order_ref (see the class docblock).
    if (read.verification !== 'no-key' && read.state === 'not-found' && 'orderRef' in lookup) {
      await this.productsService.applyRequestState(row, 'not-found', read.raw);
      return 'released';
    }
    const verified = this.verified(what, read, row.amountCents);
    if (typeof verified === 'string') return verified;
    const { state } = verified;
    if (state === 'paid' || state === 'declined' || state === 'cancelled-or-expired') {
      const status = await this.productsService.applyRequestState(row, state, verified.raw);
      this.logger.log(
        `[RECONCILE] ${what}: ${state} at Lydia (verified, ${row.amountCents} cents) - attempt now ${status}`
      );
      if (status === 'paid') return state === 'paid' ? 'settled' : 'unchanged';
      return status === 'open' ? 'unchanged' : 'released';
    }
    return this.notSettled(what, state, verified.raw);
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

  /** A verified read, or the outcome of a read that failed or cannot be trusted (logged). */
  private async read(
    what: string,
    lookup: { sessionId: string } | { orderRef: string },
    connectAccountId: string,
    expectedAmountCents: number
  ): Promise<{ state: RequestState | 'not-found'; raw: string } | ReconcileOutcome> {
    let read: VerifiedRequestRead;
    try {
      read = await readVerifiedRequestState(lookup, connectAccountId, expectedAmountCents);
    } catch (err: unknown) {
      return this.unavailable(what, err);
    }
    return this.verified(what, read, expectedAmountCents);
  }

  /** Lydia, or core, could not be asked: nothing is known, nothing is written. */
  private unavailable(what: string, err: unknown): ReconcileOutcome {
    this.logger.warn(
      `[RECONCILE] ${what}: request/state unavailable (${
        err instanceof Error ? err.message : String(err)
      }) - left as is`
    );
    return 'unavailable';
  }

  /** The read's state when its signature verified, else the logged reason it is not acted on. */
  private verified(
    what: string,
    read: VerifiedRequestRead,
    expectedAmountCents: number
  ): { state: RequestState | 'not-found'; raw: string } | ReconcileOutcome {
    if (read.verification === 'verified') return { state: read.state, raw: read.raw };
    if (read.verification === 'no-key') {
      this.logger.log(
        `[RECONCILE] ${what}: no Business key stored to verify Lydia's answer with - not read, left as is`
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
    return 'skipped-unverified';
  }

  /** A verified state that settles nothing: `open` past the request's end is an anomaly. */
  private notSettled(
    what: string,
    state: RequestState | 'not-found',
    raw: string
  ): ReconcileOutcome {
    if (state === 'open') {
      this.logger.error(
        `[RECONCILE] ${what}: still OPEN at Lydia past the expire_time Canari sent it - left as is`
      );
    } else {
      this.logger.warn(
        `[RECONCILE] ${what}: in a state nothing here settles (${state}, code ${raw}) - left as is`
      );
    }
    return 'unchanged';
  }

  /** Runs one row's reconciliation in its own `try`, and counts what it did. */
  private async count(
    kind: 'forms' | 'products',
    run: () => Promise<ReconcileOutcome>,
    what: string
  ): Promise<void> {
    const counts = this.counts[kind];
    counts.examined += 1;
    try {
      counts[COUNT_KEY[await run()]] += 1;
    } catch (err: unknown) {
      counts.errors += 1;
      this.logger.error(
        `[RECONCILE] ${what}: reconciliation FAILED: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
