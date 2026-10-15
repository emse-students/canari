import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CONFIRM_PAYMENT_PER_MINUTE, FormsController } from './forms.controller';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import axios from 'axios';
import { FindOperator } from 'typeorm';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { InternalFormsController } from '../internal/internal-forms.controller';
import {
  PENDING_HOLD_CUTOFF_SQL,
  PAYMENT_REQUEST_LIFETIME_SECONDS,
  PENDING_PAYMENT_HOLD_SECONDS,
  PREVIOUS_PAYMENT_OPEN,
  overCapacityFirst,
  seatHoldingWhere,
} from './seat-hold';

/**
 * AN ONLINE `pending` ROW HOLDS ITS SEAT FOR A BOUNDED TIME, AND A PAYMENT THAT LANDS AFTER IS
 * DECIDED FROM THE ROW (PP3, PP4 of `public-paid-forms-chantier.md`).
 *
 * The repositories are an in-memory store that evaluates the service's own `where` clauses, so the
 * test exercises the predicate the service builds rather than a mock's canned count. The one SQL
 * fragment (`PENDING_HOLD_CUTOFF_SQL`) is evaluated here against a fake clock; that it means the
 * same thing in Postgres was checked against a real server (see the pull request). The seat lock
 * is a real mutex per form, released when the transaction ends, and every transaction must be READ
 * COMMITTED, so two late payments - or two submits - genuinely interleave every `await` they reach.
 */
describe('FormsService - the seat a pending payment holds', () => {
  const HOLD_MS = PENDING_PAYMENT_HOLD_SECONDS * 1000;
  const T0 = new Date('2026-10-15T12:00:00Z');
  type Row = {
    id: string;
    formId: string;
    userId: string | null;
    paymentStatus: string;
    paymentMethod: string | null;
    totalPaid: number;
    paymentRequestedAt: Date;
    createdAt: Date;
    stripeSessionId?: string | null;
    paymentRequestId?: string | null;
    paymentSettledBy?: string | null;
    cotisationGrantedAt?: Date | null;
    purchaseRecordedAt?: Date | null;
    answers?: Record<string, unknown>;
  };
  type Flag = 'cotisationGrantedAt' | 'purchaseRecordedAt';

  function makeStore(opts: {
    maxSubmissions: number | null;
    rows: Row[];
    basePrice?: number;
    allowMultipleSubmissions?: boolean;
    /** `lydia` reaches the fake core below; `disabled` stops a paid submit after its transaction. */
    provider?: 'lydia' | 'disabled';
  }) {
    let now = T0;
    const rows: Row[] = opts.rows.map((row) => ({ ...row }));
    let nextId = 0;
    const form = {
      id: 'f1',
      title: 'Gala',
      maxSubmissions: opts.maxSubmissions,
      associationId: 'asso1',
      grantsCotisation: true,
      cotisationVariantKey: null,
      basePrice: opts.basePrice ?? 0,
      priceMatrix: null,
      submitCondition: null,
      anonymous: false,
      isPublic: false,
      allowMultipleSubmissions: opts.allowMultipleSubmissions ?? false,
      allowCashPayment: false,
      currency: 'eur',
      opensAt: null,
      closedAt: null,
      items: [],
    };

    /** Lets every concurrent caller run up to its next await, as a database round trip would. */
    const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

    /** Evaluates one value of a `where` against a row, the raw hold fragment included. */
    function matchesValue(row: Row, key: keyof Row, expected: unknown): boolean {
      if (expected instanceof FindOperator) {
        // The only operator the service puts in a submission `where` is the hold, and it must be
        // the ONE fragment the expiry job also uses - anything else is a new predicate.
        expect(key).toBe('paymentRequestedAt');
        expect(expected.type).toBe('raw');
        expect(expected.getSql?.('col')).toBe(`col > ${PENDING_HOLD_CUTOFF_SQL}`);
        return row.paymentRequestedAt.getTime() > now.getTime() - HOLD_MS;
      }
      return row[key] === expected;
    }
    const matches = (row: Row, where: Record<string, unknown> | Record<string, unknown>[]) =>
      (Array.isArray(where) ? where : [where]).some((clause) =>
        Object.entries(clause).every(([key, value]) => matchesValue(row, key as keyof Row, value))
      );
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    /** Every status a locked step wrote, in order: one payment must move its row ONCE. */
    const transitions: string[] = [];

    const locks = new Map<string, Promise<void>>();
    const purchaseRecordService = { create: jest.fn(() => Promise.resolve()) };
    const userTagService = { grantCotisant: jest.fn(() => Promise.resolve({})) };

    /** The two UPDATE shapes the service builds: the expiry job and a fulfilment claim. */
    function runUpdate(state: {
      set: Record<string, unknown>;
      where: string[];
      params: Record<string, unknown>;
    }) {
      if (state.where[0] === '"paymentStatus" = :status') {
        expect(state.where).toEqual([
          '"paymentStatus" = :status',
          `"paymentRequestedAt" <= ${PENDING_HOLD_CUTOFF_SQL}`,
        ]);
        const moved = rows.filter(
          (r) =>
            r.paymentStatus === state.params.status &&
            r.paymentRequestedAt.getTime() <= now.getTime() - HOLD_MS
        );
        moved.forEach((r) => Object.assign(r, state.set));
        return { affected: moved.length };
      }
      const [flag] = Object.keys(state.set) as Flag[];
      expect(state.where).toEqual(['id = :id', `"${flag}" IS NULL`]);
      const target = byId(state.params.id as string);
      if (target[flag]) return { affected: 0 };
      target[flag] = now;
      return { affected: 1 };
    }

    const submissionRepo: any = {
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown>[] }) =>
          rows.filter((r) => matches(r, where)).length
      ),
      update: jest.fn(async (id: string, values: Partial<Row>) => {
        Object.assign(byId(id), values);
      }),
      createQueryBuilder: () => {
        const state = {
          set: {} as Record<string, unknown>,
          where: [] as string[],
          params: {} as Record<string, unknown>,
        };
        const builder = {
          update: () => builder,
          set: (values: Record<string, unknown>) => ((state.set = values), builder),
          where: (sql: string, params: Record<string, unknown> = {}) => (
            state.where.push(sql),
            Object.assign(state.params, params),
            builder
          ),
          andWhere: (sql: string) => (state.where.push(sql), builder),
          execute: async () => {
            await roundTrip();
            return runUpdate(state);
          },
        };
        return builder;
      },
      manager: {
        transaction: jest.fn(async (level: string, run: (manager: unknown) => Promise<unknown>) => {
          // REPEATABLE READ takes its snapshot BEFORE the lock wait, so the count after it would not
          // see the previous holder's commit: the seat lock is only sound in READ COMMITTED.
          expect(level).toBe('READ COMMITTED');
          const releases: (() => void)[] = [];
          const manager = {
            query: async (sql: string, [formId]: string[]) => {
              expect(sql).toBe('SELECT 1 FROM forms WHERE id = $1 FOR UPDATE');
              while (locks.has(formId)) await locks.get(formId);
              let release!: () => void;
              locks.set(formId, new Promise<void>((resolve) => (release = resolve)));
              releases.push(() => {
                locks.delete(formId);
                release();
              });
              return [];
            },
            findOne: async (entity: unknown, { where }: { where: Record<string, unknown> }) => {
              await roundTrip();
              if (entity === Form) return { ...form };
              expect(entity).toBe(Submission);
              const row = rows.find((r) => matches(r, where));
              return row ? { ...row } : null;
            },
            count: async (_entity: unknown, { where }: { where: Record<string, unknown>[] }) => {
              await roundTrip();
              return rows.filter((r) => matches(r, where)).length;
            },
            create: (_entity: unknown, values: Partial<Row>) => ({ ...values }),
            save: async (row: Row) => {
              await roundTrip();
              if (!row.id) {
                // An insert: the database's defaults, on the fake clock.
                const inserted = {
                  ...row,
                  id: `new${++nextId}`,
                  paymentRequestedAt: now,
                  createdAt: now,
                };
                rows.push(inserted);
                return { ...inserted };
              }
              const before = byId(row.id).paymentStatus;
              Object.assign(byId(row.id), row);
              if (row.paymentStatus !== before) {
                transitions.push(`${row.id}:${before}->${row.paymentStatus}`);
              }
              return row;
            },
            update: async (_entity: unknown, id: string, values: Record<string, unknown>) => {
              await roundTrip();
              expect(Object.keys(values)).toEqual(['paymentRequestedAt']);
              expect((values.paymentRequestedAt as () => string)()).toBe('now()');
              byId(id).paymentRequestedAt = now;
            },
          };
          try {
            return await run(manager);
          } finally {
            releases.forEach((release) => release());
          }
        }),
      },
    };
    const formRepo: any = { findOne: jest.fn(async () => ({ ...form })) };
    const pricingFacts: any = {
      build: jest.fn(async (input: { answers?: Record<string, string[]> }) => ({
        promo: null,
        formation: null,
        cotisationTiers: [],
        answers: input.answers ?? {},
      })),
    };
    // Payments are DISABLED by default, so a paid submit stops right after its transaction
    // committed: those tests are about what the transaction wrote, not about the checkout.
    const associationsService: any = {
      assertPaymentsReady: jest.fn(async () => undefined),
      getPaymentAccountId: jest.fn(async () => 'vendor'),
      // Nobody manages this form through the association: only its submitter may read its answer.
      mayAct: jest.fn(async () => false),
      getActivePaymentProvider: jest.fn(async () => opts.provider ?? 'disabled'),
    };
    // A fake core-service: every call is recorded with what the ROWS looked like when it was made,
    // and the cancel route answers what the test sets (core reads Lydia's error 2 as
    // `already-settled`).
    const core = {
      calls: [] as { route: string; body: any; rowIdsThen: unknown[] }[],
      cancelAnswer: 'cancelled' as 'cancelled' | 'already-settled' | Error,
      /** What `request-state` answers once a cancel said `already-settled` (Lydia's error 2). */
      stateAnswer: 'closed' as 'closed' | 'paid' | 'open' | 'other' | Error,
      /** Runs inside the state read, as a concurrent retry replacing the row's request may. */
      duringState: null as null | (() => void),
      /** Runs inside the cancel call, as Lydia's own cancel callback for the old request may. */
      duringCancel: null as null | (() => Promise<unknown>),
    };
    let requests = 0;
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: any) => {
      const route = url.split('/payments/')[1];
      core.calls.push({
        route,
        body,
        rowIdsThen: rows.map((r) => [r.id, r.paymentRequestId ?? null, r.stripeSessionId ?? null]),
      });
      if (route === 'cancel-request') {
        if (core.duringCancel) await core.duringCancel();
        if (core.cancelAnswer instanceof Error) throw core.cancelAnswer;
        return { data: { ok: true, outcome: core.cancelAnswer } };
      }
      if (route === 'request-state') {
        core.duringState?.();
        if (core.stateAnswer instanceof Error) throw core.stateAnswer;
        // core-service maps every code it has not measured (5, refused by the payer, among them)
        // to `other` and passes the raw code along.
        const raw = { paid: '1', closed: '6', open: '0', other: '5' }[core.stateAnswer];
        return { data: { ok: true, state: core.stateAnswer, raw } };
      }
      expect(route).toBe('create-checkout-session');
      requests += 1;
      return {
        data: {
          ok: true,
          url: `https://lydia.example/pay/${requests}`,
          id: `uuid-${requests}`,
          requestId: String(1000 + requests),
        },
      };
    });
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      associationsService,
      userTagService as any,
      purchaseRecordService as any,
      pricingFacts,
      {} as any,
      // FormFilesService: these forms ask for no file, so nothing here reaches it.
      {} as any
    );
    return {
      service,
      rows,
      userTagService,
      purchaseRecordService,
      core,
      transitions,
      advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    };
  }

  afterEach(() => jest.restoreAllMocks());

  const ago = (ms: number) => new Date(T0.getTime() - ms);
  const row = (over: Partial<Row>): Row => ({
    id: 's1',
    formId: 'f1',
    userId: 'u1',
    paymentStatus: 'pending',
    paymentMethod: null,
    totalPaid: 1500,
    paymentRequestedAt: T0,
    createdAt: ago(10 * HOLD_MS),
    cotisationGrantedAt: null,
    purchaseRecordedAt: null,
    ...over,
  });

  describe('the seat count', () => {
    // The boundary itself: the hold is decided from the row in the count, so no job has run.
    it('counts a pending row one second inside the hold, and not one second past it', async () => {
      const { service } = makeStore({
        maxSubmissions: 10,
        rows: [
          row({ id: 'inside', paymentRequestedAt: ago(HOLD_MS - 1000) }),
          row({ id: 'past', paymentRequestedAt: ago(HOLD_MS + 1000) }),
        ],
      });
      expect((await service.get('f1')).submissionCount).toBe(1);
    });

    it('releases the seat as the clock crosses the hold, with no job run', async () => {
      const { service, advance } = makeStore({
        maxSubmissions: 1,
        rows: [row({ paymentRequestedAt: ago(HOLD_MS - 1000) })],
      });
      expect((await service.get('f1')).submissionCount).toBe(1);
      advance(2000);
      expect((await service.get('f1')).submissionCount).toBe(0);
    });

    it('counts every other seat-holding state whatever its age', () => {
      const branches = seatHoldingWhere('f1').map((clause) => clause.paymentStatus);
      expect(branches).toEqual(['paid', 'free', 'pending', 'pending_cash']);
    });
  });

  describe('submit', () => {
    // Fails if `submit` goes back to REPEATABLE READ (the store refuses any other level) or counts
    // before it takes the form's lock (both would count the seat free and both would insert).
    it('lets two simultaneous answers take the last seat ONCE', async () => {
      const { service, rows } = makeStore({ maxSubmissions: 1, rows: [] });
      const results = await Promise.allSettled([
        service.submit('f1', { userId: 'u1', answers: {} } as any),
        service.submit('f1', { userId: 'u2', answers: {} } as any),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(rows).toHaveLength(1);
    });

    it('restarts the hold when it reuses a live pending row for a new request', async () => {
      const { service, rows, advance } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [
          row({
            id: 'mine',
            paymentRequestedAt: ago(HOLD_MS - 60_000),
            paymentRequestId: '555',
            stripeSessionId: 'uuid-old',
          }),
        ],
      });
      await service.submit('f1', { userId: 'u1', answers: {} } as any);
      expect(rows).toHaveLength(1);
      expect(rows[0].paymentRequestedAt).toEqual(T0);
      // Past the ORIGINAL hold, still inside the new one: the seat is still held.
      advance(2 * 60_000);
      expect((await service.get('f1')).submissionCount).toBe(1);
    });

    // The new row's request is never issued (payments off): nothing is payable, so the row is
    // released at once instead of holding the seat - and reading as "being issued" - for 30 min.
    it('leaves a pending row past the hold alone, and releases a new row nothing was issued for', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        rows: [row({ id: 'stale', paymentRequestedAt: ago(HOLD_MS + 1000) })],
      });
      await expect(
        service.submit('f1', { userId: 'u1', answers: {} } as any)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rows.map((r) => [r.id, r.paymentStatus])).toEqual([
        ['stale', 'pending'],
        ['new1', 'cancelled'],
      ]);
    });
  });

  describe('the expiry job', () => {
    it('moves only pending rows past the hold to expired, and a second run moves nothing', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: null,
        rows: [
          row({ id: 'stale', paymentRequestedAt: ago(HOLD_MS + 1000) }),
          row({ id: 'live', paymentRequestedAt: ago(HOLD_MS - 1000) }),
          row({ id: 'cash', paymentStatus: 'pending_cash', paymentRequestedAt: ago(10 * HOLD_MS) }),
          row({ id: 'paid', paymentStatus: 'paid', paymentRequestedAt: ago(10 * HOLD_MS) }),
        ],
      });
      expect(await service.expireStalePendingPayments()).toBe(1);
      const first = rows.map((r) => [r.id, r.paymentStatus]);
      expect(first).toEqual([
        ['stale', 'expired'],
        ['live', 'pending'],
        ['cash', 'pending_cash'],
        ['paid', 'paid'],
      ]);
      expect(await service.expireStalePendingPayments()).toBe(0);
      expect(rows.map((r) => [r.id, r.paymentStatus])).toEqual(first);
    });
  });

  describe('a late payment', () => {
    it('takes a free seat and grants as any payment does', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 2,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid');
      // The settling id has its own column; the request's uuid is never overwritten with it.
      expect(rows[0].paymentSettledBy).toBe('req-1');
      expect(rows[0].stripeSessionId).toBeUndefined();
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(rows[0].cotisationGrantedAt).toBeTruthy();
      expect(rows[0].purchaseRecordedAt).toBeTruthy();
    });

    it('lands over capacity on a full form, accused at warn, and grants nothing', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      const warn = jest.spyOn((service as any).logger, 'warn');
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('late'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1500 cents'));
      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
      expect(rows[0].cotisationGrantedAt).toBeNull();
      // The payer's trace that they paid stays: the refund happens outside the application.
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('treats a pending row past the hold as released even before the job ran', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'late', paymentStatus: 'pending', paymentRequestedAt: ago(HOLD_MS + 1000) }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
    });

    it('never refuses a row still holding its seat, even on a full form', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'onTime', paymentStatus: 'pending', paymentRequestedAt: ago(1000) })],
      });
      await service.markPaid('onTime');
      expect(rows[0].paymentStatus).toBe('paid');
    });

    it('lets two simultaneous late payments take the last seat ONCE', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 2,
        rows: [
          row({ id: 'a', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({
            id: 'b',
            userId: 'u3',
            paymentStatus: 'expired',
            paymentRequestedAt: ago(2 * HOLD_MS),
          }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      await Promise.all([service.markPaid('a'), service.markPaid('b')]);
      const statuses = rows.slice(0, 2).map((r) => r.paymentStatus);
      expect(statuses.sort()).toEqual(['paid', 'paid_over_capacity']);
    });
  });

  describe('a replayed payment', () => {
    // The Lydia callback and the payer's return (confirmPayment) may both reach markPaid for one payment.
    it('changes nothing and grants nothing a second time', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'pending', paymentRequestedAt: ago(1000) })],
      });
      await service.markPaid('s1', 'req-1');
      await service.markPaid('s1', 'req-1');
      await Promise.all([service.markPaid('s1', 'req-1'), service.markPaid('s1', 'req-1')]);
      expect(rows[0].paymentStatus).toBe('paid');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // The effects run after the commit; the flag is what lets the next replay finish them.
    it('retries a grant that failed, and only that', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'pending', paymentRequestedAt: ago(1000) })],
      });
      userTagService.grantCotisant.mockRejectedValueOnce(new Error('core-service down'));
      await service.markPaid('s1', 'req-1');
      expect(rows[0].cotisationGrantedAt).toBeNull();
      await service.markPaid('s1', 'req-1');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(2);
      expect(rows[0].cotisationGrantedAt).toBeTruthy();
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('finishes a payment whose effects never ran (a crash after the commit)', async () => {
      const { service, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'paid', stripeSessionId: 'req-1' })],
      });
      await service.markPaid('s1', 'req-1');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('keeps a payment over capacity over capacity', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'late', paymentStatus: 'paid_over_capacity' }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
    });

    // ONE payment reaches markPaid under TWO ids: the Lydia callback carries its `request_id`, the
    // payer's return (confirmPayment) the `request_uuid` `submit` stored. Neither order may leave the row
    // unpaid, accuse anybody, or fulfil twice - whichever id is stored when the other one arrives.
    it.each([
      ['the callback first, then the payer return', ['124', 'uuid-1']],
      ['the payer return first, then the callback', ['uuid-1', '124']],
    ])('pays once whatever the id: %s', async (_order, [first, second]) => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({
            id: 's1',
            paymentStatus: 'pending',
            paymentRequestedAt: ago(1000),
            stripeSessionId: 'uuid-1',
            paymentRequestId: '124',
          }),
        ],
      });
      const warn = jest.spyOn((service as any).logger, 'warn');
      const error = jest.spyOn((service as any).logger, 'error');
      await service.markPaid('s1', first);
      expect(rows[0].paymentStatus).toBe('paid');
      await service.markPaid('s1', second);
      expect(rows[0].paymentStatus).toBe('paid');
      expect(rows[0]).toMatchObject({ paymentSettledBy: first, stripeSessionId: 'uuid-1' });
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    // P1-b: the row names its request by both ids, so a confirmation naming NEITHER is a second
    // request paid for one answer. Accused at ERROR with both sides; nothing moves or repeats.
    it('accuses at ERROR a confirmation of ANOTHER request on a settled row', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({
            id: 's1',
            paymentStatus: 'pending',
            paymentRequestedAt: ago(1000),
            stripeSessionId: 'uuid-1',
            paymentRequestId: '124',
          }),
        ],
      });
      const error = jest.spyOn((service as any).logger, 'error');
      await service.markPaid('s1', '124');
      await service.markPaid('s1', '999');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('999'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('by 124'));
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentSettledBy: '124' });
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('does not accuse a row written before 084, which names only its uuid', async () => {
      const { service } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'paid', stripeSessionId: 'uuid-1' })],
      });
      const error = jest.spyOn((service as any).logger, 'error');
      await service.markPaid('s1', '124');
      expect(error).not.toHaveBeenCalled();
    });
  });

  // P2-d: one answer per person. A late payment whose payer already has ANOTHER row holding a seat
  // or paid on a one-answer form is a second payment for one answer, never a silent second `paid`.
  describe('a late payment on a one-answer form', () => {
    it.each([
      ['a live pending answer', 'pending', ago(1000)],
      ['a paid answer', 'paid', ago(10 * HOLD_MS)],
      ['an answer paid over capacity', 'paid_over_capacity', ago(10 * HOLD_MS)],
    ])('lands over capacity, at ERROR, when the payer has %s', async (_l, status, requestedAt) => {
      const { service, rows, userTagService } = makeStore({
        maxSubmissions: 10,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'newer', paymentStatus: status, paymentRequestedAt: requestedAt }),
        ],
      });
      const error = jest.spyOn((service as any).logger, 'error');
      await service.markPaid('late', '777');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('newer'));
      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
    });

    it('is an ordinary late payment when the other answer is someone else', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 10,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'theirs', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late', '777');
      expect(rows[0].paymentStatus).toBe('paid');
    });

    it('is an ordinary late payment on a form that takes several answers', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 10,
        allowMultipleSubmissions: true,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'newer', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late', '777');
      expect(rows[0].paymentStatus).toBe('paid');
    });
  });

  describe('a cancel callback', () => {
    // The status check and the write are one locked step: a cancel never overwrites a payment.
    it('cancels a pending row and leaves a paid one alone', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'p', paymentStatus: 'pending', paymentRequestId: '1' }),
          row({ id: 'q', paymentStatus: 'paid', paymentRequestId: '2' }),
        ],
      });
      await service.cancelPendingSubmission('p', { requestId: '1' });
      await service.cancelPendingSubmission('q', { requestId: '2' });
      expect(rows.map((r) => r.paymentStatus)).toEqual(['cancelled', 'paid']);
    });

    // Fails without the comparison: after a retry, the cancel of the OLD request would cancel the
    // answer whose NEW request the payer is paying right now.
    it('applies only to the request the row is waiting on, by either id', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '600', stripeSessionId: 'uuid-600' })],
      });
      await service.cancelPendingSubmission('p', { requestId: '555' });
      await service.cancelPendingSubmission('p', { sessionId: 'uuid-555' });
      expect(rows[0].paymentStatus).toBe('pending');
      await service.cancelPendingSubmission('p', { sessionId: 'uuid-600' });
      expect(rows[0].paymentStatus).toBe('cancelled');
    });

    it('refuses a report naming no request, and leaves a row with no stored id alone', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: null, stripeSessionId: null })],
      });
      await expect(service.cancelPendingSubmission('p', {})).rejects.toBeInstanceOf(
        BadRequestException
      );
      await service.cancelPendingSubmission('p', { requestId: '555' });
      expect(rows[0].paymentStatus).toBe('pending');
    });
  });

  describe('the payment request a submit issues', () => {
    // D1: the request dies with the seat hold, from ONE constant - Lydia reads 0 as "never".
    it('expires with the seat hold, and the row keeps both of its ids', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [],
      });
      const result = await service.submit('f1', { userId: 'u1', answers: {} } as any);
      expect(result).toMatchObject({ checkoutUrl: 'https://lydia.example/pay/1' });
      expect(core.calls.map((c) => c.route)).toEqual(['create-checkout-session']);
      // P2-b: the request is dead BEFORE the seat is released - Lydia's expiry sweep fired up to
      // ~80 s late on the sandbox, so the lifetime is the hold minus a two-minute margin.
      expect(core.calls[0].body.expireAfterSeconds).toBe(PAYMENT_REQUEST_LIFETIME_SECONDS);
      expect(PAYMENT_REQUEST_LIFETIME_SECONDS).toBe(1680);
      expect(
        PENDING_PAYMENT_HOLD_SECONDS - PAYMENT_REQUEST_LIFETIME_SECONDS
      ).toBeGreaterThanOrEqual(120);
      expect(rows[0]).toMatchObject({ paymentRequestId: '1001', stripeSessionId: 'uuid-1' });
      // The ids are written by name: the hold the transaction set is not written back over.
      expect(rows[0].paymentRequestedAt).toEqual(T0);
    });

    const mine = (over: Partial<Row> = {}) =>
      row({
        id: 'mine',
        paymentRequestedAt: ago(60_000),
        paymentRequestId: '555',
        stripeSessionId: 'uuid-old',
        ...over,
      });
    const retry = (service: FormsService) =>
      service.submit('f1', { userId: 'u1', answers: {} } as any);

    // D2: a retry settles the request the row was waiting on, BEFORE issuing the new one, and the
    // row keeps naming that request until the answer is known (P1-a: never cleared before it).
    it.each([
      ['cancelled now', 'cancelled', ['cancel-request', 'create-checkout-session']],
      [
        'already processed, found closed',
        'already-settled',
        ['cancel-request', 'request-state', 'create-checkout-session'],
      ],
    ] as const)('cancels the old request first on a retry (%s)', async (_label, answer, routes) => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = answer;
      const warn = jest.spyOn((service as any).logger, 'warn');
      await retry(service);
      expect(core.calls.map((c) => c.route)).toEqual(routes);
      expect(core.calls[0].body).toEqual({ requestId: '555', connectAccountId: 'vendor' });
      expect(core.calls[0].rowIdsThen).toEqual([['mine', '555', 'uuid-old']]);
      // The state is read by the uuid, and only after an `already-settled`.
      expect(core.calls.find((c) => c.route === 'request-state')?.body ?? null).toEqual(
        answer === 'already-settled' ? { sessionId: 'uuid-old', connectAccountId: 'vendor' } : null
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        paymentStatus: 'pending',
        paymentRequestId: '1001',
        stripeSessionId: 'uuid-1',
        paymentRequestedAt: T0,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    // P1-a: Lydia's error 2 for a request the payer PAID in the app without coming back. Reading it
    // as "cancelled" issued a second request - a second charge. Fails without the state read.
    it('stops the retry and marks the answer paid when the old request was PAID', async () => {
      const { service, rows, core, userTagService } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      await expect(retry(service)).resolves.toEqual({ submissionId: 'mine', alreadyPaid: true });
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request', 'request-state']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        paymentStatus: 'paid',
        paymentRequestId: '555',
        stripeSessionId: 'uuid-old',
        paymentSettledBy: '555',
      });
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
    });

    // P2-a: a request that cannot be shown dead or paid refuses the retry instead of leaving two
    // payable requests. The row keeps naming its request and its seat.
    it.each([
      ['the cancel failed', { cancelAnswer: new Error('connect ECONNREFUSED') }],
      ['the state is still open', { cancelAnswer: 'already-settled', stateAnswer: 'open' }],
      [
        'the state read failed',
        { cancelAnswer: 'already-settled', stateAnswer: new Error('timeout') },
      ],
    ] as const)('refuses the retry with PREVIOUS_PAYMENT_OPEN when %s', async (_label, answers) => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      Object.assign(core, answers);
      const refusal = await retry(service).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: PREVIOUS_PAYMENT_OPEN,
      });
      expect(core.calls.map((c) => c.route)).not.toContain('create-checkout-session');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', paymentRequestId: '555' });
    });

    // A row naming no request is one whose request is being issued right now: a second request
    // would be the double charge, so the retry is refused.
    it('refuses a retry while the row request is being issued', async () => {
      const { service, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine({ paymentRequestId: null, stripeSessionId: null })],
      });
      await expect(retry(service)).rejects.toBeInstanceOf(ConflictException);
      expect(core.calls).toEqual([]);
    });

    // Lydia calls the old request's cancel_url once it is cancelled - possibly before the retry's
    // transaction runs, while the row still names that request, so the report cancels the row. The
    // retry takes back the cancel it caused; a later report about the old request changes nothing.
    it('takes back the cancel its own cancel caused, and ignores it afterwards', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.duringCancel = () => service.cancelPendingSubmission('mine', { requestId: '555' });
      await retry(service);
      await service.cancelPendingSubmission('mine', { requestId: '555' });
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', paymentRequestId: '1001' });
    });

    // P2-c: the submitter's own cancel settles the request by the same rules.
    it('cancels the Lydia request when the submitter cancels the answer', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      await expect(service.cancelSubmission('mine', 'u1', false)).resolves.toEqual({ ok: true });
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request']);
      expect(rows[0].paymentStatus).toBe('cancelled');
    });

    it('marks the answer paid instead of cancelling it when its request was PAID', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      await expect(service.cancelSubmission('mine', 'u1', false)).resolves.toEqual({
        ok: false,
        alreadyPaid: true,
      });
      expect(rows[0].paymentStatus).toBe('paid');
    });

    it('refuses the submitter cancel while the request cannot be cancelled', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = new Error('connect ECONNREFUSED');
      await expect(service.cancelSubmission('mine', 'u1', false)).rejects.toBeInstanceOf(
        ConflictException
      );
      expect(rows[0].paymentStatus).toBe('pending');
    });
  });

  /**
   * THE PAYER'S RETURN CONFIRMS A PAYMENT THE CALLBACK MISSED. Until 2026-10-15 nothing did: the
   * return page only re-read the row, and `verify-session` - the one route that asked Lydia - took
   * the submission from an `order_ref` `request/state` never echoes (sandbox, payments.md). A paid
   * request whose callback failed stayed `pending` until the expiry job released its seat.
   */
  describe('the payer return (confirm-payment)', () => {
    // A `request_uuid` as Lydia issues it (32 hex digits): `confirmPayment` asks about no other shape.
    const UUID_OLD = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    const UUID_NEW = 'f9e8d7c6b5a4938271605f4e3d2c1b0a';
    const mine = (over: Partial<Row> = {}) =>
      row({
        id: 'mine',
        paymentRequestedAt: ago(60_000),
        paymentRequestId: '555',
        stripeSessionId: UUID_OLD,
        ...over,
      });

    it('records a payment Lydia reports PAID that no callback confirmed', async () => {
      const { service, rows, core, userTagService } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = 'paid';
      await expect(service.confirmPayment('mine')).resolves.toMatchObject({
        id: 'mine',
        paymentStatus: 'paid',
      });
      // Read by the row's OWN uuid and the Business's vendor_token: nothing comes from the caller.
      expect(core.calls.map((c) => [c.route, c.body])).toEqual([
        ['request-state', { sessionId: UUID_OLD, connectAccountId: 'vendor' }],
      ]);
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentSettledBy: UUID_OLD });
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
    });

    it('then a late callback for the same payment is a replay, accused of nothing', async () => {
      const { service, rows, core, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = 'paid';
      const error = jest.spyOn((service as any).logger, 'error');
      await service.confirmPayment('mine');
      await service.markPaid('mine', '555');
      expect(rows[0].paymentStatus).toBe('paid');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      // The same row, then confirmed by a request it never named: THAT is accused. Without this
      // line the test above passes with the accusation deleted, since silence is all it asserts.
      await service.markPaid('mine', '999');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('999'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`by ${UUID_OLD}`));
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // P2-a: a payment made at the end of the hold whose callback is lost leaves the row released
    // (`expired` by the job, or `cancelled` by its own expire callback). It is still read, and
    // decided like any late payment: `paid` while the form has room.
    it.each([['expired'], ['cancelled']])(
      'records a payment found PAID on a row already %s',
      async (status) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: 1,
          provider: 'lydia',
          rows: [mine({ paymentStatus: status })],
        });
        core.stateAnswer = 'paid';
        await expect(service.confirmPayment('mine')).resolves.toMatchObject({
          paymentStatus: 'paid',
        });
        expect(core.calls.map((c) => c.route)).toEqual(['request-state']);
        expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentSettledBy: UUID_OLD });
      }
    );

    it('lands a late payment on an expired row over capacity when the seat went meanwhile', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [
          mine({ paymentStatus: 'expired' }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ],
      });
      core.stateAnswer = 'paid';
      await service.confirmPayment('mine');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
    });

    // P3: the request was read paid outside the row lock. If a retry replaced it in between, the
    // retry's own settle read it and decided it; this read writes nothing.
    it('writes nothing when the row no longer names the uuid it read', async () => {
      const { service, rows, core, userTagService } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = 'paid';
      core.duringState = () => {
        rows[0].stripeSessionId = UUID_NEW;
        rows[0].paymentRequestId = '777';
      };
      const warn = jest.spyOn((service as any).logger, 'warn');
      await service.confirmPayment('mine');
      expect(rows[0].paymentStatus).toBe('pending');
      expect(rows[0].paymentSettledBy ?? null).toBeNull();
      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(UUID_NEW));
    });

    it.each([
      ['still open', 'open'],
      ['closed', 'closed'],
      // A code nothing here has measured - 5, refused by the payer, is one - is never read as paid.
      ['in an unmeasured state (5)', 'other'],
    ] as const)('leaves the row pending when the request is %s', async (_label, state) => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = state;
      await expect(service.confirmPayment('mine')).resolves.toMatchObject({
        paymentStatus: 'pending',
      });
      expect(rows[0].paymentStatus).toBe('pending');
    });

    it('answers the row unchanged, at WARN, when the provider cannot be read', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = new Error('timeout');
      const warn = jest.spyOn((service as any).logger, 'warn');
      await expect(service.confirmPayment('mine')).resolves.toMatchObject({
        paymentStatus: 'pending',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
      expect(rows[0].paymentStatus).toBe('pending');
    });

    it.each([
      ['already paid', { paymentStatus: 'paid' }],
      ['naming no request yet', { stripeSessionId: null, paymentRequestId: null }],
    ])('asks the provider nothing for a row %s', async (_label, over) => {
      const { service, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine(over as Partial<Row>)],
      });
      await service.confirmPayment('mine');
      expect(core.calls).toEqual([]);
    });

    // A Stripe-era row still holds a `cs_...` id: core refuses it with a 400, so asking would only
    // put a WARN in the log on every poll of the return page.
    it.each([['pending'], ['expired'], ['cancelled']])(
      'asks nothing about a Stripe-era id on a %s row, and says so once at INFO',
      async (status) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: 1,
          provider: 'lydia',
          rows: [
            mine({
              paymentStatus: status,
              stripeSessionId: 'cs_test_a1B2c3',
              paymentRequestId: null,
            }),
          ],
        });
        core.stateAnswer = 'paid';
        const log = jest.spyOn((service as any).logger, 'log');
        const warn = jest.spyOn((service as any).logger, 'warn');
        await expect(service.confirmPayment('mine')).resolves.toMatchObject({
          paymentStatus: status,
        });
        expect(core.calls).toEqual([]);
        expect(rows[0].paymentStatus).toBe(status);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('non-Lydia request id'));
        expect(warn).not.toHaveBeenCalled();
      }
    );

    // P3: the ROUTE refuses someone who is neither the submitter nor a manager of the form, before
    // anything is asked of the provider.
    it('the route answers 403 to a caller who neither submitted nor manages it', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = 'paid';
      const routes = new FormsController(
        service,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );
      await expect(routes.confirmPayment('mine', 'intruder', 'false')).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('pending');
      // The submitter passes the same route.
      await expect(routes.confirmPayment('mine', 'u1', 'false')).resolves.toMatchObject({
        paymentStatus: 'paid',
      });
    });

    it('the route is throttled per user and submission', () => {
      const handler = (FormsController.prototype as unknown as Record<string, object>)
        .confirmPayment;
      const guards = Reflect.getMetadata('__guards__', handler);
      expect(guards).toContain(UserResourceThrottlerGuard);
      expect(CONFIRM_PAYMENT_PER_MINUTE).toBeGreaterThanOrEqual(10);
      expect(CONFIRM_PAYMENT_PER_MINUTE).toBeLessThanOrEqual(20);
    });
  });

  /**
   * THE TWO CONFIRMATIONS OF ONE PAYMENT, THROUGH THE ROUTE CORE-SERVICE CALLS. Since #1910 Lydia's
   * callbacks are parsed: the confirm callback posts `{ sessionId: <numeric request_id> }`
   * (webhook.controller.ts) and a cancel or expire callback posts `{ requestId }`. The payer's
   * return reaches `markPaid` with the `request_uuid` (`confirmPayment` above) - but only when the
   * row is still `pending` as it arrives, so a payment reaches `markPaid` once or twice, in either
   * order. The callback bodies are pinned on the core side by its own specs; here they enter
   * through `InternalFormsController`, the handler they reach, and the uuid stands for the return.
   */
  describe('through the internal routes, in either order', () => {
    const SECRET = 'internal-secret-for-test';
    const webhookConfirm = { sessionId: '1001' };
    const payerReturn = { sessionId: 'uuid-1' };

    function makeRoutes(over: Partial<Row> = {}, maxSubmissions = 1, others: Row[] = []) {
      process.env.INTERNAL_SECRET = SECRET;
      const store = makeStore({
        maxSubmissions,
        rows: [
          row({
            id: 's1',
            paymentRequestedAt: ago(60_000),
            paymentRequestId: '1001',
            stripeSessionId: 'uuid-1',
            ...over,
          }),
          ...others,
        ],
      });
      const routes = new InternalFormsController(store.service);
      return {
        ...store,
        markPaid: (body: { sessionId: string }) => routes.markPaid('s1', SECRET, body),
        cancelPending: (body: { requestId: string }) => routes.cancelPending('s1', SECRET, body),
      };
    }

    it.each([
      ['the webhook, then the payer return', [webhookConfirm, payerReturn]],
      ['the payer return, then the webhook', [payerReturn, webhookConfirm]],
    ])('%s: one transition, one grant, one purchase', async (_order, bodies) => {
      const r = makeRoutes();
      const warn = jest.spyOn((r.service as any).logger, 'warn');
      for (const body of bodies) await r.markPaid(body);
      expect(r.rows[0].paymentStatus).toBe('paid');
      expect(r.transitions).toEqual(['s1:pending->paid']);
      expect(r.userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('both at once: one transition, one grant, one purchase', async () => {
      const r = makeRoutes();
      await Promise.all([r.markPaid(webhookConfirm), r.markPaid(payerReturn)]);
      expect(r.transitions).toEqual(['s1:pending->paid']);
      expect(r.userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // A cancel or expiry report that lands AFTER the payment never takes it back, and neither does
    // the expiry job: both move only a `pending` row.
    it.each(['cancel', 'expire'])(
      'a %s callback after the payment leaves it paid',
      async (_outcome) => {
        const r = makeRoutes();
        await r.markPaid(webhookConfirm);
        await r.cancelPending({ requestId: '1001' });
        await r.markPaid(payerReturn);
        r.advance(10 * HOLD_MS);
        await r.service.expireStalePendingPayments();
        expect(r.rows[0].paymentStatus).toBe('paid');
        expect(r.transitions).toEqual(['s1:pending->paid']);
        expect(r.userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      }
    );

    it('a cancel landing in the middle of the two confirmations changes nothing', async () => {
      const r = makeRoutes();
      await Promise.all([
        r.markPaid(webhookConfirm),
        r.cancelPending({ requestId: '1001' }),
        r.markPaid(payerReturn),
      ]);
      // Whichever took the row lock first, a payment is never undone: either the cancel lost the
      // race to a `paid`, or it won and the payment then lands on `cancelled` as a late payment.
      // The form has room either way, so both orders end `paid`.
      expect(r.rows[0].paymentStatus).toBe('paid');
      expect(r.userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // The request expired first (its callback cancels the row), then the payer's money lands
    // anyway: decided from the row, once, and over capacity when the seat went meanwhile.
    it('a payment after its own expiry is decided from the row, once', async () => {
      const r = makeRoutes({}, 1, [row({ id: 'other', paymentStatus: 'pending', userId: 'u2' })]);
      await r.cancelPending({ requestId: '1001' });
      r.rows[1].paymentStatus = 'paid';
      await r.markPaid(webhookConfirm);
      await r.markPaid(payerReturn);
      expect(r.rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(r.transitions).toEqual(['s1:pending->cancelled', 's1:cancelled->paid_over_capacity']);
      expect(r.userTagService.grantCotisant).not.toHaveBeenCalled();
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('overCapacityFirst', () => {
    it('puts the rows owed a refund on top and keeps the order within each half', () => {
      const ordered = overCapacityFirst([
        { id: '1', paymentStatus: 'paid' },
        { id: '2', paymentStatus: 'paid_over_capacity' },
        { id: '3', paymentStatus: 'expired' },
        { id: '4', paymentStatus: 'paid_over_capacity' },
      ]);
      expect(ordered.map((r) => r.id)).toEqual(['2', '4', '1', '3']);
    });
  });
});
