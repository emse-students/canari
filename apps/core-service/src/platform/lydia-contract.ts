/**
 * THE PLATFORM'S LYDIA CONTRACT TERMS, AS DATA - entered by a global admin, never written in code
 * (docs/wiki/lydia-contract-flux.md). The repository is public and the contract is confidential, so
 * every value below arrives from `platform_config` (migration 024), and a value not entered is
 * "not configured", never a default.
 *
 * Pure functions only: the parse of what an admin sends, the contract year a date falls in, the
 * band a volume falls in. `LydiaContractService` does the reads and the logging.
 */

/**
 * The kinds of Lydia payment a fee is stated for. `remote`: a payment request Canari issues
 * (`request/do`: the boutique and paid forms). `qr` and `tap_to_pay`: payments a cashier collects
 * face to face in Lydia's own app, which Canari enables through its cashiers (the Vendeur role) but
 * never sees.
 */
export const LYDIA_PAYMENT_KINDS = ['remote', 'qr', 'tap_to_pay'] as const;

/** One of {@link LYDIA_PAYMENT_KINDS}. */
export type LydiaPaymentKind = (typeof LYDIA_PAYMENT_KINDS)[number];

/** A fee per payment, HT as the contract states it: a percentage of the amount plus a fixed part. */
export interface LydiaFee {
  /** The percentage, in basis points (1 % = 100). */
  percentBps: number;
  /** The fixed part, in cents. */
  fixedCents: number;
}

/** The fee of each kind the contract states; a kind left out is not configured. */
export type LydiaFeesByKind = Partial<Record<LydiaPaymentKind, LydiaFee>>;

/** A regularization band: from this yearly volume up, these fees apply. */
export interface LydiaBand {
  /** The lowest yearly volume (cents TTC) the band applies to. */
  fromCents: number;
  fees: LydiaFeesByKind;
}

/** Everything but the anniversary, as stored in `platform_config.lydia_contract`. */
export interface LydiaContractTerms {
  /** The yearly flux the platform commits to, cents TTC. */
  fluxTargetCents: number | null;
  /** The VAT rate turning an HT fee into what is really deducted, in basis points. */
  vatBps: number | null;
  /** The fees per payment kind, HT. */
  fees: LydiaFeesByKind;
  /** The regularization bands, ascending by `fromCents`. */
  bands: LydiaBand[];
}

/** The terms as an admin reads and writes them: the anniversary beside the rest. */
export interface LydiaContractSettings extends LydiaContractTerms {
  /** `YYYY-MM-DD`: the date every contract year starts on. */
  anniversary: string | null;
}

/** A parse refusal: the field it names and why, for the admin's 400. */
export class LydiaContractInvalid extends Error {
  constructor(
    readonly field: string,
    reason: string
  ) {
    super(`${field}: ${reason}`);
    this.name = 'LydiaContractInvalid';
  }
}

/** No terms entered: every value unset. */
export const EMPTY_LYDIA_CONTRACT_TERMS: LydiaContractTerms = {
  fluxTargetCents: null,
  vatBps: null,
  fees: {},
  bands: [],
};

/** The bound of any amount an admin may enter, cents: far above any real figure, below 2^53. */
const MAX_CENTS = 1_000_000_000_000;
/** The bound of a basis-point rate: 100 %. */
const MAX_BPS = 10_000;
/** The bound of the band list. */
const MAX_BANDS = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a real `YYYY-MM-DD` date (no 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function integerIn(value: unknown, field: string, max: number, nullable: true): number | null;
function integerIn(value: unknown, field: string, max: number, nullable: false): number;
function integerIn(value: unknown, field: string, max: number, nullable: boolean): number | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new LydiaContractInvalid(field, 'is required');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new LydiaContractInvalid(field, `must be an integer from 0 to ${max}`);
  }
  return value;
}

function parseFees(raw: unknown, field: string): LydiaFeesByKind {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LydiaContractInvalid(field, 'must be an object keyed by payment kind');
  }
  const out: LydiaFeesByKind = {};
  for (const [kind, fee] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LYDIA_PAYMENT_KINDS as readonly string[]).includes(kind)) {
      throw new LydiaContractInvalid(`${field}.${kind}`, 'is not a known payment kind');
    }
    if (fee === null || fee === undefined) continue;
    if (typeof fee !== 'object' || Array.isArray(fee)) {
      throw new LydiaContractInvalid(`${field}.${kind}`, 'must be { percentBps, fixedCents }');
    }
    const f = fee as Record<string, unknown>;
    out[kind as LydiaPaymentKind] = {
      percentBps: integerIn(f.percentBps, `${field}.${kind}.percentBps`, MAX_BPS, false),
      fixedCents: integerIn(f.fixedCents, `${field}.${kind}.fixedCents`, MAX_CENTS, false),
    };
  }
  return out;
}

/**
 * Parses the terms an admin sends (or the stored JSON), refusing - never correcting - anything that
 * is not exactly the shape: a typo in a confidential rate is caught here or nowhere. Bands must be
 * strictly ascending by `fromCents`.
 */
export function parseLydiaContractTerms(raw: unknown): LydiaContractTerms {
  if (raw === null || raw === undefined) return { ...EMPTY_LYDIA_CONTRACT_TERMS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LydiaContractInvalid('terms', 'must be an object');
  }
  const r = raw as Record<string, unknown>;
  const bandsRaw = r.bands ?? [];
  if (!Array.isArray(bandsRaw) || bandsRaw.length > MAX_BANDS) {
    throw new LydiaContractInvalid('bands', `must be a list of at most ${MAX_BANDS}`);
  }
  const bands: LydiaBand[] = bandsRaw.map((band, i) => {
    if (typeof band !== 'object' || band === null || Array.isArray(band)) {
      throw new LydiaContractInvalid(`bands[${i}]`, 'must be { fromCents, fees }');
    }
    const b = band as Record<string, unknown>;
    return {
      fromCents: integerIn(b.fromCents, `bands[${i}].fromCents`, MAX_CENTS, false),
      fees: parseFees(b.fees, `bands[${i}].fees`),
    };
  });
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].fromCents <= bands[i - 1].fromCents) {
      throw new LydiaContractInvalid(`bands[${i}].fromCents`, 'must be above the band before it');
    }
  }
  return {
    fluxTargetCents: integerIn(r.fluxTargetCents, 'fluxTargetCents', MAX_CENTS, true),
    vatBps: integerIn(r.vatBps, 'vatBps', MAX_BPS, true),
    fees: parseFees(r.fees, 'fees'),
    bands,
  };
}

/** Parses the anniversary an admin sends: a real date, or null to unset it. */
export function parseAnniversary(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isCalendarDate(raw)) throw new LydiaContractInvalid('anniversary', 'must be YYYY-MM-DD');
  return raw;
}

/** Today's date in Paris, `YYYY-MM-DD`: the contract's calendar. */
export function parisDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The anniversary's month and day in `year`; a 29 February falls on the 28th in a common year. */
function anniversaryIn(anniversary: string, year: number): string {
  const [, m, d] = anniversary.split('-').map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Whole days from `a` to `b`, two `YYYY-MM-DD` dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A contract year: `[start, end)`, and where `today` stands in it. */
export interface ContractYear {
  start: string;
  end: string;
  daysTotal: number;
  daysLeft: number;
}

/**
 * The contract year `today` falls in: from the last anniversary on or before it to the next one.
 * Null before the first anniversary (the contract has not started).
 */
export function contractYearOf(anniversary: string, today: string): ContractYear | null {
  if (today < anniversary) return null;
  const year = Number(today.slice(0, 4));
  let start = anniversaryIn(anniversary, year);
  if (start > today) start = anniversaryIn(anniversary, year - 1);
  const end = anniversaryIn(anniversary, Number(start.slice(0, 4)) + 1);
  return {
    start,
    end,
    daysTotal: daysBetween(start, end),
    daysLeft: daysBetween(today, end),
  };
}

/**
 * The band `volumeCents` falls in - the highest whose `fromCents` it reaches - and the next one up.
 * `index` is null when the volume is below every band.
 */
export function bandOf(
  bands: readonly LydiaBand[],
  volumeCents: number
): { index: number | null; next: number | null } {
  let index: number | null = null;
  for (let i = 0; i < bands.length; i++) {
    if (volumeCents >= bands[i].fromCents) index = i;
  }
  const next = index === null ? (bands.length > 0 ? 0 : null) : index + 1;
  return { index, next: next !== null && next < bands.length ? next : null };
}
