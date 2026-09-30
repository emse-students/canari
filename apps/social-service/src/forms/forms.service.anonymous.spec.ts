import * as ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { FormsService } from './forms.service';
import type { ExportLabels } from './export-labels';

/**
 * AN ANONYMOUS FORM KEEPS NO AUTHOR, AND THE PROOF IS WHAT IS WRITTEN.
 *
 * Every claim here is about the row handed to the database or the bytes of the workbook, never
 * about a flag: a form that says anonymous and stores a `userId` is the defect.
 */
describe('FormsService - anonymous forms', () => {
  const LABELS: ExportLabels = {
    date: 'Date',
    firstName: 'Prenom',
    lastName: 'Nom',
    amount: 'Montant',
    status: 'Statut',
    statuses: { free: 'Gratuit' },
  };

  const baseForm = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    title: 'Sondage du BDE',
    anonymous: true,
    requiresPayment: false,
    currency: 'eur',
    basePrice: 0,
    allowMultipleSubmissions: false,
    priceMatrix: null,
    submitCondition: null,
    items: [{ id: 'q1', label: 'Avis', required: false, type: 'short_text' }],
    ...over,
  });

  function makeService(opts: { form?: Record<string, unknown>; inserted?: unknown[] } = {}) {
    const saved: Record<string, unknown>[] = [];
    const manager: any = {
      query: jest.fn(() => Promise.resolve(opts.inserted ?? [{ formId: 'f1' }])),
      create: jest.fn((_entity: unknown, row: Record<string, unknown>) => row),
      save: jest.fn((row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ id: 's1', ...row });
      }),
      count: jest.fn(() => Promise.resolve(0)),
    };
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(opts.form ?? baseForm())),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const submissionRepo: any = {
      find: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      manager: { transaction: jest.fn((_l: string, fn: any) => fn(manager)), query: jest.fn() },
    };
    const respondentRepo: any = { count: jest.fn(() => Promise.resolve(0)) };
    const pricingFacts: any = { build: jest.fn(() => Promise.resolve({ answers: {} })) };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      {} as any,
      { get: jest.fn() } as any,
      { isMember: jest.fn(() => Promise.resolve(true)) } as any,
      {} as any,
      {} as any,
      pricingFacts,
      respondentRepo
    );
    return { service, manager, saved, formRepo, submissionRepo, respondentRepo };
  }

  describe('submit', () => {
    it('stores the answer with no account, no address and a time cut to the day', async () => {
      const { service, saved } = makeService();
      await service.submit('f1', {
        userId: 'u-alice',
        email: 'alice@example.org',
        answers: { q1: 'bof' },
      });
      expect(saved).toHaveLength(1);
      const row = saved[0];
      expect(row.userId).toBeNull();
      expect(row.email).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('u-alice');
      expect(JSON.stringify(row)).not.toContain('alice@example.org');
      const at = row.createdAt as Date;
      expect([at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]).toEqual([0, 0, 0]);
      expect(row.updatedAt).toBe(row.createdAt);
    });

    it('records WHO answered in the registry, which names no answer', async () => {
      const { service, manager } = makeService();
      await service.submit('f1', { userId: 'u-alice', answers: { q1: 'bof' } });
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain('form_respondents');
      expect(sql).not.toMatch(/submission/i);
      expect(params).toEqual(['f1', 'u-alice']);
    });

    it('refuses a second answer from the same account', async () => {
      const { service, saved } = makeService({ inserted: [] });
      await expect(
        service.submit('f1', { userId: 'u-alice', answers: { q1: 'bof' } })
      ).rejects.toThrow(BadRequestException);
      expect(saved).toHaveLength(0);
    });

    it('lets an account answer again when the form allows repeats, registering nobody', async () => {
      const { service, manager, saved } = makeService({
        form: baseForm({ allowMultipleSubmissions: true }),
      });
      await service.submit('f1', { userId: 'u-alice', answers: { q1: 'bof' } });
      expect(manager.query).not.toHaveBeenCalled();
      expect(saved).toHaveLength(1);
    });

    it('refuses to charge for an option, since a charge needs a payer', async () => {
      const { service, saved } = makeService({
        form: baseForm({
          items: [
            {
              id: 'q1',
              label: 'Menu',
              required: false,
              type: 'single_choice',
              options: [{ id: 'o1', label: 'Gros', priceModifier: 500 }],
            },
          ],
        }),
      });
      await expect(
        service.submit('f1', { userId: 'u-alice', answers: { q1: ['o1'] } })
      ).rejects.toThrow(BadRequestException);
      expect(saved).toHaveLength(0);
    });
  });

  describe('hasSubmission', () => {
    it('reads the registry, since the answers know no author', async () => {
      const { service, respondentRepo, submissionRepo } = makeService();
      respondentRepo.count.mockResolvedValueOnce(1);
      const res = await service.hasSubmission('f1', 'u-alice');
      expect(res.hasSubmitted).toBe(true);
      expect(res.paymentStatus).toBe('free');
      expect(submissionRepo.count).not.toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    const input = (over: Record<string, unknown> = {}) =>
      ({
        title: 'T',
        basePrice: 0,
        currency: 'eur',
        items: [],
        ownerId: 'u1',
        anonymous: true,
        ...over,
      }) as any;

    it.each([
      ['requiresPayment', { requiresPayment: true }],
      ['a base price', { basePrice: 500 }],
      ['a price grid', { priceMatrix: { dimensions: [], cells: {} } }],
      ['cash', { allowCashPayment: true }],
      ['a cotisation grant', { grantsCotisation: true }],
    ])('refuses an anonymous form with %s', async (_name, over) => {
      const { service } = makeService();
      await expect(service.create(input(over))).rejects.toThrow(BadRequestException);
    });

    it('accepts a free anonymous form', async () => {
      const { service, formRepo } = makeService();
      await service.create(input());
      expect(formRepo.save).toHaveBeenCalled();
    });

    it('refuses to change anonymity after creation, in either direction', async () => {
      const { service } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm() as any);
      await expect(service.update('f1', input({ anonymous: false }), 'u1', false)).rejects.toThrow(
        BadRequestException
      );
    });

    it('refuses to make an anonymous form paid', async () => {
      const { service } = makeService();
      jest.spyOn(service, 'assertFormManager').mockResolvedValue(baseForm() as any);
      await expect(
        service.update('f1', input({ anonymous: undefined, requiresPayment: true }), 'u1', false)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('export', () => {
    it('has no name column, and lists in a random order rather than arrival order', async () => {
      const { service, submissionRepo } = makeService();
      submissionRepo.find.mockResolvedValueOnce([
        {
          id: 's1',
          userId: null,
          answers: { q1: 'bof' },
          createdAt: new Date(Date.UTC(2026, 8, 30)),
        },
      ]);
      const { buffer } = await service.exportSubmissions('f1', LABELS);
      expect(submissionRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { id: 'ASC' } })
      );
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const header = (workbook.worksheets[0].getRow(1).values as unknown[]).slice(1).map(String);
      expect(header).toEqual(['Date', 'Avis']);
    });
  });
});
