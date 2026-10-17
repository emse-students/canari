import * as ExcelJS from 'exceljs';
import { FormsService } from './forms.service';
import type { ExportLabels } from './export-labels';

/**
 * THE XLSX A MANAGER OPENS, READ BACK.
 *
 * Two defects shipped here and both were invisible to every gate: the file was written in English
 * because this service has no Paraglide, and a FREE form still got an amount column full of zeroes
 * and a status column reading `free` on every row. Neither is a claim about a header constant -
 * they are claims about the bytes, so these tests parse the workbook that comes out.
 */
describe('FormsService.exportSubmissions', () => {
  const LABELS: ExportLabels = {
    date: 'Date',
    firstName: 'Prenom',
    lastName: 'Nom de famille',
    amount: 'Montant paye',
    status: 'Statut',
    statuses: { free: 'Gratuit', paid: 'Paye', pending: 'En attente' },
  };

  const ASSO = { id: 'q_asso', label: 'Ton association', required: false, type: 'short_text' };

  function makeService(opts: {
    requiresPayment: boolean;
    submissions?: Record<string, unknown>[];
    items?: Record<string, unknown>[];
    deletedFiles?: string[];
  }) {
    const formRepo: any = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 'f1',
          title: 'Inscription',
          items: opts.items ?? [ASSO],
          requiresPayment: opts.requiresPayment,
        })
      ),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const submissionRepo: any = {
      find: jest.fn(() => Promise.resolve(opts.submissions ?? [])),
    };
    return new FormsService(
      formRepo,
      submissionRepo,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { deletedFileIds: jest.fn(() => Promise.resolve(new Set(opts.deletedFiles ?? []))) } as any
    );
  }

  const submission = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    userId: 'u1',
    answers: { q_asso: 'BDS' },
    totalPaid: 0,
    paymentStatus: 'free',
    createdAt: new Date(2026, 8, 20, 15, 7),
    ...over,
  });

  /** The first row of the produced sheet, which is the header row. */
  async function headers(service: FormsService, labels = LABELS): Promise<string[]> {
    const { buffer } = await service.exportSubmissions('f1', labels);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const row = workbook.worksheets[0].getRow(1);
    return (row.values as unknown[]).slice(1).map(String);
  }

  async function firstDataRow(service: FormsService): Promise<unknown[]> {
    const { buffer } = await service.exportSubmissions('f1', LABELS);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return (workbook.worksheets[0].getRow(2).values as unknown[]).slice(1);
  }

  it('writes the headers it was handed, and none of its own', async () => {
    const service = makeService({ requiresPayment: true, submissions: [submission()] });
    expect(await headers(service)).toEqual([
      'Date',
      'Prenom',
      'Nom de famille',
      'Montant paye',
      'Statut',
      'Ton association',
    ]);
  });

  // The defect the user reported: `Amount paid` and `Status` on a form that asks for no money.
  it('draws neither the amount nor the status column on a free form', async () => {
    const service = makeService({ requiresPayment: false, submissions: [submission()] });
    expect(await headers(service)).toEqual(['Date', 'Prenom', 'Nom de famille', 'Ton association']);
  });

  it('writes the status as a word, not as the stored enum', async () => {
    const service = makeService({
      requiresPayment: true,
      submissions: [submission({ totalPaid: 1500, paymentStatus: 'paid' })],
    });
    expect(await firstDataRow(service)).toContain('Paye');
  });

  // A status the client had no word for is a fact about the row, so it is written as stored rather
  // than blanked - and accused in the log, because a file that reads as if it had been translated
  // is how the English shipped in the first place.
  it('writes an unknown status raw and says so', async () => {
    const service = makeService({
      requiresPayment: true,
      submissions: [submission({ paymentStatus: 'refunded' })],
    });
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    expect(await firstDataRow(service)).toContain('refunded');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refunded'));
  });

  describe('a file question', () => {
    const CV = { id: 'q_cv', label: 'Ton CV', required: false, type: 'file' };
    const FILE_A = '11111111-1111-4111-8111-111111111111';
    const FILE_B = '22222222-2222-4222-8222-222222222222';
    const WITH_WORDS: ExportLabels = {
      ...LABELS,
      file: 'Fichier',
      fileDeleted: 'Fichier supprime',
    };

    async function rows(service: FormsService): Promise<unknown[][]> {
      const { buffer } = await service.exportSubmissions('f1', WITH_WORDS);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      return [2, 3].map((n) => (sheet.getRow(n).values as unknown[]).slice(1));
    }

    // The file is never exported, and its id is not a reading of anything: the cell is a word.
    it('writes the client word for a kept file and for a purged one, never the id', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [CV],
        deletedFiles: [FILE_B],
        submissions: [
          submission({ id: 's1', answers: { q_cv: FILE_A } }),
          submission({ id: 's2', answers: { q_cv: FILE_B } }),
        ],
      });
      const [first, second] = await rows(service);
      expect(first).toContain('Fichier');
      expect(second).toContain('Fichier supprime');
      expect(JSON.stringify([first, second])).not.toContain(FILE_A);
    });

    it('refuses a form with a file question when the client sent no word for it', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [CV],
        submissions: [submission({ answers: { q_cv: FILE_A } })],
      });
      await expect(service.exportSubmissions('f1', LABELS)).rejects.toThrow(/fileDeleted/);
    });
  });
});
