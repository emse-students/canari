import { BadRequestException } from '@nestjs/common';

/**
 * THE WORDS THE XLSX EXPORT IS WRITTEN WITH, SENT BY THE CLIENT THAT HAS THEM.
 *
 * This service has no Paraglide, no locale and no request language it could trust, so before
 * 2026-09-22 it wrote its own English into a file French managers open: `Timestamp`, `First name`,
 * `Amount paid`, and the raw `free` enum in the status column. The fix is not a translation table
 * here - it is to stop this side owning any word at all. The only place that knows the reader's
 * language is the client, so the client sends the five fixed headers and every payment status label
 * it knows, and this side writes exactly what it was handed.
 *
 * `frontend/src/lib/forms/api.ts` holds the mirror of this shape and `exportLabels()` builds it.
 * The two are small, and neither has any behaviour: a drift shows up as a missing header, refused
 * here rather than written blank.
 */
export interface ExportLabels {
  /** Header of the submission timestamp column. */
  date: string;
  /** Header of the respondent's first-name column. */
  firstName: string;
  /** Header of the respondent's last-name column. */
  lastName: string;
  /** Header of the amount column - a paid form only. */
  amount: string;
  /** Header of the payment-status column - a paid form only. */
  status: string;
  /** Every payment status the client knows, by its stored value. */
  statuses: Record<string, string>;
  /**
   * What a FILE question's cell reads when the file is kept, and when the retention purge has
   * deleted it. Optional HERE because only a form with a file question needs them -
   * `exportSubmissions` refuses such a form when they are missing. A client older than the file
   * question cannot have built one, so it is never asked for them.
   */
  file?: string;
  fileDeleted?: string;
  /**
   * Header of a guest's e-mail column (`guest-identity.ts`, migration 138). Optional HERE for the
   * same reason as `file`: only a form that asks guests for it (or holds an answer that carries
   * one) writes the column, and `exportSubmissions` refuses such a form when it is missing.
   */
  email?: string;
  /**
   * Header of the guest marker column: written on a non-anonymous form holding at least one answer
   * with no account, each guest row carrying its reference (`guestReference`), so a name a guest
   * typed is never read as an account's. Optional HERE, required by `exportSubmissions` when the
   * column is written.
   */
  guest?: string;
  /**
   * Header of the "last changed" column (migration 164): when the respondent last changed their
   * answer, blank on an answer never changed. Optional HERE, required by `exportSubmissions` when the
   * column is written - on a form that allows changes, or holding an answer that was changed.
   */
  edited?: string;
  /**
   * The words of the priced grid's two sheets (`product-grid-export.ts`). Optional HERE for the same
   * reason as `file`: only a form with a `product_grid` question needs them, and its export is refused
   * `EXPORT_LABELS_PRODUCT_GRID_MISSING` without them.
   */
  productGrid?: ProductGridExportLabels;
}

/** The words of the "Articles" and "Totaux" sheets, every one required when the object is sent. */
export interface ProductGridExportLabels {
  /** Sheet names (cut to Excel's 31 characters). */
  articlesSheet: string;
  totalsSheet: string;
  /** Header of the buyer column: a member's name, or `guest` and the reference a guest was given. */
  buyer: string;
  guest: string;
  /** Headers of the grid question, its row, its column and the price category. */
  question: string;
  row: string;
  column: string;
  category: string;
  /** What the "everyone else" category reads as (a guest's, and anybody no category claims). */
  othersCategory: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  /** "Total" (units) and "Amount" (euros) in the totals tables. */
  total: string;
  amount: string;
  /** Titles of the two blocks per grid: paid or free answers, and cash not yet received. */
  received: string;
  awaitingCash: string;
}

/** Every key of `ProductGridExportLabels`, for the check below. */
const PRODUCT_GRID_KEYS: readonly (keyof ProductGridExportLabels)[] = [
  'articlesSheet',
  'totalsSheet',
  'buyer',
  'guest',
  'question',
  'row',
  'column',
  'category',
  'othersCategory',
  'quantity',
  'unitPrice',
  'lineTotal',
  'total',
  'amount',
  'received',
  'awaitingCash',
];

const REQUIRED = ['date', 'firstName', 'lastName', 'amount', 'status'] as const;

/**
 * Reads the `labels` query parameter, or refuses.
 *
 * THERE IS NO DEFAULT AND THERE MUST NOT BE ONE. A missing parameter is a client that has not been
 * updated, and the only thing this side could substitute is the English that was the defect. A
 * refusal names the problem at the one moment somebody can act on it; a silent fallback ships a
 * wrong file that looks right.
 */
export function parseExportLabels(raw: string | undefined): ExportLabels {
  if (!raw) throw new BadRequestException('export labels are required');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('export labels are not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null)
    throw new BadRequestException('export labels must be an object');

  const labels = parsed as Record<string, unknown>;
  for (const key of REQUIRED)
    if (typeof labels[key] !== 'string' || labels[key] === '')
      throw new BadRequestException(`export label "${key}" is missing`);

  const statuses = labels.statuses;
  if (typeof statuses !== 'object' || statuses === null || Array.isArray(statuses))
    throw new BadRequestException('export label "statuses" is missing');
  for (const [status, label] of Object.entries(statuses))
    if (typeof label !== 'string')
      throw new BadRequestException(`export label for status "${status}" is not a string`);

  for (const key of ['file', 'fileDeleted', 'email', 'guest', 'edited'] as const)
    if (labels[key] !== undefined && (typeof labels[key] !== 'string' || labels[key] === ''))
      throw new BadRequestException(`export label "${key}" must be a non-empty string`);

  if (labels.productGrid !== undefined) {
    const grid = labels.productGrid;
    if (typeof grid !== 'object' || grid === null || Array.isArray(grid))
      throw new BadRequestException('export label "productGrid" must be an object');
    for (const key of PRODUCT_GRID_KEYS) {
      const value = (grid as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value === '')
        throw new BadRequestException(`export label "productGrid.${key}" is missing`);
    }
  }

  return parsed as ExportLabels;
}
