import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  FORM_CREATE_KEY_GONE,
  FORM_CREATE_KEY_ON_EDIT,
  FORM_CREATE_KEY_REUSED,
  FormsService,
} from './forms.service';
import { FORM_DRAFT, FORM_PUBLISHED } from './form-status';
import {
  FORM_CHANGED_SINCE_REVISION,
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
/** The client id of the save that wrote each form's current revision. */
const saveIds = new Map<string, string | null>();
/** The forms written outside their revision since it started (`formChangedSinceRevision`). */
const changedSince = new Set<string>();

jest.mock('./form-draft-revision', () => {
  const actual = jest.requireActual('./form-draft-revision');
  return {
    ...actual,
    readFormDraft: jest.fn(async (_m: unknown, formId: string) => {
      const row = store.get(formId);
      return row
        ? {
            revision: row.revision,
            document: row.document,
            savedAt: 'now',
            saveId: saveIds.get(formId) ?? null,
          }
        : { revision: 0, document: null, savedAt: null, saveId: null };
    }),
    writeFormDraft: jest.fn(
      async (
        _m: unknown,
        formId: string,
        base: number,
        document: Record<string, unknown>,
        saveId: string | null
      ) => {
        const row = store.get(formId);
        if ((row?.revision ?? 0) !== base) return null;
        const revision = base + 1;
        store.set(formId, { revision, document });
        saveIds.set(formId, saveId);
        return { revision, savedAt: 'now' };
      }
    ),
    closeFormDraft: jest.fn(async (_m: unknown, formId: string) => {
      const row = store.get(formId)!;
      store.set(formId, { revision: row.revision + 1, document: null });
      saveIds.set(formId, null);
      return row.revision + 1;
    }),
    formChangedSinceRevision: jest.fn(async (_m: unknown, formId: string) =>
      changedSince.has(formId)
    ),
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
      // A save writes the columns it is given; one it is not given (the status) keeps its value.
      save: jest.fn(async (_entity: unknown, form: Record<string, unknown>) => {
        row = { ...row, ...form };
        return { ...row };
      }),
      createQueryBuilder: jest.fn(queryBuilder),
      query: jest.fn(),
      // The publication's locked read of the form (`FOR UPDATE`): the row as it stands.
      findOne: jest.fn(async () => ({ ...row })),
    };
    const formRepo: any = {
      findOne: jest.fn(async () => ({ ...row })),
      save: jest.fn(async (x: Record<string, unknown>) => ((row = { ...row, ...x }), { ...row })),
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
      // The owner manages the association's forms (MANAGE_FORMS, owner 2026-11-14); a stranger not.
      mayAct: jest.fn(async (user: string) => user === OWNER),
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
    return { service, current: () => row, statusWrites, images, formRepo, m };
  }

  beforeEach(() => {
    store.clear();
    saveIds.clear();
    changedSince.clear();
  });

  describe('autosave', () => {
    it('stores a half-built form as typed: no rule is asked of an autosave', async () => {
      const { service } = makeService();
      const saved = await service.saveDraft('f1', 0, { title: '' }, null, OWNER, false);
      expect(saved.revision).toBe(1);
      expect(store.get('f1')).toEqual({ revision: 1, document: { title: '' } });
    });

    it('refuses a save built on a revision another save moved, typed and carrying the current one', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      const stale = service.saveDraft('f1', 0, doc({ title: 'Other tab' }), null, OWNER, false);
      await expect(stale).rejects.toThrow(ConflictException);
      await expect(stale).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 1 },
      });
      expect(store.get('f1')!.document).toMatchObject({ title: 'Gala 2026' });
    });

    it("a save whose answer was lost: the next one is refused WITH that save's id, so its client adopts it", async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), 'aaaaaaaa-0000-4000-8000-000000000001', OWNER, false);
      // The client never heard the answer, and sends its newer edit on the base it still holds.
      const resend = service.saveDraft(
        'f1',
        0,
        doc({ title: 'Plus tard' }),
        'aaaaaaaa-0000-4000-8000-000000000002',
        OWNER,
        false
      );
      await expect(resend).rejects.toMatchObject({
        response: {
          code: FORM_DRAFT_CONFLICT,
          revision: 1,
          saveId: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
      });
    });

    it('binds the question images a revision cites to the form, under the saver, in the save', async () => {
      const { service, images, m } = makeService();
      const items = [{ ...item, image: { mediaId: 'img-1' } }];
      await service.saveDraft('f1', 0, doc({ items }), null, OWNER, false);
      expect(images.claimForSave).toHaveBeenCalledWith(m, items, 'f1', OWNER);
    });

    it('refuses what is not one JSON object', async () => {
      const { service } = makeService();
      await expect(service.saveDraft('f1', 0, [1, 2], null, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_MALFORMED },
      });
    });

    it('is a manager route: a stranger can neither save nor read a revision', async () => {
      const { service } = makeService();
      await expect(service.saveDraft('f1', 0, doc(), null, STRANGER, false)).rejects.toThrow(
        ForbiddenException
      );
      await expect(service.getDraft('f1', STRANGER, false)).rejects.toThrow(ForbiddenException);
    });

    it('marks the forms holding unpublished changes in the managers list', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      const [listed] = (await (service as any).withAssociationNames([baseForm()])) as Array<{
        hasUnpublishedChanges: boolean;
      }>;
      expect(listed.hasUnpublishedChanges).toBe(true);
    });
  });

  describe('publishing the changes', () => {
    it('applies the revision to the form and empties it, in one transaction', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      const result = await service.publishChanges('f1', 1, OWNER, false);
      expect(current().title).toBe('Gala 2026');
      expect(store.get('f1')).toEqual({ revision: 2, document: null });
      expect(result).toEqual({ id: 'f1', status: FORM_PUBLISHED, revision: 2 });
    });

    it('refuses a stale revision and changes nothing', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      await service.saveDraft('f1', 1, doc({ title: 'Newer' }), null, OWNER, false);
      await expect(service.publishChanges('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 2 },
      });
      expect(current().title).toBe('Gala');
      expect(store.get('f1')!.document).toMatchObject({ title: 'Newer' });
    });

    it("judges the revision by the edit route's validation, and keeps it when refused", async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc({ title: '' }), null, OWNER, false);
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
        null,
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

    it('refuses a revision when the form was written outside it since it started, typed, unless overwritten', async () => {
      const { service, current } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      changedSince.add('f1');
      await expect(service.publishChanges('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_CHANGED_SINCE_REVISION },
      });
      expect(current().title).toBe('Gala');
      expect(store.get('f1')!.document).toMatchObject({ title: 'Gala 2026' });
      await service.publishChanges('f1', 1, OWNER, false, true);
      expect(current().title).toBe('Gala 2026');
    });

    it('answers a published form with nothing unpublished with a typed refusal', async () => {
      const { service } = makeService();
      await expect(service.publishChanges('f1', 0, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_EMPTY },
      });
    });

    it('publishes a DRAFT form together with its revision', async () => {
      const { service, current } = makeService({ form: { status: FORM_DRAFT } });
      await service.saveDraft('f1', 0, doc({ anonymous: true }), null, OWNER, false);
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

    it('takes the form row BEFORE the revision row, the order the tier retag takes them in', async () => {
      const { service, m } = makeService({ form: { status: FORM_DRAFT } });
      const revisionModule = jest.requireMock('./form-draft-revision');
      revisionModule.readFormDraft.mockClear();
      m.findOne.mockClear();
      await service.publishChanges('f1', 0, OWNER, false);
      const formLock = m.findOne.mock.invocationCallOrder[0];
      const draftLock = revisionModule.readFormDraft.mock.calls.findIndex(
        (call: unknown[]) => call[2] === true
      );
      expect(draftLock).toBeGreaterThanOrEqual(0);
      expect(formLock).toBeLessThan(
        revisionModule.readFormDraft.mock.invocationCallOrder[draftLock]
      );
    });

    it('judges a DRAFT with no revision as its row stands under the lock, not as read before', async () => {
      const { service, current, m } = makeService({
        form: { status: FORM_DRAFT },
        canTakePayments: false,
      });
      // Free when the manager check read it; made paid (online only) before the transaction.
      m.findOne.mockImplementationOnce(async () => ({
        ...current(),
        requiresPayment: true,
        basePrice: 1500,
      }));
      await expect(service.publishChanges('f1', 0, OWNER, false)).rejects.toMatchObject({
        response: { code: 'FORM_PAYMENTS_NOT_READY' },
      });
      expect(m.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { id: 'f1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(current().status).toBe(FORM_DRAFT);
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
        null,
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
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      expect(await service.discardDraft('f1', 1, OWNER, false)).toEqual({ revision: 2 });
      expect(store.get('f1')).toEqual({ revision: 2, document: null });
      expect(current().title).toBe('Gala');
    });

    it('refuses to throw away a revision moved since the editor read it', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      await service.saveDraft('f1', 1, doc({ title: 'Other tab' }), null, OWNER, false);
      await expect(service.discardDraft('f1', 1, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT },
      });
      expect(store.get('f1')!.document).toMatchObject({ title: 'Other tab' });
    });

    it('a tab still holding the old number cannot start a revision on top of the discarded one', async () => {
      const { service } = makeService();
      await service.saveDraft('f1', 0, doc(), null, OWNER, false);
      await service.discardDraft('f1', 1, OWNER, false);
      await expect(service.saveDraft('f1', 1, doc(), null, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_CONFLICT, revision: 2 },
      });
      await expect(service.saveDraft('f1', 0, doc(), null, OWNER, false)).rejects.toThrow(
        ConflictException
      );
    });
  });

  describe('a create under a client idempotency key', () => {
    const KEY = 'bbbbbbbb-0000-4000-8000-000000000001';

    it('answers the stored form when the same account sends the create again', async () => {
      const { service, formRepo } = makeService({ form: { clientCreateId: KEY } });
      const createNew = jest.spyOn(service as any, 'createNew');
      const again = await service.create({
        ...doc(),
        associationId: 'a1',
        clientCreateId: KEY,
        ownerId: OWNER,
      } as any);
      expect(again).toMatchObject({ id: 'f1', ownerId: OWNER });
      expect(formRepo.findOne).toHaveBeenCalledWith({
        where: { ownerId: OWNER, clientCreateId: KEY },
      });
      expect(createNew).not.toHaveBeenCalled();
    });

    it("never looks at another account's forms: the same key from a stranger is a new create", async () => {
      const { service, formRepo } = makeService({ form: { clientCreateId: KEY } });
      formRepo.findOne.mockResolvedValueOnce(null);
      const createNew = jest
        .spyOn(service as any, 'createNew')
        .mockResolvedValueOnce({ id: 'minted-by-the-server' });
      const made = await service.create({
        ...doc(),
        clientCreateId: KEY,
        ownerId: STRANGER,
      } as any);
      expect(formRepo.findOne).toHaveBeenCalledWith({
        where: { ownerId: STRANGER, clientCreateId: KEY },
      });
      expect(createNew).toHaveBeenCalledTimes(1);
      expect(made).toEqual({ id: 'minted-by-the-server' });
    });

    it('two sends racing to the insert: the loser answers what the winner stored', async () => {
      const { service, formRepo } = makeService({ form: { clientCreateId: KEY } });
      formRepo.findOne.mockResolvedValueOnce(null);
      jest.spyOn(service as any, 'createNew').mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'forms_owner_client_create_id',
        })
      );
      expect(
        await service.create({
          ...doc(),
          associationId: 'a1',
          clientCreateId: KEY,
          ownerId: OWNER,
        } as any)
      ).toMatchObject({ id: 'f1' });
    });

    it('two sends racing with a question image: the loser, refused the image, answers the stored form', async () => {
      const { service, formRepo } = makeService({ form: { clientCreateId: KEY } });
      formRepo.findOne.mockResolvedValueOnce(null);
      jest
        .spyOn(service as any, 'createNew')
        .mockRejectedValueOnce(new BadRequestException({ code: 'QUESTION_IMAGE_NOT_YOURS' }));
      expect(
        await service.create({
          ...doc(),
          associationId: 'a1',
          clientCreateId: KEY,
          ownerId: OWNER,
        } as any)
      ).toMatchObject({ id: 'f1' });
    });

    it("a unique violation on ANOTHER index is the create's own failure", async () => {
      const { service, formRepo } = makeService({ form: { clientCreateId: KEY } });
      formRepo.findOne.mockResolvedValueOnce(null);
      const other = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'forms_something_else',
      });
      jest.spyOn(service as any, 'createNew').mockRejectedValueOnce(other);
      await expect(
        service.create({
          ...doc(),
          associationId: 'a1',
          clientCreateId: KEY,
          ownerId: OWNER,
        } as any)
      ).rejects.toBe(other);
    });

    it('a replay naming another association is refused, typed, never answered the first form', async () => {
      const { service } = makeService({
        form: { clientCreateId: KEY, associationId: 'asso-a' },
      });
      await expect(
        service.create({
          ...doc(),
          associationId: 'asso-b',
          clientCreateId: KEY,
          ownerId: OWNER,
        } as any)
      ).rejects.toMatchObject({ status: 409, response: { code: FORM_CREATE_KEY_REUSED } });
    });

    it('a replay of a create whose form was archived since is refused gone', async () => {
      const { service } = makeService({
        form: { clientCreateId: KEY, deletedAt: new Date() },
      });
      await expect(
        service.create({
          ...doc(),
          associationId: 'a1',
          clientCreateId: KEY,
          ownerId: OWNER,
        } as any)
      ).rejects.toMatchObject({ status: 410, response: { code: FORM_CREATE_KEY_GONE } });
    });

    it('an edit never carries the key', async () => {
      const { service } = makeService();
      await expect(
        service.update('f1', { ...doc(), clientCreateId: KEY } as any, OWNER, false)
      ).rejects.toMatchObject({ response: { code: FORM_CREATE_KEY_ON_EDIT } });
    });
  });

  it('an overwrite still takes the form row: the changed-since read runs whatever the answer', async () => {
    const { service } = makeService();
    const revisionModule = jest.requireMock('./form-draft-revision');
    await service.saveDraft('f1', 0, doc(), null, OWNER, false);
    revisionModule.formChangedSinceRevision.mockClear();
    await service.publishChanges('f1', 1, OWNER, false, true);
    expect(revisionModule.formChangedSinceRevision).toHaveBeenCalledTimes(1);
  });
});
