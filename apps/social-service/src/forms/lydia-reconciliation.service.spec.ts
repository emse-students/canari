import { Logger } from '@nestjs/common';
import {
  CheckoutSettlementFailed,
  FORM_SWEEP_BUDGET_MS,
  LydiaReconciliationService,
  RECONCILE_BATCH,
} from './lydia-reconciliation.service';
import { readVerifiedRequestState } from './verified-request-state';
import type { Submission } from './entities/submission.entity';
import type { ProductCheckout } from '../associations/entities/product-checkout.entity';

jest.mock('./verified-request-state', () => ({ readVerifiedRequestState: jest.fn() }));
const read = readVerifiedRequestState as jest.MockedFunction<typeof readVerifiedRequestState>;

const UUID = '0123456789abcdef0123456789abcdef';

/** An axios-shaped error carrying core's answer. */
const coreAnswered = (status: number, data: unknown) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
/** Core's typed 400 for a Lydia refusal. */
const refusal = (providerCode: string) => ({ code: 'PAYMENT_PROVIDER_REFUSED', providerCode });
/**
 * A code no Lydia answer carries, put on the allowlist through the mechanism the services expose:
 * the real allowlists are EMPTY until a code is measured final on an issued request.
 */
const TEST_FINAL = 'test-only-final';
const withTestFinal = (service: LydiaReconciliationService) => {
  service.refusalsFinal = { read: new Set([TEST_FINAL]), cancel: new Set() };
  return service;
};
const CUTOFF = new Date('2026-10-27T12:00:00Z');

/** A TypeORM query builder that answers `rows` to `getMany` and `count` to `getCount`. */
function builder(rows: unknown[], count = 0) {
  const qb: Record<string, jest.Mock> = {};
  for (const name of ['where', 'andWhere', 'orderBy', 'limit']) qb[name] = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);
  qb.getCount = jest.fn(async () => count);
  return qb;
}

function makeService(
  opts: { submissions?: unknown[]; checkouts?: unknown[]; payee?: string | null } = {}
) {
  const formsService = {
    markPaid: jest.fn(async () => ({ ok: true })),
    releaseSettledRefusedRow: jest.fn(async () => true),
  };
  const productsService = {
    applyRequestState: jest.fn(async (_row: unknown, state: string) =>
      state === 'paid' ? 'paid' : state === 'declined' ? 'declined' : 'expired'
    ),
    expireUnprovenCheckout: jest.fn(async () => 'expired'),
    cancelStillOpenCheckout: jest.fn(async () => 'cancelled'),
  };
  const associationsService = {
    getLydiaPayeeAccountId: jest.fn(async () =>
      opts.payee === undefined ? 'vendor-payee' : opts.payee
    ),
  };
  const submissionRepo = { createQueryBuilder: jest.fn(() => builder(opts.submissions ?? [])) };
  const formRepo = { findOne: jest.fn(async () => ({ id: 'form-1', associationId: 'asso-1' })) };
  const checkoutRepo = { createQueryBuilder: jest.fn(() => builder(opts.checkouts ?? [], 3)) };
  const service = new LydiaReconciliationService(
    submissionRepo as never,
    formRepo as never,
    checkoutRepo as never,
    formsService as never,
    productsService as never,
    associationsService as never
  );
  return { service, formsService, productsService, associationsService };
}

const submission = (overrides: Partial<Submission> = {}) =>
  ({
    id: 'sub-1',
    formId: 'form-1',
    paymentStatus: 'pending',
    stripeSessionId: UUID,
    totalPaid: 1200,
    ...overrides,
  }) as Submission;

const checkout = (overrides: Partial<ProductCheckout> = {}) =>
  ({
    id: '33333333-3333-4333-8333-333333333333',
    productId: '11111111-1111-4111-8111-111111111111',
    vendorToken: 'vendor-snapshot',
    amountCents: 1000,
    requestUuid: UUID,
    status: 'open',
    expiresAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  }) as ProductCheckout;

let logs: Record<'log' | 'warn' | 'error', jest.SpyInstance>;
beforeEach(() => {
  read.mockReset();
  logs = {
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('LydiaReconciliationService.reconcileSubmission', () => {
  it("reads the row's own request with the payee and the ROW's amount, and records a verified payment through markPaid", async () => {
    const { service, formsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    await expect(service.reconcileSubmission(submission())).resolves.toBe('settled');
    expect(read).toHaveBeenCalledWith({ sessionId: UUID }, 'vendor-payee', 1200);
    // The one writer of `paid`, re-checking under its lock that the row still names this uuid.
    expect(formsService.markPaid).toHaveBeenCalledWith('sub-1', UUID, true);
  });

  it('says unchanged when markPaid finds the request replaced meanwhile', async () => {
    const { service, formsService } = makeService();
    formsService.markPaid.mockResolvedValue({ ok: false });
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    await expect(service.reconcileSubmission(submission())).resolves.toBe('unchanged');
  });

  it.each(['declined', 'cancelled-or-expired'] as const)(
    'releases a verified %s request through the return path',
    async (state) => {
      const { service, formsService } = makeService();
      read.mockResolvedValue({ verification: 'verified', state, raw: '5' });
      await expect(service.reconcileSubmission(submission())).resolves.toBe('released');
      expect(formsService.releaseSettledRefusedRow).toHaveBeenCalledWith(
        'sub-1',
        UUID,
        state,
        '[RECONCILE]'
      );
      expect(formsService.markPaid).not.toHaveBeenCalled();
    }
  );

  it('settles NOTHING on an answer that does not verify, and accuses it at ERROR', async () => {
    const { service, formsService } = makeService();
    read.mockResolvedValue({ verification: 'mismatch', state: 'paid', raw: '1' });
    await expect(service.reconcileSubmission(submission())).resolves.toBe('skipped-unverified');
    expect(formsService.markPaid).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('does NOT verify over 1200 cents')
    );
  });

  it.each([
    [{ verification: 'unsigned', state: 'paid', raw: '1' }],
    [{ verification: 'unknown', state: 'paid', raw: '1' }],
    [{ verification: 'no-key' }],
  ] as const)('settles and releases nothing on %p', async (answer) => {
    const { service, formsService } = makeService();
    read.mockResolvedValue(answer as never);
    await expect(service.reconcileSubmission(submission())).resolves.toBe('skipped-unverified');
    expect(formsService.markPaid).not.toHaveBeenCalled();
    expect(formsService.releaseSettledRefusedRow).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('leaves the row when request/state is unavailable, and writes nothing', async () => {
    const { service, formsService } = makeService();
    read.mockRejectedValue(new Error('core 503'));
    await expect(service.reconcileSubmission(submission())).resolves.toBe('unavailable');
    expect(formsService.markPaid).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable (core 503)'));
  });

  it('accuses a request still OPEN past its end at ERROR, and writes nothing', async () => {
    const { service, formsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    await expect(service.reconcileSubmission(submission())).resolves.toBe('unchanged');
    expect(formsService.releaseSettledRefusedRow).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('still OPEN'));
  });

  it('does not read a row whose form pays into no Lydia account', async () => {
    const { service } = makeService({ payee: null });
    await expect(service.reconcileSubmission(submission())).resolves.toBe('skipped-unverified');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('LydiaReconciliationService.reconcileCheckout', () => {
  it("records a verified payment through the attempt's one mapping, read with its OWN Business and amount", async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    const row = checkout();
    await expect(service.reconcileCheckout(row)).resolves.toBe('settled');
    expect(read).toHaveBeenCalledWith({ sessionId: UUID }, 'vendor-snapshot', 1000);
    expect(productsService.applyRequestState).toHaveBeenCalledWith(row, 'paid', '1');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  it('closes a verified declined attempt', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'declined', raw: '5' });
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('released');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  it('says nothing above debug when another settler recorded the payment first', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'declined', raw: '5' });
    productsService.applyRequestState.mockResolvedValueOnce('paid');
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('unchanged');
    expect(logs.log).not.toHaveBeenCalled();
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  // The ANSWERS it cannot act on: the attempt is closed after that one read, never read again.
  it.each([
    ['a mismatch', { verification: 'mismatch', state: 'paid', raw: '1' }, 'skipped-unverified'],
    ['unsigned', { verification: 'unsigned', state: 'paid', raw: '1' }, 'skipped-unverified'],
    // A key that does not open is answered `no-key` by social-service's key route.
    ['no usable key', { verification: 'no-key' }, 'skipped-unverified'],
    // A refusal whose code is on the allowlist (a test-only code: the real one is empty).
    ['a refusal known final', { verification: 'refused', providerCode: TEST_FINAL }, 'refused'],
    [
      'not-found for a uuid Lydia itself issued',
      { verification: 'verified', state: 'not-found', raw: 'error 2' },
      'unchanged',
    ],
  ] as const)(
    'closes the attempt expired after ONE read answering %s',
    async (_name, answer, outcome) => {
      const { service, productsService } = makeService();
      read.mockResolvedValue(answer as never);
      const row = checkout();
      await expect(withTestFinal(service).reconcileCheckout(row)).resolves.toBe(outcome);
      expect(productsService.applyRequestState).not.toHaveBeenCalled();
      expect(productsService.expireUnprovenCheckout).toHaveBeenCalledTimes(1);
      expect(productsService.expireUnprovenCheckout).toHaveBeenCalledWith(row, expect.any(String));
      expect(productsService.cancelStillOpenCheckout).not.toHaveBeenCalled();
    }
  );

  it('cancels at Lydia, then closes, an attempt Lydia verifiably says is still open past its end', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    const row = checkout();
    await expect(service.reconcileCheckout(row)).resolves.toBe('unchanged');
    expect(productsService.cancelStillOpenCheckout).toHaveBeenCalledWith(row, expect.any(String));
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  it('reads once more when the cancel says already processed, and settles from that read', async () => {
    const { service, productsService } = makeService();
    read
      .mockResolvedValueOnce({ verification: 'verified', state: 'open', raw: '0' })
      .mockResolvedValueOnce({ verification: 'verified', state: 'paid', raw: '1' });
    productsService.cancelStillOpenCheckout.mockResolvedValueOnce('open');
    const row = checkout();
    await expect(service.reconcileCheckout(row)).resolves.toBe('settled');
    expect(read).toHaveBeenCalledTimes(2);
    expect(productsService.applyRequestState).toHaveBeenCalledWith(row, 'paid', '1');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  it('closes, rather than cancels again every tick, an attempt Lydia says is open after its cancel said processed', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    productsService.cancelStillOpenCheckout.mockResolvedValueOnce('open');
    const row = checkout();
    await expect(service.reconcileCheckout(row)).resolves.toBe('unchanged');
    expect(productsService.cancelStillOpenCheckout).toHaveBeenCalledTimes(1);
    expect(productsService.expireUnprovenCheckout).toHaveBeenCalledWith(
      row,
      expect.stringContaining('its cancel says already processed')
    );
  });

  it('leaves the attempt open when the cancel at Lydia fails: the request may still be payable', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    productsService.cancelStillOpenCheckout.mockRejectedValueOnce(new Error('core 503'));
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('unavailable');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  // The cancel and the read go through ONE classifier: core refusing THIS service (401/403), its
  // 503 when payments are off, a refusal not known final - none closes an attempt Lydia said OPEN.
  it.each([
    ['core refusing this service', coreAnswered(401, {})],
    ['core refusing this service', coreAnswered(403, {})],
    ['payments switched off', coreAnswered(503, { code: 'PAYMENT_SERVICE_NOT_READY' })],
    ['a refused cancel not known final', coreAnswered(400, refusal('3'))],
    ['a rate limit', coreAnswered(429, {})],
  ])('leaves the attempt open when its cancel meets %s', async (_name, err) => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    productsService.cancelStillOpenCheckout.mockRejectedValueOnce(err);
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('unavailable');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  // NOT a final answer: left open, read again next tick, said once per tick by the sweep.
  it.each([
    [
      'core or Lydia unreachable',
      () => read.mockRejectedValue(new Error('ECONNRESET')),
      'unavailable',
    ],
    ['a 5xx', () => read.mockRejectedValue(coreAnswered(500, {})), 'unavailable'],
    ['a timeout', () => read.mockRejectedValue(coreAnswered(408, {})), 'unavailable'],
    ['a rate limit', () => read.mockRejectedValue(coreAnswered(429, {})), 'unavailable'],
    [
      'core refusing this service',
      () => read.mockRejectedValue(coreAnswered(401, {})),
      'unavailable',
    ],
    [
      'core refusing this service',
      () => read.mockRejectedValue(coreAnswered(403, {})),
      'unavailable',
    ],
    [
      "core's 503 when payments are off, Lydia unconfigured or the payload refused",
      () => read.mockRejectedValue(coreAnswered(503, { code: 'PAYMENT_SERVICE_NOT_READY' })),
      'unavailable',
    ],
    [
      'a verdict this service does not know',
      () => read.mockResolvedValue({ verification: 'unknown', state: 'paid', raw: '1' }),
      'unavailable',
    ],
    // A refusal is NOT closed unless its code is measured final: Lydia error 5 is "temporarily
    // blocked", and a revoked provider token refuses every row with an HTTP 401.
    // Error 2 was measured on a uuid Lydia NEVER issued; the sweep reads issued ones, for which
    // it is unmeasured - a PAID request answered that way must not be closed for good.
    [
      'error 2 on an issued uuid (unmeasured)',
      () => read.mockResolvedValue({ verification: 'refused', providerCode: '2' }),
      'refused',
    ],
    [
      'a refusal not known final (error 5)',
      () => read.mockResolvedValue({ verification: 'refused', providerCode: '5' }),
      'refused',
    ],
    [
      'a refusal not known final (HTTP 401 from Lydia)',
      () => read.mockResolvedValue({ verification: 'refused', providerCode: 'http-401' }),
      'refused',
    ],
  ] as const)('leaves the attempt open on %s', async (_name, arrange, outcome) => {
    const { service, productsService } = makeService();
    arrange();
    await expect(withTestFinal(service).reconcileCheckout(checkout())).resolves.toBe(outcome);
    expect(productsService.applyRequestState).not.toHaveBeenCalled();
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  // Control: closing in a catch here expired a VERIFIED PAID attempt whose write had failed - no
  // purchase record, and nothing reads a closed attempt again but its callback.
  it('NEVER closes an attempt whose settlement write failed: it throws, saying Lydia said PAID', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    productsService.applyRequestState.mockRejectedValueOnce(new Error('deadlock'));
    const failure = service.reconcileCheckout(checkout());
    await expect(failure).rejects.toBeInstanceOf(CheckoutSettlementFailed);
    await expect(failure).rejects.toMatchObject({ lydiaSaidPaid: true, message: 'deadlock' });
    // The write's own error and stack survive the wrapping.
    const thrown = (await failure.catch((err: unknown) => err)) as CheckoutSettlementFailed;
    expect(thrown.cause).toBeInstanceOf(Error);
    expect(thrown.stack).toContain('Caused by: Error: deadlock');
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
  });

  it('closes an attempt read by order_ref that Lydia does not hold, the one unsigned answer acted on', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'unsigned', state: 'not-found', raw: 'error 2' });
    const row = checkout({ requestUuid: null });
    await expect(service.reconcileCheckout(row)).resolves.toBe('released');
    expect(read).toHaveBeenCalledWith(
      { orderRef: `product:${row.productId}:${row.id}` },
      'vendor-snapshot',
      1000
    );
    expect(productsService.applyRequestState).toHaveBeenCalledWith(row, 'not-found', 'error 2');
  });

  it('never closes it cancelled on a not-found for a uuid Lydia itself issued', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'unsigned', state: 'not-found', raw: 'error 2' });
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('skipped-unverified');
    expect(productsService.applyRequestState).not.toHaveBeenCalled();
  });

  it('acts on a not-found only when core called it unsigned - an unknown verdict is not one', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'unknown', state: 'not-found', raw: 'error 2' });
    await expect(service.reconcileCheckout(checkout({ requestUuid: null }))).resolves.toBe(
      'unavailable'
    );
    expect(productsService.applyRequestState).not.toHaveBeenCalled();
  });
});

describe('LydiaReconciliationService sweeps', () => {
  const saved = process.env.LYDIA_RECONCILE_ENABLED;
  beforeEach(() => {
    process.env.LYDIA_RECONCILE_ENABLED = 'true';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LYDIA_RECONCILE_ENABLED;
    else process.env.LYDIA_RECONCILE_ENABLED = saved;
  });

  it.each([undefined, 'false', 'TRUE', '1'])(
    'switched OFF (LYDIA_RECONCILE_ENABLED=%p): selects no row and asks Lydia nothing',
    async (value) => {
      if (value === undefined) delete process.env.LYDIA_RECONCILE_ENABLED;
      else process.env.LYDIA_RECONCILE_ENABLED = value;
      const { service } = makeService({
        submissions: [submission()],
        checkouts: [checkout()],
      });
      const repos = service as unknown as {
        submissionRepo: { createQueryBuilder: jest.Mock };
        checkoutRepo: { createQueryBuilder: jest.Mock };
      };
      await service.sweepFormPayments(CUTOFF);
      await service.sweepProductCheckouts();
      expect(repos.submissionRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(repos.checkoutRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(service.takeCounts().forms.examined).toBe(0);
    }
  );

  it('switched ON: the same rows are read at Lydia', async () => {
    const { service } = makeService({ submissions: [submission()], checkouts: [checkout()] });
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    await service.sweepFormPayments(CUTOFF);
    await service.sweepProductCheckouts();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('isolates each row: one that throws is counted as an error, the next still settles', async () => {
    const rows = [submission({ id: 'sub-a' }), submission({ id: 'sub-b' })];
    const { service, formsService } = makeService({ submissions: rows });
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    formsService.markPaid
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValue({ ok: true });
    await service.sweepFormPayments(CUTOFF);
    expect(formsService.markPaid).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('submission sub-a: reconciliation FAILED: deadlock')
    );
    expect(service.takeCounts().forms).toMatchObject({ examined: 2, settled: 1, errors: 1 });
    // Taken means reset: the next summary starts from zero.
    expect(service.takeCounts().forms.examined).toBe(0);
  });

  it('reads at most one batch, and says at ERROR that the rest of the tick goes to the expiry unread', async () => {
    const rows = Array.from({ length: RECONCILE_BATCH + 1 }, (_, i) =>
      submission({ id: `sub-${i}` })
    );
    const { service } = makeService({ submissions: rows });
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    await service.sweepFormPayments(CUTOFF);
    expect(read).toHaveBeenCalledTimes(RECONCILE_BATCH);
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('expired without a read'));
  });

  it('stops starting form reads once its budget is spent, so the expiry is never held longer', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => submission({ id: `sub-${i}` }));
    const { service } = makeService({ submissions: rows });
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    read.mockImplementation(async () => {
      now += (FORM_SWEEP_BUDGET_MS * 2) / 3;
      return { verification: 'verified', state: 'open', raw: '0' };
    });
    await service.sweepFormPayments(CUTOFF);
    expect(read).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('3 ended answer(s) are expired without a read')
    );
  });

  it('selects the forms by the cutoff it is handed, and the boutique oldest first', async () => {
    const { service } = makeService();
    const repos = service as unknown as {
      submissionRepo: { createQueryBuilder: jest.Mock };
      checkoutRepo: { createQueryBuilder: jest.Mock };
    };
    await service.sweepFormPayments(CUTOFF);
    await service.sweepProductCheckouts();
    const forms = repos.submissionRepo.createQueryBuilder.mock.results[0].value;
    expect(forms.andWhere).toHaveBeenCalledWith(
      `s."paymentRequestedAt" <= CAST(:cutoff AS timestamptz)`,
      {
        cutoff: CUTOFF,
      }
    );
    const checkouts = repos.checkoutRepo.createQueryBuilder.mock.results[0].value;
    expect(checkouts.orderBy).toHaveBeenCalledWith('c.expiresAt', 'ASC');
  });

  it('says what it left open in ONE line per tick per cause, naming the attempts Lydia said PAID', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => checkout({ id: `checkout-${id}` }));
    const { service, productsService } = makeService({ checkouts: rows });
    read
      .mockRejectedValueOnce(new Error('core 503'))
      .mockRejectedValueOnce(new Error('core 503'))
      .mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    productsService.applyRequestState.mockRejectedValue(new Error('deadlock'));
    await service.sweepProductCheckouts();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('2 call(s) got no answer'));
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '2 settlement write(s) FAILED this tick after a verified read (first: deadlock) - Lydia answered PAID for 2, NOT recorded yet: checkout-c, checkout-d - left open'
      ),
      expect.stringContaining('Caused by')
    );
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
    expect(service.takeCounts().products).toMatchObject({ examined: 4, unavailable: 2, errors: 2 });
  });

  it('ACCUSES, in ONE line per tick, what it left open on an answer that is not final', async () => {
    const rows = ['g', 'h', 'i'].map((id) => checkout({ id: `checkout-${id}` }));
    const { service, productsService } = makeService({ checkouts: rows });
    read
      .mockRejectedValueOnce(coreAnswered(403, {}))
      .mockResolvedValueOnce({ verification: 'refused', providerCode: '5' })
      .mockResolvedValueOnce({ verification: 'verified', state: 'open', raw: '0' });
    productsService.cancelStillOpenCheckout.mockRejectedValueOnce(coreAnswered(400, refusal('3')));
    await service.sweepProductCheckouts();
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '3 attempt(s) left open on an answer that is not final - ' +
          'checkout-g (read: core answered HTTP 403 about itself); ' +
          'checkout-h (read refused, error 5, not known final); ' +
          'checkout-i (cancel refused, error 3, not known final) - read again next tick'
      )
    );
    expect(productsService.expireUnprovenCheckout).not.toHaveBeenCalled();
    expect(service.takeCounts().products).toMatchObject({
      examined: 3,
      refused: 1,
      unavailable: 2,
    });
  });

  it('accuses again only when the list CHANGES, and says once when it empties', async () => {
    const row = checkout({ id: 'checkout-j' });
    const { service } = makeService({ checkouts: [row] });
    read.mockResolvedValue({ verification: 'refused', providerCode: '5' });
    await service.sweepProductCheckouts();
    await service.sweepProductCheckouts();
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(service.standingAccused()).toBe(1);
    // Another cause for the same attempt is news.
    read.mockResolvedValue({ verification: 'refused', providerCode: '6' });
    await service.sweepProductCheckouts();
    expect(logs.error).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenLastCalledWith(
      expect.stringContaining('checkout-j (read refused, error 6, not known final)')
    );
    // Answered at last: said once, at log level, and the gauge empties.
    read.mockResolvedValue({ verification: 'verified', state: 'declined', raw: '5' });
    await service.sweepProductCheckouts();
    await service.sweepProductCheckouts();
    expect(logs.error).toHaveBeenCalledTimes(2);
    expect(
      logs.log.mock.calls.filter(([line]) => String(line).includes('not final any more'))
    ).toHaveLength(1);
    expect(service.standingAccused()).toBe(0);
  });

  it('warns an attempt still OPEN at Lydia once while its cancel keeps being refused', async () => {
    const { service, productsService } = makeService({ checkouts: [checkout()] });
    read.mockResolvedValue({ verification: 'verified', state: 'open', raw: '0' });
    productsService.cancelStillOpenCheckout.mockRejectedValue(coreAnswered(400, refusal('3')));
    await service.sweepProductCheckouts();
    await service.sweepProductCheckouts();
    await service.sweepProductCheckouts();
    const stillOpen = logs.warn.mock.calls.filter(([line]) => String(line).includes('still OPEN'));
    expect(stillOpen).toHaveLength(1);
    expect(logs.error).toHaveBeenCalledTimes(1);
  });

  // Fairness without a column: a standing cause must not hold the newer rows back for ever.
  it("reads newer attempts first when the batch is full, putting last tick's accused last", async () => {
    const uuid = (i: number) => i.toString(16).padStart(32, '0');
    const rows = Array.from({ length: RECONCILE_BATCH + 1 }, (_, i) =>
      checkout({ id: `checkout-${i}`, requestUuid: uuid(i) })
    );
    const { service } = makeService({ checkouts: rows });
    // The ten oldest are refused with a code not known final; the rest get no answer.
    const accused = new Set(rows.slice(0, 10).map((row) => row.requestUuid));
    read.mockImplementation(async (lookup) =>
      accused.has((lookup as { sessionId: string }).sessionId)
        ? { verification: 'refused', providerCode: '5' }
        : { verification: 'unknown', state: 'paid', raw: '1' }
    );
    await service.sweepProductCheckouts();
    // Oldest first: the newest waited.
    const firstTick = read.mock.calls.map(
      ([lookup]) => (lookup as { sessionId: string }).sessionId
    );
    expect(firstTick).not.toContain(uuid(RECONCILE_BATCH));
    read.mockClear();
    await service.sweepProductCheckouts();
    const secondTick = read.mock.calls.map(
      ([lookup]) => (lookup as { sessionId: string }).sessionId
    );
    expect(secondTick).toHaveLength(RECONCILE_BATCH);
    expect(secondTick).toContain(uuid(RECONCILE_BATCH));
    // The one accused attempt left out stays accused, so the list did not change: one ERROR.
    expect(secondTick).not.toContain(uuid(9));
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(service.standingAccused()).toBe(10);
  });

  it('names the failed writes Lydia did NOT say paid too', async () => {
    const rows = ['e', 'f'].map((id) => checkout({ id: `checkout-${id}` }));
    const { service, productsService } = makeService({ checkouts: rows });
    read
      .mockResolvedValueOnce({ verification: 'verified', state: 'paid', raw: '1' })
      .mockResolvedValueOnce({ verification: 'verified', state: 'declined', raw: '5' });
    productsService.applyRequestState.mockRejectedValue(new Error('deadlock'));
    await service.sweepProductCheckouts();
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'NOT recorded yet: checkout-e - other failed writes: checkout-f - left open'
      ),
      expect.any(String)
    );
  });

  it('counts the boutique sweep apart from the forms', async () => {
    const { service } = makeService({ checkouts: [checkout()] });
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    await service.sweepProductCheckouts();
    const { forms, products } = service.takeCounts();
    expect(forms.examined).toBe(0);
    expect(products).toMatchObject({ examined: 1, settled: 1 });
    await expect(service.openWithoutKey()).resolves.toBe(3);
  });
});
