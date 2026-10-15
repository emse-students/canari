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
 * is a real mutex per form, released when the transaction ends, so two late payments genuinely
 * interleave every `await` they reach.
 */
describe('FormsService - the seat a pending payment holds', () => {
  const HOLD_MS = PENDING_PAYMENT_HOLD_SECONDS * 1000;
  type Row = {
    id: string;
    formId: string;
    userId: string | null;
    paymentStatus: string;
    paymentMethod: string | null;
    totalPaid: number;
    createdAt: Date;
    stripeSessionId?: string;
  };

  function makeStore(opts: { maxSubmissions: number | null; rows: Row[] }) {
    let now = new Date('2026-10-15T12:00:00Z');
    const rows = opts.rows.map((row) => ({ ...row }));
    const form = {
      id: 'f1',
      title: 'Gala',
      maxSubmissions: opts.maxSubmissions,
      associationId: 'asso1',
      grantsCotisation: true,
      cotisationVariantKey: null,
    };

    /** Lets every concurrent caller run up to its next await, as a database round trip would. */
    const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

    /** Evaluates one value of a `where` against a row, the raw hold fragment included. */
    function matchesValue(row: Row, key: keyof Row, expected: unknown): boolean {
      if (expected instanceof FindOperator) {
        // The only operator the service puts in a submission `where` is the hold, and it must be
        // the ONE fragment the expiry job also uses - anything else is a new predicate.
        expect(key).toBe('createdAt');
        expect(expected.type).toBe('raw');
        expect(expected.getSql?.('col')).toBe(`col > ${PENDING_HOLD_CUTOFF_SQL}`);
        return row.createdAt.getTime() > now.getTime() - HOLD_MS;
      }
      return row[key] === expected;
    }
    const matches = (row: Row, where: Record<string, unknown> | Record<string, unknown>[]) =>
      (Array.isArray(where) ? where : [where]).some((clause) =>
        Object.entries(clause).every(([key, value]) => matchesValue(row, key as keyof Row, value))
      );

    const locks = new Map<string, Promise<void>>();
    const purchaseRecordService = { create: jest.fn(() => Promise.resolve()) };
    const userTagService = { grantCotisant: jest.fn(() => Promise.resolve({})) };

    const submissionRepo: any = {
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown>[] }) =>
          rows.filter((r) => matches(r, where)).length
      ),
      createQueryBuilder: () => {
        const state: { set?: Partial<Row>; where: string[]; params: Record<string, unknown> } = {
          where: [],
          params: {},
        };
        const builder = {
          update: () => builder,
          set: (values: Partial<Row>) => ((state.set = values), builder),
          where: (sql: string, params: Record<string, unknown> = {}) => (
            state.where.push(sql),
            Object.assign(state.params, params),
            builder
          ),
          andWhere: (sql: string) => (state.where.push(sql), builder),
          execute: async () => {
            await roundTrip();
            expect(state.where).toEqual([
              '"paymentStatus" = :status',
              `"createdAt" <= ${PENDING_HOLD_CUTOFF_SQL}`,
            ]);
            const moved = rows.filter(
              (r) =>
                r.paymentStatus === state.params.status &&
                r.createdAt.getTime() <= now.getTime() - HOLD_MS
            );
            moved.forEach((r) => Object.assign(r, state.set));
            return { affected: moved.length };
          },
        };
        return builder;
      },
      manager: {
        transaction: jest.fn(async (level: string, run: (manager: unknown) => Promise<unknown>) => {
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
            save: async (row: Row) => {
              await roundTrip();
              Object.assign(
                rows.find((r) => r.id === row.id)!,
                row
              );
              return row;
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
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
      userTagService as any,
      purchaseRecordService as any,
      {} as any,
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

  const row = (over: Partial<Row>): Row => ({
    id: 's1',
    formId: 'f1',
    userId: 'u1',
    paymentStatus: 'pending',
    paymentMethod: null,
    totalPaid: 1500,
    createdAt: new Date('2026-10-15T12:00:00Z'),
    ...over,
  });
  const ago = (ms: number) => new Date(new Date('2026-10-15T12:00:00Z').getTime() - ms);

  describe('the seat count', () => {
    // The boundary itself: the hold is decided from `createdAt` in the count, so no job has run.
    it('counts a pending row one second inside the hold, and not one second past it', async () => {
      const { service } = makeStore({
        maxSubmissions: 10,
        rows: [
          row({ id: 'inside', createdAt: ago(HOLD_MS - 1000) }),
          row({ id: 'past', createdAt: ago(HOLD_MS + 1000) }),
        ],
      });
      expect((await service.get('f1')).submissionCount).toBe(1);
    });

    it('releases the seat as the clock crosses the hold, with no job run', async () => {
      const { service, advance } = makeStore({
        maxSubmissions: 1,
        rows: [row({ createdAt: ago(HOLD_MS - 1000) })],
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

  describe('the expiry job', () => {
    it('moves only pending rows past the hold to expired, and a second run moves nothing', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: null,
        rows: [
          row({ id: 'stale', createdAt: ago(HOLD_MS + 1000) }),
          row({ id: 'live', createdAt: ago(HOLD_MS - 1000) }),
          row({ id: 'cash', paymentStatus: 'pending_cash', createdAt: ago(10 * HOLD_MS) }),
          row({ id: 'paid', paymentStatus: 'paid', createdAt: ago(10 * HOLD_MS) }),
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
          row({ id: 'late', paymentStatus: 'expired', createdAt: ago(2 * HOLD_MS) }),
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid');
      expect(rows[0].stripeSessionId).toBe('req-1');
      expect(userTagService.grantCotisant).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('lands over capacity on a full form, accused at warn, and grants nothing', async () => {
      const { service, rows, userTagService, purchaseRecordService } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'late', paymentStatus: 'expired', createdAt: ago(2 * HOLD_MS) }),
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      const warn = jest.spyOn((service as any).logger, 'warn');
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('late'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1500 cents'));
      expect(userTagService.grantCotisant).not.toHaveBeenCalled();
      // The payer's trace that they paid stays: the refund happens outside the application.
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('treats a pending row past the hold as released even before the job ran', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [
          row({ id: 'late', paymentStatus: 'pending', createdAt: ago(HOLD_MS + 1000) }),
          row({ id: 'other', paymentStatus: 'paid' }),
        ],
      });
      await service.markPaid('late');
      expect(rows[0].paymentStatus).toBe('paid_over_capacity');
    });

    it('never refuses a row still holding its seat, even on a full form', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        rows: [row({ id: 'onTime', paymentStatus: 'pending', createdAt: ago(1000) })],
      });
      await service.markPaid('onTime');
      expect(rows[0].paymentStatus).toBe('paid');
    });

    it('lets two simultaneous late payments take the last seat ONCE', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 2,
        rows: [
          row({ id: 'a', paymentStatus: 'expired', createdAt: ago(2 * HOLD_MS) }),
          row({ id: 'b', paymentStatus: 'expired', createdAt: ago(2 * HOLD_MS) }),
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
        rows: [row({ id: 's1', paymentStatus: 'pending', createdAt: ago(1000) })],
      });
      await service.markPaid('s1');
      await service.markPaid('s1');
      expect(rows[0].paymentStatus).toBe('paid');
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
