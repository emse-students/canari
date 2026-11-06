import * as ExcelJS from 'exceljs';
import { FormsService } from './forms.service';
import {
  parseExportLabels,
  type ExportLabels,
  type ProductGridExportLabels,
} from './export-labels';
import { guestReference } from './guest-receipt';
import type { ProductGridLine } from './product-grid-contract';
import { productGridExportLabels } from './product-grid-export';

/**
 * THE PRICED GRID IN THE XLSX, READ BACK: the main sheet's "Vert / M x2; Noir / L x1", one
 * "Articles" line per ordered cell, and "Totaux" per row and per column with cash not yet received
 * apart. Everything is read from what was CHARGED (`submissions.lines`), so a row renamed after the
 * order keeps its old name in the file.
 */

const GRID_WORDS: ProductGridExportLabels = {
  articlesSheet: 'Articles',
  totalsSheet: 'Totaux',
  buyer: 'Acheteur',
  guest: 'Invite',
  question: 'Question',
  row: 'Ligne',
  column: 'Colonne',
  category: 'Categorie',
  othersCategory: 'Autres',
  quantity: 'Quantite',
  unitPrice: 'Prix unitaire',
  lineTotal: 'Total ligne',
  total: 'Total',
  amount: 'Montant',
  received: 'Paye ou gratuit',
  awaitingCash: 'Especes non recues',
};
const LABELS: ExportLabels = {
  date: 'Date',
  firstName: 'Prenom',
  lastName: 'Nom',
  amount: 'Montant paye',
  status: 'Statut',
  statuses: { paid: 'Paye', pending_cash: 'Especes', free: 'Gratuit' },
  productGrid: GRID_WORDS,
};

const GRID_ITEM = {
  id: 'q-grid',
  label: 'Sweat',
  type: 'product_grid',
  required: true,
  productGrid: {
    rows: [
      { id: 'vert', label: 'Vert' },
      { id: 'noir', label: 'Noir' },
    ],
    columns: [
      { id: 'm', label: 'M' },
      { id: 'l', label: 'L' },
    ],
    maxPerCell: 5,
    closedCells: [],
    pricing: { mode: 'single', tiers: null, prices: { _all: { '*': 2800 } } },
  },
};

const line = (rowId: string, rowLabel: string, colId: string, quantity: number, unit = 2800) =>
  ({
    itemId: 'q-grid',
    itemLabel: 'Sweat',
    rowId,
    rowLabel,
    colId,
    colLabel: colId.toUpperCase(),
    quantity,
    unitCents: unit,
    lineCents: unit * quantity,
    tierId: '_others',
    tierLabel: null,
  }) satisfies ProductGridLine;

const SUBMISSIONS = [
  {
    id: 's-paid',
    userId: 'u1',
    paymentStatus: 'paid',
    totalPaid: 8400,
    createdAt: new Date(2026, 10, 6, 10, 0),
    answers: { 'q-grid': { 'vert:m': 2, 'noir:l': 1 } },
    lines: [line('vert', 'Vert', 'm', 2), line('noir', 'Noir', 'l', 1)],
  },
  {
    // A guest, ordering a row since DELETED from the grid: it keeps its charged label.
    id: 's-guest',
    userId: null,
    paymentStatus: 'paid',
    totalPaid: 3000,
    createdAt: new Date(2026, 10, 6, 11, 0),
    answers: { 'q-grid': { 'rose:m': 1 } },
    lines: [line('rose', 'Rose', 'm', 1, 3000)],
  },
  {
    id: 's-cash',
    userId: 'u2',
    paymentStatus: 'pending_cash',
    totalPaid: 2800,
    createdAt: new Date(2026, 10, 6, 12, 0),
    answers: { 'q-grid': { 'vert:l': 1 } },
    lines: [line('vert', 'Vert', 'l', 1)],
  },
  {
    // Neither received nor awaited: counted nowhere in the totals, still listed as an article.
    id: 's-cancelled',
    userId: 'u3',
    paymentStatus: 'cancelled',
    totalPaid: 2800,
    createdAt: new Date(2026, 10, 6, 13, 0),
    answers: { 'q-grid': { 'vert:m': 1 } },
    lines: [line('vert', 'Vert', 'm', 1)],
  },
];

function makeService() {
  const formRepo: any = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: 'f1', title: 'Merch', items: [GRID_ITEM], requiresPayment: true })
    ),
    manager: {
      query: jest.fn(() =>
        Promise.resolve([
          { id: 'u1', firstName: 'Ada', lastName: 'Lovelace' },
          { id: 'u2', firstName: 'Alan', lastName: 'Turing' },
          { id: 'u3', firstName: 'Grace', lastName: 'Hopper' },
        ])
      ),
    },
  };
  const submissionRepo: any = { find: jest.fn(() => Promise.resolve(SUBMISSIONS)) };
  return new FormsService(
    formRepo,
    submissionRepo,
    {} as any,
    { get: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { enabled: () => false } as any,
    {} as any // FormItemImagesService
  );
}

async function workbookOf(labels: ExportLabels = LABELS): Promise<ExcelJS.Workbook> {
  const { buffer } = await makeService().exportSubmissions('f1', labels);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet) => {
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
};

describe('the priced grid in the XLSX export', () => {
  it('the main sheet reads each answer from what was charged', async () => {
    const main = (await workbookOf()).worksheets[0];
    const cells = rowsOf(main)
      .slice(1)
      .map((row) => row[row.length - 1]);
    expect(cells).toEqual([
      'Vert / M x2; Noir / L x1',
      'Rose / M x1',
      'Vert / L x1',
      'Vert / M x1',
    ]);
  });

  it('"Articles": one line per ordered cell, a guest named by its reference', async () => {
    const articles = (await workbookOf()).getWorksheet('Articles')!;
    const rows = rowsOf(articles);
    expect(rows[0]).toEqual([
      'Date',
      'Acheteur',
      'Question',
      'Ligne',
      'Colonne',
      'Categorie',
      'Quantite',
      'Prix unitaire (EUR)',
      'Total ligne (EUR)',
      'Statut',
    ]);
    const body = rows.slice(1).map((r) => r.slice(1));
    expect(body).toEqual([
      ['Ada Lovelace', 'Sweat', 'Vert', 'M', 'Autres', 2, 28, 56, 'Paye'],
      ['Ada Lovelace', 'Sweat', 'Noir', 'L', 'Autres', 1, 28, 28, 'Paye'],
      [`Invite ${guestReference('s-guest')}`, 'Sweat', 'Rose', 'M', 'Autres', 1, 30, 30, 'Paye'],
      ['Alan Turing', 'Sweat', 'Vert', 'L', 'Autres', 1, 28, 28, 'Especes'],
      ['Grace Hopper', 'Sweat', 'Vert', 'M', 'Autres', 1, 28, 28, 'cancelled'],
    ]);
  });

  it('"Totaux": per row and per column, received apart from cash not yet received', async () => {
    const rows = rowsOf((await workbookOf()).getWorksheet('Totaux')!);
    expect(rows).toEqual([
      ['Sweat'],
      ['Paye ou gratuit'],
      ['', 'M', 'L', 'Total', 'Montant (EUR)'],
      ['Vert', 2, 0, 2, 56],
      ['Noir', 0, 1, 1, 28],
      // The deleted row, from its lines.
      ['Rose', 1, 0, 1, 30],
      ['Total', 3, 1, 4, 114],
      ['Montant (EUR)', 86, 28],
      ['Especes non recues'],
      ['', 'M', 'L', 'Total', 'Montant (EUR)'],
      ['Vert', 0, 1, 1, 28],
      ['Noir', 0, 0, 0, 0],
      ['Total', 0, 1, 1, 28],
      ['Montant (EUR)', 0, 28],
    ]);
  });

  it('refuses a grid form exported without the grid words, coded', async () => {
    const { productGrid: _words, ...older } = LABELS;
    await expect(makeService().exportSubmissions('f1', older)).rejects.toMatchObject({
      response: { code: 'EXPORT_LABELS_PRODUCT_GRID_MISSING' },
    });
  });

  it('asks no grid words of a form without a grid: the export of any other form is unchanged', () => {
    const { productGrid: _words, ...older } = LABELS;
    const items = [{ type: 'short_text' }, { type: 'matrix_single' }, { type: 'file' }];
    expect(productGridExportLabels(items, older)).toBeNull();
    expect(productGridExportLabels(null, older)).toBeNull();
    expect(parseExportLabels(JSON.stringify(older)).productGrid).toBeUndefined();
  });

  it('parseExportLabels refuses an incomplete set of grid words', () => {
    const { buyer: _buyer, ...partial } = GRID_WORDS;
    expect(() => parseExportLabels(JSON.stringify({ ...LABELS, productGrid: partial }))).toThrow(
      'export label "productGrid.buyer" is missing'
    );
    expect(parseExportLabels(JSON.stringify(LABELS)).productGrid).toEqual(GRID_WORDS);
  });
});
