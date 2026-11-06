import { BadRequestException } from '@nestjs/common';
import type * as ExcelJS from 'exceljs';
import type { ExportLabels, ProductGridExportLabels } from './export-labels';
import { guestDisplayName } from './guest-identity';
import { guestReference } from './guest-receipt';
import { productGridItems } from './product-grid';
import {
  PRODUCT_GRID_AWAITING_CASH_STATUSES,
  PRODUCT_GRID_OTHERS_TIER,
  PRODUCT_GRID_RECEIVED_STATUSES,
  productGridCellKey,
  productGridLinesOf,
  productGridTotals,
  type ProductGridLine,
  type ProductGridTotals,
} from './product-grid-contract';

/**
 * THE PRICED GRID IN THE XLSX: an "Articles" sheet (one line per ordered cell) and a "Totaux" sheet
 * (per grid, quantities and amounts per row and per column). Both read `submissions.lines` - what
 * was CHARGED - never the grid as it stands now, so a renamed row or a moved price leaves the
 * accounting as it was. Every word is the client's (`ExportLabels.productGrid`), like every other
 * header of the export.
 */

/** The part of a submission the sheets read. */
export interface GridExportSubmission {
  id: string;
  userId: string | null;
  paymentStatus: string;
  createdAt: Date | string;
  lines: ProductGridLine[] | null;
  /** What a guest typed when the form asked (migration 138); absent or null otherwise. */
  guestFirstName?: string | null;
  guestLastName?: string | null;
}

/**
 * The words a grid form's export needs, or a refusal: a client older than the grid cannot have sent
 * them, and the only words this side could write instead are its own - the defect `ExportLabels`
 * exists to prevent.
 */
export function productGridExportLabels(
  items: readonly { type?: string }[] | null | undefined,
  labels: ExportLabels
): ProductGridExportLabels | null {
  if (productGridItems(items).length === 0) return null;
  if (!labels.productGrid) {
    throw new BadRequestException({
      code: 'EXPORT_LABELS_PRODUCT_GRID_MISSING',
      message: 'export labels "productGrid" are required for a form with a product grid',
    });
  }
  return labels.productGrid;
}

/**
 * One block of the "Totaux" sheet: a title, then rows x columns of quantities with a total column
 * and an amount column, then a total row (units per column) and an amount row (euros per column).
 */
function writeTotalsBlock(
  sheet: ExcelJS.Worksheet,
  title: string,
  totals: ProductGridTotals,
  words: ProductGridExportLabels
): void {
  sheet.addRow([title]).font = { bold: true };
  sheet.addRow([
    '',
    ...totals.columns.map((c) => c.label),
    words.total,
    `${words.amount} (EUR)`,
  ]).font = { bold: true };
  for (const row of totals.rows) {
    sheet.addRow([
      row.label,
      ...totals.columns.map((c) => totals.cells[productGridCellKey(row.id, c.id)]?.units ?? 0),
      totals.rowTotals[row.id].units,
      totals.rowTotals[row.id].cents / 100,
    ]);
  }
  sheet.addRow([
    words.total,
    ...totals.columns.map((c) => totals.columnTotals[c.id].units),
    totals.total.units,
    totals.total.cents / 100,
  ]).font = { bold: true };
  sheet.addRow([
    `${words.amount} (EUR)`,
    ...totals.columns.map((c) => totals.columnTotals[c.id].cents / 100),
  ]);
  sheet.addRow([]);
}

/**
 * Adds the "Articles" and "Totaux" sheets for a form with priced grids. `names` holds each member
 * submitter's name; a guest is written as the guest word and the reference they were given.
 */
export function addProductGridSheets(
  workbook: ExcelJS.Workbook,
  items: readonly { type?: string }[],
  submissions: readonly GridExportSubmission[],
  names: ReadonlyMap<string, { firstName: string | null; lastName: string | null }>,
  labels: ExportLabels,
  words: ProductGridExportLabels
): void {
  const grids = productGridItems(items);
  const articles = workbook.addWorksheet(words.articlesSheet.slice(0, 31));
  articles.columns = [
    { header: labels.date, key: 'date', width: 20, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
    { header: words.buyer, key: 'buyer', width: 26 },
    { header: words.question, key: 'question', width: 26 },
    { header: words.row, key: 'row', width: 20 },
    { header: words.column, key: 'column', width: 14 },
    { header: words.category, key: 'category', width: 16 },
    { header: words.quantity, key: 'quantity', width: 10 },
    { header: `${words.unitPrice} (EUR)`, key: 'unit', width: 14 },
    { header: `${words.lineTotal} (EUR)`, key: 'line', width: 14 },
    { header: labels.status, key: 'status', width: 16 },
  ];
  for (const sub of submissions) {
    if (!sub.lines?.length) continue;
    const person = sub.userId ? names.get(sub.userId) : undefined;
    // A guest is named by what they typed when the form asked (`guest-identity.ts`), else by the
    // reference they were given.
    const buyer = sub.userId
      ? [person?.firstName, person?.lastName].filter(Boolean).join(' ')
      : (guestDisplayName(sub) ?? `${words.guest} ${guestReference(sub.id)}`);
    for (const line of sub.lines) {
      articles.addRow({
        date: sub.createdAt instanceof Date ? sub.createdAt : new Date(sub.createdAt),
        buyer,
        question: line.itemLabel,
        row: line.rowLabel,
        column: line.colLabel,
        category:
          line.tierLabel ?? (line.tierId === PRODUCT_GRID_OTHERS_TIER ? words.othersCategory : ''),
        quantity: line.quantity,
        unit: line.unitCents / 100,
        line: line.lineCents / 100,
        status: labels.statuses[sub.paymentStatus] ?? sub.paymentStatus,
      });
    }
  }

  const totals = workbook.addWorksheet(words.totalsSheet.slice(0, 31));
  totals.getColumn(1).width = 26;
  // The ONE counting rule, shared with the responses screen (`product-grid-contract.ts`).
  const received = productGridLinesOf(submissions, PRODUCT_GRID_RECEIVED_STATUSES);
  const awaiting = productGridLinesOf(submissions, PRODUCT_GRID_AWAITING_CASH_STATUSES);
  for (const item of grids) {
    totals.addRow([item.label]).font = { bold: true, size: 13 };
    writeTotalsBlock(totals, words.received, productGridTotals(item, received), words);
    writeTotalsBlock(totals, words.awaitingCash, productGridTotals(item, awaiting), words);
  }
}

/**
 * What the export endpoint writes: the whole workbook, or ONE of the grid's two sheets as CSV - the
 * "CSV Articles" (one line per ordered cell) and "CSV Totaux" (the supplier order) of the responses
 * screen's export menu. A CSV is the SAME sheet the workbook carries, written by the same code, so
 * the two files cannot disagree.
 */
export const SUBMISSIONS_EXPORT_FORMATS = ['xlsx', 'articles-csv', 'totals-csv'] as const;
export type SubmissionsExportFormat = (typeof SUBMISSIONS_EXPORT_FORMATS)[number];

/** Reads the `format` query parameter: absent is the workbook (every client before the CSVs). */
export function parseExportFormat(raw: string | undefined): SubmissionsExportFormat {
  if (raw === undefined || raw === '') return 'xlsx';
  if ((SUBMISSIONS_EXPORT_FORMATS as readonly string[]).includes(raw))
    return raw as SubmissionsExportFormat;
  throw new BadRequestException({
    code: 'EXPORT_FORMAT_UNKNOWN',
    message: `export format "${raw}" is not one of ${SUBMISSIONS_EXPORT_FORMATS.join(', ')}`,
  });
}

/**
 * A CSV format names a grid sheet, so a form without a priced grid has nothing to write: refused,
 * typed, before any read - never an empty file that looks like "nobody ordered".
 */
export function assertExportFormatFits(
  format: SubmissionsExportFormat,
  gridWords: ProductGridExportLabels | null
): void {
  if (format === 'xlsx' || gridWords) return;
  throw new BadRequestException({
    code: 'EXPORT_FORMAT_NEEDS_PRODUCT_GRID',
    message: `export format "${format}" needs a form with a product grid`,
  });
}

/** The sheet a CSV format writes, as `addProductGridSheets` named it. */
export function csvSheetName(
  format: Exclude<SubmissionsExportFormat, 'xlsx'>,
  words: ProductGridExportLabels
): string {
  return (format === 'articles-csv' ? words.articlesSheet : words.totalsSheet).slice(0, 31);
}

/**
 * A text cell a spreadsheet would read as a FORMULA - it starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return - prefixed with `'`, so it opens as the text it is. An xlsx cell is typed and never
 * evaluated; a CSV cell has no type, and a buyer's name, a row label or a tier label is typed by
 * someone other than the manager who opens the file (CSV injection). Numbers pass untouched: a
 * negative amount is a number, not a formula.
 */
export function neutraliseCsvCell(value: unknown): unknown {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** A row as exceljs hands it to the CSV writer - an array of cells - each cell neutralised. */
function neutraliseCsvRow<R>(row: R): R {
  return (Array.isArray(row) ? row.map(neutraliseCsvCell) : row) as R;
}

/**
 * Writes one sheet of the workbook as CSV: `;`-separated with a byte-order mark, which is what a
 * French spreadsheet opens as columns and accents rather than one column of mojibake; dates as the
 * workbook shows them, in UTC as the workbook stores them; every text cell neutralised
 * (`neutraliseCsvCell`).
 */
export async function sheetAsCsv(workbook: ExcelJS.Workbook, sheetName: string): Promise<Buffer> {
  const buffer = await workbook.csv.writeBuffer({
    sheetName,
    dateFormat: 'DD/MM/YYYY HH:mm:ss',
    dateUTC: true,
    formatterOptions: {
      delimiter: ';',
      writeBOM: true,
      transform: neutraliseCsvRow,
    },
  });
  return Buffer.from(buffer as ArrayBuffer);
}
