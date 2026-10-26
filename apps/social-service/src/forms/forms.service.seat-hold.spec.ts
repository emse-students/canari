import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { CONFIRM_PAYMENT_PER_MINUTE, FormsController } from './forms.controller';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import axios from 'axios';
import { FindOperator } from 'typeorm';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { guestReference, hashGuestReceipt } from './guest-receipt';
import { GUEST_PENDING_CEILING, GUEST_PENDING_LIMIT, guestVisitorKey } from './guest-visitor';
import { InternalFormsController } from '../internal/internal-forms.controller';
import {
  PENDING_HOLD_CUTOFF_SQL,
  PAYMENT_REQUEST_LIFETIME_SECONDS,
  PENDING_PAYMENT_HOLD_SECONDS,
  PREVIOUS_PAYMENT_OPEN,
  ALREADY_ANSWERED,
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
  /** A Lydia `request_uuid`: 32 hex digits, no dash (measured on the sandbox). */
  const LYDIA_UUID = '00112233445566778899aabbccddeeff';
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
    organiserNotifiedAt?: Date | null;
    guestReceiptHash?: string | null;
    guestVisitorKey?: string | null;
    answers?: Record<string, unknown>;
  };
  type Flag = 'cotisationGrantedAt' | 'purchaseRecordedAt' | 'organiserNotifiedAt';

  function makeStore(opts: {
    maxSubmissions: number | null;
    rows: Row[];
    basePrice?: number;
    allowMultipleSubmissions?: boolean;
    /** `lydia` reaches the fake core below; `disabled` stops a paid submit after its transaction. */
    provider?: 'lydia' | 'disabled';
    /** The organiser alert switched on (it ships off: `FORM_ORGANISER_ALERT_ENABLED`). */
    organiserAlert?: boolean;
    /** A public form, answered by guests (WP-P1); default false. */
    isPublic?: boolean;
    allowCashPayment?: boolean;
    /** Default true: most rows here are members whose payment grants a cotisation. */
    grantsCotisation?: boolean;
  }) {
    let now = T0;
    const rows: Row[] = opts.rows.map((row) => ({ ...row }));
    let nextId = 0;
    const form = {
      id: 'f1',
      title: 'Gala',
      maxSubmissions: opts.maxSubmissions,
      associationId: 'asso1',
      grantsCotisation: opts.grantsCotisation ?? true,
      cotisationVariantKey: null,
      basePrice: opts.basePrice ?? 0,
      priceMatrix: null,
      submitCondition: null,
      anonymous: false,
      isPublic: opts.isPublic ?? false,
      allowMultipleSubmissions: opts.allowMultipleSubmissions ?? false,
      allowCashPayment: opts.allowCashPayment ?? false,
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
    // The alert service's own behaviour (who, what) is its spec's and the integration spec's; here
    // it is the AT MOST ONCE around it, so `tell` yields like a round trip and records its form.
    const organiserAlert = {
      enabled: jest.fn(() => opts.organiserAlert ?? false),
      tell: jest.fn(async (_form: { id: string; title: string | null; ownerId: string }) => {
        await roundTrip();
      }),
    };
    const userTagService = {
      grantCotisantIfARise: jest.fn(() => Promise.resolve({ granted: {} })),
    };

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
      find: jest.fn(
        async ({ where, order }: { where: Record<string, unknown>[]; order?: object }) => {
          expect(order).toEqual({ createdAt: 'DESC' });
          return rows
            .filter((r) => matches(r, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((r) => ({ ...r }));
        }
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
        find: jest.fn(async (_entity: unknown, { where }: { where: Record<string, unknown>[] }) =>
          rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))
        ),
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
            find: async (_entity: unknown, { where }: { where: Record<string, unknown>[] }) => {
              await roundTrip();
              return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
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
      // The account the form's money is paid into, whatever provider is active: what a verified
      // callback's Business must be (`isCallbackPayee`).
      getLydiaPayeeAccountId: jest.fn(async () => 'vendor'),
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
      stateAnswer: 'cancelled-or-expired' as
        | 'cancelled-or-expired'
        | 'paid'
        | 'open'
        | 'declined'
        | 'unknown'
        /** What an OLDER core answered for 6, before the state was typed: a wire mismatch. */
        | 'closed'
        | Error,
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
        // core-service classifies Lydia's code (`CheckoutRequestStateKind`) and passes it along.
        const raw = {
          paid: '1',
          'cancelled-or-expired': '6',
          open: '0',
          declined: '5',
          unknown: '9',
          closed: '6',
        }[core.stateAnswer];
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
      {} as any,
      organiserAlert as any
    );
    return {
      service,
      rows,
      userTagService,
      purchaseRecordService,
      organiserAlert,
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
    organiserNotifiedAt: null,
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

    // A total outside the provider range is the SAME typed refusal core would answer (code +
    // bounds, which the payer's page words), refused before core, logged, and releasing the seat.
    it.each([49, 100_001])(
      'refuses a %i-cent total typed with the bounds, calls no core, and releases the row',
      async (cents) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: 1,
          basePrice: cents,
          provider: 'lydia',
          rows: [],
        });
        const warn = jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => undefined);
        const err = await service
          .submit('f1', { userId: 'u1', answers: {} } as any)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'AMOUNT_OUT_OF_RANGE',
          minCents: 50,
          maxCents: 100_000,
        });
        expect(core.calls).toHaveLength(0);
        expect(rows.map((r) => [r.id, r.paymentStatus])).toEqual([['new1', 'cancelled']]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`total=${cents} cents`));
      }
    );

    it('says payments are disabled, not a range, when both are true', async () => {
      const { service, rows, core } = makeStore({ maxSubmissions: 1, basePrice: 49, rows: [] });
      const err = await service
        .submit('f1', { userId: 'u1', answers: {} } as any)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).not.toMatchObject({
        code: 'AMOUNT_OUT_OF_RANGE',
      });
      expect(core.calls).toHaveLength(0);
      expect(rows.map((r) => [r.id, r.paymentStatus])).toEqual([['new1', 'cancelled']]);
    });

    it.each([50, 100_000])(
      'CONTROL: a %i-cent total, on a bound, issues its request',
      async (cents) => {
        const { service, core } = makeStore({
          maxSubmissions: 1,
          basePrice: cents,
          provider: 'lydia',
          rows: [],
        });
        const result = await service.submit('f1', { userId: 'u1', answers: {} } as any);
        expect(result).toMatchObject({ checkoutUrl: 'https://lydia.example/pay/1' });
        expect(core.calls.map((c) => c.route)).toEqual(['create-checkout-session']);
      }
    );
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
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

  /**
   * THE ORGANISER ALERT (migration 102): a payment that landed on a FULL form tells the form's
   * managers AT MOST ONCE, from the row's `organiserNotifiedAt` - never a clock, and nothing claimed
   * while the alert is switched off.
   */
  describe('the organiser alert for a payment over capacity', () => {
    const full = () => [
      row({ id: 'late', paymentStatus: 'expired', paymentRequestedAt: ago(2 * HOLD_MS) }),
      row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
    ];

    it('tells nobody and claims nothing while it is switched off, as it ships', async () => {
      const { service, rows, organiserAlert } = makeStore({ maxSubmissions: 1, rows: full() });
      await service.markPaid('late', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(organiserAlert.tell).not.toHaveBeenCalled();
      expect(rows[0].organiserNotifiedAt).toBeNull();
    });

    it('tells the managers once, naming the form, and marks the row', async () => {
      const { service, rows, organiserAlert } = makeStore({
        maxSubmissions: 1,
        rows: full(),
        organiserAlert: true,
      });
      await service.markPaid('late', 'req-1');
      expect(organiserAlert.tell).toHaveBeenCalledTimes(1);
      expect(organiserAlert.tell).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f1', title: 'Gala' })
      );
      expect(rows[0].organiserNotifiedAt).toBeTruthy();
    });

    it('tells nobody again on a replay, one after the other or at once', async () => {
      const { service, organiserAlert } = makeStore({
        maxSubmissions: 1,
        rows: full(),
        organiserAlert: true,
      });
      await service.markPaid('late', 'req-1');
      await service.markPaid('late', 'req-1');
      await Promise.all([service.markPaid('late', 'req-1'), service.markPaid('late', 'req-1')]);
      expect(organiserAlert.tell).toHaveBeenCalledTimes(1);
    });

    it('tells once when the callback and the return settle the same row at once', async () => {
      const { service, organiserAlert } = makeStore({
        maxSubmissions: 1,
        rows: full(),
        organiserAlert: true,
      });
      await Promise.all([service.markPaid('late', 'req-1'), service.markPaid('late', 'req-1')]);
      expect(organiserAlert.tell).toHaveBeenCalledTimes(1);
    });

    it('releases the claim when the notice could not be written, and the next replay tells', async () => {
      const { service, rows, organiserAlert } = makeStore({
        maxSubmissions: 1,
        rows: full(),
        organiserAlert: true,
      });
      organiserAlert.tell.mockRejectedValueOnce(new Error('insert failed'));
      const error = jest.spyOn((service as any).logger, 'error');
      await service.markPaid('late', 'req-1');
      expect(rows[0].organiserNotifiedAt).toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('released for the next replay'),
        expect.any(Error)
      );
      await service.markPaid('late', 'req-1');
      expect(organiserAlert.tell).toHaveBeenCalledTimes(2);
      expect(rows[0].organiserNotifiedAt).toBeTruthy();
    });

    it('tells nobody about a payment that took a seat', async () => {
      const { service, rows, organiserAlert } = makeStore({
        maxSubmissions: 2,
        rows: full(),
        organiserAlert: true,
      });
      await service.markPaid('late', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid');
      expect(organiserAlert.tell).not.toHaveBeenCalled();
      expect(rows[0].organiserNotifiedAt).toBeNull();
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // The effects run after the commit; the flag is what lets the next replay finish them.
    it('retries a grant that failed, and only that', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'pending', paymentRequestedAt: ago(1000) })],
      });
      userTagService.grantCotisantIfARise.mockRejectedValueOnce(new Error('core-service down'));
      await service.markPaid('s1', 'req-1');
      expect(rows[0].cotisationGrantedAt).toBeNull();
      await service.markPaid('s1', 'req-1');
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(2);
      expect(rows[0].cotisationGrantedAt).toBeTruthy();
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('finishes a payment whose effects never ran (a crash after the commit)', async () => {
      const { service, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 's1', paymentStatus: 'paid', stripeSessionId: 'req-1' })],
      });
      await service.markPaid('s1', 'req-1');
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
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
    const OTHER_UUID = 'ffeeddccbbaa99887766554433221100';

    // The status check and the write are one locked step: a cancel never overwrites a payment.
    it.each(['cancelled-or-expired', 'declined'] as const)(
      'cancels a pending row Lydia reads %s, and leaves a paid one alone',
      async (state) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: 1,
          rows: [
            row({
              id: 'p',
              paymentStatus: 'pending',
              paymentRequestId: '1',
              stripeSessionId: LYDIA_UUID,
            }),
            row({
              id: 'q',
              paymentStatus: 'paid',
              paymentRequestId: '2',
              stripeSessionId: OTHER_UUID,
            }),
          ],
        });
        core.stateAnswer = state;
        await expect(
          service.cancelPendingSubmission('p', { requestId: '1' }, 'vendor')
        ).resolves.toEqual({ ok: true, outcome: state });
        await service.cancelPendingSubmission('q', { requestId: '2' }, 'vendor');
        expect(rows.map((r) => r.paymentStatus)).toEqual(['cancelled', 'paid']);
      }
    );

    // Fails without the comparison: after a retry, the cancel of the OLD request would cancel the
    // answer whose NEW request the payer is paying right now.
    it('applies only to the request the row is waiting on, by either id', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '600', stripeSessionId: LYDIA_UUID })],
      });
      await service.cancelPendingSubmission('p', { requestId: '555' }, 'vendor');
      await service.cancelPendingSubmission('p', { sessionId: OTHER_UUID }, 'vendor');
      expect(rows[0].paymentStatus).toBe('pending');
      // A report about another request is not even read at Lydia.
      expect(core.calls).toEqual([]);
      await service.cancelPendingSubmission('p', { sessionId: LYDIA_UUID }, 'vendor');
      expect(rows[0].paymentStatus).toBe('cancelled');
    });

    it('refuses a report naming no request, and leaves a row with no stored id alone', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: null, stripeSessionId: null })],
      });
      await expect(service.cancelPendingSubmission('p', {}, 'vendor')).rejects.toBeInstanceOf(
        BadRequestException
      );
      await service.cancelPendingSubmission('p', { requestId: '555' }, 'vendor');
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // THE CALLBACK IS A TRIGGER FOR A CANCEL TOO. A signed cancel proves only that the Business's
    // key signed it, and that key is whatever its payout manager typed: a forged cancel for a
    // request Lydia still holds open must not release the seat. Fails if `cancel-pending` cancels
    // on the callback's word.
    it.each([
      ['still open', 'open', 'open'],
      ['in an unmeasured state', 'unknown', 'unknown'],
      // An older core's `closed` mid-deploy is a word this service does not know: never a release.
      ['with a word this service does not know', 'closed', 'unknown'],
    ] as const)('keeps the seat of a request Lydia reads %s', async (_label, state, outcome) => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '1', stripeSessionId: LYDIA_UUID })],
      });
      core.stateAnswer = state;
      await expect(
        service.cancelPendingSubmission('p', { requestId: '1' }, 'vendor')
      ).resolves.toEqual({ ok: true, outcome });
      expect(rows[0].paymentStatus).toBe('pending');
      // It read the ROW's own request, with the verified Business.
      expect(core.calls.map((c) => [c.route, c.body])).toEqual([
        ['request-state', { sessionId: LYDIA_UUID, connectAccountId: 'vendor' }],
      ]);
    });

    it('records the payment instead of cancelling when Lydia reads the request paid', async () => {
      const { service, rows, core, userTagService } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '1', stripeSessionId: LYDIA_UUID })],
      });
      core.stateAnswer = 'paid';
      await expect(
        service.cancelPendingSubmission('p', { requestId: '1' }, 'vendor')
      ).resolves.toEqual({ ok: true, outcome: 'paid' });
      expect(rows[0].paymentStatus).toBe('paid');
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
    });

    // A failed read is not a verdict: the seat is kept and core answers Lydia a retryable 503.
    it('keeps the seat and answers unreadable when the state read fails', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '1', stripeSessionId: LYDIA_UUID })],
      });
      core.stateAnswer = new Error('timeout');
      await expect(
        service.cancelPendingSubmission('p', { requestId: '1' }, 'vendor')
      ).resolves.toEqual({ ok: false, outcome: 'unreadable' });
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // The read happens outside the row lock: a retry that replaced the request meanwhile keeps
    // its row, because the cancel re-checks under the lock that the row still names what was read.
    it('cancels nothing when a retry replaced the request during the read', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'p', paymentRequestId: '1', stripeSessionId: LYDIA_UUID })],
      });
      core.duringState = () => {
        rows[0].paymentRequestId = '2';
        rows[0].stripeSessionId = OTHER_UUID;
      };
      await service.cancelPendingSubmission('p', { requestId: '1' }, 'vendor');
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      // A code core has not measured is never read as settled, nor as paid.
      ['the state is unknown', { cancelAnswer: 'already-settled', stateAnswer: 'unknown' }],
      // An older core's `closed` during a deploy: a word this service no longer knows is refused.
      [
        'core answers a word it does not know',
        { cancelAnswer: 'already-settled', stateAnswer: 'closed' },
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

    // P1-a (2026-10-21): a payer who DECLINED on Lydia's page (state 5) retries. It used to read as
    // an unmeasured `other` and answer 409 PREVIOUS_PAYMENT_OPEN for up to 30 minutes. Control:
    // with `declined` left out of SETTLED_REFUSED_REQUEST_STATES this test fails on the 409.
    it('settles a DECLINED old request and issues the new one on a retry', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'declined';
      await expect(retry(service)).resolves.toMatchObject({
        checkoutUrl: 'https://lydia.example/pay/1',
      });
      expect(core.calls.map((c) => c.route)).toEqual([
        'cancel-request',
        'request-state',
        'create-checkout-session',
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', stripeSessionId: 'uuid-1' });
    });

    // P1-b (2026-10-21): a submit after a PAID answer issued a new request/do, and a second paid
    // purchase was recorded for one answer. Control: with BOTH ALREADY_ANSWERED checks removed from
    // `submit`, these fail on the request issued and the second row written.
    it.each([['paid'], ['paid_over_capacity'], ['free'], ['pending_cash']])(
      'refuses a second submit once a %s answer exists, issuing NO request',
      async (status) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: null,
          basePrice: 1500,
          provider: 'lydia',
          rows: [mine({ paymentStatus: status })],
        });
        const log = jest.spyOn((service as any).logger, 'log');
        const refusal = await retry(service).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(ConflictException);
        expect((refusal as ConflictException).getResponse()).toMatchObject({
          code: ALREADY_ANSWERED,
        });
        expect(core.calls).toEqual([]);
        expect(rows).toHaveLength(1);
        expect(rows[0].paymentStatus).toBe(status);
        // Expected (a second tab), so INFO and not an accusation.
        expect(log).toHaveBeenCalledWith(expect.stringContaining('already answers'));
      }
    );

    // Control for the guard: a released answer (declined / cancelled / expired request) is no
    // answer, and a live pending row is the one a retry reuses - both still go through.
    it.each([['cancelled'], ['expired']])(
      'still lets the person answer again after a %s answer',
      async (status) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: null,
          basePrice: 1500,
          provider: 'lydia',
          rows: [mine({ paymentStatus: status })],
        });
        await expect(retry(service)).resolves.toMatchObject({
          checkoutUrl: 'https://lydia.example/pay/1',
        });
        expect(core.calls.map((c) => c.route)).toEqual(['create-checkout-session']);
        expect(rows).toHaveLength(2);
      }
    );

    it('still reuses the live pending row on a retry, and a first submit still issues', async () => {
      const first = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        provider: 'lydia',
        rows: [],
      });
      await expect(retry(first.service)).resolves.toMatchObject({
        checkoutUrl: 'https://lydia.example/pay/1',
      });
      const { service, rows, core } = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      await expect(retry(service)).resolves.toMatchObject({
        checkoutUrl: 'https://lydia.example/pay/1',
      });
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request', 'create-checkout-session']);
      expect(rows).toHaveLength(1);
    });

    it('lets a multiple-answer form take a second paid answer', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        provider: 'lydia',
        allowMultipleSubmissions: true,
        rows: [mine({ paymentStatus: 'paid' })],
      });
      await expect(retry(service)).resolves.toMatchObject({ checkoutUrl: expect.any(String) });
      expect(rows).toHaveLength(2);
    });

    // Review of #2215: an OLDER paid answer hidden behind a NEWER live pending row. The guard read
    // the newest row only, saw the reused one and let a second request out. Order-independent:
    // both insertion orders, and the refusal comes BEFORE the settle cancels anything at Lydia.
    it.each([['paid first'], ['pending first']])(
      'refuses a retry on a live pending row while an older paid answer exists (%s)',
      async (order) => {
        const paid = row({
          id: 'old-paid',
          paymentStatus: 'paid_over_capacity',
          createdAt: ago(3_600_000),
        });
        const live = mine({ createdAt: ago(60_000) });
        const { service, rows, core } = makeStore({
          maxSubmissions: null,
          basePrice: 1500,
          provider: 'lydia',
          rows: order === 'paid first' ? [paid, live] : [live, paid],
        });
        const refusal = await retry(service).catch((e: unknown) => e);
        expect((refusal as ConflictException).getResponse()).toMatchObject({
          code: ALREADY_ANSWERED,
        });
        expect(core.calls).toEqual([]);
        expect(rows.find((r) => r.id === 'mine')).toMatchObject({
          paymentStatus: 'pending',
          stripeSessionId: 'uuid-old',
        });
      }
    );

    // The guard UNDER THE LOCK is the authoritative one: two submits of the same person in parallel
    // both pass the early guard (neither row exists yet) and queue on the form lock. A FREE form
    // has no live pending row for the second to trip on, so only the lock-held check stops it from
    // inserting a second answer. Control: with that check removed, two `free` rows are written.
    it('refuses the second of two simultaneous answers by the same person, under the lock', async () => {
      const { service, rows } = makeStore({ maxSubmissions: null, rows: [] });
      const results = await Promise.allSettled([retry(service), retry(service)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refusal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((refusal.reason as ConflictException).getResponse()).toMatchObject({
        code: ALREADY_ANSWERED,
      });
      expect(rows.map((r) => r.paymentStatus)).toEqual(['free']);
    });

    // Review of #2215: a legacy OLDER paid row behind a NEWER live pending one. The page took the
    // newest and showed "pending", offering a retry the guard refuses with ALREADY_ANSWERED.
    // Control: with the newest row picked again, both orders show `pending`.
    it.each([['paid'], ['paid_over_capacity'], ['free']])(
      'shows an older %s answer over a newer live pending row, in either insertion order',
      async (status) => {
        const settled = row({ id: 'old', paymentStatus: status, createdAt: ago(3_600_000) });
        const live = mine({ createdAt: ago(60_000) });
        for (const rows of [
          [settled, live],
          [live, settled],
        ]) {
          const { service } = makeStore({ maxSubmissions: null, basePrice: 1500, rows });
          // `submissionId` is the SHOWN row's: the page asks `confirm-payment` about it, so a
          // newest-row id beside an older row's status would poll the wrong answer.
          await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
            hasSubmitted: true,
            paymentStatus: status,
            submissionId: 'old',
          });
        }
      }
    );

    it('shows the live pending row when it is the only answer', async () => {
      const { service } = makeStore({ maxSubmissions: null, basePrice: 1500, rows: [mine()] });
      await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
        hasSubmitted: true,
        paymentStatus: 'pending',
        submissionId: 'mine',
      });
    });

    // The page reads the same predicate as the guard: a paid-over-capacity answer is answered.
    it('shows a paid-over-capacity answer as answered, as the guard refuses it', async () => {
      const { service } = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        rows: [mine({ paymentStatus: 'paid_over_capacity' })],
      });
      await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
        hasSubmitted: true,
        paymentStatus: 'paid_over_capacity',
      });
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
        // A real request uuid: the cancel callback reads it at Lydia (expired) before it cancels.
        rows: [mine({ stripeSessionId: LYDIA_UUID })],
      });
      core.duringCancel = () =>
        service.cancelPendingSubmission('mine', { requestId: '555' }, 'vendor');
      await retry(service);
      await service.cancelPendingSubmission('mine', { requestId: '555' }, 'vendor');
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
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
      expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(UUID_NEW));
    });

    it.each([
      ['still open', 'open'],
      // A code core has not measured is never read as paid, nor as settled.
      ['in an unknown state', 'unknown'],
      // An older core's word for 6, mid-deploy: unknown here, so nothing is released.
      ['answered with a word this service does not know', 'closed'],
    ] as const)('leaves the row pending when the request is %s', async (_label, state) => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        rows: [mine()],
      });
      core.stateAnswer = state;
      await expect(service.confirmPayment('mine')).resolves.toMatchObject({
        paymentStatus: 'pending',
        requestState: state === 'open' ? 'open' : 'unknown',
      });
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // P1-a (2026-10-21): a decline sends NO callback and ends on Lydia's own page, so the payer's
    // next read is the only thing that can release the answer. It used to stay `pending` (no retry)
    // until the hold ended. Control: with `releaseSettledRefusedRow` not called, the status
    // assertion fails on `pending` (the unfixed behaviour).
    it.each([['declined'], ['cancelled-or-expired']] as const)(
      'releases the answer when the request is %s, and a retry then issues a new request',
      async (state) => {
        const { service, rows, core, userTagService } = makeStore({
          maxSubmissions: 1,
          basePrice: 1500,
          provider: 'lydia',
          rows: [mine()],
        });
        core.stateAnswer = state;
        await expect(service.confirmPayment('mine')).resolves.toMatchObject({
          id: 'mine',
          paymentStatus: 'cancelled',
          requestState: state,
        });
        expect(rows[0].paymentStatus).toBe('cancelled');
        expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
        // The released row holds no seat and is not reused: the retry writes a new answer and
        // issues ONE request, with no cancel of the dead one.
        core.calls.length = 0;
        await expect(
          service.submit('f1', { userId: 'u1', answers: {} } as any)
        ).resolves.toMatchObject({
          checkoutUrl: 'https://lydia.example/pay/1',
        });
        expect(core.calls.map((c) => c.route)).toEqual(['create-checkout-session']);
        expect(rows.filter((r) => r.paymentStatus === 'pending')).toHaveLength(1);
      }
    );

    // Review of #2210: the stale state must not be ANSWERED either - "declined, try again" while
    // the newer request is payable would offer a retry that cancels it. Control: answering the
    // state read unconditionally fails the `requestState` assertion.
    it.each([['declined'], ['cancelled-or-expired'], ['open']] as const)(
      'releases nothing and answers no state when a retry replaced the %s request meanwhile',
      async (state) => {
        const { service, rows, core } = makeStore({
          maxSubmissions: 1,
          provider: 'lydia',
          rows: [mine()],
        });
        core.stateAnswer = state;
        core.duringState = () => {
          rows[0].stripeSessionId = UUID_NEW;
          rows[0].paymentRequestId = '777';
        };
        const answer = await service.confirmPayment('mine');
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending', stripeSessionId: UUID_NEW });
        expect(answer.paymentStatus).toBe('pending');
        expect(answer.requestState).toBeUndefined();
      }
    );

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
   * THE TWO CONFIRMATIONS OF ONE PAYMENT, THROUGH THE ROUTES THEY REACH. A Lydia confirm callback,
   * verified by core-service with the association's Business key, posts `{ vendorToken, requestId }`
   * to `provider-confirm` (webhook.controller.ts); the payer's return calls `confirmPayment`. BOTH
   * read the row's own request at Lydia and record it only if Lydia answers paid - the callback is a
   * trigger, never the payment - so a payment reaches `markPaid` once or twice, in either order. A
   * cancel or expire callback posts `{ requestId, vendorToken }` to `cancel-pending`.
   */
  describe('through the internal routes, in either order', () => {
    const SECRET = 'internal-secret-for-test';

    function makeRoutes(over: Partial<Row> = {}, maxSubmissions = 1, others: Row[] = []) {
      process.env.INTERNAL_SECRET = SECRET;
      const store = makeStore({
        maxSubmissions,
        rows: [
          row({
            id: 's1',
            paymentRequestedAt: ago(60_000),
            paymentRequestId: '1001',
            stripeSessionId: LYDIA_UUID,
            ...over,
          }),
          ...others,
        ],
      });
      store.core.stateAnswer = 'paid';
      const routes = new InternalFormsController(store.service);
      return {
        ...store,
        routes,
        callback: (vendorToken = 'vendor', requestId = '1001') =>
          routes.providerConfirm('s1', SECRET, { vendorToken, requestId }),
        payerReturn: () => store.service.confirmPayment('s1'),
        cancelPending: (body: { requestId: string; vendorToken?: string }) =>
          routes.cancelPending('s1', SECRET, { vendorToken: 'vendor', ...body }),
      };
    }

    it.each([
      ['the callback, then the payer return', ['callback', 'payerReturn'] as const],
      ['the payer return, then the callback', ['payerReturn', 'callback'] as const],
    ])('%s: one transition, one grant, one purchase', async (_order, steps) => {
      const r = makeRoutes();
      const warn = jest.spyOn((r.service as any).logger, 'warn');
      for (const step of steps) await r[step]();
      expect(r.rows[0].paymentStatus).toBe('paid');
      expect(r.transitions).toEqual(['s1:pending->paid']);
      expect(r.userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('both at once: one transition, one grant, one purchase', async () => {
      const r = makeRoutes();
      await Promise.all([r.callback(), r.payerReturn()]);
      expect(r.transitions).toEqual(['s1:pending->paid']);
      expect(r.userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // THE CALLBACK IS A TRIGGER: a verified confirm on a request Lydia does not answer `paid` for
    // records nothing. Fails if `provider-confirm` marks the row paid on the callback's word.
    it('a verified callback records nothing while Lydia does not answer paid for the row', async () => {
      const r = makeRoutes();
      r.core.stateAnswer = 'open';
      const { outcome } = await r.callback();
      expect(outcome).toBe('open');
      expect(r.rows[0].paymentStatus).toBe('pending');
      expect(r.purchaseRecordService.create).not.toHaveBeenCalled();
      // It read the ROW's own request, with the verified Business - nothing of the callback's.
      const read = r.core.calls.find((c) => c.route === 'request-state');
      expect(read?.body).toEqual({ sessionId: LYDIA_UUID, connectAccountId: 'vendor' });
    });

    // CROSS-ASSOCIATION: association A's genuine callback naming a submission of association B
    // (whose form pays into 'vendor') never settles it - not even a read is made with A's Business.
    it('refuses a callback verified for another Business than the row payee', async () => {
      const r = makeRoutes();
      const error = jest.spyOn((r.service as any).logger, 'error');
      const { outcome } = await r.callback('vendor-of-association-a');
      expect(outcome).toBe('other-account');
      expect(r.rows[0].paymentStatus).toBe('pending');
      expect(r.core.calls.filter((c) => c.route === 'request-state')).toHaveLength(0);
      expect(error.mock.calls.some(([line]) => /REFUSED/.test(String(line)))).toBe(true);
    });

    it('refuses a cancel verified for another Business, and a report naming none', async () => {
      const r = makeRoutes();
      await r.cancelPending({ requestId: '1001', vendorToken: 'vendor-of-association-a' });
      expect(r.rows[0].paymentStatus).toBe('pending');
      expect(() => r.routes.cancelPending('s1', SECRET, { requestId: '1001' })).toThrow(
        BadRequestException
      );
      expect(() => r.routes.providerConfirm('s1', SECRET, { requestId: '1001' })).toThrow(
        BadRequestException
      );
      expect(r.rows[0].paymentStatus).toBe('pending');
    });

    it('refuses a caller without the internal secret', () => {
      const r = makeRoutes();
      expect(() =>
        r.routes.providerConfirm('s1', 'wrong', { vendorToken: 'vendor', requestId: '1001' })
      ).toThrow(ForbiddenException);
    });

    // A cancel or expiry report that lands AFTER the payment never takes it back, and neither does
    // the expiry job: both move only a `pending` row.
    it.each(['cancel', 'expire'])(
      'a %s callback after the payment leaves it paid',
      async (_outcome) => {
        const r = makeRoutes();
        await r.callback();
        await r.cancelPending({ requestId: '1001' });
        await r.payerReturn();
        r.advance(10 * HOLD_MS);
        await r.service.expireStalePendingPayments();
        expect(r.rows[0].paymentStatus).toBe('paid');
        expect(r.transitions).toEqual(['s1:pending->paid']);
        expect(r.userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
      }
    );

    it('a cancel landing in the middle of the two confirmations changes nothing', async () => {
      const r = makeRoutes();
      await Promise.all([r.callback(), r.cancelPending({ requestId: '1001' }), r.payerReturn()]);
      // Whichever took the row lock first, a payment is never undone: either the cancel lost the
      // race to a `paid`, or it won and the payment then lands on `cancelled` as a late payment.
      // The form has room either way, so both orders end `paid`.
      expect(r.rows[0].paymentStatus).toBe('paid');
      expect(r.userTagService.grantCotisantIfARise).toHaveBeenCalledTimes(1);
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    // The request expired first (its callback cancels the row), then the payer's money lands
    // anyway: decided from the row, once, and over capacity when the seat went meanwhile.
    it('a payment after its own expiry is decided from the row, once', async () => {
      const r = makeRoutes({}, 1, [row({ id: 'other', paymentStatus: 'pending', userId: 'u2' })]);
      // Lydia reads the request expired when the expiry callback lands, paid once the money did.
      r.core.stateAnswer = 'cancelled-or-expired';
      await r.cancelPending({ requestId: '1001' });
      r.core.stateAnswer = 'paid';
      r.rows[1].paymentStatus = 'paid';
      await r.callback();
      await r.payerReturn();
      expect(r.rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(r.transitions).toEqual(['s1:pending->cancelled', 's1:cancelled->paid_over_capacity']);
      expect(r.userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
      expect(r.purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });
  });

  // WP-P1 of `public-paid-forms-chantier.md`: a guest (a public form, no account) pays as a member
  // does - the same row, the same hold, the same settle - with `userId` NULL throughout.
  describe('a guest who pays (public form)', () => {
    /** The visitor's address, as `clientAddress` reads it: a guest's paid answer is counted on it. */
    const VISITOR = '203.0.113.7';
    const savedSecret = process.env.INTERNAL_SECRET;
    // The visitor key is an HMAC under the internal secret (`guest-visitor.ts`).
    beforeAll(() => (process.env.INTERNAL_SECRET = 'internal-secret-for-test'));
    afterAll(() => {
      if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = savedSecret;
    });
    const GUEST_UUID = 'abcdefabcdefabcdefabcdefabcdef01';
    const guestRow = (over: Partial<Row> = {}) =>
      row({
        id: 'guest',
        userId: null,
        paymentRequestedAt: ago(60_000),
        paymentRequestId: '777',
        stripeSessionId: GUEST_UUID,
        ...over,
      });

    it('writes a pending row with no account and issues the request to the address typed', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 5,
        rows: [],
        basePrice: 1500,
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
        grantsCotisation: false,
      });
      const result = await service.submit(
        'f1',
        // Whatever a caller passes, a guest names nobody: `userId` and `email` are dropped.
        { userId: 'forged', email: 'x@y.z', payerEmail: 'guest@example.org', answers: {} } as any,
        'guest',
        VISITOR
      );
      expect(result).toMatchObject({ checkoutUrl: 'https://lydia.example/pay/1' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: null,
        paymentStatus: 'pending',
        totalPaid: 1500,
        stripeSessionId: 'uuid-1',
        paymentRequestId: '1001',
      });
      expect(rows[0]).not.toHaveProperty('email', 'x@y.z');
      const [checkout] = core.calls;
      expect(checkout.route).toBe('create-checkout-session');
      expect(checkout.body).toMatchObject({
        payerEmail: 'guest@example.org',
        connectAccountId: 'vendor',
        expireAfterSeconds: PAYMENT_REQUEST_LIFETIME_SECONDS,
        metadata: { userId: '' },
      });
      // The server chooses where a guest comes back: the public form's receipt page, never
      // /forms/success - and the URL carries the receipt, of which the row keeps only the hash.
      const success = new URL(checkout.body.successUrl);
      expect(`${success.origin}${success.pathname}`).toBe('http://localhost/f/f1/receipt');
      expect([...success.searchParams.keys()]).toEqual(['receipt']);
      const receipt = success.searchParams.get('receipt')!;
      expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(checkout.body.cancelUrl).toBe(checkout.body.successUrl);
      expect(rows[0].guestReceiptHash).toBe(hashGuestReceipt(receipt));
      // Never the submission id: the receipt is the only key the page holds.
      expect(checkout.body.successUrl).not.toContain(rows[0].id);
    });

    it('mints a different receipt for every guest answer', async () => {
      const { service, core } = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        rows: [],
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
      });
      await service.submit('f1', { answers: {} } as any, 'guest', VISITOR);
      await service.submit('f1', { answers: {} } as any, 'guest', VISITOR);
      expect(core.calls[0].body.successUrl).not.toBe(core.calls[1].body.successUrl);
    });

    it('ignores a return URL a guest names', async () => {
      const { service, core } = makeStore({
        maxSubmissions: null,
        basePrice: 1500,
        rows: [],
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
      });
      await service.submit(
        'f1',
        { answers: {}, successUrl: 'http://localhost/forms/success?x=1' } as any,
        'guest',
        VISITOR
      );
      expect(core.calls[0].body.successUrl).toMatch(
        /^http:\/\/localhost\/f\/f1\/receipt\?receipt=/
      );
    });

    it('records cash owed by a guest as waiting for the organiser, with no account', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: null,
        basePrice: 800,
        rows: [],
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
        allowCashPayment: true,
      });
      const result = await service.submit(
        'f1',
        { answers: {}, paymentMethod: 'cash' } as any,
        'guest',
        VISITOR
      );
      expect(result).toEqual({
        submissionId: rows[0].id,
        cashPayment: true,
        reference: guestReference(rows[0].id),
      });
      expect(rows[0]).toMatchObject({ userId: null, paymentStatus: 'pending_cash' });
      // Cash never leaves the page: no receipt is minted for it.
      expect(rows[0].guestReceiptHash ?? null).toBeNull();
      expect(core.calls).toHaveLength(0);
    });

    it('lets two guests take the last seat ONCE', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        rows: [],
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
      });
      const results = await Promise.allSettled([
        service.submit('f1', { answers: {} } as any, 'guest', VISITOR),
        service.submit('f1', { answers: {} } as any, 'guest', VISITOR),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(rows.filter((r) => r.paymentStatus === 'pending')).toHaveLength(1);
    });

    describe('the ceiling of answers one visitor may leave waiting (PP5)', () => {
      const paidPublic = (over: Record<string, unknown> = {}) =>
        makeStore({
          maxSubmissions: null,
          basePrice: 1500,
          rows: [],
          provider: 'lydia',
          isPublic: true,
          allowMultipleSubmissions: true,
          allowCashPayment: true,
          ...over,
        });

      // Control (2026-10-22): the ceiling check removed from `submit` -> this test failed.
      it(`refuses the ${GUEST_PENDING_CEILING + 1}th waiting answer from one visitor, with its code, and issues nothing for it`, async () => {
        const { service, rows, core } = paidPublic();
        for (let i = 0; i < GUEST_PENDING_CEILING; i++) {
          await service.submit('f1', { answers: {} } as any, 'guest', VISITOR);
        }
        const err = await service
          .submit('f1', { answers: {} } as any, 'guest', VISITOR)
          .catch((e: HttpException) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(429);
        expect((err as HttpException).getResponse()).toMatchObject({ code: GUEST_PENDING_LIMIT });
        expect(rows).toHaveLength(GUEST_PENDING_CEILING);
        expect(core.calls).toHaveLength(GUEST_PENDING_CEILING);
        // Another visitor is another count.
        await expect(
          service.submit('f1', { answers: {} } as any, 'guest', '198.51.100.9')
        ).resolves.toMatchObject({ checkoutUrl: expect.any(String) });
      });

      it('counts a cash answer still waiting for the organiser', async () => {
        const { service, rows } = paidPublic();
        for (let i = 0; i < GUEST_PENDING_CEILING; i++) {
          await service.submit(
            'f1',
            { answers: {}, paymentMethod: 'cash' } as any,
            'guest',
            VISITOR
          );
        }
        await expect(
          service.submit('f1', { answers: {} } as any, 'guest', VISITOR)
        ).rejects.toBeInstanceOf(HttpException);
        expect(rows.map((r) => r.paymentStatus)).toEqual(
          Array(GUEST_PENDING_CEILING).fill('pending_cash')
        );
      });

      it('stores a keyed hash of the form and the address, never the address', async () => {
        const { service, rows } = paidPublic();
        await service.submit('f1', { answers: {} } as any, 'guest', VISITOR);
        expect(rows[0].guestVisitorKey).toBe(guestVisitorKey('f1', VISITOR));
        expect(rows[0].guestVisitorKey).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0].guestVisitorKey).not.toContain(VISITOR);
        expect(guestVisitorKey('f2', VISITOR)).not.toBe(rows[0].guestVisitorKey);
      });

      it('leaves a free guest answer uncounted and unkeyed', async () => {
        const { service, rows } = paidPublic({ basePrice: 0 });
        for (let i = 0; i < GUEST_PENDING_CEILING + 2; i++) {
          await service.submit('f1', { answers: {} } as any, 'guest', VISITOR);
        }
        expect(rows).toHaveLength(GUEST_PENDING_CEILING + 2);
        expect(rows.every((r) => (r.guestVisitorKey ?? null) === null)).toBe(true);
      });

      it('refuses to key a paid guest answer that names no visitor, rather than count it on nobody', async () => {
        const { service, rows } = paidPublic();
        await expect(service.submit('f1', { answers: {} } as any, 'guest')).rejects.toThrow(
          'without a visitor address'
        );
        expect(rows).toHaveLength(0);
      });
    });

    it('records a guest payment: paid, a purchase record with no buyer, no grant', async () => {
      const { service, rows, core, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
        grantsCotisation: false,
        rows: [guestRow()],
      });
      core.stateAnswer = 'paid';
      await service.confirmPayment('guest');
      await service.markPaid('guest', '777');
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentSettledBy: GUEST_UUID });
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null, source: 'form', amountCents: 1500 })
      );
      expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
    });

    // A granting form holding a guest row was made private after the guest answered (a public form
    // cannot be saved with a grant). Control: drop the guest branch in `fulfilPayment` and the
    // grant is attempted for `null` (fails `not.toHaveBeenCalled`).
    it('grants nothing to nobody, says so at ERROR ONCE, and still records the money', async () => {
      const { service, rows, core, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: null,
        provider: 'lydia',
        grantsCotisation: true,
        rows: [guestRow()],
      });
      const error = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
      core.stateAnswer = 'paid';
      await service.confirmPayment('guest');
      await service.markPaid('guest', '777');
      await service.markPaid('guest', GUEST_UUID);
      expect(rows[0].paymentStatus).toBe('paid');
      expect(userTagService.grantCotisantIfARise).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('no account to grant it to'));
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
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
