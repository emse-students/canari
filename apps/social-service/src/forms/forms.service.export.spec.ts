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
      { deletedFileIds: jest.fn(() => Promise.resolve(new Set(opts.deletedFiles ?? []))) } as any,
      // FormOrganiserAlertService: switched off, as it ships.
      { enabled: () => false } as any,
      {} as any
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

  describe('a choice question with a comment and an "Autre"', () => {
    const COLOUR = {
      id: 'q_col',
      label: 'Couleur',
      required: false,
      type: 'single_choice',
      allowComment: true,
      options: [
        { id: 'red', label: 'Rouge' },
        { id: 'oth', label: 'Autre', other: true },
      ],
    };
    const WORDS: ExportLabels = { ...LABELS, comment: 'Commentaire' };

    async function sheet(service: FormsService, labels: ExportLabels) {
      const { buffer } = await service.exportSubmissions('f1', labels);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const rows = workbook.worksheets[0];
      return [1, 2, 3].map((n) => (rows.getRow(n).values as unknown[]).slice(1));
    }

    it('writes the comment in its own column and the "Autre" text inside the answer cell', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [COLOUR],
        submissions: [
          submission({
            id: 's1',
            answers: { q_col: 'oth', 'q_col#other': 'Vert', 'q_col#comment': 'Merci' },
          }),
          submission({ id: 's2', answers: { q_col: 'red' } }),
        ],
      });
      const [head, first, second] = await sheet(service, WORDS);
      expect(head.slice(3)).toEqual(['Couleur', 'Couleur - Commentaire']);
      expect(first.slice(3)).toEqual(['Autre: Vert', 'Merci']);
      expect(second.slice(3)).toEqual(['Rouge', '']);
    });

    it('exports without the comment column when an older client sent no word for it', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [COLOUR],
        submissions: [submission({ answers: { q_col: 'red', 'q_col#comment': 'Merci' } })],
      });
      const [head, first] = await sheet(service, LABELS);
      expect(head.slice(3)).toEqual(['Couleur']);
      expect(first.slice(3)).toEqual(['Rouge']);
    });

    it('keeps the column of a comment that was given while the switch was on', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [{ ...COLOUR, allowComment: false }],
        submissions: [submission({ answers: { q_col: 'red', 'q_col#comment': 'Avant' } })],
      });
      const [head, first] = await sheet(service, WORDS);
      expect(head.slice(3)).toEqual(['Couleur', 'Couleur - Commentaire']);
      expect(first.slice(3)).toEqual(['Rouge', 'Avant']);
    });
  });

  describe('a number format', () => {
    const AGE = {
      id: 'q_age',
      label: 'Age',
      required: false,
      type: 'short_text',
      format: 'number',
    };

    it('keeps an identifier-looking answer as the text it was, never a rewritten number', async () => {
      const texts = ['007', '0612345678', '1e3', '0x1A'];
      const service = makeService({
        requiresPayment: false,
        items: [AGE],
        submissions: texts.map((text, n) => submission({ id: `s${n}`, answers: { q_age: text } })),
      });
      const { buffer } = await service.exportSubmissions('f1', LABELS);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const cells = texts.map((_t, n) => workbook.worksheets[0].getRow(n + 2).getCell(4).value);
      expect(cells).toEqual(texts);
    });

    it('writes a number as a number, a skipped answer as an empty cell, and legacy text as text', async () => {
      const service = makeService({
        requiresPayment: false,
        items: [AGE],
        submissions: [
          submission({ id: 's1', answers: { q_age: '21' } }),
          submission({ id: 's2', answers: {} }),
          submission({ id: 's3', answers: { q_age: 'vingt' } }),
        ],
      });
      const { buffer } = await service.exportSubmissions('f1', LABELS);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const cells = [2, 3, 4].map((n) => workbook.worksheets[0].getRow(n).getCell(4).value);
      expect(cells[0]).toBe(21);
      expect(cells[1] == null || cells[1] === '').toBe(true);
      expect(cells[2]).toBe('vingt');
    });
  });
});
