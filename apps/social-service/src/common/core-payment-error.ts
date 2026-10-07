import { BadGatewayException, BadRequestException, HttpException } from '@nestjs/common';
import { describeHttpError } from './http-error-log';

/** Mirrors core-service's `PAYMENT_PROVIDER_REFUSED` (`lydia-payment-provider.ts`): the body `code` of a refusal. */
export const PAYMENT_PROVIDER_REFUSED = 'PAYMENT_PROVIDER_REFUSED';

/** Minimal logger surface, so a service passes its own `Logger` and the log carries ITS context. */
interface WarnLogger {
  warn(message: string): void;
  error(message: string): void;
}

interface CoreAnswer {
  response?: { status?: unknown; data?: unknown };
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
