import { Logger } from '@nestjs/common';
import { LydiaReconciliationService, RECONCILE_BATCH } from './lydia-reconciliation.service';
import { readVerifiedRequestState } from './verified-request-state';
import type { Submission } from './entities/submission.entity';
import type { ProductCheckout } from '../associations/entities/product-checkout.entity';

jest.mock('./verified-request-state', () => ({ readVerifiedRequestState: jest.fn() }));
const read = readVerifiedRequestState as jest.MockedFunction<typeof readVerifiedRequestState>;

const UUID = '0123456789abcdef0123456789abcdef';

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
  });

  it('closes a verified declined attempt', async () => {
    const { service } = makeService();
    read.mockResolvedValue({ verification: 'verified', state: 'declined', raw: '5' });
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('released');
  });

  it('applies nothing on an answer that does not verify', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'mismatch', state: 'paid', raw: '1' });
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('skipped-unverified');
    expect(productsService.applyRequestState).not.toHaveBeenCalled();
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

  it('never closes on a not-found for a uuid Lydia itself issued', async () => {
    const { service, productsService } = makeService();
    read.mockResolvedValue({ verification: 'unsigned', state: 'not-found', raw: 'error 2' });
    await expect(service.reconcileCheckout(checkout())).resolves.toBe('skipped-unverified');
    expect(productsService.applyRequestState).not.toHaveBeenCalled();
  });
});

describe('LydiaReconciliationService sweeps', () => {
  it('isolates each row: one that throws is counted as an error, the next still settles', async () => {
    const rows = [submission({ id: 'sub-a' }), submission({ id: 'sub-b' })];
    const { service, formsService } = makeService({ submissions: rows });
    read.mockResolvedValue({ verification: 'verified', state: 'paid', raw: '1' });
    formsService.markPaid
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValue({ ok: true });
    await service.sweepFormPayments();
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
    await service.sweepFormPayments();
    expect(read).toHaveBeenCalledTimes(RECONCILE_BATCH);
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('expired without a read'));
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
