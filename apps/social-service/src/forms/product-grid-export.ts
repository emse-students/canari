import { BadRequestException } from '@nestjs/common';
import type * as ExcelJS from 'exceljs';
import type { ExportLabels, ProductGridExportLabels } from './export-labels';
import { guestReference } from './guest-receipt';
import { productGridItems, type ProductGridItem } from './product-grid';
import {
  PRODUCT_GRID_OTHERS_TIER,
  type ProductGridAxisEntry,
  type ProductGridLine,
} from './product-grid-contract';

/**
 * THE PRICED GRID IN THE XLSX: an "Articles" sheet (one line per ordered cell) and a "Totaux" sheet
 * (per grid, quantities and amounts per row and per column). Both read `submissions.lines` - what
 * was CHARGED - never the grid as it stands now, so a renamed row or a moved price leaves the
 * accounting as it was. Every word is the client's (`ExportLabels.productGrid`), like every other
 * header of the export.
 */

/** Statuses whose units are counted as ordered: the money landed, or nothing was owed. */
export const RECEIVED_STATUSES: ReadonlySet<string> = new Set(['paid', 'free']);
/** Statuses whose units are counted apart: ordered in cash, the money not yet received. */
export const AWAITING_CASH_STATUSES: ReadonlySet<string> = new Set(['pending_cash']);

/** The part of a submission the sheets read. */
export interface GridExportSubmission {
  id: string;
  userId: string | null;
  paymentStatus: string;
  createdAt: Date | string;
  lines: ProductGridLine[] | null;
}

/** Quantities and amounts of one grid, by row x column, over one set of answers. */
export interface GridTotals {
  rows: ProductGridAxisEntry[];
  columns: ProductGridAxisEntry[];
  /** `rowId:colId` -> units. */
  quantities: Map<string, number>;
  /** `rowId:colId` -> cents. */
  amounts: Map<string, number>;
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
 * An axis of a grid as the totals list it: the grid's entries as they stand, then any entry the
 * lines name that the grid no longer has (a deleted row keeps its past orders), under the label it
 * was charged with.
 */
function axisWithPast(
  current: readonly ProductGridAxisEntry[],
  lines: readonly ProductGridLine[],
  pick: (line: ProductGridLine) => ProductGridAxisEntry
): ProductGridAxisEntry[] {
  const axis = current.map((entry) => ({ id: entry.id, label: entry.label }));
  const known = new Set(axis.map((entry) => entry.id));
  for (const line of lines) {
    const entry = pick(line);
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    axis.push(entry);
  }
  return axis;
}

/** Sums the lines of ONE grid question into quantities and amounts per cell. */
export function gridTotals(item: ProductGridItem, lines: readonly ProductGridLine[]): GridTotals {
  const own = lines.filter((line) => line.itemId === item.id);
  const quantities = new Map<string, number>();
  const amounts = new Map<string, number>();
  for (const line of own) {
    const key = `${line.rowId}:${line.colId}`;
    quantities.set(key, (quantities.get(key) ?? 0) + line.quantity);
    amounts.set(key, (amounts.get(key) ?? 0) + line.lineCents);
  }
  return {
    rows: axisWithPast(item.productGrid.rows, own, (l) => ({ id: l.rowId, label: l.rowLabel })),
    columns: axisWithPast(item.productGrid.columns, own, (l) => ({
      id: l.colId,
      label: l.colLabel,
    })),
    quantities,
    amounts,
  };
}

/** A sum over a map's entries matching a predicate on the cell key. */
function sumWhere(map: Map<string, number>, match: (rowId: string, colId: string) => boolean) {
  let total = 0;
  for (const [key, value] of map) {
    const [rowId, colId] = key.split(':');
    if (match(rowId, colId)) total += value;
  }
  return total;
}

/**
 * One block of the "Totaux" sheet: a title, then rows x columns of quantities with a total column
 * and an amount column, then a total row (units per column) and an amount row (euros per column).
 */
function writeTotalsBlock(
  sheet: ExcelJS.Worksheet,
  title: string,
  totals: GridTotals,
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
      ...totals.columns.map((c) => totals.quantities.get(`${row.id}:${c.id}`) ?? 0),
      sumWhere(totals.quantities, (r) => r === row.id),
      sumWhere(totals.amounts, (r) => r === row.id) / 100,
    ]);
  }
  sheet.addRow([
    words.total,
    ...totals.columns.map((c) => sumWhere(totals.quantities, (_r, col) => col === c.id)),
    sumWhere(totals.quantities, () => true),
    sumWhere(totals.amounts, () => true) / 100,
  ]).font = { bold: true };
  sheet.addRow([
    `${words.amount} (EUR)`,
    ...totals.columns.map((c) => sumWhere(totals.amounts, (_r, col) => col === c.id) / 100),
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
    const buyer = sub.userId
      ? [person?.firstName, person?.lastName].filter(Boolean).join(' ')
      : `${words.guest} ${guestReference(sub.id)}`;
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
  const linesOf = (statuses: ReadonlySet<string>) =>
    submissions.filter((s) => statuses.has(s.paymentStatus)).flatMap((s) => s.lines ?? []);
  const received = linesOf(RECEIVED_STATUSES);
  const awaiting = linesOf(AWAITING_CASH_STATUSES);
  for (const item of grids) {
    totals.addRow([item.label]).font = { bold: true, size: 13 };
    writeTotalsBlock(totals, words.received, gridTotals(item, received), words);
    writeTotalsBlock(totals, words.awaitingCash, gridTotals(item, awaiting), words);
  }
}
