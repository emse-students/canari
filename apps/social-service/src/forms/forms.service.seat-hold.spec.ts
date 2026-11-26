import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
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
import { PricingFactsService } from '../pricing/pricing-facts.service';
import {
  PENDING_HOLD_CUTOFF_CLOCK_SQL,
  PENDING_HOLD_CUTOFF_SQL,
  PAYMENT_REQUEST_LIFETIME_SECONDS,
  PENDING_PAYMENT_HOLD_SECONDS,
  PREVIOUS_PAYMENT_OPEN,
  ALREADY_ANSWERED,
  overCapacityFirst,
  seatHoldingWhere,
} from './seat-hold';
import {
  PAYMENT_IN_PROGRESS,
  PAYMENT_NOT_RESUMABLE,
  PAYMENT_PRICE_CHANGED,
} from './payment-resume';
import {
  CASH_ALREADY_PAID_ONLINE,
  FORM_CASH_NOT_OFFERED,
  CASH_SWITCH_LOST_AFTER_CANCEL,
  PAYMENT_ISSUE_WITHDRAWN,
  PAYMENT_NOT_SWITCHABLE,
} from './payment-cash-switch';
import { cashReminderDueAt } from './cash-reminder';

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
    /** Who cancelled the payment (migration 179, `PaymentCancelOrigin`). */
    paymentCancelOrigin?: string | null;
    cotisationGrantedAt?: Date | null;
    purchaseRecordedAt?: Date | null;
    organiserNotifiedAt?: Date | null;
    guestReceiptHash?: string | null;
    guestVisitorKey?: string | null;
    /** The Business the row's request was issued to (written with the request ids). */
    lydiaVendorToken?: string | null;
    answers?: Record<string, unknown>;
    /** The priced grids' lines and the price questions, snapshotted at submit (137, 166). */
    lines?: unknown[] | null;
    priceLockedItemIds?: string[] | null;
    /** A switch to cash in progress (migration 184, `claimCashSwitch`). */
    cashSwitchClaimId?: string | null;
    /** The cash hold and its one notice (`pending_cash`, migration 179). */
    cashExpiresAt?: Date | null;
    cashReminderDueAt?: Date | null;
    cashReminderNotifiedAt?: Date | null;
  };
  type Flag = 'cotisationGrantedAt' | 'purchaseRecordedAt' | 'organiserNotifiedAt';
  /** What a payment resume writes when it reopens a released answer (`resumePayment`). */
  const RESUME_REOPENS = {
    paymentStatus: 'pending',
    paymentRequestId: null,
    stripeSessionId: null,
    paymentSettledBy: null,
    paymentCancelOrigin: null,
  };

  function makeStore(opts: {
    maxSubmissions: number | null;
    rows: Row[];
    basePrice?: number;
    allowMultipleSubmissions?: boolean;
    /** `lydia` reaches the fake core below; `disabled` stops a paid submit after its transaction. */
    provider?: 'lydia' | 'disabled';
    /** The organiser alert switched on (`FORM_ORGANISER_ALERT_ENABLED` is ON since the 1.7.0 floor; a spec turns it off). */
    organiserAlert?: boolean;
    /** A public form, answered by guests (WP-P1); default false. */
    isPublic?: boolean;
    allowCashPayment?: boolean;
    /** Default true: most rows here are members whose payment grants a cotisation. */
    grantsCotisation?: boolean;
    /** The form's price grid; default none, so `basePrice` is the price. */
    priceMatrix?: unknown;
    /** The facts builder; default a stub that knows nobody's promo, formation or cotisation. */
    pricingFacts?: unknown;
    /** The manager's close, or a past end date: the form takes no new answer (`assertFormOpen`). */
    closedAt?: Date | null;
    /** Who may answer (`assertMaySubmit`); default open to everyone. */
    submitCondition?: unknown;
    /** The cash deadline in days (`cashPaymentExpiryDays`); default none. */
    cashPaymentExpiryDays?: number | null;
    /** Default true: the editor accepts online payment (`allowOnlinePayment`). */
    allowOnlinePayment?: boolean;
    /** An anonymous form (it takes no money); default false. */
    anonymous?: boolean;
  }) {
    let now = T0;
    // A seeded row naming a request was issued to the form's Business ('vendor'), as `submit` writes.
    const rows: Row[] = opts.rows.map((row) => ({
      lydiaVendorToken: row.stripeSessionId || row.paymentRequestId ? 'vendor' : null,
      ...row,
    }));
    let nextId = 0;
    const form = {
      id: 'f1',
      title: 'Gala',
      maxSubmissions: opts.maxSubmissions,
      associationId: 'asso1',
      grantsCotisation: opts.grantsCotisation ?? true,
      cotisationVariantKey: null,
      basePrice: opts.basePrice ?? 0,
      priceMatrix: opts.priceMatrix ?? null,
      submitCondition: opts.submitCondition ?? null,
      anonymous: opts.anonymous ?? false,
      isPublic: opts.isPublic ?? false,
      allowMultipleSubmissions: opts.allowMultipleSubmissions ?? false,
      allowCashPayment: opts.allowCashPayment ?? false,
      allowOnlinePayment: opts.allowOnlinePayment ?? true,
      cashPaymentExpiryDays: opts.cashPaymentExpiryDays ?? null,
      currency: 'eur',
      opensAt: null,
      closedAt: opts.closedAt ?? null,
      items: [],
    };

    /** Lets every concurrent caller run up to its next await, as a database round trip would. */
    const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

    /** Evaluates one value of a `where` against a row, the raw hold fragment included. */
    function matchesValue(row: Row, key: keyof Row, expected: unknown): boolean {
      if (expected instanceof FindOperator) {
        // The resume's offer (`resumableWhere`): an online, charged row - read as Postgres would.
        if (expected.type === 'isNull') return row[key] === null || row[key] === undefined;
        // `Not(In(...))`: SQL's NOT IN, which a NULL never satisfies.
        if (expected.type === 'not') {
          const inner = (expected as unknown as { _value: unknown })._value;
          return row[key] !== null && row[key] !== undefined && !matchesValue(row, key, inner);
        }
        if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
        if (expected.type === 'moreThan') return (row[key] as number) > (expected.value as number);
        // Otherwise the hold, and it must be the ONE fragment the expiry job also uses - its two
        // halves `>` (still holding) and `<=` (past it) - anything else is a new predicate.
        expect(key).toBe('paymentRequestedAt');
        expect(expected.type).toBe('raw');
        const sql = expected.getSql?.('col');
        const past = `col <= ${PENDING_HOLD_CUTOFF_SQL}`;
        // The switch's own self-check reads the hold at the WALL clock: the fake clock is both.
        expect([
          `col > ${PENDING_HOLD_CUTOFF_SQL}`,
          past,
          `col > ${PENDING_HOLD_CUTOFF_CLOCK_SQL}`,
        ]).toContain(sql);
        const holding = row.paymentRequestedAt.getTime() > now.getTime() - HOLD_MS;
        return sql === past ? !holding : holding;
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
    /** Every switch-to-cash claim written (`claimCashSwitch`), in order. */
    const claims: string[] = [];

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
      // The paid form's pre-check before any payment request: no catalogue to check the tier
      // against, and nothing held, so a rise.
      listCotisationTiers: jest.fn(() => Promise.resolve([])),
      cotisationModeOf: jest.fn(() => Promise.resolve('dated')),
      rankCotisationTier: jest.fn(() => Promise.resolve('none')),
      // Asked after a grant that failed: the tier is not held as this answer's delivery.
      holdsTierDeliveredBy: jest.fn(() => Promise.resolve(false)),
    };

    /** The two UPDATE shapes the builder makes: an unknown issue's mark and a fulfilment claim. */
    function runUpdate(state: {
      set: Record<string, unknown>;
      where: string[];
      params: Record<string, unknown>;
    }) {
      if ('paymentCancelOrigin' in state.set) {
        // An issue whose outcome is unknown: the row stays pending, marked, while it names nothing.
        expect(state.set).toEqual({ paymentCancelOrigin: 'issue-unknown' });
        expect(state.where).toEqual([
          'id = :id',
          '"paymentStatus" = :pending',
          '"paymentRequestId" IS NULL AND "stripeSessionId" IS NULL',
        ]);
        const target = byId(state.params.id as string);
        if (
          target.paymentStatus !== 'pending' ||
          target.paymentRequestId ||
          target.stripeSessionId
        ) {
          return { affected: 0 };
        }
        target.paymentCancelOrigin = 'issue-unknown';
        return { affected: 1 };
      }
      const [flag] = Object.keys(state.set) as Flag[];
      expect(state.where).toEqual(['id = :id', `"${flag}" IS NULL`]);
      const target = byId(state.params.id as string);
      if (target[flag]) return { affected: 0 };
      target[flag] = now;
      return { affected: 1 };
    }

    /** The online expiry's rows (`expireStalePendingPayments`): `pending` and `payment_due` past `cutoff`. */
    const onlineDue = (sql: string, cutoff: Date, formId?: string) => {
      expect(sql).toContain(
        `"paymentStatus" IN ('pending', 'payment_due') AND "paymentRequestedAt" <= CAST($1 AS timestamptz)`
      );
      return rows.filter(
        (r) =>
          (formId === undefined || r.formId === formId) &&
          ['pending', 'payment_due'].includes(r.paymentStatus) &&
          r.paymentRequestedAt.getTime() <= cutoff.getTime()
      );
    };

    const submissionRepo: any = {
      // The expiry's first read: the forms whose rows are due, each then expired under its lock.
      query: jest.fn(async (sql: string, params: unknown[]) => {
        // The live "Reserver ma place" holds of a capped form (`countLiveSeatHolds`): none here.
        if (sql.includes('FROM form_seat_holds')) return [{ n: 0 }];
        await roundTrip();
        expect(sql.startsWith('SELECT DISTINCT "formId" FROM submissions WHERE')).toBe(true);
        return [...new Set(onlineDue(sql, params[0] as Date).map((r) => r.formId))].map(
          (formId) => ({
            formId,
          })
        );
      }),
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown>[] }) =>
          rows.filter((r) => matches(r, where)).length
      ),
      find: jest.fn(async ({ where }: { where: Record<string, unknown>[] }) => {
        return rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => ({ ...r }));
      }),
      // By id, or by a criteria object (the conditional naming of a request, `issueOnlineRequest`).
      update: jest.fn(async (criteria: string | Record<string, unknown>, values: Partial<Row>) => {
        await roundTrip();
        if (typeof criteria === 'string') {
          Object.assign(byId(criteria), values);
          return { affected: 1 };
        }
        const target = rows.find((r) => matches(r, criteria));
        if (!target) return { affected: 0 };
        Object.assign(target, values);
        return { affected: 1 };
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
          andWhere: (sql: string, params: Record<string, unknown> = {}) => (
            state.where.push(sql),
            Object.assign(state.params, params),
            builder
          ),
          execute: async () => {
            await roundTrip();
            // An UPDATE waits on every row it matches that another transaction locked.
            for (const r of rows) {
              while (locks.has(`row:${r.id}`)) await locks.get(`row:${r.id}`);
            }
            return runUpdate(state);
          },
        };
        return builder;
      },
      manager: {
        find: jest.fn(async (_entity: unknown, { where }: { where: Record<string, unknown>[] }) =>
          rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))
        ),
        // The association's archive, read outside any transaction (the switch's pre-check).
        query: jest.fn(async (sql: string) => {
          expect(sql).toContain('FROM associations');
          return [];
        }),
        transaction: jest.fn(async (level: string, run: (manager: unknown) => Promise<unknown>) => {
          // REPEATABLE READ takes its snapshot BEFORE the lock wait, so the count after it would not
          // see the previous holder's commit: the seat lock is only sound in READ COMMITTED.
          expect(level).toBe('READ COMMITTED');
          const releases: (() => void)[] = [];
          const manager = {
            query: async (sql: string, params: unknown[]) => {
              // The association's archive, read FOR SHARE before the seat lock: never archived
              // here (the archive itself is proven on PostgreSQL, answer-edit.integration).
              if (sql.includes('FROM associations')) return [];
              // The live seat holds of the other people (`countLiveSeatHolds`): none here.
              if (sql.includes('FROM form_seat_holds')) return [{ n: 0 }];
              // A late payment takes its payer's WAITING answer off the line (`markPaid`).
              if (sql.startsWith('DELETE FROM submissions WHERE "formId" = $1 AND "userId" = $2')) {
                await roundTrip();
                const [f, u, st, keep] = params as string[];
                const gone = rows.filter(
                  (r) => r.formId === f && r.userId === u && r.paymentStatus === st && r.id !== keep
                );
                gone.forEach((r) => rows.splice(rows.indexOf(r), 1));
                return [gone.map((r) => ({ id: r.id })), gone.length];
              }
              // The online expiry of ONE form, under its seat lock (`expirePerForm`).
              if (sql.startsWith(`UPDATE submissions SET "paymentStatus" = 'expired'`)) {
                await roundTrip();
                const [cutoff, f] = params as [Date, string];
                // The form is the LAST parameter, after the cutoff the due rows are read by.
                if (!sql.includes('WHERE "formId" = $2 AND'))
                  throw new Error(`unexpected expiry: ${sql}`);
                const moved = onlineDue(sql, cutoff, f);
                // The claim of a switch to cash ends with the hold it protected (`claimCashSwitch`).
                if (!sql.includes('"cashSwitchClaimId" = NULL'))
                  throw new Error(`an online expiry that keeps the claim: ${sql}`);
                moved.forEach((r) => {
                  r.paymentStatus = 'expired';
                  r.cashSwitchClaimId = null;
                });
                return [moved.map((r) => ({ id: r.id })), moved.length];
              }
              const [formId] = params as string[];
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
            findOne: async (
              entity: unknown,
              { where, lock }: { where: Record<string, unknown>; lock?: { mode: string } }
            ) => {
              await roundTrip();
              if (entity === Form) return { ...form };
              expect(entity).toBe(Submission);
              const found = rows.find((r) => matches(r, where));
              if (found && lock) {
                // A submission ROW lock, held to the end of the transaction as PostgreSQL holds it:
                // every locked step on the row (a cancel callback, the poll, `markPaid`) queues.
                const key = `row:${found.id}`;
                while (locks.has(key)) await locks.get(key);
                let release!: () => void;
                locks.set(key, new Promise<void>((resolve) => (release = resolve)));
                releases.push(() => {
                  locks.delete(key);
                  release();
                });
                // Re-read after the wait: READ COMMITTED sees what the previous holder committed.
                const row = rows.find((r) => matches(r, where));
                return row ? { ...row } : null;
              }
              return found ? { ...found } : null;
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
              if (values.paymentStatus === 'pending_cash') {
                // A switch to cash (`switchToCash`): named columns, the request ids NOT among them
                // (they stay, the trace a late confirmation is matched against), no hold restart.
                // A wrong shape THROWS out of the service call, so the test that drove it fails.
                const written = Object.keys(values).sort().join(',');
                const expected = [
                  'cashExpiresAt',
                  'cashReminderDueAt',
                  'cashReminderNotifiedAt',
                  'cashSwitchClaimId',
                  'paymentCancelOrigin',
                  'paymentMethod',
                  'paymentStatus',
                  ...('guestVisitorKey' in values ? ['guestVisitorKey'] : []),
                ]
                  .sort()
                  .join(',');
                if (written !== expected) {
                  throw new Error(`switch to cash wrote [${written}], expected [${expected}]`);
                }
                const before = byId(id).paymentStatus;
                Object.assign(byId(id), values);
                transitions.push(`${id}:${before}->pending_cash`);
                return;
              }
              if (Object.keys(values).join() === 'cashSwitchClaimId') {
                // The switch's CLAIM (`claimCashSwitch`): a token, and nothing else of the row. A
                // wrong shape THROWS out of the service call, so the test that drove it fails.
                if (typeof values.cashSwitchClaimId !== 'string') {
                  throw new Error(`a claim wrote ${String(values.cashSwitchClaimId)}, not a token`);
                }
                byId(id).cashSwitchClaimId = values.cashSwitchClaimId;
                claims.push(`${id}:claimed`);
                return;
              }
              const { paymentRequestedAt, ...named } = values;
              // A retry restarts the hold alone; a payment resume also reopens the row naming NO
              // request (`resumePayment`), by named columns - those two shapes and no other.
              const reopens = Object.keys(named).length > 0;
              expect([{}, RESUME_REOPENS]).toContainEqual(named);
              if (reopens) {
                const before = byId(id).paymentStatus;
                Object.assign(byId(id), named);
                transitions.push(`${id}:${before}->pending`);
              }
              expect((paymentRequestedAt as () => string)()).toBe('now()');
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
    const pricingFacts: any = opts.pricingFacts ?? {
      build: jest.fn(async (input: { answers?: Record<string, string[]> }) => ({
        cursus: [{ promo: null, formation: null }],
        cotisationTiers: [],
        answers: input.answers ?? {},
      })),
    };
    // Payments are DISABLED by default, so a paid submit stops right after its transaction
    // committed: those tests are about what the transaction wrote, not about the checkout.
    const associationsService: any = {
      namesByIds: jest.fn(async () => new Map()),
      assertPaymentsReady: jest.fn(async () => undefined),
      collectsNow: jest.fn(async () => true),
      getPaymentAccountId: jest.fn(async () => 'vendor'),
      // Nobody manages this form through the association: only its submitter may read its answer.
      mayAct: jest.fn(async () => false),
      getActivePaymentProvider: jest.fn(async () => opts.provider ?? 'disabled'),
      revertLydiaReadinessAfterRefusal: jest.fn(async () => undefined),
      noteLydiaRequestIssued: jest.fn(async () => undefined),
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
      /** What `create-checkout-session` answers instead of a request, when set (a core refusal). */
      createAnswer: null as null | Error,
      /** Runs inside request creation, as a concurrent switch to cash may. */
      duringCreate: null as null | (() => Promise<unknown>),
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
      if (core.duringCreate) await core.duringCreate();
      if (core.createAnswer) throw core.createAnswer;
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
      organiserAlert as any,
      {} as any
    );
    return {
      service,
      rows,
      associationsService,
      userTagService,
      purchaseRecordService,
      organiserAlert,
      core,
      transitions,
      claims,
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
      // `payment_due`: a waiting answer promoted on a paid form, held by the online hold (waitlist.ts).
      expect(branches).toEqual(['paid', 'free', 'pending', 'pending_cash', 'payment_due']);
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

  // "Clore le formulaire" (owner, 2026-11-16): the close refuses a NEW answer (`submit`, an edit),
  // and nothing else. A payment already issued settles or expires through the row's own paths,
  // which never read `closedAt` - the form's close is not the payer's loss.
  describe('a form closed while a payment is in progress', () => {
    const closedAt = new Date(T0.getTime() - 1000);

    it('refuses a new answer, typed', async () => {
      const { service, rows } = makeStore({ maxSubmissions: null, rows: [], closedAt });
      await expect(
        service.submit('f1', { userId: 'u1', answers: {} } as any)
      ).rejects.toMatchObject({ response: { code: 'FORM_CLOSED' } });
      expect(rows).toHaveLength(0);
    });

    it('still takes the payment of a pending row that started before the close', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        closedAt,
        rows: [row({ id: 'p', paymentStatus: 'pending', paymentRequestedAt: ago(1000) })],
      });
      await service.markPaid('p', 'req-1');
      expect(rows[0].paymentStatus).toBe('paid');
    });

    it('still lets the expiry job release a pending row, so its seat is not held for ever', async () => {
      const { service, rows } = makeStore({
        maxSubmissions: 1,
        closedAt,
        rows: [row({ id: 'p', paymentStatus: 'pending', paymentRequestedAt: ago(HOLD_MS + 1000) })],
      });
      expect(await service.expireStalePendingPayments(ago(HOLD_MS))).toBe(1);
      expect(rows[0].paymentStatus).toBe('expired');
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
      expect(await service.expireStalePendingPayments(ago(HOLD_MS))).toBe(1);
      const first = rows.map((r) => [r.id, r.paymentStatus]);
      expect(first).toEqual([
        ['stale', 'expired'],
        ['live', 'pending'],
        ['cash', 'pending_cash'],
        ['paid', 'paid'],
      ]);
      expect(await service.expireStalePendingPayments(ago(HOLD_MS))).toBe(0);
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
      // The payer's trace that they paid stays: the refund happens outside the application. It is
      // MARKED: the form grants a tier, and no seat means no tier was granted.
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      expect(purchaseRecordService.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'paid_not_granted' })
      );
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
      // The payer is not on the waiting list: the refund is owed now.
      expect(organiserAlert.tell).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f1', title: 'Gala' }),
        { payerInLine: false }
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

    // The settle runs BEFORE the tier pre-check: the earlier request's grant makes the tier "held",
    // and the pre-check would refuse that person (409 FORM_TIER_ALREADY_HELD) for a payment they
    // made. Fails when the pre-check runs first.
    it('answers alreadyPaid, not a 409, when the paid old request made its tier held', async () => {
      const { service, core, userTagService } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [mine()],
      });
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      userTagService.rankCotisationTier.mockResolvedValue('held');
      await expect(retry(service)).resolves.toEqual({ submissionId: 'mine', alreadyPaid: true });
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

    // P1 (2026-10-27): the retry above reuses the row, and every request of it used to carry the
    // SAME order_ref `form:<submissionId>`, which Lydia refuses on the second request/do (error 3,
    // measured 2026-10-21). Control: with the order_ref back to `form:${id}` this test fails on the
    // two keys being equal.
    it('sends a NEW order_ref for the retry of a reused row, naming the same submission', async () => {
      const { service, rows, core } = makeStore({
        maxSubmissions: 1,
        basePrice: 1500,
        provider: 'lydia',
        rows: [],
      });
      await retry(service);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'declined';
      await retry(service);
      expect(rows).toHaveLength(1);
      const keys = core.calls
        .filter((c) => c.route === 'create-checkout-session')
        .map((c) => c.body.idempotencyKey as string);
      expect(keys).toHaveLength(2);
      const perAttempt = new RegExp(`^form:${rows[0].id}:[0-9a-f]{8}$`);
      for (const key of keys) expect(key).toMatch(perAttempt);
      expect(keys[0]).not.toBe(keys[1]);
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

    // A row holding an id that is not a Lydia `request_uuid` (a historic `cs_...` one): core refuses
    // it with a 400, so asking would only put a WARN in the log on every poll of the return page.
    it.each([['pending'], ['expired'], ['cancelled']])(
      'asks nothing about a non-Lydia id on a %s row, and says so once at INFO',
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
        await r.service.expireStalePendingPayments(new Date(T0.getTime() + 9 * HOLD_MS));
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

    // A GUEST PAYS THE "EVERYONE ELSE" TIER of a grid on who the person is (owner, 2026-11-06),
    // computed here from facts the server builds - never from a price the page sends. The REAL
    // facts builder runs, with a cotisation store and a profile fetch that fail the test if a guest
    // ever reaches them. Control: a guest given `cotisationTiers: [null]` lands in "_others|c1" and
    // the total reads 1200.
    it('charges a guest the "everyone else" tier of a grid on promo and cotisation', async () => {
      const userTags = {
        listHeldCotisationTiers: jest.fn(() => {
          throw new Error('a guest has no cotisation to read');
        }),
      };
      const profileFetch = jest.spyOn(axios, 'get');
      const { service, rows, core } = makeStore({
        maxSubmissions: null,
        rows: [],
        provider: 'lydia',
        isPublic: true,
        allowMultipleSubmissions: true,
        grantsCotisation: false,
        priceMatrix: {
          dimensions: [
            { id: 'd1', kind: 'promo', buckets: [{ id: 'b1', label: '1A', values: [2026] }] },
            { id: 'd2', kind: 'cotisation', buckets: [{ id: 'c1', label: 'BDE', anyTier: true }] },
          ],
          cells: {
            'b1|c1': 800,
            'b1|_others': 1000,
            '_others|c1': 1200,
            '_others|_others': 2500,
          },
        },
        pricingFacts: new PricingFactsService(userTags as any),
      });
      await service.submit(
        'f1',
        // A price in the body is not read: the server computes the total.
        { payerEmail: 'guest@example.org', answers: {}, totalPaid: 1 } as any,
        'guest',
        VISITOR
      );
      expect(rows[0]).toMatchObject({ userId: null, paymentStatus: 'pending', totalPaid: 2500 });
      expect(core.calls[0].route).toBe('create-checkout-session');
      expect(userTags.listHeldCotisationTiers).not.toHaveBeenCalled();
      expect(profileFetch).not.toHaveBeenCalled();
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

  describe('a payment resumed on the same answer (owner decision of 2026-11-21)', () => {
    /** The caller's answer whose payment ended: its old request named by both ids. */
    const released = (over: Partial<Row> = {}) =>
      row({
        id: 'ans',
        paymentStatus: 'expired',
        paymentRequestedAt: ago(2 * HOLD_MS),
        paymentRequestId: '555',
        stripeSessionId: 'uuid-old',
        // What `submit` stored with the answer: no grid, and no question fixing the price.
        lines: null,
        priceLockedItemIds: [],
        // A cancel names its origin since 179; Lydia's verdict is the ordinary one.
        paymentCancelOrigin: over.paymentStatus === 'cancelled' ? 'provider' : null,
        ...over,
      });
    const resume = (service: FormsService, caller = 'u1') =>
      service.resumePayment('ans', caller, { payerEmail: 'payer@example.org' });
    const lydia = (rows: Row[], over: Partial<Parameters<typeof makeStore>[0]> = {}) =>
      makeStore({ maxSubmissions: 2, basePrice: 1500, provider: 'lydia', rows, ...over });

    it.each([
      ['expired', 'cancelled'],
      ['cancelled', 'already-settled'],
    ] as const)(
      'issues a NEW request for the SAME %s answer, after settling the old one at Lydia',
      async (status, cancelAnswer) => {
        const { service, rows, core, transitions } = lydia([released({ paymentStatus: status })]);
        core.cancelAnswer = cancelAnswer;
        await expect(resume(service)).resolves.toEqual({
          checkoutUrl: 'https://lydia.example/pay/1',
          submissionId: 'ans',
        });
        const routes = core.calls.map((c) => c.route);
        expect(routes[0]).toBe('cancel-request');
        expect(routes[routes.length - 1]).toBe('create-checkout-session');
        // The old request was settled while the row still named it, before anything was issued.
        expect(core.calls[0].rowIdsThen).toEqual([['ans', '555', 'uuid-old']]);
        const issued = core.calls[core.calls.length - 1];
        // The answer's own amount, never a client figure, on the same row.
        expect(issued.body.lineItems[0].price_data.unit_amount).toBe(1500);
        expect(issued.body.metadata.submissionId).toBe('ans');
        expect(issued.body.payerEmail).toBe('payer@example.org');
        expect(issued.body.expireAfterSeconds).toBe(PAYMENT_REQUEST_LIFETIME_SECONDS);
        // While it was being issued, the row named NO request: what a second click refuses on.
        expect(issued.rowIdsThen).toEqual([['ans', null, null]]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          paymentStatus: 'pending',
          paymentRequestId: '1001',
          stripeSessionId: 'uuid-1',
          paymentRequestedAt: T0,
        });
        expect(transitions).toEqual([`ans:${status}->pending`]);
      }
    );

    it('issues at once when the released answer names no request (it was never issued)', async () => {
      const { service, core } = lydia([
        released({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      await resume(service);
      expect(core.calls.map((c) => c.route)).toEqual(['create-checkout-session']);
    });

    it('resumes a pending answer whose hold has passed before the expiry job said so', async () => {
      const { service, rows } = lydia([released({ paymentStatus: 'pending' })]);
      await resume(service);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', paymentRequestId: '1001' });
    });

    // NEVER A SECOND CHARGE: the payer paid the old request in the Lydia app and never came back.
    // Fails if the resume issues before reading the old request.
    it('records the old request PAID and issues nothing when it was paid meanwhile', async () => {
      const { service, rows, core } = lydia([released()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      await expect(resume(service)).resolves.toEqual({ submissionId: 'ans', alreadyPaid: true });
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request', 'request-state']);
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentSettledBy: '555' });
    });

    it('refuses while the old request cannot be shown dead or paid (PREVIOUS_PAYMENT_OPEN)', async () => {
      const { service, rows, core } = lydia([released()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'open';
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PREVIOUS_PAYMENT_OPEN },
      });
      expect(core.calls.map((c) => c.route)).not.toContain('create-checkout-session');
      expect(rows[0].paymentStatus).toBe('expired');
    });

    // IDEMPOTENCE FROM DURABLE STATE: the row is `pending` once a resume took it, and that is what
    // the second click reads - no clock, no in-memory flag.
    it('refuses a second click once a checkout is live, typed, issuing nothing more', async () => {
      const { service, core } = lydia([released()]);
      await resume(service);
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_IN_PROGRESS },
      });
      expect(core.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
    });

    it('lets ONE of two simultaneous clicks through, and refuses the other', async () => {
      const { service, core } = lydia([
        released({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      const results = await Promise.allSettled([resume(service), resume(service)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ response: { code: PAYMENT_IN_PROGRESS } });
      expect(core.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
    });

    it('refuses a payment still within its hold without asking Lydia anything', async () => {
      const { service, core } = lydia([
        released({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) }),
      ]);
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_IN_PROGRESS },
      });
      expect(core.calls).toEqual([]);
    });

    it.each([
      ['a paid answer', { paymentStatus: 'paid' }],
      ['a refunded answer', { paymentStatus: 'refunded' }],
      ['an answer waiting for cash', { paymentStatus: 'pending_cash', paymentMethod: 'cash' }],
      ['an expired cash answer', { paymentStatus: 'expired', paymentMethod: 'cash' }],
      ['a free answer', { paymentStatus: 'cancelled', totalPaid: 0 }],
    ])('refuses %s as having nothing to resume', async (_label, over) => {
      const { service, core } = lydia([released(over as Partial<Row>)]);
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_RESUMABLE },
      });
      expect(core.calls).toEqual([]);
    });

    it('answers the answer of another person as missing', async () => {
      const { service, core } = lydia([released()]);
      await expect(resume(service, 'u2')).rejects.toMatchObject({ status: 404 });
      expect(core.calls).toEqual([]);
    });

    it('refuses on a closed form, as a submit is', async () => {
      const { service, core } = lydia([released()], { closedAt: ago(1000) });
      await expect(resume(service)).rejects.toMatchObject({ response: { code: 'FORM_CLOSED' } });
      expect(core.calls).toEqual([]);
    });

    // The capacity, counted as a fresh submit counts it, under the form lock.
    it('refuses on a full form, issuing nothing', async () => {
      const { service, rows, core } = lydia(
        [released(), row({ id: 'other', userId: 'u2', paymentStatus: 'paid' })],
        { maxSubmissions: 1 }
      );
      await expect(resume(service)).rejects.toMatchObject({ response: { code: 'FORM_FULL' } });
      expect(core.calls.map((c) => c.route)).not.toContain('create-checkout-session');
      expect(rows[0].paymentStatus).toBe('expired');
    });

    it('refuses when the person has answered again since, before cancelling anything', async () => {
      const { service, core } = lydia([
        released(),
        row({ id: 'newer', paymentStatus: 'paid', createdAt: T0 }),
      ]);
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: ALREADY_ANSWERED },
      });
      expect(core.calls).toEqual([]);
    });

    it('releases the answer again when the new request is REFUSED, so it may be resumed', async () => {
      const { service, rows, core } = lydia([released()]);
      // An answer from core (a 4xx, as axios reports it): nothing was created at Lydia.
      core.createAnswer = Object.assign(new Error('refused'), {
        isAxiosError: true,
        response: { status: 400, data: { code: 'PAYMENT_PROVIDER_REFUSED' } },
      });
      await expect(resume(service)).rejects.toBeDefined();
      expect(rows[0]).toMatchObject({
        paymentStatus: 'cancelled',
        paymentRequestId: null,
        paymentCancelOrigin: 'unissued',
      });
      core.createAnswer = null;
      await expect(resume(service)).resolves.toMatchObject({ submissionId: 'ans' });
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // A RESUME SELLS ONLY WHAT A FRESH SUBMIT WOULD (review of #3949): judged again, NOW.
    it('refuses a person the form is no longer open to, before cancelling anything', async () => {
      const { service, rows, core } = lydia([released()], {
        submitCondition: { promo: [2024] },
      });
      await expect(resume(service)).rejects.toMatchObject({ status: 403 });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('expired');
    });

    it('refuses an answer whose price changed since, typed, issuing nothing', async () => {
      const { service, rows, core } = lydia([released()], { basePrice: 2000 });
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_PRICE_CHANGED },
      });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('expired');
    });

    it('refuses an answer whose combination closed since, with the submit code', async () => {
      const { service, core } = lydia([released()], {
        priceMatrix: {
          dimensions: [
            { id: 'd1', kind: 'promo', buckets: [{ id: 'b1', label: '1A', values: [2026] }] },
          ],
          cells: { b1: 1500, _others: null },
        },
      });
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: 'FORM_COMBINATION_UNAVAILABLE' },
      });
      expect(core.calls).toEqual([]);
    });

    it('refuses an answer whose price questions or lines changed at the same total', async () => {
      const moved = lydia([released({ priceLockedItemIds: ['size'] })]);
      await expect(resume(moved.service)).rejects.toMatchObject({
        response: { code: PAYMENT_PRICE_CHANGED },
      });
      const lined = lydia([released({ lines: [{ itemId: 'g', cents: 1500 }] })]);
      await expect(resume(lined.service)).rejects.toMatchObject({
        response: { code: PAYMENT_PRICE_CHANGED },
      });
      // Before 166 nothing was snapshotted: refused rather than guessed.
      const old = lydia([released({ priceLockedItemIds: null })]);
      await expect(resume(old.service)).rejects.toMatchObject({
        response: { code: PAYMENT_PRICE_CHANGED },
      });
      expect([moved, lined, old].flatMap((st) => st.core.calls)).toEqual([]);
    });

    it('refuses on a form taking several answers, which check never offers', async () => {
      const { service, core } = lydia([released()], { allowMultipleSubmissions: true });
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_RESUMABLE },
      });
      expect(core.calls).toEqual([]);
    });

    // A request named with no Business (before migration 120) can never be settled: not offered,
    // and refused as not resumable rather than "try again in 30 minutes" forever.
    it('refuses an answer whose old request records no Business', async () => {
      const { service, core } = lydia([released({ lydiaVendorToken: null })]);
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_RESUMABLE },
      });
      expect(core.calls).toEqual([]);
    });

    // A MANAGER'S CANCEL IS A DECISION: never offered back as a payment that failed.
    // FAIL CLOSED: an origin nothing recorded (before 179, or an older image during the rolling
    // deploy) may be a manager's decision or a timed-out issue still payable at Lydia.
    it.each([
      ['a manager', 'manager', PAYMENT_NOT_RESUMABLE],
      ['an issue whose outcome at Lydia is unknown', 'issue-unknown', PAYMENT_NOT_RESUMABLE],
      ['nobody recorded (NULL)', null, PAYMENT_NOT_RESUMABLE],
    ])('refuses a payment cancelled by %s', async (_label, origin, code) => {
      const { service, core } = lydia([
        released({ paymentStatus: 'cancelled', paymentCancelOrigin: origin }),
      ]);
      await expect(resume(service)).rejects.toMatchObject({ response: { code } });
      expect(core.calls).toEqual([]);
    });

    it.each(['member', 'provider', 'unissued'])(
      'resumes a payment cancelled by %s, and clears the origin',
      async (origin) => {
        const { service, rows } = lydia([
          released({ paymentStatus: 'cancelled', paymentCancelOrigin: origin }),
        ]);
        await resume(service);
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending', paymentCancelOrigin: null });
      }
    );

    it('records who cancelled: the submitter, a manager, the provider', async () => {
      const own = lydia([released({ paymentStatus: 'pending', paymentRequestedAt: T0 })]);
      own.core.cancelAnswer = 'cancelled';
      await own.service.cancelSubmission('ans', 'u1', false);
      expect(own.rows[0]).toMatchObject({
        paymentStatus: 'cancelled',
        paymentCancelOrigin: 'member',
      });

      const managed = lydia([released({ paymentStatus: 'pending', paymentRequestedAt: T0 })]);
      managed.core.cancelAnswer = 'cancelled';
      await managed.service.cancelSubmission('ans', 'admin', true);
      expect(managed.rows[0]).toMatchObject({
        paymentStatus: 'cancelled',
        paymentCancelOrigin: 'manager',
      });
    });

    // A TIMED-OUT ISSUE may have left a request at Lydia the row does not name: the answer KEEPS its
    // seat until its hold lapses (the next in line must not be promoted into a place that request
    // may claim), marked, and is NOT offered for a resume (a second payable request for one answer).
    it('keeps an answer whose issuing call failed after it was sent pending, as issue-unknown', async () => {
      const { service, rows, core } = lydia([released()]);
      core.createAnswer = new Error('socket hang up');
      await expect(resume(service)).rejects.toBeDefined();
      expect(rows[0]).toMatchObject({
        paymentStatus: 'pending',
        paymentRequestId: null,
        paymentCancelOrigin: 'issue-unknown',
      });
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_RESUMABLE },
      });
      expect(core.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
    });

    /** A failed call to core as axios reports one: `status` and `data` are core's answer. */
    const coreAnswered = (status: number, data: Record<string, unknown>) =>
      Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: { status, data },
      });

    // CODE, NEVER A STATUS CLASS (review of #3949): core once answered a request/do whose answer
    // timed out as an untyped 400 - Lydia may hold a payable request, so resuming would issue a
    // second one for the same answer. Fails if any 4xx is read as "nothing was created".
    it.each([
      ['an untyped 400 (a request/do timeout, as core once answered it)', 400],
      ['a 401', 401],
      ["core's 502 for a request/do with no answer", 502],
    ])('records %s as issue-unknown, and refuses to resume it', async (_label, status) => {
      const { service, rows, core } = lydia([released()]);
      core.createAnswer = coreAnswered(status, { message: 'Payment error: timeout' });
      await expect(resume(service)).rejects.toBeDefined();
      expect(rows[0]).toMatchObject({
        paymentStatus: 'pending',
        paymentRequestId: null,
        paymentCancelOrigin: 'issue-unknown',
      });
      await expect(resume(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_RESUMABLE },
      });
      expect(core.calls.filter((c) => c.route === 'create-checkout-session')).toHaveLength(1);
    });

    // The ONLY codes that promise nothing was created at Lydia (`CHECKOUT_REFUSAL_CODES`).
    it.each([
      'PAYMENT_PROVIDER_REFUSED',
      'LYDIA_BUSINESS_NOT_VALIDATED',
      'LYDIA_BUSINESS_BLOCKED',
      'AMOUNT_OUT_OF_RANGE',
      'CHECKOUT_REQUEST_INVALID',
    ])('records a typed %s refusal as unissued', async (code) => {
      const { service, rows, core } = lydia([released()]);
      core.createAnswer = coreAnswered(400, { code, message: 'refused' });
      await expect(resume(service)).rejects.toBeDefined();
      expect(rows[0]).toMatchObject({
        paymentStatus: 'cancelled',
        paymentRequestId: null,
        paymentCancelOrigin: 'unissued',
      });
    });

    // A resume core refused before calling Lydia (no payer e-mail it would send) created nothing:
    // the answer stays resumable, never `issue-unknown`.
    it('keeps an answer resumable when core refuses the resume with CHECKOUT_REQUEST_INVALID', async () => {
      const { service, rows, core } = lydia([released()]);
      core.createAnswer = coreAnswered(400, {
        code: 'CHECKOUT_REQUEST_INVALID',
        message: 'Lydia request/do requires payerRecipient (email or phone)',
      });
      await expect(resume(service)).rejects.toMatchObject({ status: 400 });
      expect(rows[0]).toMatchObject({
        paymentStatus: 'cancelled',
        paymentCancelOrigin: 'unissued',
      });
      core.createAnswer = null;
      await expect(resume(service)).resolves.toMatchObject({ submissionId: 'ans' });
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // THE WEBHOOK RACE: Lydia's callbacks about the OLD request land after the new one exists.
    // Neither may move the row, and the new payment is recorded once.
    it('ignores late callbacks of the old request and records the new payment once', async () => {
      const NEW_UUID = 'aabbccddeeff00112233445566778899';
      const { service, rows, core, transitions, purchaseRecordService } = lydia([released()]);
      await resume(service);
      // Lydia's real uuid shape on the new request, so the callbacks below read it.
      rows[0].stripeSessionId = NEW_UUID;
      const error = jest.spyOn((service as any).logger, 'error');

      // The old request's cancel/expire report: about a request the row no longer names.
      await expect(
        service.cancelPendingSubmission('ans', { requestId: '555' }, 'vendor')
      ).resolves.toEqual({ ok: true, outcome: 'other-request' });
      expect(rows[0].paymentStatus).toBe('pending');

      // The old request's confirm: accused, and only the row's OWN (new, still open) request read.
      core.stateAnswer = 'open';
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '555' });
      expect(core.calls[core.calls.length - 1].body).toEqual({
        sessionId: NEW_UUID,
        connectAccountId: 'vendor',
      });
      expect(rows[0].paymentStatus).toBe('pending');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('names request 555'));

      // The new request is paid: once, whatever replays follow.
      core.stateAnswer = 'paid';
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '1001' });
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '555' });
      await service.confirmPayment('ans');
      expect(rows[0].paymentStatus).toBe('paid');
      expect(transitions.filter((t) => t.endsWith('->paid'))).toEqual(['ans:pending->paid']);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    describe('what the form page is offered (check)', () => {
      it('offers the released answer with its own amount', async () => {
        const { service } = lydia([released()]);
        await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
          hasSubmitted: false,
          resumable: { submissionId: 'ans', amountCents: 1500 },
        });
      });

      it.each([
        [
          'a live payment (answered, in progress)',
          () => [released({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) })],
          {},
        ],
        [
          'an answer given since',
          () => [released(), row({ id: 'newer', paymentStatus: 'paid', createdAt: T0 })],
          {},
        ],
        [
          'a full form',
          () => [released(), row({ id: 'x', userId: 'u2', paymentStatus: 'paid' })],
          { maxSubmissions: 1 },
        ],
        ['a closed form', () => [released()], { closedAt: ago(1000) }],
        ['a cash answer', () => [released({ paymentMethod: 'cash' })], {}],
        [
          "a manager's cancel",
          () => [released({ paymentStatus: 'cancelled', paymentCancelOrigin: 'manager' })],
          {},
        ],
        ['an answer whose price changed', () => [released()], { basePrice: 2000 }],
        [
          'a person the form is closed to',
          () => [released()],
          { submitCondition: { promo: [2024] } },
        ],
        [
          'a cancel whose origin nothing recorded',
          () => [released({ paymentStatus: 'cancelled', paymentCancelOrigin: null })],
          {},
        ],
        ['an old request with no Business', () => [released({ lydiaVendorToken: null })], {}],
        ['a same-total price shift', () => [released({ priceLockedItemIds: ['size'] })], {}],
      ])('offers nothing for %s', async (_label, rowsOf, over) => {
        const { service } = lydia(rowsOf(), over);
        await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
          resumable: null,
        });
      });
    });
  });

  // "PAYER EN DIRECT" (owner decision of 2026-11-23): the SAME answer, whose card payment failed,
  // is settled in person instead - `pending_cash`, validated by a manager like any cash answer.
  describe('a failed card payment settled in person (owner decision of 2026-11-23)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    /** The caller's online answer, its request named by both ids. */
    const card = (over: Partial<Row> = {}) =>
      row({
        id: 'ans',
        paymentStatus: 'expired',
        paymentRequestedAt: ago(2 * HOLD_MS),
        paymentRequestId: '555',
        stripeSessionId: LYDIA_UUID,
        lines: null,
        priceLockedItemIds: [],
        paymentCancelOrigin: over.paymentStatus === 'cancelled' ? 'provider' : null,
        ...over,
      });
    const toCash = (service: FormsService, userId = 'u1') =>
      service.switchToCash({ kind: 'member', submissionId: 'ans', userId });
    const cashForm = (rows: Row[], over: Partial<Parameters<typeof makeStore>[0]> = {}) =>
      makeStore({
        maxSubmissions: 2,
        basePrice: 1500,
        provider: 'lydia',
        allowCashPayment: true,
        cashPaymentExpiryDays: 7,
        rows,
        ...over,
      });
    /** The switched row, as the manager and the hourly cash job will read it. */
    const expectWaitingForCash = (switched: Row, before: number) => {
      expect(switched).toMatchObject({
        paymentStatus: 'pending_cash',
        paymentMethod: 'cash',
        paymentCancelOrigin: null,
        // The online request stays named: the trace a late confirmation is matched against.
        paymentRequestId: '555',
        stripeSessionId: LYDIA_UUID,
        cashReminderNotifiedAt: null,
      });
      // The deadline of a direct cash answer: the form's days from the switch.
      const expires = switched.cashExpiresAt!.getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
      expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
      // The one notice before the hold ends, by the direct cash answer's own rule.
      expect(switched.cashReminderDueAt).toEqual(
        cashReminderDueAt(switched.cashExpiresAt!, new Date(expires - 7 * DAY_MS))
      );
    };
    /** The answers holding a seat once nothing is pending online. */
    const seated = (rows: Row[]) =>
      rows.filter((r) => ['paid', 'free', 'pending_cash'].includes(r.paymentStatus));

    it('keeps the seat of a payment still within its hold, the request settled at Lydia first', async () => {
      // The ONLY seat of the form is this live hold: a count would refuse it, the switch keeps it.
      const { service, rows, core, transitions } = cashForm(
        [card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) })],
        { maxSubmissions: 1 }
      );
      const before = Date.now();
      await expect(toCash(service)).resolves.toMatchObject({
        submissionId: 'ans',
        cashPayment: true,
      });
      // Settled while the row still named the request, before anything moved.
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request']);
      expect(core.calls[0].body).toEqual({ requestId: '555', connectAccountId: 'vendor' });
      expect(core.calls[0].rowIdsThen).toEqual([['ans', '555', LYDIA_UUID]]);
      expectWaitingForCash(rows[0], before);
      expect(transitions).toEqual(['ans:pending->pending_cash']);
      expect(seated(rows).map((r) => r.id)).toEqual(['ans']);
    });

    it.each([
      ['expired', 'cancelled'],
      ['cancelled', 'already-settled'],
    ] as const)(
      'switches a %s answer and re-takes a free seat under the form lock',
      async (status, cancelAnswer) => {
        const { service, rows, core, transitions } = cashForm([
          card({ paymentStatus: status }),
          row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
        ]);
        core.cancelAnswer = cancelAnswer;
        const before = Date.now();
        await toCash(service);
        expect(core.calls.map((c) => c.route)).not.toContain('create-checkout-session');
        expectWaitingForCash(rows[0], before);
        expect(transitions).toEqual([`ans:${status}->pending_cash`]);
        expect(seated(rows)).toHaveLength(2);
      }
    );

    it('switches a released answer that never named a request without asking Lydia', async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      await toCash(service);
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('pending_cash');
    });

    // NEVER A SEAT OUT OF NOTHING: a released answer counts like a fresh cash submit.
    it('refuses a released answer on a full form, FORM_FULL, the row unchanged', async () => {
      const { service, rows, transitions } = cashForm(
        [card(), row({ id: 'other', userId: 'u2', paymentStatus: 'paid' })],
        { maxSubmissions: 1 }
      );
      await expect(toCash(service)).rejects.toMatchObject({ response: { code: 'FORM_FULL' } });
      expect(rows[0]).toMatchObject({ paymentStatus: 'expired', paymentMethod: null });
      expect(transitions).toEqual([]);
    });

    it('refuses on a form that does not take cash, asking Lydia nothing', async () => {
      const { service, rows, core } = cashForm([card()], { allowCashPayment: false });
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: FORM_CASH_NOT_OFFERED },
      });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('expired');
    });

    // NO DOUBLE PAYMENT: the payer paid in the Lydia app after all.
    it('records the request PAID and switches nothing when it was paid meanwhile', async () => {
      const { service, rows, core } = cashForm([card()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      await expect(toCash(service)).resolves.toEqual({ submissionId: 'ans', alreadyPaid: true });
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentMethod: null });
    });

    it.each([
      ['a request still open', 'open' as const],
      ['a request it cannot read', new Error('core down')],
    ])('refuses on %s (PREVIOUS_PAYMENT_OPEN), the row unchanged', async (_l, state) => {
      const { service, rows, transitions, core } = cashForm([card()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = state;
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: PREVIOUS_PAYMENT_OPEN },
      });
      expect(rows[0].paymentStatus).toBe('expired');
      expect(transitions).toEqual([]);
    });

    it('refuses a live payment whose request is being issued (it names none yet)', async () => {
      const { service, rows, core } = cashForm([
        card({
          paymentStatus: 'pending',
          paymentRequestedAt: ago(1000),
          paymentRequestId: null,
          stripeSessionId: null,
        }),
      ]);
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: PAYMENT_IN_PROGRESS },
      });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe('pending');
    });

    // IDEMPOTENT FROM THE ROW: the second press reads `pending_cash` and answers the same.
    it('answers a second press with the same result, asking nothing and moving nothing', async () => {
      const { service, core, transitions } = cashForm([card()]);
      const first = await toCash(service);
      const calls = core.calls.length;
      await expect(toCash(service)).resolves.toEqual(first);
      expect(core.calls).toHaveLength(calls);
      expect(transitions).toEqual(['ans:expired->pending_cash']);
    });

    it('moves the row ONCE for two simultaneous presses, both answered the same', async () => {
      const { service, transitions } = cashForm([card()]);
      const [a, b] = await Promise.all([toCash(service), toCash(service)]);
      expect(a).toEqual(b);
      expect(transitions).toEqual(['ans:expired->pending_cash']);
    });

    it.each([
      ['paid', 'paid'],
      ['paid over capacity', 'paid_over_capacity'],
    ])('answers an answer %s online "already paid", asking Lydia nothing', async (_l, status) => {
      const { service, rows, core, transitions } = cashForm([card({ paymentStatus: status })]);
      await expect(toCash(service)).resolves.toEqual({ submissionId: 'ans', alreadyPaid: true });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe(status);
      expect(transitions).toEqual([]);
    });

    it('answers a second press after the request was found paid "already paid" again', async () => {
      const { service, core } = cashForm([card()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      await expect(toCash(service)).resolves.toEqual({ submissionId: 'ans', alreadyPaid: true });
      const calls = core.calls.length;
      await expect(toCash(service)).resolves.toEqual({ submissionId: 'ans', alreadyPaid: true });
      expect(core.calls).toHaveLength(calls);
    });

    it.each([
      ['a refunded answer', { paymentStatus: 'refunded' }],
      ['a free answer', { paymentStatus: 'free', totalPaid: 0 }],
      ['an expired cash answer', { paymentStatus: 'expired', paymentMethod: 'cash' }],
      ["a manager's cancel", { paymentStatus: 'cancelled', paymentCancelOrigin: 'manager' }],
      [
        'an issue whose outcome at Lydia is unknown',
        { paymentStatus: 'cancelled', paymentCancelOrigin: 'issue-unknown' },
      ],
      ['a cancel nobody recorded', { paymentStatus: 'cancelled', paymentCancelOrigin: null }],
      ['a request with no Business', { lydiaVendorToken: null }],
    ])('refuses %s as having nothing to switch, asking Lydia nothing', async (_l, over) => {
      const { service, rows, core, transitions } = cashForm([card(over as Partial<Row>)]);
      const status = rows[0].paymentStatus;
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_SWITCHABLE },
      });
      expect(core.calls).toEqual([]);
      expect(rows[0].paymentStatus).toBe(status);
      expect(transitions).toEqual([]);
    });

    it('refuses an anonymous form, which never charges, as having nothing to switch', async () => {
      const { service, core } = cashForm([card()], { anonymous: true });
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: PAYMENT_NOT_SWITCHABLE },
      });
      expect(core.calls).toEqual([]);
    });

    it('answers the answer of another person as missing', async () => {
      const { service, core } = cashForm([card()]);
      await expect(toCash(service, 'u2')).rejects.toMatchObject({ status: 404 });
      expect(core.calls).toEqual([]);
    });

    it.each([
      ['a closed form', { closedAt: ago(1000) }, 'FORM_CLOSED'],
      ['a price changed since', { basePrice: 2000 }, PAYMENT_PRICE_CHANGED],
    ])('refuses on %s before asking Lydia anything', async (_l, over, code) => {
      const { service, core } = cashForm([card()], over);
      await expect(toCash(service)).rejects.toMatchObject({ response: { code } });
      expect(core.calls).toEqual([]);
    });

    it('refuses when the person has answered again since, before cancelling anything', async () => {
      const { service, core } = cashForm([
        card(),
        row({ id: 'newer', paymentStatus: 'paid', createdAt: T0 }),
      ]);
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: ALREADY_ANSWERED },
      });
      expect(core.calls).toEqual([]);
    });

    // THE SEAT IS KEPT CONTINUOUSLY (owner): the cancel the switch makes at Lydia makes Lydia call
    // back, and the payer's return poll may read the request dead, while a third person submits on
    // the full form. The row is CLAIMED before the call: both release paths leave it, the third
    // submit counts the held seat - nothing is ever released.
    it('never releases a claimed seat to its own cancel, the poll, or a third submit', async () => {
      const { service, rows, core, transitions, claims } = cashForm(
        [card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) })],
        { maxSubmissions: 1 }
      );
      let during: unknown[] = [];
      core.duringCancel = async () => {
        // Each racer COMPLETES while the call is pending: nothing waits on the switch.
        during = await Promise.all([
          service.cancelPendingSubmission('ans', { requestId: '555' }, 'vendor'),
          service.confirmPayment('ans'),
          service.submit('f1', { userId: 'u2', answers: {} } as any).catch((e: unknown) => e),
        ]);
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending' });
        expect(rows[0].cashSwitchClaimId).toEqual(expect.any(String));
      };
      await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      const [cancelled, polled, third] = during;
      expect(cancelled).toMatchObject({ ok: true });
      expect(polled).toMatchObject({ paymentStatus: 'pending' });
      expect(third).toMatchObject({ response: { code: 'FORM_FULL' } });
      expect(claims).toEqual(['ans:claimed']);
      expect(transitions).toEqual(['ans:pending->pending_cash']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending_cash', cashSwitchClaimId: null });
    });

    // A SECOND PRESS ADOPTS THE CLAIM (third review of #4019, D1): press 2 arrives while press 1 is
    // mid-call, its own settle is refused (Lydia unreadable) - and its refusal must not clear press
    // 1's claim, or the cancel callback releases the seat and press 1 finishes on a released row.
    it("keeps the seat when a second press's settle is refused while the first is mid-call", async () => {
      const { service, rows, core, transitions } = cashForm(
        [card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) })],
        { maxSubmissions: 1 }
      );
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      let second: unknown;
      let third: unknown;
      core.duringCancel = async () => {
        core.duringCancel = null;
        const claimOfFirst = rows[0].cashSwitchClaimId;
        core.cancelAnswer = new Error('core down');
        core.stateAnswer = new Error('core down');
        second = await toCash(service).catch((e: unknown) => e);
        // Adopted, not overwritten, and not cleared by the second press's refusal.
        expect(rows[0].cashSwitchClaimId).toBe(claimOfFirst);
        core.cancelAnswer = 'cancelled';
        core.stateAnswer = 'cancelled-or-expired';
        await service.cancelPendingSubmission('ans', { requestId: '555' }, 'vendor');
        third = await service
          .submit('f1', { userId: 'u2', answers: {} } as any)
          .catch((e: unknown) => e);
      };
      await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      expect(second).toMatchObject({ response: { code: PREVIOUS_PAYMENT_OPEN } });
      expect(third).toMatchObject({ response: { code: 'FORM_FULL' } });
      expect(transitions).toEqual(['ans:pending->pending_cash']);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending_cash', cashSwitchClaimId: null });
    });

    // A crash between a settle that read `paid` and the release: the payment clears the claim.
    it('clears a switch claim when the payment is recorded', async () => {
      const { service, rows } = cashForm([
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) }),
      ]);
      rows[0].cashSwitchClaimId = 'left-by-a-crash';
      await service.markPaid('ans', '555');
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', cashSwitchClaimId: null });
    });

    // NO LOCK ACROSS THE PROVIDER CALL (review of #4019): a slow Lydia never holds up the form's
    // other submits, nor the expiry sweep - even on this very row, whose hold lapses mid-call.
    it('lets another submit and the expiry sweep complete while the call to Lydia is pending', async () => {
      const { service, rows, core, advance } = cashForm(
        [
          card({ paymentStatus: 'pending', paymentRequestedAt: ago(HOLD_MS - 1000) }),
          row({ id: 'stale', userId: 'u3', paymentRequestedAt: ago(2 * HOLD_MS) }),
        ],
        { maxSubmissions: 5, provider: 'disabled' }
      );
      core.duringCancel = async () => {
        advance(2000);
        const sweep = await service.expireStalePendingPayments(ago(HOLD_MS - 2000));
        expect(sweep).toBe(2);
        await expect(
          service.submit('f1', { userId: 'u2', answers: {} } as any).catch((e: unknown) => e)
        ).resolves.toBeDefined();
        // The sweep ended the claim with the hold it protected.
        expect(rows[0]).toMatchObject({ paymentStatus: 'expired', cashSwitchClaimId: null });
      };
      await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      expect(rows.find((r) => r.userId === 'u2')).toBeDefined();
      expect(rows[0].paymentStatus).toBe('pending_cash');
    });

    // A resume or a submit's retry of the same answer during the call never takes it from under
    // the switch: the claimed row is refused, the switch finishes.
    it('refuses a resume of a claimed row whose hold lapsed during the call', async () => {
      const { service, rows, core, advance } = cashForm([
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(HOLD_MS - 1000) }),
      ]);
      let resumed: unknown;
      core.duringCancel = async () => {
        core.duringCancel = null;
        advance(2000);
        resumed = await service
          .resumePayment('ans', 'u1', { payerEmail: 'payer@example.org' })
          .catch((e: unknown) => e);
      };
      await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      expect(resumed).toMatchObject({ response: { code: PAYMENT_IN_PROGRESS } });
      expect(rows[0].paymentStatus).toBe('pending_cash');
      expect(core.calls.map((c) => c.route)).not.toContain('create-checkout-session');
    });

    it("refuses a submit's retry of a claimed row, and the switch finishes", async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) }),
      ]);
      let retried: unknown;
      core.duringCancel = async () => {
        core.duringCancel = null;
        retried = await service
          .submit('f1', { userId: 'u1', answers: {}, payerEmail: 'p@example.org' } as any)
          .catch((e: unknown) => e);
      };
      await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      expect(retried).toMatchObject({ response: { code: PREVIOUS_PAYMENT_OPEN } });
      expect(rows).toHaveLength(1);
      expect(rows[0].paymentStatus).toBe('pending_cash');
    });

    // A person's own cancel during their switch is told the switch is the payment in progress.
    it("answers the payer's own cancel of a claimed row PAYMENT_IN_PROGRESS", async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) }),
      ]);
      let mine: unknown;
      core.duringCancel = async () => {
        core.duringCancel = null;
        mine = await service.cancelSubmission('ans', 'u1', false).catch((e: unknown) => e);
      };
      await toCash(service);
      expect(mine).toMatchObject({ response: { code: PAYMENT_IN_PROGRESS } });
      expect(rows[0].paymentStatus).toBe('pending_cash');
    });

    // A CLAIM A CRASH LEAVES (the process dies during the call): the release paths still leave the
    // row; the next press re-drives it to the end; or the hold ends and the sweep clears it.
    describe('a claim a crash left', () => {
      const crashed = async (over: Partial<Parameters<typeof makeStore>[0]> = {}) => {
        const store = cashForm(
          [card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) })],
          over
        );
        // The press never comes back from Lydia: everything after the claim is lost.
        store.core.duringCancel = () => new Promise<never>(() => undefined);
        void toCash(store.service);
        for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
        expect(store.rows[0].cashSwitchClaimId).toEqual(expect.any(String));
        store.core.duringCancel = null;
        return store;
      };

      it('keeps the seat from the cancel callback, and the next press finishes the switch', async () => {
        const { service, rows, transitions } = await crashed({ maxSubmissions: 1 });
        await service.cancelPendingSubmission('ans', { requestId: '555' }, 'vendor');
        expect(rows[0].paymentStatus).toBe('pending');
        await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending_cash', cashSwitchClaimId: null });
        expect(transitions).toEqual(['ans:pending->pending_cash']);
      });

      it('ends with the hold: the sweep expires the row and clears the claim', async () => {
        const { service, rows, advance } = await crashed();
        advance(HOLD_MS);
        expect(await service.expireStalePendingPayments(ago(0))).toBe(1);
        expect(rows[0]).toMatchObject({ paymentStatus: 'expired', cashSwitchClaimId: null });
        // An ordinary released answer again: the payer may resume or switch it.
        await expect(toCash(service)).resolves.toMatchObject({ cashPayment: true });
      });
    });

    // The ceiling re-read under the form lock: a live guest row whose visitor key was forgotten
    // takes the presser's, and answers that appeared during the call are counted.
    it('re-checks the guest ceiling under the lock when the row takes the presser key', async () => {
      const VISITOR = '203.0.113.9';
      const RECEIPT = 'A'.repeat(43);
      const saved = process.env.INTERNAL_SECRET;
      process.env.INTERNAL_SECRET = 'internal-secret-for-test';
      try {
        const { service, rows, core } = cashForm(
          [
            card({
              userId: null,
              guestReceiptHash: hashGuestReceipt(RECEIPT),
              paymentStatus: 'pending',
              paymentRequestedAt: ago(60_000),
              guestVisitorKey: null,
            }),
          ],
          { isPublic: true, allowMultipleSubmissions: true, grantsCotisation: false }
        );
        const key = guestVisitorKey('f1', VISITOR);
        core.duringCancel = async () => {
          for (let i = 0; i < GUEST_PENDING_CEILING; i += 1) {
            rows.push(
              row({
                id: `w${i}`,
                userId: null,
                paymentStatus: 'pending_cash',
                paymentMethod: 'cash',
                guestVisitorKey: key,
              })
            );
          }
        };
        await expect(service.switchGuestToCash(RECEIPT, VISITOR)).rejects.toMatchObject({
          response: { code: GUEST_PENDING_LIMIT },
        });
        // Refused: the claim is cleared, the row is the payer's again.
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending', cashSwitchClaimId: null });
      } finally {
        if (saved === undefined) delete process.env.INTERNAL_SECRET;
        else process.env.INTERNAL_SECRET = saved;
      }
    });

    it('answers PREVIOUS_PAYMENT_OPEN, never a bare 500, when recording a paid request fails', async () => {
      const { service, core } = cashForm([card()]);
      core.cancelAnswer = 'already-settled';
      core.stateAnswer = 'paid';
      jest.spyOn(service, 'markPaid').mockRejectedValueOnce(new Error('connection lost'));
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: PREVIOUS_PAYMENT_OPEN },
      });
    });

    // A hold that ENDS during the call to Lydia (read at the wall clock after it) holds no seat any
    // more: the row re-takes one under the form lock like any released answer.
    it('re-takes a seat with the capacity check when the hold ended during the call', async () => {
      const lapsing = () => [
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(HOLD_MS - 1000) }),
        row({ id: 'other', userId: 'u2', paymentStatus: 'paid' }),
      ];
      const free = cashForm(lapsing(), { maxSubmissions: 2 });
      free.core.duringCancel = async () => free.advance(2000);
      await expect(toCash(free.service)).resolves.toMatchObject({ cashPayment: true });
      expect(free.transitions).toEqual(['ans:pending->pending_cash']);

      const taken = cashForm(lapsing(), { maxSubmissions: 2 });
      taken.core.duringCancel = async () => {
        taken.advance(2000);
        // The seat the lapsed hold freed is taken by someone else meanwhile.
        taken.rows.push(row({ id: 'third', userId: 'u3', paymentStatus: 'paid' }));
      };
      // The card request is already cancelled: told as what happened to the payer.
      await expect(toCash(taken.service)).rejects.toMatchObject({
        response: { code: CASH_SWITCH_LOST_AFTER_CANCEL },
      });
      expect(taken.rows[0].paymentStatus).toBe('pending');
    });

    it('answers an association archived DURING the call as the cash switch lost after the cancel', async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'pending', paymentRequestedAt: ago(60_000) }),
      ]);
      jest
        .spyOn(service as any, 'assertAssociationLiveUnderLock')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new NotFoundException('Form not found'));
      await expect(toCash(service)).rejects.toMatchObject({
        response: { code: CASH_SWITCH_LOST_AFTER_CANCEL },
      });
      expect(core.calls.map((c) => c.route)).toEqual(['cancel-request']);
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', cashSwitchClaimId: null });
    });

    // NEVER A CASH ANSWER UNDER A REQUEST BEING ISSUED: tab A resumes the released answer (pending,
    // naming none, the request being created), tab B pressed "Payer en direct" on the row it read
    // released. Under the lock B finds the row moved INTO pending and refuses.
    it('refuses a switch on a row a resume reopened since it was read', async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      const stale = { ...rows[0] };
      let switched: unknown;
      core.duringCreate = async () => {
        jest.spyOn(service as any, 'cashSwitchRow').mockResolvedValueOnce(stale);
        switched = await toCash(service).catch((e: unknown) => e);
      };
      await expect(
        service.resumePayment('ans', 'u1', { payerEmail: 'payer@example.org' })
      ).resolves.toMatchObject({ checkoutUrl: expect.any(String) });
      expect(switched).toMatchObject({ response: { code: PAYMENT_IN_PROGRESS } });
      expect(rows[0]).toMatchObject({ paymentStatus: 'pending', paymentRequestId: '1001' });
    });

    // The issuing write is CONDITIONAL: a row moved off `pending` while its request was created
    // never gets that request written onto it, nor its URL handed out - the request is cancelled.
    it('withholds and cancels a request created for a row that moved meanwhile', async () => {
      const { service, rows, core } = cashForm([
        card({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      const error = jest.spyOn((service as any).logger, 'error');
      core.duringCreate = async () => {
        Object.assign(rows[0], { paymentStatus: 'pending_cash', paymentMethod: 'cash' });
      };
      await expect(
        service.resumePayment('ans', 'u1', { payerEmail: 'payer@example.org' })
      ).rejects.toMatchObject({ response: { code: PAYMENT_NOT_RESUMABLE } });
      expect(rows[0]).toMatchObject({
        paymentStatus: 'pending_cash',
        paymentRequestId: null,
        stripeSessionId: null,
      });
      expect(core.calls[core.calls.length - 1]).toMatchObject({
        route: 'cancel-request',
        body: { requestId: '1001', connectAccountId: 'vendor' },
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('its URL withheld'));
    });

    it('answers a SUBMIT whose row moved during the issue PAYMENT_ISSUE_WITHDRAWN', async () => {
      const { service, rows, core } = cashForm([], { maxSubmissions: 5 });
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      core.duringCreate = async () => {
        Object.assign(rows[0], { paymentStatus: 'expired' });
      };
      await expect(
        service.submit('f1', { userId: 'u1', answers: {}, payerEmail: 'p@example.org' } as any)
      ).rejects.toMatchObject({ response: { code: PAYMENT_ISSUE_WITHDRAWN } });
      expect(core.calls[core.calls.length - 1]).toMatchObject({ route: 'cancel-request' });
    });

    // An orphan whose cancel FAILED may still be paid: it is named on the row (which names none),
    // so the confirm callback reads it and every resume or switch settles it first.
    it('names an orphan request it could not cancel on the row, which settles it first', async () => {
      const { service, rows, core, purchaseRecordService } = cashForm([
        card({ paymentStatus: 'cancelled', paymentRequestId: null, stripeSessionId: null }),
      ]);
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      core.duringCreate = async () => {
        Object.assign(rows[0], { paymentStatus: 'expired' });
        core.cancelAnswer = new Error('core down');
      };
      await expect(
        service.resumePayment('ans', 'u1', { payerEmail: 'payer@example.org' })
      ).rejects.toMatchObject({ response: { code: PAYMENT_NOT_RESUMABLE } });
      expect(rows[0]).toMatchObject({
        paymentStatus: 'expired',
        paymentRequestId: '1001',
        stripeSessionId: 'uuid-1',
      });
      // The next resume settles THAT request at Lydia before it issues anything.
      core.duringCreate = null;
      core.cancelAnswer = 'cancelled';
      const before = core.calls.length;
      await service.resumePayment('ans', 'u1', { payerEmail: 'payer@example.org' });
      expect(core.calls[before]).toMatchObject({
        route: 'cancel-request',
        body: { requestId: '1001' },
      });
      expect(purchaseRecordService.create).not.toHaveBeenCalled();
    });

    // Refusals that would come after the irreversible cancel are judged BEFORE it.
    it('refuses an archived association before cancelling anything at Lydia', async () => {
      const { service, core } = cashForm([card()]);
      jest
        .spyOn(service as any, 'assertAssociationLiveUnderLock')
        .mockRejectedValueOnce(new NotFoundException('Form not found'));
      await expect(toCash(service)).rejects.toMatchObject({ status: 404 });
      expect(core.calls).toEqual([]);
    });

    // A LATE CONFIRMATION, which the settle makes unexpected, is decided from the row all the same:
    // the money landed online, so the answer is paid online and its cash hold ends.
    it('records a late online confirmation after the switch as paid online, once', async () => {
      const { service, rows, core, transitions, purchaseRecordService } = cashForm([card()]);
      await toCash(service);
      // The switch's own cancel callback: about the request the row names, read nothing, moved nothing.
      await expect(
        service.cancelPendingSubmission('ans', { requestId: '555' }, 'vendor')
      ).resolves.toEqual({ ok: true, outcome: 'nothing-to-read (pending_cash)' });
      // The payer's return poll asks Lydia nothing about a cash answer.
      const before = core.calls.length;
      await service.confirmPayment('ans');
      expect(core.calls).toHaveLength(before);
      // A VERIFIED confirm callback is read: Lydia says paid. Then replayed. Accused at ERROR:
      // cash may have been handed over too.
      const error = jest.spyOn((service as any).logger, 'error');
      core.stateAnswer = 'paid';
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '555' });
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '555' });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('if cash was also handed over, a refund is owed')
      );
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentMethod: null });
      expect(transitions).toEqual(['ans:expired->pending_cash', 'ans:pending_cash->paid']);
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
      // The cash hold is over: a manager's validation is told the answer was paid online, accused.
      await expect(service.validateCashPayment('f1', 'ans', 'admin', true)).rejects.toMatchObject({
        response: { code: CASH_ALREADY_PAID_ONLINE },
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('a refund is owed'));
      expect(purchaseRecordService.create).toHaveBeenCalledTimes(1);
    });

    it('accuses at ERROR a confirmation of the old request once the answer was paid in cash', async () => {
      const { service, rows, core } = cashForm([card()]);
      await toCash(service);
      await service.validateCashPayment('f1', 'ans', 'admin', true);
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentMethod: 'cash' });
      const error = jest.spyOn((service as any).logger, 'error');
      const before = core.calls.length;
      await service.confirmPaymentFromCallback('ans', { vendorToken: 'vendor', requestId: '555' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('TWO PAYMENTS'));
      expect(core.calls).toHaveLength(before);
      expect(rows[0]).toMatchObject({ paymentStatus: 'paid', paymentMethod: 'cash' });
    });

    describe('a guest, by the receipt', () => {
      const VISITOR = '203.0.113.9';
      const RECEIPT = 'A'.repeat(43);
      const savedSecret = process.env.INTERNAL_SECRET;
      beforeAll(() => (process.env.INTERNAL_SECRET = 'internal-secret-for-test'));
      afterAll(() => {
        if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
        else process.env.INTERNAL_SECRET = savedSecret;
      });
      const guestCard = (over: Partial<Row> = {}) =>
        card({ userId: null, guestReceiptHash: hashGuestReceipt(RECEIPT), ...over });
      const guestForm = (rows: Row[], over: Partial<Parameters<typeof makeStore>[0]> = {}) =>
        cashForm(rows, {
          isPublic: true,
          allowMultipleSubmissions: true,
          grantsCotisation: false,
          ...over,
        });

      it('switches the answer the receipt proves, counted on this visitor, no notice owed', async () => {
        const { service, rows } = guestForm([guestCard()]);
        await expect(service.switchGuestToCash(RECEIPT, VISITOR)).resolves.toEqual({
          reference: guestReference('ans'),
          formId: 'f1',
          totalPaid: 1500,
          currency: 'eur',
          paymentStatus: 'pending_cash',
        });
        expect(rows[0]).toMatchObject({
          paymentStatus: 'pending_cash',
          guestVisitorKey: guestVisitorKey('f1', VISITOR),
          // A guest has no account to be told on.
          cashReminderDueAt: null,
        });
      });

      it('refuses a public form with no cash deadline (a guest cash answer must expire)', async () => {
        const { service, core } = guestForm([guestCard()], { cashPaymentExpiryDays: null });
        await expect(service.switchGuestToCash(RECEIPT, VISITOR)).rejects.toMatchObject({
          response: { code: FORM_CASH_NOT_OFFERED },
        });
        expect(core.calls).toEqual([]);
      });

      it('refuses past the ceiling of answers one visitor may leave waiting', async () => {
        const key = guestVisitorKey('f1', VISITOR);
        const waiting = Array.from({ length: GUEST_PENDING_CEILING }, (_, i) =>
          row({
            id: `w${i}`,
            userId: null,
            paymentStatus: 'pending_cash',
            paymentMethod: 'cash',
            guestVisitorKey: key,
          })
        );
        const { service, rows, core } = guestForm([guestCard(), ...waiting], {
          maxSubmissions: null,
        });
        await expect(service.switchGuestToCash(RECEIPT, VISITOR)).rejects.toMatchObject({
          response: { code: GUEST_PENDING_LIMIT },
        });
        expect(rows[0].paymentStatus).toBe('expired');
        // Judged BEFORE the irreversible cancel: the online request is left as it was.
        expect(core.calls).toEqual([]);
      });

      it("keeps a waiting answer's own visitor key, whoever presses", async () => {
        const answered = guestVisitorKey('f1', '198.51.100.1');
        const { service, rows } = guestForm([
          guestCard({
            paymentStatus: 'pending',
            paymentRequestedAt: ago(60_000),
            guestVisitorKey: answered,
          }),
        ]);
        await service.switchGuestToCash(RECEIPT, VISITOR);
        expect(rows[0]).toMatchObject({ paymentStatus: 'pending_cash', guestVisitorKey: answered });
      });

      it.each([
        ['an unknown receipt', 'B'.repeat(43)],
        ['a malformed one', 'short'],
        ['a submission id', 'ans'],
      ])('answers %s as a receipt that matches nothing', async (_l, receipt) => {
        const { service, core } = guestForm([guestCard()]);
        await expect(service.switchGuestToCash(receipt, VISITOR)).rejects.toMatchObject({
          status: 404,
        });
        expect(core.calls).toEqual([]);
      });

      it('offers it on the receipt page only where the switch would take it', async () => {
        const offered = guestForm([guestCard({ paymentStatus: 'cancelled' })]);
        await expect(offered.service.confirmGuestReceipt(RECEIPT)).resolves.toMatchObject({
          cashSwitchOffered: true,
        });
        const noDeadline = guestForm([guestCard({ paymentStatus: 'cancelled' })], {
          cashPaymentExpiryDays: null,
        });
        await expect(noDeadline.service.confirmGuestReceipt(RECEIPT)).resolves.not.toHaveProperty(
          'cashSwitchOffered'
        );
        const paid = guestForm([guestCard({ paymentStatus: 'paid' })]);
        await expect(paid.service.confirmGuestReceipt(RECEIPT)).resolves.not.toHaveProperty(
          'cashSwitchOffered'
        );
      });
    });

    describe('what the form page is offered (check)', () => {
      it('offers the released answer both ways when the form takes both', async () => {
        const { service } = cashForm([card()]);
        await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
          resumable: { submissionId: 'ans', amountCents: 1500 },
          cashSwitchable: { submissionId: 'ans', amountCents: 1500 },
        });
      });

      it('offers it in person only when the editor took online payment off', async () => {
        const { service } = cashForm([card()], { allowOnlinePayment: false });
        await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
          resumable: null,
          cashSwitchable: { submissionId: 'ans', amountCents: 1500 },
        });
      });

      it.each([
        ['a form taking no cash', () => [card()], { allowCashPayment: false }],
        [
          'a full form',
          () => [card(), row({ id: 'x', userId: 'u2', paymentStatus: 'paid' })],
          { maxSubmissions: 1 },
        ],
        [
          "a manager's cancel",
          () => [card({ paymentStatus: 'cancelled', paymentCancelOrigin: 'manager' })],
          {},
        ],
        ['an answer whose price changed', () => [card()], { basePrice: 2000 }],
      ])('offers nothing in person for %s', async (_l, rowsOf, over) => {
        const { service } = cashForm(rowsOf(), over);
        await expect(service.hasSubmission('f1', 'u1')).resolves.toMatchObject({
          cashSwitchable: null,
        });
      });
    });
  });

  describe('the answers the organiser reads (holdsSeat)', () => {
    it('flags each answer with the SAME predicate the seat count uses', async () => {
      const { service } = makeStore({
        maxSubmissions: 10,
        rows: [
          row({ id: 'paid', userId: null, paymentStatus: 'paid' }),
          row({ id: 'cancelled', userId: null, paymentStatus: 'cancelled' }),
          row({ id: 'expired', userId: null, paymentStatus: 'expired' }),
          row({ id: 'inside', userId: null, paymentRequestedAt: ago(HOLD_MS - 1000) }),
          row({ id: 'past', userId: null, paymentRequestedAt: ago(HOLD_MS + 1000) }),
        ],
      });
      const read = await service.getSubmissions('f1');
      const flags = Object.fromEntries(read.map((s: any) => [s.id, s.holdsSeat]));
      expect(flags).toEqual({
        paid: true,
        cancelled: false,
        expired: false,
        inside: true,
        past: false,
      });
      expect(read.filter((s: any) => s.holdsSeat)).toHaveLength(
        (await service.get('f1')).submissionCount as number
      );
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

  /** Lydia's error 5 / 2701 on a form's request/do (lot 2): the HOLDER stops being ready. */
  describe('a request/do refused on the Business itself', () => {
    const savedSecret = process.env.INTERNAL_SECRET;
    // A guest's visitor key is an HMAC under the internal secret (`guest-visitor.ts`).
    beforeAll(() => (process.env.INTERNAL_SECRET = 'internal-secret-for-test'));
    afterAll(() => {
      if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = savedSecret;
    });
    const refusedBy = (code: string) =>
      Object.assign(new Error('refused'), {
        response: { status: 400, data: { code, providerCode: '5' } },
      });

    it.each([
      [
        'member',
        'LYDIA_BUSINESS_NOT_VALIDATED',
        'request-refused',
        'PAYMENTS_NOT_ACTIVATED',
        'form',
      ],
      ['guest', 'LYDIA_BUSINESS_BLOCKED', 'request-blocked', 'PAYMENTS_BLOCKED', 'form-guest'],
    ])(
      'a %s submit: the row released, the holder reverted on %s (%s), the typed 409 %s',
      async (who, coreCode, cause, payerCode, path) => {
        const guest = who === 'guest';
        const { service, rows, core, associationsService } = makeStore({
          maxSubmissions: 5,
          rows: [],
          basePrice: 1500,
          provider: 'lydia',
          isPublic: guest,
          allowMultipleSubmissions: true,
          grantsCotisation: false,
        });
        core.createAnswer = refusedBy(coreCode);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        const err = await (
          guest
            ? service.submit(
                'f1',
                { payerEmail: 'guest@example.org', answers: {} } as any,
                'guest',
                '203.0.113.7'
              )
            : service.submit('f1', { userId: 'u1', answers: {} } as any)
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({ code: payerCode });
        expect(rows.map((r) => r.paymentStatus)).toEqual(['cancelled']);
        expect(associationsService.revertLydiaReadinessAfterRefusal).toHaveBeenCalledWith(
          'vendor',
          cause,
          { path, id: rows[0].id }
        );
      }
    );

    it('a bridge switch back re-issues the SAME answer ONCE on the historical account, a new order_ref', async () => {
      const { service, rows, core, associationsService } = makeStore({
        maxSubmissions: 5,
        rows: [],
        basePrice: 1500,
        provider: 'lydia',
        allowMultipleSubmissions: true,
        grantsCotisation: false,
      });
      core.createAnswer = refusedBy('LYDIA_BUSINESS_NOT_VALIDATED');
      // Error 5 on a bridge's just-switched Business: switched back, the historical account collects.
      associationsService.getPaymentAccountId
        .mockResolvedValueOnce('vendor-enrolled')
        .mockResolvedValueOnce('vendor-historical');
      associationsService.revertLydiaReadinessAfterRefusal.mockImplementationOnce(async () => {
        core.createAnswer = null;
        return true;
      });
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const answer = await service.submit('f1', { userId: 'u1', answers: {} } as any);
      expect(answer).toMatchObject({ checkoutUrl: 'https://lydia.example/pay/1' });
      const issued = core.calls.filter((c) => c.route === 'create-checkout-session');
      expect(issued.map((c) => c.body.connectAccountId)).toEqual([
        'vendor-enrolled',
        'vendor-historical',
      ]);
      expect(issued[0].body.idempotencyKey).not.toBe(issued[1].body.idempotencyKey);
      expect(associationsService.revertLydiaReadinessAfterRefusal).toHaveBeenCalledTimes(1);
      expect(rows[0]).toMatchObject({
        lydiaVendorToken: 'vendor-historical',
        lydiaOrderRef: issued[1].body.idempotencyKey,
      });
    });

    it('any other refusal reverts nothing', async () => {
      const { service, core, associationsService } = makeStore({
        maxSubmissions: 5,
        rows: [],
        basePrice: 1500,
        provider: 'lydia',
      });
      core.createAnswer = refusedBy('PAYMENT_PROVIDER_REFUSED');
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      await service.submit('f1', { userId: 'u1', answers: {} } as any).catch(() => undefined);
      expect(associationsService.revertLydiaReadinessAfterRefusal).not.toHaveBeenCalled();
    });
  });
});
