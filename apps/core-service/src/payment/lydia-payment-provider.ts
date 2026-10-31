import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { signLydiaRequest } from './lydia-signature';
import {
  isLydiaRefundConfirmed,
  LYDIA_REFUND_UNCONFIRMED,
  lydiaRefundRefusalCode,
  signLydiaRefund,
} from './lydia-refund';
import type { ConnectAccountStatusResponse } from './payment-provider.interface';
import type {
  CancelRequestOutcome,
  CheckoutRequestLookup,
  CheckoutRequestState,
  CheckoutRequestStateKind,
  CheckoutSessionResult,
  ConnectBalanceSummary,
  CreateCheckoutSessionParams,
  OnboardingParams,
  OnboardingResult,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * The `code` a provider refusal carries in its response body. A refusal (a blocked venue, a bad
 * phone number) is an ANSWER about the request, not a server fault: social-service reads this code
 * to answer the SAME 400 with the provider's readable message on every checkout route.
 */
export const PAYMENT_PROVIDER_REFUSED = 'PAYMENT_PROVIDER_REFUSED';

/**
 * The `code` of a refusal because the amount is outside the payable range. Mirrored in
 * social-service's `core-payment-error.ts` and the frontend's `paymentRefusal.ts`.
 */
export const AMOUNT_OUT_OF_RANGE = 'AMOUNT_OUT_OF_RANGE';

const HOMOLOGATION_BASE_URL = 'https://homologation.lydia-app.com';
const PRODUCTION_BASE_URL = 'https://lydia-app.com';

/**
 * How long one call to Lydia may take. Below the 120 s social-service waits on core
 * (`associations.module.ts`), so core always ANSWERS - a 5xx, which social reads as a lost call and
 * leaves the attempt open - rather than social timing out while core still waits on Lydia.
 */
export const LYDIA_CALL_TIMEOUT_MS = 60_000;

/**
 * THE ONBOARDING ANSWERS BEFORE ANYTHING IN FRONT OF IT GIVES UP. `POST /api/payments/onboarding`
 * runs five calls in a row behind nginx's `/api/payments` location, whose `proxy_read_timeout` is
 * nginx's 60 s default. With the 60 s `LYDIA_CALL_TIMEOUT_MS` on each Lydia call the chain could
 * take minutes, nginx answered a bare 504 at 60 s, and the screen read it as "save error" - the
 * line that invites the retry creating a second Business. Each step therefore has its own bound,
 * and their SUM (55 s, asserted by a spec) stays under 60 s, so core always answers - typed - first.
 * The client waits `LYDIA_ONBOARDING_DEADLINE_MS` (75 s, frontend `associations/api.ts`), above both.
 */
export const LYDIA_ONBOARDING_STEP_TIMEOUT_MS = {
  /** social-service: may this user manage the association's payments. */
  permission: 5_000,
  /** social-service: is a Business already linked. */
  payoutRead: 5_000,
  /** Lydia `business/create`: the only slow call measured. */
  create: 25_000,
  /** Lydia `auth/vendortoken`. */
  verify: 10_000,
  /** social-service: link the Business with its key. */
  link: 10_000,
} as const;

/** nginx's `proxy_read_timeout` on `/api/payments` (its 60 s default; Dockerfile.frontend sets none). */
export const PAYMENTS_PROXY_READ_TIMEOUT_MS = 60_000;

/**
 * The HTTP 4xx a call to Lydia may answer WITHOUT having refused it: 408 (request timeout), 409
 * (conflict), 425 (too early), 429 (too many requests). After any of them a request/do may still
 * have created a request, so they are a LOST call (the attempt stays open and is read by its
 * order_ref), never the refusal that releases it - releasing one that was then paid would be a
 * second charge refunded by hand.
 */
export const LYDIA_HTTP_NOT_A_REFUSAL: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/**
 * Lydia's payable range per request, confirmed by Lydia 2026-10-04: 0,50 EUR to 1000 EUR. Shared
 * with social-service's mirror through `libs/contracts/payment-amount-range.json`, whose specs on
 * both sides fail the day the two disagree.
 */
export const LYDIA_MIN_AMOUNT_CENTS = 50;
export const LYDIA_MAX_AMOUNT_CENTS = 100_000;

/**
 * An amount in cents as Canari writes it to Lydia: euros with two decimals, `1250` -> `"12.50"`.
 * The ONE formatting, shared by `request/do` (the `amount` field) and the verification of a
 * `request/state` signature (`lydia-state-verification.ts`), which covers the amount the request
 * was issued for - so the string the signature is recomputed over is the string that was sent.
 */
export function lydiaAmountString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * The ONE `code` (502) of an onboarding that failed AFTER `business/create` succeeded: the Business
 * exists at Lydia and is linked to nothing. Whatever came next - no `api_token_id`, `auth/vendortoken`
 * answering 103, another code, a 5xx or nothing at all, or the link to social-service failing - the
 * outcome for the association is the same, and so is what a human does about it (payments.md, "An
 * orphan Business"). A retry WOULD create a second Business (nothing is linked), so the client says
 * not to retry and to contact an admin.
 */
export const LYDIA_BUSINESS_CREATED_UNLINKED = 'LYDIA_BUSINESS_CREATED_UNLINKED';

/**
 * The tag of the ERROR line that is the durable record of an orphan Business: it names the
 * association and the Business's `vendor_token`, which is what Lydia's support needs to delete it.
 */
export const LYDIA_ORPHAN_LOG_TAG = '[LYDIA-ORPHAN]';

/**
 * The `code` (504) of a `business/create` whose fate is UNKNOWN: no answer in time, a 5xx, a 4xx
 * that does not say refused, or a 200 with no `api_token`. Lydia may have created the Business, so
 * the client re-reads the payout account and says to check before retrying - never "save error".
 */
export const LYDIA_BUSINESS_CREATE_UNCONFIRMED = 'LYDIA_BUSINESS_CREATE_UNCONFIRMED';

/**
 * The tag of the ERROR line of an UNCONFIRMED `business/create`: there is no `vendor_token` to name,
 * so an admin asks Lydia's support which Businesses the Provider created for that association.
 */
export const LYDIA_ORPHAN_SUSPECT_LOG_TAG = '[LYDIA-ORPHAN-SUSPECT]';

/** Logs an unconfirmed `business/create` at ERROR and returns the typed 504 to throw. */
export function businessCreateUnconfirmed(
  logger: Logger,
  associationId: string,
  why: string
): GatewayTimeoutException {
  logger.error(
    `${LYDIA_ORPHAN_SUSPECT_LOG_TAG} association ${associationId}: business/create gave no usable ` +
      `answer (${why}) - a Business MAY exist at Lydia, unlinked`
  );
  return new GatewayTimeoutException({
    code: LYDIA_BUSINESS_CREATE_UNCONFIRMED,
    message: 'Lydia did not confirm whether the Business was created; check before retrying',
  });
}

/**
 * Logs an orphan Business at ERROR - association, `vendor_token` and why - and returns the typed `LYDIA_BUSINESS_CREATED_UNLINKED` 502 to throw. The private token
 * never reaches this line.
 */
export function businessCreatedUnlinked(
  logger: Logger,
  associationId: string,
  vendorToken: string,
  why: string
): BadGatewayException {
  logger.error(
    `${LYDIA_ORPHAN_LOG_TAG} association ${associationId}: Business vendor_token=${vendorToken} ` +
      `was created at Lydia and is NOT linked (${why}) - Lydia's support deletes it, then the ` +
      `association re-enrols`
  );
  return new BadGatewayException({
    code: LYDIA_BUSINESS_CREATED_UNLINKED,
    message: 'The Lydia Business was created but could not be linked; do not retry',
  });
}

/**
 * The `code` (400) of a `request/do` Lydia answered with error 5: the Business is not validated (yet,
 * or any more). Measured: error 5 answers BEFORE any request exists (sandbox 2026-10-27, lydia-api.md
 * section 2), so there is no `mobile_url` and nothing a payer could pay. social-service reads this
 * code to revert the holder's readiness (`setLydiaReadiness`). Mirrored in
 * `libs/contracts/lydia-refusal-codes.json`.
 */
export const LYDIA_BUSINESS_NOT_VALIDATED = 'LYDIA_BUSINESS_NOT_VALIDATED';

/** The `code` (400) of a `request/do` Lydia answered with error 2701, a blocked Business. */
export const LYDIA_BUSINESS_BLOCKED = 'LYDIA_BUSINESS_BLOCKED';

/** Lydia's `request/do` error codes that name the BUSINESS, not the request, and their typed code. */
const LYDIA_BUSINESS_STATE_ERRORS: Readonly<Record<string, string>> = {
  '5': LYDIA_BUSINESS_NOT_VALIDATED,
  '2701': LYDIA_BUSINESS_BLOCKED,
};

/** The `code` (502) of a cashier call whose signature Lydia refused (error 444). */
export const LYDIA_SIGNATURE_REFUSED = 'LYDIA_SIGNATURE_REFUSED';
/** The `code` (502) of a cashier call whose permission list Lydia refused (error 3). */
export const LYDIA_CASHIER_PERMISSIONS_INVALID = 'LYDIA_CASHIER_PERMISSIONS_INVALID';
/** The `code` (502) of a cashier call Lydia refused on the Business's vendor token (102, 103). */
export const LYDIA_BUSINESS_TOKEN_REJECTED = 'LYDIA_BUSINESS_TOKEN_REJECTED';
/** The `code` (503) when no Provider private token is configured: nothing is sent to Lydia. */
export const LYDIA_CASHIER_NOT_CONFIGURED = 'LYDIA_CASHIER_NOT_CONFIGURED';
/** The `code` (503) of no usable answer from Lydia (a transport failure, an HTML 500): a retry is safe. */
export const LYDIA_UNREACHABLE = 'LYDIA_UNREACHABLE';
/** The `code` (502) of an add Lydia accepted but whose read-back does not show every right. */
export const LYDIA_CASHIER_RIGHTS_INCOMPLETE = 'LYDIA_CASHIER_RIGHTS_INCOMPLETE';

/**
 * Thrown by `addBusinessHolder` when `business/addcashier` ANSWERED (Lydia now holds the cashier)
 * and what followed - the rights read-back, or rights short of the full set - did not confirm it.
 * Carries the original status and body (`LYDIA_CASHIER_RIGHTS_INCOMPLETE`, a typed 502, or 503
 * `LYDIA_UNREACHABLE` for an error that was not one), so the answer to the browser is unchanged;
 * the TYPE is what tells the caller to record the person as unconfirmed.
 */
export class LydiaCashierAddedUnconfirmedException extends HttpException {
  constructor(cause: unknown) {
    super(
      cause instanceof HttpException
        ? cause.getResponse()
        : { code: LYDIA_UNREACHABLE, message: 'Lydia did not answer the rights read-back' },
      cause instanceof HttpException ? cause.getStatus() : 503,
      { cause }
    );
  }
}

/** The `code` (400) of a cashier phone that is not E.164: refused before any call. */
export const LYDIA_CASHIER_PHONE_INVALID = 'LYDIA_CASHIER_PHONE_INVALID';

/**
 * Every right a Lydia cashier can hold (lydia-api.md section 5b, homologation 2026-10-30): the
 * Responsable is added with ALL of them, and the add counts only when `business/getpermission`
 * reads every one back as 1.
 */
export const LYDIA_CASHIER_PERMISSIONS = [
  'access_collect',
  'access_allreceipt',
  'access_checkout',
  'access_statement',
  'access_feedback',
  'access_cashier',
  'access_voucher',
  'access_marketing',
  'access_fee',
  'access_cancelrequest',
  'access_canceltransaction',
  'access_manage_collects',
  'access_easeofpayment',
] as const;

/** A cashier phone as Lydia takes it: E.164, `+` and 8 to 15 digits (`+33...`, accepted 2026-10-30). */
export const LYDIA_CASHIER_PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** What `business/getpermission` read for one cashier: every right, true when it reads 1. */
export type LydiaCashierRights = Readonly<
  Record<(typeof LYDIA_CASHIER_PERMISSIONS)[number], boolean>
>;

// ── Lydia enrolment lot 3: cashier roles and removal ─────────────────────────

/** The three cashier roles Canari manages (`lydia_cashiers.role`, migration 118). */
export type LydiaCashierRole = 'responsable' | 'tresorier' | 'vendeur';

/**
 * THE ONE MAPPING FROM A CASHIER ROLE TO ITS LYDIA RIGHTS (lot 3, the owner's three roles of
 * 2026-10-30), documented in docs/wiki/frontend/modules/payments.md. Lydia's documentation lists the
 * names and describes none of them, so each set is read from the names and kept NARROW:
 * - `responsable`: all 13 - the person who runs the Business.
 * - `tresorier` ("statements, refunds and cancels"): `access_statement`, `access_canceltransaction`
 *   (the right Lydia's refund call names) and `access_cancelrequest`. NOT `access_allreceipt` nor
 *   `access_fee`, whose meaning the documentation does not give.
 * - `vendeur` ("collect"): `access_collect` alone. NOT `access_checkout`, whose meaning is not given.
 * A repeat `business/addcashier` replaces the rights, so changing a role is a re-add with the new set.
 */
export const LYDIA_CASHIER_ROLE_PERMISSIONS: Readonly<
  Record<LydiaCashierRole, readonly (typeof LYDIA_CASHIER_PERMISSIONS)[number][]>
> = {
  responsable: LYDIA_CASHIER_PERMISSIONS,
  tresorier: ['access_statement', 'access_canceltransaction', 'access_cancelrequest'],
  vendeur: ['access_collect'],
};

/**
 * What `business/getpermission` read for one cashier, PARSED FAIL-CLOSED (`parseCashierReading`):
 * `rights` holds the 13 documented names (each present, `true` when it reads `"1"`), and `held`
 * EVERY `access_*` name that reads `"1"` - the documented ones and any Lydia lists beyond them
 * (five undocumented names were read on homologation 2026-10-31).
 */
export interface LydiaCashierReading {
  rights: LydiaCashierRights;
  held: readonly string[];
}

/**
 * The `code` (502) of a `business/getpermission` answer that cannot be trusted: an `error` other
 * than `"0"` or none, no `data` object, a documented right missing, or a right reading anything but
 * `"0"` / `"1"`. Never read as "no rights".
 */
export const LYDIA_CASHIER_READBACK_INVALID = 'LYDIA_CASHIER_READBACK_INVALID';

/**
 * The `code` (409) of a removal refused BEFORE any change at Lydia because the association's
 * Responsable does not read all 13 documented rights: nothing is removed while the Responsable is not
 * intact.
 */
export const LYDIA_CASHIER_HOLDER_RIGHTS_MISSING = 'LYDIA_CASHIER_HOLDER_RIGHTS_MISSING';

/**
 * Parses a `business/getpermission` answer FAIL-CLOSED into a {@link LydiaCashierReading}, or throws
 * the typed 502 `LYDIA_CASHIER_READBACK_INVALID` (the reason in its message, for the log). Accepted
 * only when: `error` is `"0"`; `data` is a non-null, non-array object; every documented right is
 * present; and every `access_*` value present is exactly `"0"` or `"1"`.
 */
export function parseCashierReading(answer: Record<string, unknown>): LydiaCashierReading {
  const refuse = (why: string): never => {
    throw new BadGatewayException({
      code: LYDIA_CASHIER_READBACK_INVALID,
      message: `Lydia's rights read cannot be trusted: ${why}`,
    });
  };
  if (answer.error === undefined || String(answer.error) !== '0') {
    refuse(`error is ${answer.error === undefined ? 'absent' : 'not 0'}`);
  }
  const data = answer.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) refuse('no data object');
  const source = data as Record<string, unknown>;
  const held: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('access_')) continue;
    if (value !== '0' && value !== '1') refuse(`${name} reads neither "0" nor "1"`);
    if (value === '1') held.push(name);
  }
  const missing = LYDIA_CASHIER_PERMISSIONS.filter((name) => !Object.hasOwn(source, name));
  if (missing.length > 0) refuse(`missing ${missing.join(',')}`);
  const rights = Object.fromEntries(
    LYDIA_CASHIER_PERMISSIONS.map((name) => [name, source[name] === '1'])
  ) as LydiaCashierRights;
  return { rights, held: held.sort() };
}

/**
 * The rights on which a reading differs from `role`'s set; empty means it matches. A Responsable
 * must read EVERY documented right at 1 (the undocumented names Lydia may list are neither required
 * nor refused: the owner keeps the documented 13). A Tresorier or a Vendeur must read every right
 * of its set at 1 and NO OTHER `access_*` at 1 - documented or not.
 */
export function cashierRightsDifference(
  reading: LydiaCashierReading,
  role: LydiaCashierRole
): string[] {
  const wanted = new Set<string>(LYDIA_CASHIER_ROLE_PERMISSIONS[role]);
  const lacking = [...wanted].filter((name) => !reading.held.includes(name));
  if (role === 'responsable') return lacking;
  return [...lacking, ...reading.held.filter((name) => !wanted.has(name))];
}

/** What a removal's re-read showed: `verified` only at 0 rights; `held` null when unread. */
export interface LydiaCashierRemoval {
  verified: boolean;
  held: number | null;
}

/** The typed `code` of an HttpException, or its class name - for a log line, never a branch. */
function typedCode(err: unknown): string {
  if (err instanceof HttpException) {
    const answer = err.getResponse();
    const code = answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : null;
    return typeof code === 'string' ? code : `HTTP ${err.getStatus()}`;
  }
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * The `code` (409) of adding a cashier or changing their role while {@link LYDIA_CASHIER_ADD_ENABLED}
 * is off: nothing is sent to Lydia.
 */
export const LYDIA_CASHIER_ADD_DISABLED = 'LYDIA_CASHIER_ADD_DISABLED';

/**
 * The `code` (502) of a removal Lydia did not confirm: the re-read of the number still showed a
 * right, or could not be read. The cashier row stays live and flagged.
 */
export const LYDIA_CASHIER_REVOKE_UNCONFIRMED = 'LYDIA_CASHIER_REVOKE_UNCONFIRMED';

/**
 * THE OWNER'S GATE (2026-10-30): adding a Tresorier or a Vendeur, and changing a cashier's role,
 * ship OFF. It flips to `true` ONLY AFTER ONE REMOVAL (`removeCashier`, verified at 0 rights) HAS
 * BEEN OBSERVED IN PRODUCTION - nobody is added who Canari has not proven it can take away. The
 * flip is ONE pull request changing this constant, the frontend's constant of the same name
 * (`frontend/src/lib/associations/lydiaCashiers.ts`) and `switches.cashierAddEnabled` in
 * `libs/contracts/lydia-refusal-codes.json` together; each side's contract spec asserts them equal.
 * The removal path is live meanwhile: it only takes rights away.
 */
export const LYDIA_CASHIER_ADD_ENABLED = false;

/** `auth/vendortoken`'s answer when the private token does not match the vendor token (homologation, 2026-10-30). */
const LYDIA_VENDOR_TOKEN_MISMATCH = '103';

/** `request/cancel`'s answer for a request already cancelled or expired (sandbox, 2026-10-15). */
const LYDIA_CANCEL_ALREADY_SETTLED = '2';

/** `request/state`'s answer for an order_ref no request carries, "Requete introuvable" (sandbox, 2026-10-15). */
const LYDIA_STATE_NOT_FOUND = '2';

/**
 * Every `request/state` code Lydia answers that has been MEASURED on the sandbox (2026-10-15 and
 * 2026-10-21, payments.md), and what it means. A code missing here is `unknown`, never guessed.
 */
const LYDIA_REQUEST_STATES: Readonly<Record<string, CheckoutRequestStateKind>> = {
  '0': 'open',
  '1': 'paid',
  '5': 'declined',
  '6': 'cancelled-or-expired',
};

/**
 * Fields no log line may ever carry in the clear - `api_token_id` IS the Business's own private
 * token (`auth/vendortoken`, homologation 2026-10-30; `createOnboarding` stores it encrypted) and
 * `vendor_id` is the name `auth/vendortoken` gives the same value, and
 * `signature` is the value Lydia's `request/state` answers with (and the callbacks carry): the proof
 * the whole confirmation rests on. `api_token`, the Business's `vendor_token`, is not in this set:
 * it is what identifies an orphan Business to Lydia's support.
 */
const LYDIA_LOG_REDACT_KEYS = new Set([
  'api_token_id',
  'vendor_id',
  'signature',
  // Personal data an answer may echo (a cashier call's, a payer's): never in a log line.
  'cashier_phone',
  'phone',
  'firstname',
  'lastname',
  'name',
]);

/** The public origin Lydia calls back on: nginx, the single entry point, from `FRONTEND_URL`. */
function publicApiBase(): string {
  return (process.env.FRONTEND_URL || 'http://localhost').replace(/\/$/, '');
}

/**
 * A copy of a Lydia answer fit for a log line: every `LYDIA_LOG_REDACT_KEYS` field replaced, at ANY
 * depth (an answer nests `data`, `permissions` or a list of cashiers), the rest kept as is.
 */
export function redactForLog(data: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) =>
          LYDIA_LOG_REDACT_KEYS.has(key) ? [key, '[redacted]'] : [key, walk(inner)]
        )
      );
    }
    return value;
  };
  return walk(data) as Record<string, unknown>;
}

/**
 * Lydia API implementation of PaymentProvider (WP-LYDIA-1). Stripe left the product
 * (docs/wiki/stripe-archive.md); this is the only live provider.
 * Covers checkout (`request/do`, confirmed server-side via its signed per-request callback - see
 * `webhook.controller.ts`'s `lydia-request-callback` route) and session lookup (`request/state`).
 *
 * Everything else throws deliberately instead of faking a result - each throw below documents a
 * real gap found while implementing this, not a missing feature to silently stub:
 * - Account/balance status (`getAccountStatus`, `getConnectAccountStatus`, `getConnectBalance`,
 *   `createConnectDashboardLink`) has no live-poll equivalent: Lydia pushes a `BUSINESS_VALIDATED`
 *   webhook event once, it does not expose a "retrieve current status" call. The webhook is
 *   received (`lydia-business-webhook`): an UNSIGNED `BUSINESS_VALIDATED` marks the holder ready
 *   (risk accepted by the owner, 2026-10-30), `BUSINESS_UNVALIDATED` changes nothing; Lydia's
 *   error 5 / 2701 on a real `request/do` reverts it (`typedBusinessStateRefusal`).
 * - There are no saved payment methods: every purchase is its own `request/do` with payer
 *   interaction, there is no server-side vaulted instrument.
 * - `createCheckoutSession` requires `payerRecipient`: the payment controller builds it from the
 *   `payerEmail` its caller sends, and a request without one is refused rather than sent.
 */
export class LydiaPaymentProvider implements PaymentProvider {
  readonly id = 'lydia' as const;
  private readonly logger = new Logger(LydiaPaymentProvider.name);
  private readonly baseUrl: string;
  private readonly providerToken: string | undefined;

  /** The Provider PRIVATE token: it signs the cashier calls (`signLydiaRequest`). Never logged. */
  private readonly providerPrivateToken: string | undefined;

  constructor(env: {
    LYDIA_ENV?: string;
    LYDIA_PROVIDER_TOKEN?: string;
    LYDIA_PROVIDER_PRIVATE_TOKEN?: string;
  }) {
    this.baseUrl =
      (env.LYDIA_ENV || '').trim().toLowerCase() === 'production'
        ? PRODUCTION_BASE_URL
        : HOMOLOGATION_BASE_URL;
    this.providerToken = env.LYDIA_PROVIDER_TOKEN;
    this.providerPrivateToken = env.LYDIA_PROVIDER_PRIVATE_TOKEN?.trim() || undefined;
    this.logger.log(`Lydia configured: ${this.isConfigured() ? 'yes' : 'no'} (${this.baseUrl})`);
  }

  /**
   * URL Lydia calls back on a `request/do` outcome (`webhook.controller.ts`'s
   * `lydia-request-callback` route). Built from `FRONTEND_URL` because nginx is the single public
   * entry point - `/api/...` under it already reaches core-service, exactly like every
   * success/cancel URL this controller already hands to Stripe and Lydia.
   */
  private callbackUrl(outcome: 'confirm' | 'cancel' | 'expire'): string {
    return `${publicApiBase()}/api/payments/lydia-request-callback?outcome=${outcome}`;
  }

  /**
   * URL Lydia POSTs a Business's `BUSINESS_VALIDATED` / `BUSINESS_UNVALIDATED` event to, given to
   * `business/create` as `webhook` (`webhook.controller.ts`'s `lydia-business-webhook` route). The
   * same public origin as the request callbacks.
   */
  private businessWebhookUrl(): string {
    return `${publicApiBase()}/api/payments/lydia-business-webhook`;
  }

  isConfigured(): boolean {
    return !!this.providerToken;
  }

  /**
   * POSTs a form to Lydia and throws a `PAYMENT_PROVIDER_REFUSED` 400 on any error code - except the
   * codes listed in `answers`, which the CALLER knows to be an answer rather than a refusal (the
   * cancel call's "already cancelled or expired", error 2). Those come back as the raw body, so the
   * caller reads `error` itself and no refusal is logged for an outcome that is not one.
   */
  private async postForm<T>(
    path: string,
    fields: Record<string, string>,
    answers: readonly string[] = [],
    timeoutMs: number = LYDIA_CALL_TIMEOUT_MS
  ): Promise<T & { error?: string }> {
    const body = new URLSearchParams(fields);
    let res;
    try {
      res = await axios.post<
        T & { error?: string; status?: string; code?: string; message?: string }
      >(`${this.baseUrl}${path}.json`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: timeoutMs,
      });
    } catch (err: unknown) {
      // An HTTP 4xx IS an answer: Lydia read the call and refused it, so nothing was created and
      // the caller may release what it holds - the same typed refusal as an `error` code. Except
      // the 4xx that do NOT say "refused" (`LYDIA_HTTP_NOT_A_REFUSAL`): a timeout, a rate limit, a
      // conflict or "too early" may come back after the request was created, so they stay LOST.
      const httpStatus = (err as { response?: { status?: unknown } } | null)?.response?.status;
      if (
        typeof httpStatus === 'number' &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        !LYDIA_HTTP_NOT_A_REFUSAL.has(httpStatus)
      ) {
        this.logger.warn(`${path} refused by Lydia: HTTP ${httpStatus}`);
        throw new BadRequestException({
          code: PAYMENT_PROVIDER_REFUSED,
          provider: 'lydia',
          providerCode: `http-${httpStatus}`,
          message: `Lydia refused the call (HTTP ${httpStatus})`,
        });
      }
      // Not an answer (a timeout, a reset, a 5xx, a 4xx that does not say refused): rethrown, so
      // the caller sees a 5xx and treats the call as LOST (a request/do may still have created a
      // request at Lydia), never as a refusal.
      const timedOut = (err as { code?: unknown } | null)?.code === 'ECONNABORTED';
      this.logger.error(
        `${path} got no usable answer from Lydia: ${
          timedOut
            ? `no response within ${timeoutMs / 1000} s`
            : typeof httpStatus === 'number'
              ? `HTTP ${httpStatus}, which does not say the call was refused - treated as lost`
              : String(err)
        }`
      );
      throw err;
    }
    // Every call through here was previously unlogged, so a response that was neither the
    // expected shape NOR a recognized error left no trace anywhere - the caller silently got back
    // whatever fields WERE there and nothing else. Logging the body (redacted) is what makes that
    // case diagnosable instead of just absent.
    const loggable = res.data && typeof res.data === 'object' ? redactForLog(res.data) : res.data;
    this.logger.log(`${path} -> ${JSON.stringify(loggable)}`);
    // TWO error shapes, confirmed in homologation, and a single check missed the second one
    // entirely: `request/do`/`request/state`/a successful `business/create` all use
    // `{error: "0" | "<code>", message}`, but a REJECTED `business/create` (observed: an unknown
    // `provider_token`, code 104, "Provider inconnu") instead answers `{status: "error", code,
    // message}` - no `error` key at all. The first shape used to be the only one recognized, so
    // this fell through as neither a caught error NOR the expected fields, and the caller below
    // (`createOnboarding`) had nothing but a generic "unexpected shape" to show for a message
    // Lydia had already spelled out.
    const numericError =
      res.data && 'error' in res.data && res.data.error && res.data.error !== '0'
        ? res.data.error
        : null;
    const statusError = res.data?.status === 'error' ? (res.data.code ?? 'unknown') : null;
    const errorCode = numericError ?? statusError;
    if (errorCode && answers.includes(String(errorCode))) {
      this.logger.debug(`${path} answered error ${errorCode}, which the caller reads as an answer`);
      return res.data;
    }
    if (errorCode) {
      this.logger.warn(`${path} refused by Lydia: error ${errorCode}: ${res.data.message ?? ''}`);
      throw new BadRequestException({
        code: PAYMENT_PROVIDER_REFUSED,
        provider: 'lydia',
        providerCode: String(errorCode),
        message: res.data.message || `Lydia error ${errorCode}`,
      });
    }
    return res.data;
  }

  /**
   * Creates a payment request via `POST /api/request/do`. `connectAccountId` is the target
   * Business's `vendor_token` (unchanged storage shape from Stripe's `stripeAccountId` - confirmed
   * by the doc that `vendor_token` is a per-request field, so Canari's existing payment-delegation
   * logic keeps choosing the destination exactly as it does today).
   *
   * `request/do` needs no signature (confirmed by the doc: "you can't sign a call to
   * api/request/do.json, it's reserved to another Lydia product"), so no private_token is needed
   * here - only the provider_token and the target vendor_token, both already available.
   */
  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    if (!params.connectAccountId) {
      throw new BadRequestException('Lydia checkout requires a target vendor_token');
    }
    if (!params.payerRecipient) {
      throw new BadRequestException('Lydia request/do requires payerRecipient (email or phone)');
    }
    const { value: recipient, type: recipientType } = params.payerRecipient;

    const totalCents = params.lineItems.reduce(
      (sum, item) => sum + item.unitAmountCents * item.quantity,
      0
    );
    if (totalCents < LYDIA_MIN_AMOUNT_CENTS || totalCents > LYDIA_MAX_AMOUNT_CENTS) {
      this.logger.warn(`Lydia checkout refused: ${totalCents} cents is outside the payable range`);
      // TYPED, with the bounds: social-service and the UI read `code` and the two numbers, never the
      // sentence, to show the payer the allowed range in their own language.
      throw new BadRequestException({
        code: AMOUNT_OUT_OF_RANGE,
        message:
          `Lydia accepts payments from ${(LYDIA_MIN_AMOUNT_CENTS / 100).toFixed(2)} to ` +
          `${(LYDIA_MAX_AMOUNT_CENTS / 100).toFixed(2)} EUR (got ${(totalCents / 100).toFixed(2)})`,
        minCents: LYDIA_MIN_AMOUNT_CENTS,
        maxCents: LYDIA_MAX_AMOUNT_CENTS,
      });
    }
    const currency = params.lineItems[0]?.currency?.toUpperCase() ?? 'EUR';
    const description = params.lineItems.map((i) => i.productName).join(', ');

    const fields: Record<string, string> = {
      amount: lydiaAmountString(totalCents),
      currency,
      type: recipientType,
      recipient,
      message: description,
      vendor_token: params.connectAccountId,
      provider_token: this.providerToken,
      payment_method: 'auto',
      browser_success_url: params.successUrl,
      browser_fail_url: params.cancelUrl,
      confirm_url: this.callbackUrl('confirm'),
      cancel_url: this.callbackUrl('cancel'),
      expire_url: this.callbackUrl('expire'),
    };
    if (params.idempotencyKey) fields.order_ref = params.idempotencyKey;
    if (params.expireAfterSeconds !== undefined) {
      // Lydia reads 0 as "never expires" and refuses anything but an integer (measured on the
      // sandbox 2026-10-15): a value that would silently drop the expiry is refused HERE instead.
      if (!Number.isInteger(params.expireAfterSeconds) || params.expireAfterSeconds <= 0) {
        this.logger.warn(`Lydia checkout refused: expire_time ${params.expireAfterSeconds}`);
        throw new BadRequestException('expireAfterSeconds must be a positive whole number');
      }
      fields.expire_time = String(params.expireAfterSeconds);
    }

    let data: { request_id?: string | number; request_uuid: string; mobile_url: string };
    try {
      data = await this.postForm<{
        request_id?: string | number;
        request_uuid: string;
        mobile_url: string;
      }>('/api/request/do', fields);
    } catch (err: unknown) {
      throw this.typedBusinessStateRefusal(err);
    }
    // `request_id` (numeric) is the id Lydia's callbacks and its cancel call carry; `request_uuid`
    // is the one `request/state` reads. Both are kept, because neither replaces the other.
    const requestId =
      data.request_id === undefined || data.request_id === null ? null : String(data.request_id);
    if (!requestId) {
      this.logger.warn(`request/do answered without a request_id for ${data.request_uuid}`);
    }
    return { id: data.request_uuid, url: data.mobile_url, requestId };
  }

  /**
   * A `request/do` refusal that names the BUSINESS (error 5, not validated; 2701, blocked) becomes
   * its own typed 400 - `LYDIA_BUSINESS_NOT_VALIDATED` / `LYDIA_BUSINESS_BLOCKED`, `providerCode`
   * kept - so social-service reverts the holder's readiness on a CODE, never Lydia's sentence. Every
   * other failure is returned unchanged.
   */
  private typedBusinessStateRefusal(err: unknown): unknown {
    if (!(err instanceof BadRequestException)) return err;
    const body = err.getResponse() as { code?: unknown; providerCode?: unknown; message?: unknown };
    const providerCode = typeof body?.providerCode === 'string' ? body.providerCode : '';
    if (
      body?.code !== PAYMENT_PROVIDER_REFUSED ||
      !Object.hasOwn(LYDIA_BUSINESS_STATE_ERRORS, providerCode)
    ) {
      return err;
    }
    const code = LYDIA_BUSINESS_STATE_ERRORS[providerCode];
    this.logger.warn(
      `request/do refused by Lydia on the Business itself: error ${providerCode} -> ${code}`
    );
    return new BadRequestException({
      code,
      provider: 'lydia',
      providerCode,
      message: typeof body.message === 'string' ? body.message : `Lydia error ${providerCode}`,
    });
  }

  /**
   * Adds `phone` as the Responsable of the Business `vendorToken`: {@link addCashier} with the
   * `responsable` role, every right (`LYDIA_CASHIER_PERMISSIONS`).
   */
  async addBusinessHolder(
    associationId: string,
    vendorToken: string,
    phone: string
  ): Promise<void> {
    await this.addCashier(associationId, vendorToken, phone, 'responsable');
  }

  /**
   * Adds `phone` as a cashier of the Business `vendorToken` with EXACTLY the rights of `role`
   * (`LYDIA_CASHIER_ROLE_PERMISSIONS`), Lydia's SMS on (`notify=yes`), through
   * `business/addcashier` signed over the URL-encoded `cashier_phone` and `permissions` with the
   * Provider private token (`signLydiaRequest`, homologation 2026-10-30). `permissions` is a JSON
   * ARRAY of names. A repeat add REPLACES the rights, so a retry is safe and a role change is a
   * re-add. Then reads the rights back (`readCashierRights`) and counts success ONLY when the set
   * read is exactly the role's: every right of the role reads 1 and every other reads 0.
   *
   * Typed, before anything is sent: no Provider key -> 503 `LYDIA_CASHIER_NOT_CONFIGURED`; a phone
   * that is not E.164 -> 400 `LYDIA_CASHIER_PHONE_INVALID`. After: 444 -> 502
   * `LYDIA_SIGNATURE_REFUSED`, 3 -> 502 `LYDIA_CASHIER_PERMISSIONS_INVALID`, 102/103 -> 502
   * `LYDIA_BUSINESS_TOKEN_REJECTED` (ERROR, naming the association), no usable answer -> 503
   * `LYDIA_UNREACHABLE`. Once the add has answered, any failure - a read-back that differs from
   * the role's set (502 `LYDIA_CASHIER_RIGHTS_INCOMPLETE`) or none - is
   * `LydiaCashierAddedUnconfirmedException`. The phone is never logged, only its last two digits.
   */
  async addCashier(
    associationId: string,
    vendorToken: string,
    phone: string,
    role: LydiaCashierRole
  ): Promise<void> {
    const key = this.cashierKeyOrThrow(associationId, phone);
    const wanted = LYDIA_CASHIER_ROLE_PERMISSIONS[role];
    const signed: Record<string, string> = {
      cashier_phone: phone,
      permissions: JSON.stringify(wanted),
    };
    const signature = signLydiaRequest(signed, key);
    this.logger.log(
      `[LYDIA-CASHIER] association ${associationId}: adding a ${role} (phone ending ` +
        `${phone.slice(-2)}, ${wanted.length} right(s))`
    );
    await this.cashierCall(associationId, 'business/addcashier', {
      provider_token: this.providerToken ?? '',
      vendor_token: vendorToken,
      ...signed,
      notify: 'yes',
      signature,
    });
    // From here Lydia holds the cashier: whatever fails next is "added, unconfirmed", never a
    // refusal, so the caller records the person rather than forgetting a cashier Lydia lists.
    try {
      const reading = await this.readCashierReading(associationId, vendorToken, phone);
      const differing = cashierRightsDifference(reading, role);
      if (differing.length > 0) {
        this.logger.error(
          `[LYDIA-CASHIER] association ${associationId}: business/addcashier answered 0 but the ` +
            `read-back differs from the ${role} set on ${differing.length} right(s): ` +
            `${differing.join(',')} - added, UNCONFIRMED`
        );
        throw new BadGatewayException({
          code: LYDIA_CASHIER_RIGHTS_INCOMPLETE,
          message: 'Lydia did not confirm the rights of the cashier',
        });
      }
    } catch (err) {
      throw new LydiaCashierAddedUnconfirmedException(err);
    }
    this.logger.log(
      `[LYDIA-CASHIER] association ${associationId}: ${role} confirmed with exactly ` +
        `${wanted.length} right(s)`
    );
  }

  /**
   * Refuses unless the association's Responsable reads all 13 documented rights at Lydia - the
   * guarantee that a holder keeps full rights whatever else changes. Otherwise the typed 409
   * `LYDIA_CASHIER_HOLDER_RIGHTS_MISSING`, and nothing changes at Lydia; a read that cannot be
   * trusted or made throws its own typed error (`LYDIA_CASHIER_READBACK_INVALID`, `LYDIA_UNREACHABLE`).
   */
  async assertResponsableIntact(
    associationId: string,
    vendorToken: string,
    contextPhone: string
  ): Promise<void> {
    const reading = await this.readCashierReading(associationId, vendorToken, contextPhone);
    const lacking = cashierRightsDifference(reading, 'responsable');
    if (lacking.length === 0) {
      this.logger.debug(`[LYDIA-CASHIER] association ${associationId}: Responsable intact, 13/13`);
      return;
    }
    this.logger.error(
      `[LYDIA-CASHIER] association ${associationId}: the Responsable lacks ` +
        `${lacking.length} right(s) at Lydia (${lacking.join(',')}) - refused before any change`
    );
    throw new ConflictException({
      code: LYDIA_CASHIER_HOLDER_RIGHTS_MISSING,
      message: "Lydia does not show every right of the association's Responsable",
    });
  }

  /**
   * Removes `cashierPhone` from the Business `vendorToken` (`contextPhone`, opened by
   * social-service, is part of the call), then RE-READS `cashierPhone`'s rights: the removal counts
   * only when no `access_*` reads 1, documented or not, in an answer that parses
   * (`parseCashierReading`). First, {@link assertResponsableIntact} - its refusal, like a malformed
   * number or a missing Provider key, throws BEFORE any change. After that it never throws: whatever Lydia answers to the
   * removal, the re-read decides; a refused removal of a number that holds nothing is a confirmed one.
   * Answers `{ verified, held }`, `held` null when the re-read itself failed or could not be
   * trusted. Phones are never logged, only their last two digits.
   */
  async removeCashier(
    associationId: string,
    vendorToken: string,
    contextPhone: string,
    cashierPhone: string
  ): Promise<LydiaCashierRemoval> {
    this.cashierKeyOrThrow(associationId, contextPhone);
    this.cashierKeyOrThrow(associationId, cashierPhone);
    await this.assertResponsableIntact(associationId, vendorToken, contextPhone);
    const tag =
      `[LYDIA-CASHIER] association ${associationId}: removal of phone ending ` +
      `${cashierPhone.slice(-2)}`;
    this.logger.log(`${tag} asked`);
    try {
      await this.cashierCall(associationId, 'business/removecashier', {
        vendor_token: vendorToken,
        phone: contextPhone,
        cashier_phone: cashierPhone,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `${tag}: Lydia did not accept the call (${typedCode(err)}) - the re-read decides`
      );
    }
    let reading: LydiaCashierReading;
    try {
      reading = await this.readCashierReading(associationId, vendorToken, cashierPhone);
    } catch (err: unknown) {
      this.logger.error(`${tag}: the re-read failed (${typedCode(err)}) - NOT confirmed`);
      return { verified: false, held: null };
    }
    const held = reading.held.length;
    if (held > 0) {
      this.logger.error(
        `${tag}: the re-read still shows ${held} right(s) (${reading.held.join(',')}) - NOT confirmed`
      );
      return { verified: false, held };
    }
    this.logger.log(`${tag}: confirmed, 0 rights`);
    return { verified: true, held: 0 };
  }

  /**
   * Reads one cashier's rights on the Business (`business/getpermission`), parsed FAIL-CLOSED
   * ({@link parseCashierReading}: each `access_*` as `"0"`/`"1"` under the answer's `data` object,
   * read in production 2026-10-30 and on homologation 2026-10-31). Errors are typed like
   * `addBusinessHolder`'s, plus 502 `LYDIA_CASHIER_READBACK_INVALID`. Read-only: no SMS, no change.
   */
  async readCashierReading(
    associationId: string,
    vendorToken: string,
    phone: string
  ): Promise<LydiaCashierReading> {
    this.cashierKeyOrThrow(associationId, phone);
    const answer = await this.cashierCall(associationId, 'business/getpermission', {
      vendor_token: vendorToken,
      cashier_phone: phone,
    });
    let reading: LydiaCashierReading;
    try {
      reading = parseCashierReading(answer);
    } catch (err: unknown) {
      this.logger.error(
        `[LYDIA-CASHIER] association ${associationId}: phone ending ${phone.slice(-2)} - ` +
          `${err instanceof HttpException ? String((err.getResponse() as { message?: unknown }).message) : 'unreadable'}`
      );
      throw err;
    }
    this.logger.debug(
      `[LYDIA-CASHIER] association ${associationId}: phone ending ${phone.slice(-2)} holds ` +
        `${reading.held.length} right(s)`
    );
    return reading;
  }

  /** The 13 documented rights of one cashier ({@link readCashierReading}, fail-closed). */
  async readCashierRights(
    associationId: string,
    vendorToken: string,
    phone: string
  ): Promise<LydiaCashierRights> {
    return (await this.readCashierReading(associationId, vendorToken, phone)).rights;
  }

  /** The Provider private token, after the checks every cashier call makes BEFORE contacting Lydia. */
  private cashierKeyOrThrow(associationId: string, phone: string): string {
    if (!this.providerToken || !this.providerPrivateToken) {
      this.logger.error(
        `[LYDIA-CASHIER] association ${associationId}: refused before any call - ` +
          `LYDIA_PROVIDER_TOKEN / LYDIA_PROVIDER_PRIVATE_TOKEN not configured`
      );
      throw new ServiceUnavailableException({
        code: LYDIA_CASHIER_NOT_CONFIGURED,
        message: 'Lydia cashiers cannot be managed: the Provider key is not configured',
      });
    }
    if (!LYDIA_CASHIER_PHONE_RE.test(phone)) {
      this.logger.warn(`[LYDIA-CASHIER] association ${associationId}: refused, phone is not E.164`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_PHONE_INVALID,
        message: 'The phone number must be written +33...',
      });
    }
    return this.providerPrivateToken;
  }

  /** One cashier call through `postForm`, its failures typed (see `addBusinessHolder`). */
  private async cashierCall(
    associationId: string,
    path: 'business/addcashier' | 'business/getpermission' | 'business/removecashier',
    fields: Record<string, string>
  ): Promise<Record<string, unknown>> {
    try {
      return await this.postForm<Record<string, unknown>>(`/api/${path}`, fields);
    } catch (err: unknown) {
      if (err instanceof HttpException && !(err instanceof BadRequestException)) throw err;
      const providerCode =
        err instanceof BadRequestException
          ? String((err.getResponse() as { providerCode?: unknown })?.providerCode ?? '')
          : '';
      const tag = `[LYDIA-CASHIER] association ${associationId}: ${path}`;
      if (providerCode === '444') {
        this.logger.error(`${tag} refused the signature (444)`);
        throw new BadGatewayException({
          code: LYDIA_SIGNATURE_REFUSED,
          message: 'Lydia refused the signature',
        });
      }
      if (providerCode === '3') {
        this.logger.error(`${tag} refused the permissions (3)`);
        throw new BadGatewayException({
          code: LYDIA_CASHIER_PERMISSIONS_INVALID,
          message: 'Lydia refused the permission list',
        });
      }
      if (providerCode === '102' || providerCode === '103') {
        this.logger.error(
          `${tag} refused the Business's vendor token (${providerCode}) - the linked Business ` +
            `is not one Lydia knows for this Provider`
        );
        throw new BadGatewayException({
          code: LYDIA_BUSINESS_TOKEN_REJECTED,
          message: 'Lydia does not recognise this Business',
        });
      }
      if (providerCode && !providerCode.startsWith('http-')) {
        // Another Lydia code: an answer, but not one this call knows. Said, never guessed.
        this.logger.error(`${tag} refused with error ${providerCode}`);
        throw new BadGatewayException({
          code: PAYMENT_PROVIDER_REFUSED,
          providerCode,
          message: `Lydia refused the call (error ${providerCode})`,
        });
      }
      // No usable answer (transport, a timeout, a 5xx or an HTML 500, a 4xx): a retry is safe,
      // since a repeat add replaces the rights.
      this.logger.error(`${tag} got no usable answer`);
      throw new ServiceUnavailableException({
        code: LYDIA_UNREACHABLE,
        message: 'Lydia could not be reached; trying again is safe',
      });
    }
  }

  /**
   * Cancels a request via `POST /api/request/cancel` (measured on the sandbox 2026-10-15,
   * payments.md): the NUMERIC `request_id` plus the Business's `vendor_token`, no signature. Lydia
   * then moves the request to state 6 and calls its `cancel_url`. Error 2 ("transaction deja
   * traitee") was measured on cancelled and expired requests; a PAID one very probably answers the
   * same, so it comes back as `already-settled` - processed, not necessarily unpaid - and the caller
   * reads `getCheckoutRequestState` before treating the request as dead.
   * Any other refusal throws, like every call through `postForm`.
   */
  async cancelCheckoutRequest(
    requestId: string,
    connectAccountId: string
  ): Promise<CancelRequestOutcome> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    if (!/^\d+$/.test(requestId)) {
      // Lydia refuses a request_uuid here (error 1): the numeric id is the only one it accepts.
      throw new BadRequestException(`Lydia request/cancel needs the numeric request_id`);
    }
    if (!connectAccountId) {
      throw new BadRequestException('Lydia request/cancel requires the vendor_token');
    }
    const data = await this.postForm<object>(
      '/api/request/cancel',
      { request_id: requestId, vendor_token: connectAccountId },
      [LYDIA_CANCEL_ALREADY_SETTLED]
    );
    const outcome: CancelRequestOutcome =
      String(data.error ?? '0') === LYDIA_CANCEL_ALREADY_SETTLED ? 'already-settled' : 'cancelled';
    this.logger.log(`Lydia request ${requestId} cancel: ${outcome}`);
    return outcome;
  }

  /**
   * Refunds `amountCents` of the transaction Canari issued with `orderRef`, on the Business
   * `vendorToken`, through `transaction/refund` signed with that Business's private token over the
   * RAW `amount` and `order_ref` (`signLydiaRefund`, homologation 2026-10-31, lydia-refund.ts).
   *
   * Answers only when Lydia answered `error: 0`. A refusal Lydia ANSWERED (an error code, an HTTP
   * 4xx that says refused) is a typed 409 - nothing was refunded. Anything else (no answer in time,
   * a 5xx, a 4xx that does not say refused) is the typed 504 `LYDIA_REFUND_UNCONFIRMED`: Lydia may
   * have refunded, and the caller must not retry blind. The key never reaches a log line.
   */
  async refundTransaction(
    vendorToken: string,
    orderRef: string,
    amountCents: number,
    businessKey: string
  ): Promise<void> {
    const amount = lydiaAmountString(amountCents);
    this.logger.log(`[LYDIA-REFUND] ${orderRef}: asking Lydia to refund ${amount}`);
    let answer: unknown;
    try {
      answer = await this.postForm<unknown>('/api/transaction/refund', {
        vendor_token: vendorToken,
        order_ref: orderRef,
        amount,
        signature: signLydiaRefund(orderRef, amount, businessKey),
      });
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        const body = err.getResponse() as { code?: unknown; providerCode?: unknown };
        const providerCode = typeof body?.providerCode === 'string' ? body.providerCode : '';
        const code = lydiaRefundRefusalCode(providerCode, {
          signatureRefused: LYDIA_SIGNATURE_REFUSED,
          businessTokenRejected: LYDIA_BUSINESS_TOKEN_REJECTED,
          businessBlocked: LYDIA_BUSINESS_BLOCKED,
        });
        this.logger.warn(
          `[LYDIA-REFUND] ${orderRef}: Lydia refused the refund of ${amount} (error ${providerCode}) -> ${code}`
        );
        throw new ConflictException({
          code,
          providerCode,
          message: 'Lydia refused the refund; nothing was refunded',
        });
      }
      this.logger.error(
        `[LYDIA-REFUND] ${orderRef}: no usable answer to the refund of ${amount} - Lydia MAY have refunded`
      );
      throw new GatewayTimeoutException({
        code: LYDIA_REFUND_UNCONFIRMED,
        message: 'Lydia did not confirm the refund',
      });
    }
    // A refund is CONFIRMED only by Lydia's explicit `error: "0"`: `postForm` throws only when an
    // error code is present, so an empty body, `null`, `{status: "ok"}` or `{error: ""}` would
    // otherwise read as a refund Lydia never said it made.
    if (!isLydiaRefundConfirmed(answer)) {
      this.logger.error(
        `[LYDIA-REFUND] ${orderRef}: Lydia answered the refund of ${amount} without "error: 0" - ` +
          'not a confirmation; Lydia MAY have refunded'
      );
      throw new GatewayTimeoutException({
        code: LYDIA_REFUND_UNCONFIRMED,
        message: 'Lydia did not confirm the refund',
      });
    }
    this.logger.log(`[LYDIA-REFUND] ${orderRef}: Lydia refunded ${amount}`);
  }

  /**
   * Reads a request's state via `POST /api/request/state` with `request_uuid` AND the Business's
   * `vendor_token` (measured on the sandbox 2026-10-15, payments.md). Without the vendor_token
   * Lydia still answers the state, but unsigned; with it the answer is `{state,
   * used_ease_of_payment, signature}`. NO variant echoes `order_ref`, so the caller must already
   * know which answer the request belongs to - it reads by the uuid its own row stored.
   * The code is classified HERE, once (`LYDIA_REQUEST_STATES`): 0 open, 1 paid, 5 declined by the
   * payer, 6 cancelled or expired, all measured. Any other code is `unknown`, at WARN.
   *
   * By `orderRef` instead (`order_ref` + `vendor_token`, measured to find the request the same way):
   * the read of an attempt whose issuing call never answered a uuid. Only THERE is Lydia's error 2
   * ("Requete introuvable", measured on an unknown order_ref) an answer - `not-found`, no request
   * carries it - while for a uuid, which Canari got from Lydia itself, it stays a refusal.
   */
  async getCheckoutRequestState(
    lookup: CheckoutRequestLookup,
    connectAccountId: string
  ): Promise<CheckoutRequestState> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    if (!connectAccountId) {
      throw new BadRequestException('Lydia request/state requires the vendor_token');
    }
    const byOrderRef = 'orderRef' in lookup;
    const named = byOrderRef ? lookup.orderRef : lookup.requestUuid;
    const data = await this.postForm<{ state?: string | number; signature?: unknown }>(
      '/api/request/state',
      byOrderRef
        ? { order_ref: lookup.orderRef, vendor_token: connectAccountId }
        : { request_uuid: lookup.requestUuid, vendor_token: connectAccountId },
      byOrderRef ? [LYDIA_STATE_NOT_FOUND] : []
    );
    if (byOrderRef && String(data.error ?? '0') === LYDIA_STATE_NOT_FOUND) {
      this.logger.log(`Lydia holds no request with order_ref ${named}`);
      return { state: 'not-found', raw: `error ${LYDIA_STATE_NOT_FOUND}`, signature: null };
    }
    const raw = data.state === undefined || data.state === null ? '' : String(data.state);
    // `Object.hasOwn`: a code such as "constructor" must not read the prototype as a state.
    const state: CheckoutRequestStateKind = Object.hasOwn(LYDIA_REQUEST_STATES, raw)
      ? LYDIA_REQUEST_STATES[raw]
      : 'unknown';
    if (state === 'unknown') {
      this.logger.warn(`Lydia request ${named} answered an unknown state code "${raw}"`);
    } else {
      this.logger.debug(`Lydia request ${named} is ${state} (code ${raw})`);
    }
    // Kept as received, never logged (`postForm` redacts it): `PaymentService` verifies it when
    // its caller asks, with the Business key, over the amount and the id this read named.
    const signature = typeof data.signature === 'string' && data.signature ? data.signature : null;
    return { state, raw, signature };
  }

  /**
   * Creates a Business via `POST /api/business/create`. Unlike Stripe's `accountLinks` (a hosted
   * page the association fills in itself), Lydia needs the legal profile as request fields - the
   * caller must collect it first (see the onboarding form, WP-LYDIA-1). `dashboard_url` is returned
   * as `OnboardingResult.url` so the treasurer has somewhere to go manage the Business; there is no
   * separate "finish onboarding" redirect step like Stripe's, the Business exists immediately.
   *
   * `api_token_id` IS the Business private token (homologation 2026-10-30, lydia-api.md section 1),
   * and it is answered ONCE. So it is captured here, but only after Lydia's own `auth/vendortoken`
   * confirms it pairs with `api_token` (`verifyBusinessKey`): anything else throws the typed
   * `LYDIA_BUSINESS_CREATED_UNLINKED` and the onboarding fails visibly, linking nothing - there is
   * no path that links a Business without its key. It is returned to the controller for social-service
   * to store encrypted, and never logged (`LYDIA_LOG_REDACT_KEYS`).
   *
   * `webhook` asks Lydia to POST the Business's validation events to `lydia-business-webhook`;
   * that POST is unsigned and decides nothing (webhook.controller.ts).
   */
  async createOnboarding(params: OnboardingParams): Promise<OnboardingResult> {
    if (!this.providerToken) throw new BadRequestException('Lydia not configured');
    const profile = params.legalProfile;
    if (
      !profile?.name ||
      !profile.address ||
      !profile.zipcode ||
      !profile.city ||
      !profile.country ||
      !profile.businessEmail ||
      !profile.businessPhone
    ) {
      throw new BadRequestException(
        'Lydia business/create requires the full association legal profile (name, address, zipcode, city, country, businessEmail, businessPhone)'
      );
    }

    const unconfirmed = (why: string) =>
      businessCreateUnconfirmed(this.logger, params.associationId, why);
    let data: { api_token?: unknown; api_token_id?: unknown; dashboard_url?: unknown };
    try {
      data = await this.postForm<{
        api_token?: unknown;
        api_token_id?: unknown;
        dashboard_url?: unknown;
      }>(
        '/api/business/create',
        {
          provider_token: this.providerToken,
          name: profile.name,
          address: profile.address,
          zipcode: profile.zipcode,
          city: profile.city,
          country: profile.country,
          business_email: profile.businessEmail,
          business_phone: profile.businessPhone,
          webhook: this.businessWebhookUrl(),
        },
        [],
        LYDIA_ONBOARDING_STEP_TIMEOUT_MS.create
      );
    } catch (err: unknown) {
      // A refusal (an error code, an HTTP 4xx that says refused) created nothing: rethrown as is.
      if (err instanceof BadRequestException) throw err;
      // Anything else - no answer in time, a 5xx, a 4xx that does not say refused - is AMBIGUOUS:
      // Lydia may have created the Business and the answer was lost.
      throw unconfirmed(err instanceof Error ? err.message : String(err));
    }
    // `postForm` only throws on a recognized `error` field - a 200 with NEITHER an error NOR an
    // `api_token` (observed in homologation) names nothing, so whether a Business exists is unknown.
    if (typeof data.api_token !== 'string' || !data.api_token) {
      throw unconfirmed('a 200 with no error and no api_token - see the raw response logged above');
    }
    const vendorToken = data.api_token;
    // Recorded BEFORE anything else can fail, so a BUSINESS_VALIDATED naming it before the link is
    // retried rather than dropped. The callback reports its own failure and never throws.
    await params.onBusinessCreated?.(vendorToken);
    // A Business that answered its vendor token but no dashboard URL exists and cannot be handed to
    // the association as Lydia meant it to: an orphan, recorded like any other.
    if (typeof data.dashboard_url !== 'string' || !data.dashboard_url) {
      throw businessCreatedUnlinked(
        this.logger,
        params.associationId,
        vendorToken,
        'business/create answered no dashboard_url'
      );
    }
    const dashboardUrl = data.dashboard_url;
    const businessPrivateToken = typeof data.api_token_id === 'string' ? data.api_token_id : '';
    await this.verifyBusinessKey(params.associationId, vendorToken, businessPrivateToken);
    return { url: dashboardUrl, accountId: vendorToken, businessPrivateToken };
  }

  /**
   * Asks Lydia whether `businessPrivateToken` is the private token of `vendorToken`
   * (`POST /api/auth/vendortoken`, fields `vendor_token` and `vendor_id`): `{status: "ok"}` for the
   * pair, error 103 otherwise (homologation 2026-10-30). EVERY other outcome - no token to check,
   * 103, another code, an HTTP refusal, a 5xx or no answer - is the one typed
   * `LYDIA_BUSINESS_CREATED_UNLINKED`: the Business exists and nothing will link it. The private
   * token is never logged.
   */
  private async verifyBusinessKey(
    associationId: string,
    vendorToken: string,
    businessPrivateToken: string
  ): Promise<void> {
    const orphan = (why: string) =>
      businessCreatedUnlinked(this.logger, associationId, vendorToken, why);
    if (!businessPrivateToken) throw orphan('business/create answered no api_token_id');
    let answer: { status?: unknown; error?: string };
    try {
      answer = await this.postForm<{ status?: unknown }>(
        '/api/auth/vendortoken',
        { vendor_token: vendorToken, vendor_id: businessPrivateToken },
        [LYDIA_VENDOR_TOKEN_MISMATCH],
        LYDIA_ONBOARDING_STEP_TIMEOUT_MS.verify
      );
    } catch (err: unknown) {
      const providerCode = (err as { getResponse?: () => unknown })?.getResponse?.() as
        | { providerCode?: unknown }
        | undefined;
      throw orphan(
        providerCode?.providerCode !== undefined
          ? `auth/vendortoken refused it: ${String(providerCode.providerCode)}`
          : `auth/vendortoken gave no answer: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (String(answer.error ?? '') === LYDIA_VENDOR_TOKEN_MISMATCH) {
      throw orphan(`auth/vendortoken answered error ${LYDIA_VENDOR_TOKEN_MISMATCH}`);
    }
    if (answer.status !== 'ok') throw orphan('auth/vendortoken did not answer status ok');
    this.logger.log(
      `[LYDIA] business/create for association ${associationId}: private token confirmed by auth/vendortoken`
    );
  }

  async getAccountStatus(_accountId: string): Promise<{ chargesEnabled: boolean }> {
    throw new BadRequestException(
      "Lydia has no live account-status poll - status must be read from Canari's DB, updated by the BUSINESS_VALIDATED webhook (see WP-LYDIA-1)."
    );
  }

  async getConnectAccountStatus(_accountId: string): Promise<ConnectAccountStatusResponse> {
    throw new BadRequestException(
      "Lydia has no live account-status poll - status must be read from Canari's DB, updated by the BUSINESS_VALIDATED webhook (see WP-LYDIA-1)."
    );
  }

  async getConnectBalance(_accountId: string): Promise<ConnectBalanceSummary> {
    throw new BadRequestException(
      'Lydia exposes no generic collect balance endpoint (only business/b2cbalance, B2C-only) - see WP-LYDIA-1 open question.'
    );
  }

  async createConnectDashboardLink(_accountId: string): Promise<string> {
    throw new BadRequestException(
      'Lydia Business dashboard access is via the dashboard_url returned once at business/create, not a re-issuable login link.'
    );
  }
}
