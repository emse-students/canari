import { BadRequestException } from '@nestjs/common';

/**
 * THE WORDS OF AN ASSOCIATION'S STATEMENT (lot 4), the client's own - forms' and bookings' export
 * reasoning (`bookings/booking-export.ts`): this service has no Paraglide and no language it could
 * trust, so every header and every word written into a cell comes in the request, and a missing one
 * is refused (`export-labels`), never replaced by a default.
 */
export interface StatementLabels {
  date: string;
  operation: string;
  item: string;
  method: string;
  amount: string;
  reason: string;
  /** The operation cell of a payment received. */
  payment: string;
  /** The operation cells of a refund. */
  refundTotal: string;
  refundPartial: string;
  /** The payment-method cells. */
  cash: string;
  online: string;
  /** The three total rows. */
  totalReceived: string;
  totalRefunded: string;
  balance: string;
}

const KEYS = [
  'date',
  'operation',
  'item',
  'method',
  'amount',
  'reason',
  'payment',
  'refundTotal',
  'refundPartial',
  'cash',
  'online',
  'totalReceived',
  'totalRefunded',
  'balance',
] as const satisfies readonly (keyof StatementLabels)[];

/** The code a statement asked without its words is refused with - bookings' and forms' code. */
export const STATEMENT_LABELS_REFUSAL = 'export-labels';

/**
 * Reads the `labels` query parameter, or refuses `export-labels` (400). Every key is required, a
 * non-empty string of at most 200 characters.
 */
export function parseStatementLabels(raw: string | undefined): StatementLabels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new BadRequestException({ code: STATEMENT_LABELS_REFUSAL });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException({ code: STATEMENT_LABELS_REFUSAL });
  }
  const labels = parsed as Record<string, unknown>;
  const out = {} as StatementLabels;
  for (const key of KEYS) {
    const value = labels[key];
    if (typeof value !== 'string' || value === '' || value.length > 200) {
      throw new BadRequestException({ code: STATEMENT_LABELS_REFUSAL, key });
    }
    out[key] = value;
  }
  return out;
}
