import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FormsService } from './forms.service';
import { FORM_DRAFT, FORM_PUBLISHED } from './form-status';
import {
  FORM_DRAFT_CONFLICT,
  FORM_DRAFT_EMPTY,
  FORM_DRAFT_INVALID,
  FORM_DRAFT_MALFORMED,
} from './form-draft-revision';
import { FORM_PAYMENTS_NOT_READY } from './payment-offer';

/**
 * THE UNPUBLISHED REVISION OF A FORM (owner, 2026-11-08): saved as typed, applied with the edit's own
 * rules and emptied in ONE transaction, discarded on request, every write compare-and-set.
 *
 * The revision store is an in-memory stand-in for `form-draft-revision.ts` that keeps its contract
 * (base 0 inserts, a moved base is refused, closing bumps the counter); the SQL itself is proven on
 * PostgreSQL by `form-draft-revision.integration.spec.ts`. The transaction fake ROLLS BACK: a
 * refusal inside it restores both the form and the revision, as PostgreSQL would.
 */
const store = new Map<string, { revision: number; document: Record<string, unknown> | null }>();

jest.mock('./form-draft-revision', () => {
  const actual = jest.requireActual('./form-draft-revision');
  return {
    ...actual,
    readFormDraft: jest.fn(async (_m: unknown, formId: string) => {
      const row = store.get(formId);
      return row
        ? { revision: row.revision, document: row.document, savedAt: 'now' }
        : { revision: 0, document: null, savedAt: null };
    }),
    writeFormDraft: jest.fn(
      async (_m: unknown, formId: string, base: number, document: Record<string, unknown>) => {
        const row = store.get(formId);
        if ((row?.revision ?? 0) !== base) return null;
        const revision = base + 1;
        store.set(formId, { revision, document });
        return { revision, savedAt: 'now' };
      }
    ),
    closeFormDraft: jest.fn(async (_m: unknown, formId: string) => {
      const row = store.get(formId)!;
      store.set(formId, { revision: row.revision + 1, document: null });
      return row.revision + 1;
    }),
    formsWithUnpublishedChanges: jest.fn(
      async (_m: unknown, ids: string[]) =>
        new Set(ids.filter((id) => store.get(id)?.document != null))
    ),
  };
});

describe('FormsService - unpublished revisions', () => {
  const OWNER = 'u-owner';
  const STRANGER = 'u-stranger';

  const item = { id: 'q1', label: 'Nom', required: true, type: 'short_text' };
  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: OWNER,
    associationId: 'a1',
    title: 'Gala',
    description: '',
    imageUrl: null,
    isPublic: false,
    anonymous: false,
    requiresPayment: false,
    allowCashPayment: false,
    allowOnlinePayment: true,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: true,
    maxSubmissions: null,
    opensAt: null,
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    deletedAt: null,
    status: FORM_PUBLISHED,
    items: [item],
    ...over,
  });

  /** The editor's payload, as `PATCH /forms/:id` would carry it. */
  const doc = (over: Record<string, unknown> = {}) => ({
    title: 'Gala 2026',
    description: '',
    basePrice: 0,
    currency: 'eur',
    items: [item],
    requiresPayment: false,
    ...over,
  });

  function makeService(opts: { form?: Record<string, unknown>; canTakePayments?: boolean } = {}) {
    let row: Record<string, unknown> = { ...baseForm(), ...opts.form };
    const statusWrites: unknown[] = [];
    const queryBuilder = () => {
      const qb: any = {
        update: () => qb,
        set: (values: Record<string, unknown>) => ((qb.values = values), qb),
        where: (_sql: string, params: { id: string; draft: string }) => ((qb.params = params), qb),
        execute: async () => {
          const hit = row.id === qb.params.id && row.status === qb.params.draft;
          if (hit) row = { ...row, ...qb.values };
          statusWrites.push(qb.values);
          return { affected: hit ? 1 : 0 };
        },
      };
      return qb;
    };
    const m: any = {
      save: jest.fn(async (_entity: unknown, form: Record<string, unknown>) => {
        row = { ...form };
        return { ...row };
      }),
      createQueryBuilder: jest.fn(queryBuilder),
      query: jest.fn(),
    };
    const formRepo: any = {
      findOne: jest.fn(async () => ({ ...row })),
      save: jest.fn(async (x: Record<string, unknown>) => ((row = { ...x }), { ...row })),
      createQueryBuilder: jest.fn(queryBuilder),
      manager: {
        // A transaction that rolls back on a throw: the form row and the revision are restored.
        transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) => {
          const formBefore = { ...row };
          const draftsBefore = new Map(store);
          try {
            return await fn(m);
          } catch (e) {
            row = formBefore;
            store.clear();
            for (const [k, v] of draftsBefore) store.set(k, v);
            throw e;
          }
        }),
        query: jest.fn(),
      },
    };
    const associations: any = {
      isMember: jest.fn(async () => true),
      mayAct: jest.fn(async () => false),
      collectsNow: jest.fn(async () => true),
      collectionSubjectOf: jest.fn(async () => null),
      assertPaymentsReady: jest.fn(async () => undefined),
      canTakePaymentsNow: jest.fn(async () => opts.canTakePayments ?? true),
      namesByIds: jest.fn(async () => new Map()),
    };
    const images: any = {
      claimForSave: jest.fn(async () => undefined),
      releaseUncited: jest.fn(async () => undefined),
    };
    const service = new FormsService(
      formRepo,
      { count: jest.fn(async () => 0), manager: { transaction: jest.fn() } } as any,
      {} as any,
      { get: jest.fn() } as any,
      associations,
      { listCotisationTiers: jest.fn(async () => []) } as any,
      {} as any,
      { build: jest.fn(async () => ({ answers: {} })) } as any,
      { count: jest.fn() } as any,
      {} as any,
      { enabled: () => false } as any,
      images
    );
    return { service, current: () => row, statusWrites, images };
  }

  beforeEach(() => store.clear());

  describe('autosave', () => {
    it('stores a half-built form as typed: no rule is asked of an autosave', async () => {
      const { service } = makeService();
      const saved = await service.saveDraft('f1', 0, { title: '' }, OWNER, false);
      expect(saved.revision).toBe(1);
      expect(store.get('f1')).toEqual({ revision: 1, document: { title: '' } });
    });

    it('refuses a save built on a revision another save moved, typed and carrying the current one', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      const stale = service.saveDraft('f1', 0, doc({ title: 'Other tab' }), OWNER, false);
      await expect(stale).rejects.toThrow(ConflictException);
      await expect(stale).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 1 },
      });
      expect(store.get('f1')!.document).toMatchObject({ title: 'Gala 2026' });
    });

    it('refuses what is not one JSON object', async () => {
      const { service } = makeService();
      await expect(service.saveDraft('f1', 0, [1, 2], OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_MALFORMED },
      });
    });

    it('is a manager route: a stranger can neither save nor read a revision', async () => {
      const { service } = makeService();
      await expect(service.saveDraft('f1', 0, doc(), STRANGER, false)).rejects.toThrow(
        ForbiddenException
      );
      await expect(service.getDraft('f1', STRANGER, false)).rejects.toThrow(ForbiddenException);
    });

    it('marks the forms holding unpublished changes in the managers list', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      const [listed] = (await (service as any).withAssociationNames([baseForm()])) as Array<{
        hasUnpublishedChanges: boolean;
      }>;
      expect(listed.hasUnpublishedChanges).toBe(true);
    });
  });

  describe('publishing the changes', () => {
    it('applies the revision to the form and empties it, in one transaction', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      const result = await service.publishChanges('f1', 1, OWNER, false);
      expect(current().title).toBe('Gala 2026');
      expect(store.get('f1')).toEqual({ revision: 2, document: null });
      expect(result).toEqual({ id: 'f1', status: FORM_PUBLISHED, revision: 2 });
    });

    it('refuses a stale revision and changes nothing', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      await service.saveDraft('f1', 1, doc({ title: 'Newer' }), OWNER, false);
      await expect(service.publishChanges('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 2 },
      });
      expect(current().title).toBe('Gala');
      expect(store.get('f1')!.document).toMatchObject({ title: 'Newer' });
    });

    it("judges the revision by the edit route's validation, and keeps it when refused", async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc({ title: '' }), OWNER, false);
      const refusal = service.publishChanges('f1', 1, OWNER, false);
      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toMatchObject({ response: { code: FORM_DRAFT_INVALID } });
      expect(current().title).toBe('Gala');
      expect(store.get('f1')).toEqual({ revision: 1, document: doc({ title: '' }) });
    });

    it("judges it by the edit's rules too: a published form that starts charging while online is not ready", async () => {
      const { service, current } = makeService({ canTakePayments: false });
      await service.saveDraft(
        'f1',
        0,
        doc({ requiresPayment: true, basePrice: 1500 }),
        OWNER,
        false
      );
      await expect(service.publishChanges('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_PAYMENTS_NOT_READY },
      });
      // Rolled back: the form still free, the revision still there to fix.
      expect(current().requiresPayment).toBe(false);
      expect(store.get('f1')!.revision).toBe(1);
    });

    it('answers a published form with nothing unpublished with a typed refusal', async () => {
      const { service } = makeService();
      await expect(service.publishChanges('f1', 0, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_EMPTY },
      });
    });

    it('publishes a DRAFT form together with its revision', async () => {
      const { service, current } = makeService({ form: { status: FORM_DRAFT } });
      await service.saveDraft('f1', 0, doc({ anonymous: true }), OWNER, false);
      await service.publishChanges('f1', 1, OWNER, false);
      expect(current()).toMatchObject({
        status: FORM_PUBLISHED,
        title: 'Gala 2026',
        // A draft has no answer yet: its anonymity is still its builder's choice.
        anonymous: true,
      });
    });

    it('publishes a DRAFT form with no revision as it stands', async () => {
      const { service, current } = makeService({ form: { status: FORM_DRAFT } });
      await service.publishChanges('f1', 0, OWNER, false);
      expect(current().status).toBe(FORM_PUBLISHED);
    });

    it('keeps a paid DRAFT unpublished while its respondents could not pay, revision intact', async () => {
      const { service, current } = makeService({
        form: { status: FORM_DRAFT },
        canTakePayments: false,
      });
      await service.saveDraft(
        'f1',
        0,
        doc({ requiresPayment: true, basePrice: 1500 }),
        OWNER,
        false
      );
      await expect(service.publishChanges('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_PAYMENTS_NOT_READY },
      });
      expect(current().status).toBe(FORM_DRAFT);
      expect(store.get('f1')!.revision).toBe(1);
    });
  });

  describe('discarding the changes', () => {
    it('empties the revision and leaves the form as published', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      expect(await service.discardDraft('f1', 1, OWNER, false)).toEqual({ revision: 2 });
      expect(store.get('f1')).toEqual({ revision: 2, document: null });
      expect(current().title).toBe('Gala');
    });

    it('refuses to throw away a revision moved since the editor read it', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      await service.saveDraft('f1', 1, doc({ title: 'Other tab' }), OWNER, false);
      await expect(service.discardDraft('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT },
      });
      expect(store.get('f1')!.document).toMatchObject({ title: 'Other tab' });
    });

    it('a tab still holding the old number cannot start a revision on top of the discarded one', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), OWNER, false);
      await service.discardDraft('f1', 1, OWNER, false);
      await expect(service.saveDraft('f1', 1, doc(), OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 2 },
      });
      await expect(service.saveDraft('f1', 0, doc(), OWNER, false)).rejects.toThrow(
        ConflictException
      );
    });
  });
});
