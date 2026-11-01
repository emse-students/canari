import { BadRequestException } from '@nestjs/common';
import { FormsService } from './forms.service';

/**
 * A FILE QUESTION ON A FORM: where it may exist, and what a submission citing a file goes through.
 *
 * Refused at SAVE on a public form (D40: a guest has no account to upload with) and on an anonymous
 * one (a file is tied to the account that uploads it); at SUBMIT, a file answer is checked for shape
 * and then handed to `FormFilesService.attach` inside the submission's transaction, which is where
 * ownership is decided.
 */
describe('FormsService - the file question', () => {
  const FILE_ID = '11111111-1111-4111-8111-111111111111';
  const CV = { id: 'q_cv', label: 'Ton CV', required: true, type: 'file' };

  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: 'u-owner',
    associationId: null,
    title: 'Entretiens alumni',
    isPublic: false,
    anonymous: false,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: false,
    maxSubmissions: null,
    opensAt: null,
    closedAt: null,
    priceMatrix: null,
    submitCondition: null,
    deletedAt: null,
    items: [CV],
    ...over,
  });

  function makeService(form = baseForm()) {
    const saved: Record<string, unknown>[] = [];
    const manager: any = {
      query: jest.fn(() => Promise.resolve([{ formId: 'f1' }])),
      create: jest.fn((_entity: unknown, row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ id: 's1', createdAt: new Date(), ...row });
      }),
      count: jest.fn(() => Promise.resolve(0)),
      findOne: jest.fn(() => Promise.resolve(null)),
      // The one-answer guard reads the person's answers: none yet.
      find: jest.fn(() => Promise.resolve([])),
    };
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(form)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const submissionRepo: any = {
      count: jest.fn(() => Promise.resolve(0)),
      manager: { find: manager.find, transaction: jest.fn((_l: string, fn: any) => fn(manager)) },
    };
    const pricingFacts: any = { build: jest.fn(() => Promise.resolve({ answers: {} })) };
    const formFiles: any = { attach: jest.fn(() => Promise.resolve()) };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      { isMember: jest.fn(() => Promise.resolve(true)) } as any,
      {} as any,
      {} as any,
      pricingFacts,
      { count: jest.fn(() => Promise.resolve(0)) } as any,
      formFiles,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any
    );
    return { service, saved, formFiles, manager };
  }

  const createInput = (over: Record<string, unknown> = {}) =>
    ({
      title: 'Entretiens alumni',
      basePrice: 0,
      currency: 'eur',
      items: [CV],
      ownerId: 'u-owner',
      ...over,
    }) as any;

  describe('at save', () => {
    it('refuses a file question on a public form, with the reason', async () => {
      const { service } = makeService();
      await expect(
        service.create(createInput({ isPublic: true, allowMultipleSubmissions: true }))
      ).rejects.toThrow('A public form cannot ask for a file');
    });

    it('refuses making an existing form with a file question public, items absent from the edit', async () => {
      const { service } = makeService();
      await expect(
        service.update(
          'f1',
          {
            title: 'x',
            basePrice: 0,
            currency: 'eur',
            isPublic: true,
            allowMultipleSubmissions: true,
          } as any,
          'u-owner',
          false
        )
      ).rejects.toThrow('A public form cannot ask for a file');
    });

    it('refuses a file question on an anonymous form', async () => {
      const { service } = makeService();
      await expect(service.create(createInput({ anonymous: true }))).rejects.toThrow(
        'An anonymous form cannot ask for a file'
      );
    });

    it('accepts a file question on a member form', async () => {
      const { service } = makeService();
      await expect(service.create(createInput())).resolves.toBeDefined();
    });

    // The upload is judged on submitCondition BEFORE any answer exists: an `answer` criterion would
    // refuse every upload (403), so the form could never be filled.
    const MENU = {
      id: 'q_menu',
      label: 'Menu',
      required: true,
      type: 'single_choice',
      options: [{ id: 'a', label: 'A', priceModifier: 0 }],
    };
    const BY_ANSWER = { answer: { questionId: 'q_menu', optionIds: ['a'] } };

    it('refuses a file question with an answer criterion on who may submit', async () => {
      const { service } = makeService();
      await expect(
        service.create(createInput({ items: [MENU, CV], submitCondition: BY_ANSWER }))
      ).rejects.toThrow('A form that asks for a file cannot restrict who may answer by an answer');
    });

    it('refuses adding a file question to a form whose STORED condition reads an answer', async () => {
      const { service } = makeService(baseForm({ items: [MENU], submitCondition: BY_ANSWER }));
      await expect(
        service.update(
          'f1',
          { title: 'x', basePrice: 0, currency: 'eur', items: [MENU, CV] } as any,
          'u-owner',
          false
        )
      ).rejects.toThrow('A form that asks for a file cannot restrict who may answer by an answer');
    });

    it('lets a profile criterion stand beside a file question', async () => {
      const { service } = makeService();
      await expect(
        service.create(createInput({ submitCondition: { promo: { values: [2024] } } }))
      ).resolves.toBeDefined();
    });
  });

  describe('at submit', () => {
    it('stores the file id as the answer and attaches it in the submission transaction', async () => {
      const { service, saved, formFiles, manager } = makeService();
      await service.submit('f1', { userId: 'u1', answers: { q_cv: FILE_ID } });
      expect(saved[0].answers).toEqual({ q_cv: FILE_ID });
      expect(formFiles.attach).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ id: 's1' }),
        'f1',
        'u1',
        [{ itemId: 'q_cv', fileId: FILE_ID }]
      );
    });

    // Someone else's file: `attach` refuses inside the transaction, and the submission goes with it.
    it('fails the whole submission when the file is not the submitter own', async () => {
      const { service, formFiles } = makeService();
      formFiles.attach.mockRejectedValueOnce(new BadRequestException('not yours'));
      await expect(
        service.submit('f1', { userId: 'u2', answers: { q_cv: FILE_ID } })
      ).rejects.toThrow('not yours');
    });

    it('refuses an answer that is not a file id, before anything is written', async () => {
      const { service, saved, formFiles } = makeService();
      await expect(
        service.submit('f1', { userId: 'u1', answers: { q_cv: 'see my LinkedIn' } })
      ).rejects.toThrow(BadRequestException);
      expect(saved).toHaveLength(0);
      expect(formFiles.attach).not.toHaveBeenCalled();
    });

    it('refuses a file answer on a form that cannot receive one (anonymous)', async () => {
      const { service, saved } = makeService(baseForm({ anonymous: true }));
      await expect(
        service.submit('f1', { userId: 'u1', answers: { q_cv: FILE_ID } })
      ).rejects.toThrow('cannot receive a file');
      expect(saved).toHaveLength(0);
    });

    // A file question the submitter does not see is neither stored nor attached: only the VISIBLE
    // file answers reach `attach`. Control (2026-10-22): `attach` handed every file answer -> fails.
    it('attaches no file for a file question the submitter did not see', async () => {
      const menu = {
        id: 'q_menu',
        label: 'Menu',
        required: true,
        type: 'single_choice',
        options: [
          { id: 'a', label: 'A', priceModifier: 0 },
          { id: 'b', label: 'B', priceModifier: 0 },
        ],
      };
      const hiddenCv = {
        ...CV,
        required: false,
        showIf: { answer: { questionId: 'q_menu', optionIds: ['a'] } },
      };
      const { service, saved, formFiles } = makeService(baseForm({ items: [menu, hiddenCv] }));
      await service.submit('f1', { userId: 'u1', answers: { q_menu: 'b', q_cv: FILE_ID } });
      expect(saved[0].answers).toEqual({ q_menu: 'b' });
      expect(formFiles.attach).not.toHaveBeenCalled();
    });

    it('enforces a required file question', async () => {
      const { service } = makeService();
      await expect(service.submit('f1', { userId: 'u1', answers: {} })).rejects.toThrow(
        'Missing required field'
      );
    });
  });

  // The same audience rule as submit, applied before a byte is stored.
  describe('at upload - the form audience', () => {
    const PROMO_2024 = { promo: { values: [2024] } };
    const facts = (promo: number | null) => ({
      promo,
      formation: null,
      cotisationTiers: [],
      answers: {},
    });

    it('refuses a member the form is not open to', async () => {
      const { service } = makeService(baseForm({ submitCondition: PROMO_2024 }));
      (service as any).pricingFacts.build.mockResolvedValueOnce(facts(2023));
      await expect(service.assertMayUploadAnswerFile('f1', 'u1')).rejects.toThrow(
        'not open to you'
      );
    });

    it('accepts a member inside the audience, and anybody on an unrestricted form', async () => {
      const restricted = makeService(baseForm({ submitCondition: PROMO_2024 }));
      (restricted.service as any).pricingFacts.build.mockResolvedValueOnce(facts(2024));
      await expect(
        restricted.service.assertMayUploadAnswerFile('f1', 'u1')
      ).resolves.toBeUndefined();
      const open = makeService();
      await expect(open.service.assertMayUploadAnswerFile('f1', 'u1')).resolves.toBeUndefined();
      expect((open.service as any).pricingFacts.build).not.toHaveBeenCalled();
    });

    // Owner, 2026-10-30: a holder cannot park a file on a form for people without the cotisation -
    // refused with the same TYPED code as submit, before a byte is stored.
    it('refuses a holder of an excluded cotisation, typed FORM_COTISATION_HELD', async () => {
      const { service } = makeService(
        baseForm({ submitCondition: { notCotisation: { variantKeys: [null] } } })
      );
      (service as any).pricingFacts.build.mockResolvedValueOnce({
        ...facts(null),
        cotisationTiers: [null],
      });
      await expect(service.assertMayUploadAnswerFile('f1', 'u1')).rejects.toMatchObject({
        status: 403,
        response: { code: 'FORM_COTISATION_HELD' },
      });
    });

    it('is a 404 for a form that is gone', async () => {
      const { service } = makeService(null as any);
      await expect(service.assertMayUploadAnswerFile('f1', 'u1')).rejects.toThrow('Form not found');
    });
  });

  describe('the manager list', () => {
    const PURGED_ID = '22222222-2222-4222-8222-222222222222';

    it('names each live file and marks each purged one, cited by the answers only', async () => {
      const { service, formFiles } = makeService();
      const submissionRepo = (service as any).submissionRepo;
      submissionRepo.find = jest.fn(() =>
        Promise.resolve([
          { id: 's1', userId: null, answers: { q_cv: FILE_ID } },
          { id: 's2', userId: null, answers: { q_cv: PURGED_ID } },
        ])
      );
      formFiles.answerFiles = jest.fn(() =>
        Promise.resolve(
          new Map([
            [FILE_ID, { fileName: 'cv.pdf', purged: false }],
            [PURGED_ID, { fileName: 'old.pdf', purged: true }],
          ])
        )
      );
      const subs = await service.getSubmissions('f1');
      expect(subs[0]).toMatchObject({ deletedFileIds: [], fileNames: { [FILE_ID]: 'cv.pdf' } });
      expect(subs[1]).toMatchObject({ deletedFileIds: [PURGED_ID], fileNames: {} });
    });

    it('asks nothing about files of a form without a file question', async () => {
      const { service, formFiles } = makeService(baseForm({ items: [] }));
      (service as any).submissionRepo.find = jest.fn(() =>
        Promise.resolve([{ id: 's1', userId: null, answers: { q: FILE_ID } }])
      );
      formFiles.answerFiles = jest.fn();
      const subs = await service.getSubmissions('f1');
      expect(formFiles.answerFiles).not.toHaveBeenCalled();
      expect(subs[0]).toMatchObject({ deletedFileIds: [], fileNames: {} });
    });
  });
});
