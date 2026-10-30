import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';
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
 * The `code` of an onboarding that created a Business whose `api_token_id` Lydia's own
 * `auth/vendortoken` did not confirm as its private token (error 103, or an answer that is not
 * `status: "ok"`). Nothing is linked and nothing stored: a key Lydia does not recognise would
 * refuse every callback of that association.
 */
export const LYDIA_BUSINESS_KEY_UNVERIFIED = 'LYDIA_BUSINESS_KEY_UNVERIFIED';

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
 * token (`auth/vendortoken`, homologation 2026-10-30; `createOnboarding` stores it encrypted), and
 * `api_token` is the Business's vendor token, which `business/create` answers with and which was
 * logged in clear until 2026-10-07. `signature` is the value Lydia's `request/state` answers with
 * (and the callbacks carry): the proof the whole confirmation rests on, never a log field.
 */
const LYDIA_LOG_REDACT_KEYS = new Set(['api_token_id', 'api_token', 'signature']);

/** The public origin Lydia calls back on: nginx, the single entry point, from `FRONTEND_URL`. */
function publicApiBase(): string {
  return (process.env.FRONTEND_URL || 'http://localhost').replace(/\/$/, '');
}

function redactForLog(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      LYDIA_LOG_REDACT_KEYS.has(key) ? [key, '[redacted]'] : [key, value]
    )
  );
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
 *   received (`lydia-business-webhook`) but it is UNSIGNED and `vendor_token` is PUBLIC, so it is
 *   logged as a hint and decides nothing: a global admin still validates by hand.
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

  constructor(env: { LYDIA_ENV?: string; LYDIA_PROVIDER_TOKEN?: string }) {
    this.baseUrl =
      (env.LYDIA_ENV || '').trim().toLowerCase() === 'production'
        ? PRODUCTION_BASE_URL
        : HOMOLOGATION_BASE_URL;
    this.providerToken = env.LYDIA_PROVIDER_TOKEN;
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
    answers: readonly string[] = []
  ): Promise<T & { error?: string }> {
    const body = new URLSearchParams(fields);
    let res;
    try {
      res = await axios.post<
        T & { error?: string; status?: string; code?: string; message?: string }
      >(`${this.baseUrl}${path}.json`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: LYDIA_CALL_TIMEOUT_MS,
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
            ? `no response within ${LYDIA_CALL_TIMEOUT_MS / 1000} s`
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

    const data = await this.postForm<{
      request_id?: string | number;
      request_uuid: string;
      mobile_url: string;
    }>('/api/request/do', fields);
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
   * confirms it pairs with `api_token` (`verifyBusinessKey`): an unconfirmed value throws the typed
   * `LYDIA_BUSINESS_KEY_UNVERIFIED` and the onboarding fails visibly, linking nothing - there is no
   * path that links a Business without its key. It is returned to the controller for social-service
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

    const data = await this.postForm<{
      api_token: string;
      api_token_id?: unknown;
      dashboard_url: string;
    }>('/api/business/create', {
      provider_token: this.providerToken,
      name: profile.name,
      address: profile.address,
      zipcode: profile.zipcode,
      city: profile.city,
      country: profile.country,
      business_email: profile.businessEmail,
      business_phone: profile.businessPhone,
      webhook: this.businessWebhookUrl(),
    });
    // `postForm` only throws on a recognized `error` field - a response with NEITHER an error
    // NOR the fields this call actually needs (observed in homologation: 200, no `error`, no
    // `api_token`/`dashboard_url` at all) fell through as a "success" with both fields undefined,
    // which `JSON.stringify` then drops - the caller received `{}` and had no way to tell the two
    // apart. The log line above already puts the raw shape somewhere a human can read it; this is
    // what turns it into an error the treasurer actually sees.
    if (!data.api_token || !data.dashboard_url) {
      throw new BadRequestException(
        'Lydia business/create answered with neither an error nor the expected api_token/dashboard_url - see the core-service log for the raw response'
      );
    }
    const businessPrivateToken = typeof data.api_token_id === 'string' ? data.api_token_id : '';
    await this.verifyBusinessKey(params.associationId, data.api_token, businessPrivateToken);
    return { url: data.dashboard_url, accountId: data.api_token, businessPrivateToken };
  }

  /**
   * Asks Lydia whether `businessPrivateToken` is the private token of `vendorToken`
   * (`POST /api/auth/vendortoken`, fields `vendor_token` and `vendor_id`): `{status: "ok"}` for the
   * pair, error 103 otherwise (homologation 2026-10-30). Anything but `ok` throws the typed
   * `LYDIA_BUSINESS_KEY_UNVERIFIED`, logged at ERROR with the association - the Business then
   * exists at Lydia under that legal name and is linked to nothing. Neither token is logged.
   * A transport failure is rethrown by `postForm` as it is: not an answer about the key.
   */
  private async verifyBusinessKey(
    associationId: string,
    vendorToken: string,
    businessPrivateToken: string
  ): Promise<void> {
    const refuse = (why: string): never => {
      this.logger.error(
        `[LYDIA] business/create for association ${associationId}: the Business private token ` +
          `was NOT confirmed (${why}) - nothing linked; a Business now exists at Lydia unlinked`
      );
      throw new BadGatewayException({
        code: LYDIA_BUSINESS_KEY_UNVERIFIED,
        message: 'Lydia did not confirm the private token of the Business it created',
      });
    };
    if (!businessPrivateToken) refuse('business/create answered no api_token_id');
    const answer = await this.postForm<{ status?: unknown }>(
      '/api/auth/vendortoken',
      { vendor_token: vendorToken, vendor_id: businessPrivateToken },
      [LYDIA_VENDOR_TOKEN_MISMATCH]
    );
    if (String(answer.error ?? '') === LYDIA_VENDOR_TOKEN_MISMATCH) {
      refuse(`auth/vendortoken answered error ${LYDIA_VENDOR_TOKEN_MISMATCH}`);
    }
    if (answer.status !== 'ok') refuse('auth/vendortoken did not answer status ok');
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
