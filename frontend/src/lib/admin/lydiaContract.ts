import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { forgetLydiaFeeSchedule } from '$lib/payments/lydiaFees';
import { m } from '$lib/paraglide/messages';

/**
 * The platform's Lydia contract terms and the counter of the contract year's flux, as the admin
 * screen reads and writes them (`/api/users/admin/platform/lydia-contract`, core-service
 * `LydiaContractService`; docs/wiki/lydia-contract-flux.md). The shapes copy core's
 * `lydia-contract.ts`; no value is written here - the contract is confidential.
 */

/** The payment kinds a fee is stated for - the copy of core's `LYDIA_PAYMENT_KINDS`. */
export const LYDIA_PAYMENT_KINDS = ['remote', 'qr', 'tap_to_pay'] as const;
export type LydiaPaymentKind = (typeof LYDIA_PAYMENT_KINDS)[number];

/** A fee per payment, HT: basis points plus cents. */
interface LydiaFee {
  percentBps: number;
  fixedCents: number;
}

type LydiaFeesByKind = Partial<Record<LydiaPaymentKind, LydiaFee>>;

interface LydiaBand {
  fromCents: number;
  fees: LydiaFeesByKind;
}

/** What the admin reads and writes, whole. */
export interface LydiaContractSettings {
  anniversary: string | null;
  fluxTargetCents: number | null;
  vatBps: number | null;
  fees: LydiaFeesByKind;
  bands: LydiaBand[];
}

/** The figures of a contract year's flux, whole or for one association, cents TTC. */
interface LydiaFluxFigures {
  paidCents: number;
  paymentCount: number;
  refundedCents: number;
  refundCount: number;
  fluxCents: number;
  excludedCents: number;
  excludedCount: number;
  untraceableCents: number;
  untraceableCount: number;
}

/** One association's part of the flux (social-service `measureLydiaFlux`). */
interface LydiaFluxShare extends LydiaFluxFigures {
  associationId: string;
  /** NULL when the association no longer exists. */
  name: string | null;
  /** `association`, `list` or `institution`; NULL when it no longer exists. */
  type: string | null;
}

/**
 * The percentage of the total flux one association brings, or `null` when the total is not
 * positive (no share of nothing). Not rounded: the caller formats it.
 */
export function fluxSharePercent(shareCents: number, totalCents: number): number | null {
  if (totalCents <= 0) return null;
  return (shareCents / totalCents) * 100;
}

/** The counter of the current contract year. */
export interface LydiaContractCounter {
  today: string;
  year: { start: string; end: string; daysTotal: number; daysLeft: number } | null;
  flux:
    | (LydiaFluxFigures & {
        /** One row per association (or list), sorted by flux descending; the totals are their sums. */
        byAssociation: LydiaFluxShare[];
      })
    | null;
  targetCents: number | null;
  band: (LydiaBand & { index: number }) | null;
  nextBand: (LydiaBand & { index: number }) | null;
  missing: Array<'anniversary' | 'target' | 'bands'>;
}

/**
 * A refusal of the terms: the field core named (`LYDIA_CONTRACT_INVALID`), or none, and its typed
 * `reason` when the field alone cannot tell (`BAND_ORDER`: two bands at the same threshold).
 */
export class LydiaContractRefused extends Error {
  constructor(
    readonly field: string | null,
    readonly reason: string | null = null
  ) {
    super(`lydia contract refused${field ? ` (${field})` : ''}`);
    this.name = 'LydiaContractRefused';
  }
}

const BASE = () => `${coreUrl()}/api/users/admin/platform/lydia-contract`;

/** Reads the terms. Throws on any refusal. */
export async function fetchLydiaContract(): Promise<LydiaContractSettings> {
  const res = await apiFetch(BASE());
  if (!res.ok) throw new Error(`lydia contract read answered ${res.status}`);
  return (await res.json()) as LydiaContractSettings;
}

/** Replaces the terms; a 400 is a {@link LydiaContractRefused} naming the field. */
export async function saveLydiaContract(
  settings: LydiaContractSettings
): Promise<LydiaContractSettings> {
  const res = await apiFetch(BASE(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as {
      field?: unknown;
      reason?: unknown;
    } | null;
    const field = typeof body?.field === 'string' ? body.field : null;
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    Log.w('admin.lydia', `terms refused field=${field ?? 'none'} reason=${reason ?? 'none'}`);
    throw new LydiaContractRefused(field, reason);
  }
  if (!res.ok) throw new Error(`lydia contract write answered ${res.status}`);
  // The payout estimates read the fee and the VAT from these terms.
  forgetLydiaFeeSchedule();
  return (await res.json()) as LydiaContractSettings;
}

/** Reads the counter of the current contract year. Throws on any refusal (a 502: not measured). */
export async function fetchLydiaContractCounter(): Promise<LydiaContractCounter> {
  const res = await apiFetch(`${BASE()}/counter`);
  if (!res.ok) throw new Error(`lydia contract counter answered ${res.status}`);
  return (await res.json()) as LydiaContractCounter;
}

/**
 * A decimal typed in a form ("1,5" or "1.5") in hundredths: euros into cents, percent into basis
 * points. Empty is null (not set); anything not a number, negative or with more than two decimals
 * is `NaN`, which the form refuses.
 */
export function decimalToHundredths(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().replace(',', '.');
  if (text === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return Number.NaN;
  return Math.round(Number(text) * 100);
}

/** Cents or basis points shown as the decimal an admin types ("1.5"); null is "". */
export function hundredthsToDecimal(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return (value / 100).toString();
}

/** One fee as typed: two decimals, either may be empty. */
interface LydiaFeeInputs {
  percent: string;
  fixed: string;
}

/** The admin form, every value as typed. */
export interface LydiaContractForm {
  anniversary: string;
  target: string;
  vat: string;
  fees: Record<LydiaPaymentKind, LydiaFeeInputs>;
  bands: Array<{ from: string; fees: Record<LydiaPaymentKind, LydiaFeeInputs> }>;
}

function feeInputs(fees: LydiaFeesByKind): Record<LydiaPaymentKind, LydiaFeeInputs> {
  return Object.fromEntries(
    LYDIA_PAYMENT_KINDS.map((k) => [
      k,
      {
        percent: hundredthsToDecimal(fees[k]?.percentBps),
        fixed: hundredthsToDecimal(fees[k]?.fixedCents),
      },
    ])
  ) as Record<LydiaPaymentKind, LydiaFeeInputs>;
}

/** The form showing `settings`. */
export function toLydiaContractForm(settings: LydiaContractSettings): LydiaContractForm {
  return {
    anniversary: settings.anniversary ?? '',
    target: hundredthsToDecimal(settings.fluxTargetCents),
    vat: hundredthsToDecimal(settings.vatBps),
    fees: feeInputs(settings.fees),
    bands: settings.bands.map((b) => ({
      from: hundredthsToDecimal(b.fromCents),
      fees: feeInputs(b.fees),
    })),
  };
}

/** An empty band row. */
export function emptyLydiaBand(): LydiaContractForm['bands'][number] {
  return { from: '', fees: feeInputs({}) };
}

/**
 * Thrown by {@link fromLydiaContractForm}: the form field that is not a number, or two bands at the
 * same threshold (`BAND_ORDER`, the reason core's own refusal carries).
 */
export class LydiaContractFormInvalid extends Error {
  constructor(
    readonly field: string,
    readonly reason: 'BAND_ORDER' | null = null
  ) {
    super(`${reason ?? 'not a number'}: ${field}`);
    this.name = 'LydiaContractFormInvalid';
  }
}

function number(input: string, field: string): number | null {
  const value = decimalToHundredths(input);
  if (value !== null && Number.isNaN(value)) throw new LydiaContractFormInvalid(field);
  return value;
}

function feesOf(inputs: Record<LydiaPaymentKind, LydiaFeeInputs>, field: string): LydiaFeesByKind {
  const out: LydiaFeesByKind = {};
  for (const kind of LYDIA_PAYMENT_KINDS) {
    const percent = number(inputs[kind].percent, `${field}.${kind}.percentBps`);
    const fixed = number(inputs[kind].fixed, `${field}.${kind}.fixedCents`);
    // Both empty: the kind is not configured. One empty: that part is zero.
    if (percent === null && fixed === null) continue;
    out[kind] = { percentBps: percent ?? 0, fixedCents: fixed ?? 0 };
  }
  return out;
}

/**
 * The bands in ascending order of threshold, so the order an admin typed them in never matters
 * (core requires them strictly ascending). Rows with an empty or unreadable threshold keep their
 * relative place at the end; the save refuses them by field.
 */
export function sortLydiaBandRows(bands: LydiaContractForm['bands']): LydiaContractForm['bands'] {
  const key = (b: LydiaContractForm['bands'][number]): number => {
    const v = decimalToHundredths(b.from);
    return v === null || Number.isNaN(v) ? Number.POSITIVE_INFINITY : v;
  };
  return [...bands].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : ka < kb ? -1 : 1;
  });
}

/**
 * The settings the form says, for `PUT`, bands sent ascending whatever order they were typed in.
 * A field that is not a number, or two bands at one threshold, throws
 * {@link LydiaContractFormInvalid}; core refuses the rest (a bound) by field.
 */
export function fromLydiaContractForm(form: LydiaContractForm): LydiaContractSettings {
  return {
    anniversary: form.anniversary.trim() || null,
    fluxTargetCents: number(form.target, 'fluxTargetCents'),
    vatBps: number(form.vat, 'vatBps'),
    fees: feesOf(form.fees, 'fees'),
    bands: sortedBands(form.bands),
  };
}

function sortedBands(rows: LydiaContractForm['bands']): LydiaContractSettings['bands'] {
  const bands = sortLydiaBandRows(rows).map((b, i) => {
    const fromCents = number(b.from, `bands[${i}].fromCents`);
    if (fromCents === null) throw new LydiaContractFormInvalid(`bands[${i}].fromCents`);
    return { fromCents, fees: feesOf(b.fees, `bands[${i}].fees`) };
  });
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].fromCents === bands[i - 1].fromCents) {
      throw new LydiaContractFormInvalid(`bands[${i}].fromCents`, 'BAND_ORDER');
    }
  }
  return bands;
}

/**
 * The sentence an admin reads for a refused field. The field is core's typed path (`bands[1].fromCents`,
 * `fees.qr.percentBps`) or the form's own; `BAND_ORDER` is core's typed reason for two bands at one
 * threshold. A field this does not know is logged at ERROR (a fallback is a signal) and gets the
 * generic sentence, never the raw path.
 */
export function lydiaRefusalMessage(field: string | null, reason: string | null = null): string {
  const band = field?.match(/^bands\[(\d+)\]/);
  const n = band ? Number(band[1]) + 1 : 0;
  if (reason === 'BAND_ORDER') return m.admin_lydia_err_band_duplicate();
  if (field === 'fluxTargetCents') return m.admin_lydia_err_target();
  if (field === 'vatBps') return m.admin_lydia_err_vat();
  if (field === 'anniversary') return m.admin_lydia_err_anniversary();
  if (field === 'bands') return m.admin_lydia_err_bands_count();
  if (band && /^bands\[\d+\]\.fromCents$/.test(field!)) {
    return m.admin_lydia_err_band_from({ n });
  }
  const fee = field?.match(
    /^(?:bands\[\d+\]\.)?fees\.(remote|qr|tap_to_pay)\.(percentBps|fixedCents)$/
  );
  if (fee) {
    const where = band ? m.admin_lydia_where_band({ n }) : m.admin_lydia_where_base();
    const kind = {
      remote: m.admin_lydia_kind_remote,
      qr: m.admin_lydia_kind_qr,
      tap_to_pay: m.admin_lydia_kind_tap_to_pay,
    }[fee[1] as LydiaPaymentKind]();
    return fee[2] === 'percentBps'
      ? m.admin_lydia_err_fee_percent({ where, kind })
      : m.admin_lydia_err_fee_fixed({ where, kind });
  }
  console.error(`[admin.lydia] terms refused on a field with no sentence: ${field ?? 'none'}`);
  return m.admin_lydia_err_generic();
}
