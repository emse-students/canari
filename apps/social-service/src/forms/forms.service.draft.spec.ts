import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FormsService, FORM_DRAFT_FLAG_ON_EDIT } from './forms.service';
import {
  FORM_NO_PAYMENT_METHOD,
  FORM_ONLINE_PAYMENT_NOT_OFFERED,
  FORM_PAYMENTS_NOT_READY,
} from './payment-offer';
import { FORM_DRAFT, FORM_IS_DRAFT, FORM_PUBLISHED, assertFormNotDraft } from './form-status';
import { FORM_DRAFT_EMPTY } from './form-draft-revision';

// Publication goes through the revision route; these forms hold no revision (the revision store
// itself is `forms.service.revision.spec.ts`'s).
jest.mock('./form-draft-revision', () => ({
  ...jest.requireActual('./form-draft-revision'),
  readFormDraft: jest.fn(async () => ({
    revision: 0,
    document: null,
    savedAt: null,
    saveId: null,
  })),
}));

/**
 * A FORM IS A DRAFT UNTIL ITS MANAGER PUBLISHES IT (owner, 2026-11-08).
 *
 * The repository fake HONOURS the `where` it is given - `status`, `deletedAt`, `id` - because what
 * hides a draft from a respondent is exactly that clause (`respondentFormWhere`): a fake that
 * returned the row whatever was asked would pass with the clause deleted.
 */
describe('FormsService - drafts', () => {
  const OWNER = 'u-owner';
  const STRANGER = 'u-stranger';

  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: OWNER,
    associationId: 'a1',
    title: 'Gala',
    description: '',
    imageUrl: null,
    isPublic: true,
    anonymous: false,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: true,
    maxSubmissions: null,
    opensAt: '2099-01-01T00:00:00.000Z',
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    deletedAt: null,
    status: FORM_DRAFT,
    items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
    ...over,
  });

  /** Whether a stored row satisfies a TypeORM-style `where` (plain values and IsNull()). */
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, want]) => {
      const have = row[key];
      if (want && typeof want === 'object' && (want as { _type?: string })._type === 'isNull') {
        return have === null || have === undefined;
      }
      return have === want;
    });
  }

  function makeService(
    opts: { form?: Record<string, unknown>; canTakePayments?: boolean; mayAct?: boolean } = {}
  ) {
    const row: Record<string, unknown> = { ...baseForm(), ...opts.form };
    const updates: Record<string, unknown>[] = [];
    const formRepo: any = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(matches(row, where) ? { ...row } : null)
      ),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve({ id: 'new', ...x })),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          update: () => qb,
          set: (values: Record<string, unknown>) => {
            qb.values = values;
            return qb;
          },
          where: (_sql: string, params: { id: string; draft: string }) => {
            qb.params = params;
            return qb;
          },
          execute: () => {
            // The conditional write: only a row still in draft is changed.
            const hit = row.id === qb.params.id && row.status === qb.params.draft;
            if (hit) Object.assign(row, qb.values);
            updates.push({ ...qb.values, affected: hit ? 1 : 0 });
            return Promise.resolve({ affected: hit ? 1 : 0 });
          },
        };
        return qb;
      }),
    };
    formRepo.manager = {
      transaction: jest.fn((fn: (m: unknown) => Promise<unknown>) =>
        fn({ createQueryBuilder: formRepo.createQueryBuilder, query: jest.fn() })
      ),
      query: jest.fn(),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      manager: { transaction: jest.fn() },
    };
    const reminderRepo: any = { upsert: jest.fn(() => Promise.resolve()) };
    const associations: any = {
      isMember: jest.fn(() => Promise.resolve(true)),
      mayAct: jest.fn(() => Promise.resolve(opts.mayAct ?? false)),
      collectsNow: jest.fn(() => Promise.resolve(true)),
      collectionSubjectOf: jest.fn(() => Promise.resolve(null)),
      assertPaymentsReady: jest.fn(() =>
        opts.canTakePayments === false
          ? Promise.reject(new ConflictException({ code: 'PAYMENTS_NOT_ACTIVATED' }))
          : Promise.resolve()
      ),
      canTakePaymentsNow: jest.fn(() => Promise.resolve(opts.canTakePayments ?? true)),
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      reminderRepo,
      { get: jest.fn() } as any,
      associations,
      { listCotisationTiers: jest.fn(() => Promise.resolve([])) } as any,
      {} as any,
      { build: jest.fn(() => Promise.resolve({ answers: {} })) } as any,
      { count: jest.fn() } as any,
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    return { service, row, formRepo, associations, reminderRepo, updates };
  }

  const createInput = (over: Record<string, unknown> = {}) =>
    ({
      title: 'Gala',
      basePrice: 0,
      currency: 'eur',
      items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
      ownerId: OWNER,
      associationId: 'a1',
      ...over,
    }) as any;

  describe('create', () => {
    it('stores a draft when the client asks for one', async () => {
      const { service, formRepo } = makeService();
      await service.create(createInput({ draft: true }));
      expect(formRepo.create.mock.calls[0][0].status).toBe(FORM_DRAFT);
      expect(formRepo.create.mock.calls[0][0]).not.toHaveProperty('draft');
    });

    it('publishes at once for a client that predates drafts (no `draft` sent)', async () => {
      const { service, formRepo } = makeService();
      await service.create(createInput());
      expect(formRepo.create.mock.calls[0][0].status).toBe(FORM_PUBLISHED);
    });

    it('saves a PAID draft while the association cannot take payments yet', async () => {
      const { service, formRepo, associations } = makeService({ canTakePayments: false });
      await service.create(createInput({ draft: true, requiresPayment: true, basePrice: 1500 }));
      expect(associations.assertPaymentsReady).not.toHaveBeenCalled();
      expect(formRepo.create.mock.calls[0][0].status).toBe(FORM_DRAFT);
    });

    it('still refuses a paid form created PUBLISHED while payments are not ready (older client)', async () => {
      const { service } = makeService({ canTakePayments: false });
      await expect(
        service.create(createInput({ requiresPayment: true, basePrice: 1500 }))
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('saves a paid draft edit without asking whether payments are ready', async () => {
      const { service, associations } = makeService({ canTakePayments: false });
      await service.update(
        'f1',
        createInput({ requiresPayment: true, basePrice: 1500, associationId: undefined }),
        OWNER,
        false
      );
      expect(associations.assertPaymentsReady).not.toHaveBeenCalled();
    });

    it('asks it of a PUBLISHED form that starts charging, as before', async () => {
      const { service } = makeService({ form: { status: FORM_PUBLISHED }, canTakePayments: false });
      await expect(
        service.update(
          'f1',
          createInput({ requiresPayment: true, basePrice: 1500, associationId: undefined }),
          OWNER,
          false
        )
      ).rejects.toThrow(ConflictException);
    });

    it('never writes the status: a publication landing during an edit is not written back as draft', async () => {
      const { service, formRepo } = makeService();
      await service.update(
        'f1',
        createInput({ title: 'Gala 2', associationId: undefined }),
        OWNER,
        false
      );
      const written = formRepo.save.mock.calls.at(-1)[0];
      expect(written).not.toHaveProperty('status');
      expect(written.title).toBe('Gala 2');
    });

    it('refuses a `draft` flag on an edit, typed', async () => {
      const { service } = makeService({ form: { status: FORM_PUBLISHED } });
      const refusal = service.update(
        'f1',
        createInput({ draft: true, associationId: undefined }),
        OWNER,
        false
      );
      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toMatchObject({
        response: { code: FORM_DRAFT_FLAG_ON_EDIT },
      });
    });
  });

  describe('publish', () => {
    it('publishes a free draft', async () => {
      const { service, row } = makeService();
      await expect(service.publishChanges('f1', 0, OWNER, false)).resolves.toEqual({
        id: 'f1',
        status: FORM_PUBLISHED,
        revision: 0,
      });
      expect(row.status).toBe(FORM_PUBLISHED);
    });

    it('refuses a PAID draft whose association cannot take payments yet, typed, and keeps it a draft', async () => {
      const { service, row } = makeService({
        form: { requiresPayment: true, basePrice: 1500 },
        canTakePayments: false,
      });
      const refusal = service.publishChanges('f1', 0, OWNER, false);
      await expect(refusal).rejects.toThrow(ConflictException);
      await expect(refusal).rejects.toMatchObject({ response: { code: FORM_PAYMENTS_NOT_READY } });
      expect(row.status).toBe(FORM_DRAFT);
    });

    it('publishes the same paid draft once payments are ready', async () => {
      const { service, row } = makeService({
        form: { requiresPayment: true, basePrice: 1500 },
        canTakePayments: true,
      });
      await service.publishChanges('f1', 0, OWNER, false);
      expect(row.status).toBe(FORM_PUBLISHED);
    });

    it('a published form with nothing unpublished: refused, typed, and nothing written', async () => {
      const { service, updates } = makeService({ form: { status: FORM_PUBLISHED } });
      await expect(service.publishChanges('f1', 0, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_DRAFT_EMPTY },
      });
      expect(updates).toHaveLength(0);
    });

    it('is refused to someone who does not manage the form', async () => {
      const { service, row } = makeService();
      await expect(service.publishChanges('f1', 0, STRANGER, false)).rejects.toThrow(
        ForbiddenException
      );
      expect(row.status).toBe(FORM_DRAFT);
    });
  });

  describe('publication of a paid form: payment-ready OR cash accepted (owner, 2026-11-08)', () => {
    const paid = { requiresPayment: true, basePrice: 1500 };

    it('publishes a paid draft that accepts CASH while the association cannot collect online', async () => {
      const { service, row, associations } = makeService({
        form: { ...paid, allowCashPayment: true },
        canTakePayments: false,
      });
      await service.publishChanges('f1', 0, OWNER, false);
      expect(row.status).toBe(FORM_PUBLISHED);
      // Cash answers the question: readiness is not even asked.
      expect(associations.canTakePaymentsNow).not.toHaveBeenCalled();
    });

    it('refuses a paid draft that accepts neither online nor cash, typed', async () => {
      const { service, row } = makeService({
        form: { ...paid, allowCashPayment: false, allowOnlinePayment: false },
      });
      const refusal = service.publishChanges('f1', 0, OWNER, false);
      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toMatchObject({ response: { code: FORM_NO_PAYMENT_METHOD } });
      expect(row.status).toBe(FORM_DRAFT);
    });

    it('holds a PERSONAL paid form to the same rule: no way to pay is refused, online needs no association', async () => {
      const none = makeService({
        form: { ...paid, associationId: null, allowCashPayment: false, allowOnlinePayment: false },
      });
      await expect(none.service.publishChanges('f1', 0, OWNER, false)).rejects.toMatchObject({
        response: { code: FORM_NO_PAYMENT_METHOD },
      });
      const online = makeService({ form: { ...paid, associationId: null } });
      await online.service.publishChanges('f1', 0, OWNER, false);
      expect(online.row.status).toBe(FORM_PUBLISHED);
      expect(online.associations.canTakePaymentsNow).not.toHaveBeenCalled();
    });

    it('serves a PERSONAL cash-only paid form as paused online', async () => {
      const cashOnly = makeService({
        form: {
          ...paid,
          associationId: null,
          status: FORM_PUBLISHED,
          allowCashPayment: true,
          allowOnlinePayment: false,
        },
      });
      await expect(cashOnly.service.getPublic('f1')).resolves.toMatchObject({
        paymentsPaused: true,
      });
      const online = makeService({
        form: { ...paid, associationId: null, status: FORM_PUBLISHED },
      });
      await expect(online.service.getPublic('f1')).resolves.toMatchObject({
        paymentsPaused: false,
      });
    });

    it('lets an older client create a paid form PUBLISHED with cash while online is not ready', async () => {
      const { service, formRepo } = makeService({ canTakePayments: false });
      await service.create(
        createInput({ requiresPayment: true, basePrice: 1500, allowCashPayment: true })
      );
      expect(formRepo.create.mock.calls[0][0].status).toBe(FORM_PUBLISHED);
    });

    it('serves online as paused while not ready, and while the editor took it off', async () => {
      const notReady = makeService({
        form: { ...paid, status: FORM_PUBLISHED, allowCashPayment: true },
      });
      notReady.associations.collectsNow.mockResolvedValue(false);
      await expect(notReady.service.getPublic('f1')).resolves.toMatchObject({
        paymentsPaused: true,
        allowCashPayment: true,
      });

      const cashOnly = makeService({
        form: {
          ...paid,
          status: FORM_PUBLISHED,
          allowCashPayment: true,
          allowOnlinePayment: false,
        },
      });
      await expect(cashOnly.service.getPublic('f1')).resolves.toMatchObject({
        paymentsPaused: true,
      });

      const ready = makeService({ form: { ...paid, status: FORM_PUBLISHED } });
      await expect(ready.service.getPublic('f1')).resolves.toMatchObject({
        paymentsPaused: false,
      });
    });

    it('refuses an ONLINE answer on a cash-only form before anything is written', async () => {
      const { service } = makeService({
        form: {
          ...paid,
          status: FORM_PUBLISHED,
          isPublic: false,
          allowCashPayment: true,
          allowOnlinePayment: false,
          opensAt: null,
        },
      });
      const refusal = service.submit('f1', {
        answers: { q1: 'x' },
        userId: STRANGER,
        paymentMethod: 'online',
      } as any);
      await expect(refusal).rejects.toMatchObject({
        response: { code: FORM_ONLINE_PAYMENT_NOT_OFFERED },
      });
    });
  });

  describe('a draft is invisible to every respondent read', () => {
    it('get: 404 to a non-manager, the form to its owner and to a MANAGE_FORMS holder', async () => {
      await expect(
        makeService().service.get('f1', { userId: STRANGER, isGlobalAdmin: false })
      ).rejects.toThrow(NotFoundException);
      await expect(
        makeService().service.get('f1', { userId: OWNER, isGlobalAdmin: false })
      ).resolves.toMatchObject({ id: 'f1', status: FORM_DRAFT });
      await expect(
        makeService({ mayAct: true }).service.get('f1', { userId: STRANGER, isGlobalAdmin: false })
      ).resolves.toMatchObject({ id: 'f1' });
    });

    it('getPublic (the guest link): 404', async () => {
      await expect(makeService().service.getPublic('f1')).rejects.toThrow(NotFoundException);
    });

    it('check: answers as for an absent form, nobody may submit', async () => {
      await expect(makeService().service.hasSubmission('f1', STRANGER)).resolves.toMatchObject({
        maySubmit: false,
        pricing: null,
      });
    });

    it('submit, member and guest: 404', async () => {
      const { service } = makeService();
      await expect(
        service.submit('f1', { answers: { q1: 'x' }, userId: STRANGER } as any)
      ).rejects.toThrow(NotFoundException);
      await expect(service.submit('f1', { answers: { q1: 'x' } } as any, 'guest')).rejects.toThrow(
        NotFoundException
      );
    });

    it('a file upload pre-check: 404', async () => {
      await expect(
        makeService({
          form: { submitCondition: { promo: [2024] } },
        }).service.assertMayUploadAnswerFile('f1', STRANGER)
      ).rejects.toThrow(NotFoundException);
    });

    it('an opening reminder cannot be subscribed to a draft', async () => {
      const { service, reminderRepo } = makeService();
      await expect(service.subscribeReminder('f1', STRANGER)).rejects.toThrow(NotFoundException);
      expect(reminderRepo.upsert).not.toHaveBeenCalled();
    });

    it('the same reads find the form once it is published', async () => {
      const { service } = makeService();
      await service.publishChanges('f1', 0, OWNER, false);
      await expect(service.getPublic('f1')).resolves.toMatchObject({ id: 'f1' });
      await expect(
        service.get('f1', { userId: STRANGER, isGlobalAdmin: false })
      ).resolves.toMatchObject({ id: 'f1' });
    });
  });

  describe('assertFormNotDraft (a post, an agenda event)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const manager = (status: string | null) =>
      ({ query: jest.fn(() => Promise.resolve(status ? [{ status }] : [])) }) as any;

    it('refuses a draft, typed', async () => {
      await expect(assertFormNotDraft(manager(FORM_DRAFT), ID, 'a post')).rejects.toMatchObject({
        response: { code: FORM_IS_DRAFT },
      });
    });

    it('lets a published form, an unknown id and a non-uuid string through without a 22P02', async () => {
      await expect(assertFormNotDraft(manager(FORM_PUBLISHED), ID, 'a post')).resolves.toBe(
        undefined
      );
      await expect(assertFormNotDraft(manager(null), ID, 'a post')).resolves.toBe(undefined);
      const m = manager(FORM_DRAFT);
      await expect(assertFormNotDraft(m, 'not-a-uuid', 'a post')).resolves.toBe(undefined);
      expect(m.query).not.toHaveBeenCalled();
    });
  });
});
