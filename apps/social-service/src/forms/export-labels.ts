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
}

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

  return parsed as ExportLabels;
}
