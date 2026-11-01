import { BadGatewayException, BadRequestException, HttpException } from '@nestjs/common';
import type { LydiaReadinessCause } from '../associations/lydia-readiness';
import { paymentsNotReady } from '../associations/lydia-readiness';
import { describeHttpError } from './http-error-log';
import { sanitizeLog } from './log.utils';

/** Mirrors core-service's `PAYMENT_PROVIDER_REFUSED` (`lydia-payment-provider.ts`): the body `code` of a refusal. */
export const PAYMENT_PROVIDER_REFUSED = 'PAYMENT_PROVIDER_REFUSED';

/**
 * The body `code` of a refusal because the amount is outside what can be paid: the platform's
 * provider range (answered by core-service, same constant there) or a product's own bounds. Carries
 * `minCents` and `maxCents` (`null` = unbounded) so the UI words the allowed range itself.
 */
export const AMOUNT_OUT_OF_RANGE = 'AMOUNT_OUT_OF_RANGE';

/**
 * The payable range of one checkout, in cents: core-service's `LYDIA_MIN_AMOUNT_CENTS` /
 * `LYDIA_MAX_AMOUNT_CENTS`, mirrored here because the two apps share no TS package. The ONE
 * social-side copy - a form total outside it is refused before core is called. Both apps' specs
 * assert their constants against `libs/contracts/payment-amount-range.json`, so they cannot drift.
 */
export const PROVIDER_MIN_AMOUNT_CENTS = 50;
export const PROVIDER_MAX_AMOUNT_CENTS = 100_000;

/** The typed 400 for an amount outside `[minCents, maxCents]` (`null` max = no upper bound). */
export function amountOutOfRange(
  minCents: number,
  maxCents: number | null,
  message: string
): BadRequestException {
  return new BadRequestException({ code: AMOUNT_OUT_OF_RANGE, message, minCents, maxCents });
}

/** The body `code` of a refusal because a client-sent amount is not a whole number of cents. */
export const AMOUNT_INVALID = 'AMOUNT_INVALID';

/**
 * Reads a client-sent amount in cents at the request boundary: `undefined` stays `undefined` (no
 * amount sent), anything else must be a non-negative safe integer or the request is refused with a
 * typed `AMOUNT_INVALID` 400, logged. WHY: a body typed inline is never validated, so `5000.5`
 * passed every bound and was charged ROUNDED (`toFixed(2)`) while the sale was recorded as sent,
 * and a non-numeric string compares as NaN, which no `<` / `>` bound check ever refuses.
 */
export function wholeCentsOf(raw: unknown, logger: WarnLogger, what: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  logger.warn(
    `[${what}] amount refused: not a whole non-negative number of cents (type=${typeof raw} value=${sanitizeLog(String(raw).slice(0, 32))})`
  );
  throw new BadRequestException({
    code: AMOUNT_INVALID,
    message: 'The amount must be a whole, non-negative number of cents',
  });
}

/** Minimal logger surface, so a service passes its own `Logger` and the log carries ITS context. */
interface WarnLogger {
  warn(message: string): void;
  error(message: string): void;
}

interface CoreAnswer {
  response?: { status?: unknown; data?: unknown };
}

/**
 * Mirrors core-service's `LYDIA_BUSINESS_NOT_VALIDATED` (`lydia-payment-provider.ts`): Lydia answered
 * a `request/do` with error 5, the Business is not validated. No request exists (no `mobile_url`).
 */
export const LYDIA_BUSINESS_NOT_VALIDATED = 'LYDIA_BUSINESS_NOT_VALIDATED';

/** Mirrors core-service's `LYDIA_BUSINESS_BLOCKED`: `request/do` answered error 2701, a blocked Business. */
export const LYDIA_BUSINESS_BLOCKED = 'LYDIA_BUSINESS_BLOCKED';

/** The body `code` of a failed core call, when core answered one. */
function coreCodeOf(err: unknown): unknown {
  const data = (err as CoreAnswer | null)?.response?.data;
  return data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
}

/**
 * The readiness cause a failed `create-checkout-session` names, classified on core's typed CODE and
 * never on Lydia's sentence: `request-refused` (error 5, not validated), `request-blocked` (error
 * 2701), or null for every other failure. A non-null answer means the holder of the vendor token
 * must stop being ready (`AssociationsService.revertLydiaReadinessAfterRefusal`).
 */
export function lydiaReadinessRefusal(
  err: unknown
): Extract<LydiaReadinessCause, 'request-refused' | 'request-blocked'> | null {
  const code = coreCodeOf(err);
  if (code === LYDIA_BUSINESS_NOT_VALIDATED) return 'request-refused';
  if (code === LYDIA_BUSINESS_BLOCKED) return 'request-blocked';
  return null;
}

/**
 * Whether a failed call to core-service was ANSWERED with a 4xx - a refusal about this request, so
 * nothing was issued - rather than lost (no response, a timeout, a 5xx), after which a request may
 * exist at the provider all the same. A status code is an answer; a transport failure is not.
 * Serves `create-checkout-session` only, where ANY 4xx means nothing was issued; reading or
 * cancelling an issued request needs to tell Lydia's refusal from core's own state, so those go
 * through `classifyCoreCallFailure` instead.
 */
export function coreRefusedRequest(err: unknown): boolean {
  if (err instanceof HttpException) return false;
  const status = (err as CoreAnswer | null)?.response?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** Lydia error codes measured FINAL for one call: a refusal closes an attempt only from here. */
export interface LydiaRefusalsFinal {
  /** For a `request/state` read. */
  readonly read: ReadonlySet<string>;
  /** For a `request/cancel`. */
  readonly cancel: ReadonlySet<string>;
}

/**
 * The ALLOWLIST of Lydia refusal codes that let the reconciliation sweep CLOSE an attempt: any other
 * refusal is retried and accused, because the sweep is the only automatic path for a PAID request
 * whose callback was lost, and an attempt it closes is never read again. BOTH ARE EMPTY:
 * - read: error `2` ("Requete introuvable") was measured on a uuid Lydia NEVER issued (2026-10-15);
 *   the sweep reads uuids Lydia DID issue, and what error 2 means for one issued then purged,
 *   archived or moved between environments is unmeasured - a PAID request answered that way would
 *   be closed for good.
 * - cancel: no cancel refusal is measured (error 2 on a cancel is "already processed", read apart).
 * A code joins only after a dev-sandbox measurement on an ISSUED request shows it final (owed:
 * docs/wiki/lydia-api.md section 7). The services hold this as `refusalsFinal`, which the tests
 * replace with a test-only code to exercise the mechanism.
 */
export const LYDIA_REFUSALS_FINAL: LydiaRefusalsFinal = { read: new Set(), cancel: new Set() };

/**
 * What a failed call to core-service's `request-state` or `cancel-request` was, for the caller that
 * must decide whether to act on it - ONE classifier for the read and the cancel.
 * - `refused`: Lydia's typed refusal (a 400 with `PAYMENT_PROVIDER_REFUSED` and its
 *   `providerCode`) - about THIS request; final only if its code is allowlisted.
 * - `core-fault`: core answered, but about ITSELF or this service - a 401/403 (the internal
 *   secret), its 503 `PAYMENT_SERVICE_NOT_READY` (payments switched off, Lydia not configured, a
 *   payload it would not read), any other 4xx it should not send here. Retried, and accused.
 * - `no-answer`: no response, a timeout, a 5xx, a 408/429: retried.
 */
export type CoreCallFailure =
  | { kind: 'refused'; providerCode: string }
  | { kind: 'core-fault'; status: number }
  | { kind: 'no-answer' };

/** Classifies a failed call to core's request-state / cancel-request (see `CoreCallFailure`). */
export function classifyCoreCallFailure(err: unknown): CoreCallFailure {
  const answer = (err as CoreAnswer | null)?.response;
  const status = typeof answer?.status === 'number' ? answer.status : null;
  if (status === null || status === 408 || status === 429) return { kind: 'no-answer' };
  const body =
    answer?.data && typeof answer.data === 'object'
      ? (answer.data as { code?: unknown; providerCode?: unknown })
      : {};
  if (status === 400 && body.code === PAYMENT_PROVIDER_REFUSED) {
    const code =
      typeof body.providerCode === 'string' && body.providerCode ? body.providerCode : '';
    return { kind: 'refused', providerCode: code };
  }
  if (status >= 500 && body.code !== 'PAYMENT_SERVICE_NOT_READY') return { kind: 'no-answer' };
  return { kind: 'core-fault', status };
}

/**
 * Turns a failed call to core-service's `payments/create-checkout-session` into the ONE exception
 * every checkout route answers with - the product checkout and the paid form submit used to map the
 * same Lydia refusal two ways (500 "Internal server error" and 400 with Lydia's message).
 *
 * - A typed provider refusal (`code: PAYMENT_PROVIDER_REFUSED`, e.g. Lydia error 5 "Ce lieu
 *   d'activite est temporairement bloque") or any other 4xx core answered becomes a **400** carrying
 *   the provider's message and the code. It is an ANSWER about THIS request, not a server fault, and
 *   400 is what the paid form route already answered and its UI already reads.
 * - Anything else (no response, a 5xx) becomes a **502**: the payment service is the upstream that
 *   failed, and its raw error - which carries the internal secret - is never put in the response.
 * - An exception this service already chose (payments disabled, not ready) passes through untouched.
 *
 * Every branch logs, through `describeHttpError`, so the log line holds method, URL, status and the
 * provider's message and never the error object.
 */
export function mapCorePaymentError(err: unknown, logger: WarnLogger, what: string): HttpException {
  if (err instanceof HttpException) return err;
  const answer = (err as CoreAnswer | null)?.response;
  const status = typeof answer?.status === 'number' ? answer.status : null;
  const body =
    answer?.data && typeof answer.data === 'object' ? (answer.data as Record<string, unknown>) : {};
  const message = typeof body.message === 'string' && body.message.trim() ? body.message : null;

  if (
    status === 400 &&
    message &&
    body.code === AMOUNT_OUT_OF_RANGE &&
    typeof body.minCents === 'number' &&
    typeof body.maxCents === 'number'
  ) {
    logger.warn(
      `[${what}] payment provider refused the amount (allowed ${body.minCents}-${body.maxCents} cents): ${describeHttpError(err)}`
    );
    return amountOutOfRange(body.minCents, body.maxCents, message);
  }
  const readinessCause = status === 400 ? lydiaReadinessRefusal(err) : null;
  if (readinessCause) {
    // Typed for the payer: the association cannot take payments, which is not their request's fault.
    logger.warn(
      `[${what}] Lydia refused the request: the Business is ${readinessCause === 'request-blocked' ? 'blocked' : 'not validated'}: ${describeHttpError(err)}`
    );
    return paymentsNotReady(readinessCause, false);
  }
  if (status !== null && status >= 400 && status < 500 && message) {
    logger.warn(`[${what}] payment provider answered ${status}: ${describeHttpError(err)}`);
    return new BadRequestException(
      body.code === PAYMENT_PROVIDER_REFUSED ? { code: PAYMENT_PROVIDER_REFUSED, message } : message
    );
  }
  logger.error(`[${what}] payment service failed: ${describeHttpError(err)}`);
  return new BadGatewayException({
    code: 'PAYMENT_SERVICE_UNAVAILABLE',
    message: 'The payment service could not create the checkout session',
  });
}
