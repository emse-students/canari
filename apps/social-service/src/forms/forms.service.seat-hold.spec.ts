import { BadRequestException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import {
  PENDING_HOLD_CUTOFF_SQL,
  PENDING_PAYMENT_HOLD_SECONDS,
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
    stripeSessionId?: string;
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
              Object.assign(byId(row.id), row);
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
    // Payments are DISABLED, so a paid submit stops right after its transaction committed: these
    // tests are about what the transaction wrote, not about the checkout.
    const associationsService: any = {
      assertPaymentsReady: jest.fn(async () => undefined),
      getPaymentAccountId: jest.fn(async () => 'vendor'),
      getActivePaymentProvider: jest.fn(async () => 'disabled'),
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      associationsService,
      userTagService as any,
      purchaseRecordService as any,
      pricingFacts,
      {} as any
    );
    return {
      service,
      rows,
      userTagService,
      purchaseRecordService,
      advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    };
  }

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
        rows: [row({ id: 'mine', paymentRequestedAt: ago(HOLD_MS - 60_000) })],
      });
      await expect(
        service.submit('f1', { userId: 'u1', answers: {} } as any)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rows).toHaveLength(1);
      expect(rows[0].paymentRequestedAt).toEqual(T0);
      // Past the ORIGINAL hold, still inside the new one: the seat is still held.
      advance(2 * 60_000);
      expect((await service.get('f1')).submissionCount).toBe(1);
    });

    it('leaves a pending row past the hold alone and writes a new one', async () => {
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
        ['new1', 'pending'],
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
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid');
      expect(rows[0].stripeSessionId).toBe('req-1');
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
          row({ id: 'other', paymentStatus: 'paid' }),
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
          row({ id: 'other', paymentStatus: 'paid' }),
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
          row({ id: 'b', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      await Promise.all([service.markPaid('a'), service.markPaid('b')]);
      const statuses = rows.slice(0, 2).map((r) => r.paymentStatus);
      expect(statuses.sort()).toEqual(['paid', 'paid_over_capacity']);
    });
  });

  describe('a replayed payment', () => {
    // The Lydia callback and the payer's verify-session both reach markPaid for one payment.
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
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
    });

    // ONE payment reaches markPaid under TWO ids: the Lydia callback carries its `request_id`, the
    // payer's verify-session the `request_uuid` `submit` stored. Neither order may leave the row
    // unpaid, accuse anybody, or fulfil twice - whichever id is stored when the other one arrives.
    it.each([
      ['the callback first, then verify-session', ['124', 'uuid-1']],
      ['verify-session first, then the callback', ['uuid-1', '124']],
    ])('pays once whatever the id: %s', async (_order, [first, second]) => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({
            id: 's1',
            paymentStatus: 'pending',
            paymentRequestedAt: ago(1000),
            stripeSessionId: 'uuid-1',
          }),
        ],
      });
      const warn = jest.spyOn((service as any).logger, 'warn');
      await service.markPaid('s1', first);
      expect(rows[0].paymentStatus).toBe('paid');
      await service.markPaid('s1', second);
      expect(rows[0].paymentStatus).toBe('paid');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('a cancel callback', () => {
    // The status check and the write are one locked step: a cancel never overwrites a payment.
    it('cancels a pending row and leaves a paid one alone', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentStatus: 'pending' }), row({ id: 'q', paymentStatus: 'paid' })],
      });
      await service.cancelPendingSubmission('p');
      await service.cancelPendingSubmission('q');
      expect(rows.map((r) => r.paymentStatus)).toEqual(['cancelled', 'paid']);
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
