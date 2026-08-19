import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from './service-urls';

/**
 * ONE WAY FOR THIS SERVICE TO CALL CHAT-DELIVERY, AND IT REFUSES TO INTERPRET ANYTHING BUT A STATUS.
 *
 * A STATUS CODE IS AN ANSWER; A TRANSPORT FAILURE IS NOT. Every function built on this one either
 * gets a 2xx body or throws, and no caller may turn "I could not ask" into a value - which is
 * exactly the fault this file was extracted to stop repeating. `userHasMlsDevices` returned `true`
 * on `!res.ok` and on any thrown error, so the day its URL was missing the `/api` prefix it was a
 * constant `true`: not a degraded guard, no guard at all, and nothing said so
 * ([service-urls](service-urls.ts) records the measurement).
 *
 * The distribution-group client had already been written this way and carried its own private copy.
 * This is that copy, with the log tag as an argument so each caller keeps its own prefix.
 */

const logger = new Logger('DeliveryClient');

/**
 * The one refusal every failure here becomes, carrying a stable code.
 *
 * A CODE IS A TYPE. The sentence is prose the backend may reword; the code is what the client
 * branches on to say "we could not check right now" rather than inventing a reason from a status.
 */
function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'KEY_DISTRIBUTION_UNAVAILABLE',
    message: 'Key distribution is unavailable.',
  });
}

/**
 * Performs one internal call to chat-delivery.
 *
 * @param secret `INTERNAL_SECRET`; empty is a misconfigured deployment and fails closed
 * @param tag log prefix identifying the caller, e.g. `DISTRIBUTION_GROUP`
 * @returns the parsed JSON body, or null for an empty one (204 is legitimate on DELETE)
 * @throws ServiceUnavailableException when the call could not be completed, or answered non-2xx
 */
export async function callDelivery(
  secret: string,
  tag: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }
): Promise<unknown> {
  if (!secret) {
    // Fails closed, like every other internal-secret check in the monorepo: an unset secret means
    // the deployment is misconfigured, and answering as though the far side had said something
    // would hide it behind whatever that answer happened to imply.
    logger.error(`[${tag}] INTERNAL_SECRET unset - refusing ${init.method} ${path}`);
    throw unavailable();
  }

  let res: Response;
  try {
    res = await fetch(deliveryUrl(path), {
      method: init.method,
      headers: {
        'X-Internal-Secret': secret,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (e) {
    logger.error(
      `[${tag}] ${init.method} ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
    throw unavailable();
  }

  if (!res.ok) {
    logger.error(`[${tag}] ${init.method} ${path} answered ${res.status}`);
    throw unavailable();
  }

  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

/**
 * How many MLS devices a user has registered, as chat-delivery knows it.
 *
 * ZERO IS A FACT, AND IT IS NOT THE SAME FACT AS "I COULD NOT ASK". This returns 0 only for a
 * genuine 200 carrying an empty list - the person exists and has never opened Canari on anything -
 * and throws for every other outcome. The caller owes its user two different sentences, because
 * "this person has not installed Canari" is advice and "the key service is down" is a retry.
 *
 * Same rule the client side already follows in `fetchUserDevices`, which throws on a non-2xx and
 * returns `[]` only for a real empty answer.
 */
export async function fetchUserDeviceCount(secret: string, userId: string): Promise<number> {
  const payload = await callDelivery(
    secret,
    'MLS_DEVICES',
    `mls/devices/${encodeURIComponent(userId)}`,
    { method: 'GET' }
  );
  // A 200 whose body is not a list is chat-delivery answering something this function cannot read.
  // That is a failure of the call, not a user with no device, and it is not going to be rounded to
  // zero - which is the whole point of this function.
  if (!Array.isArray(payload)) {
    logger.error(`[MLS_DEVICES] user=${userId.slice(0, 8)} answered a non-list body`);
    throw unavailable();
  }
  return payload.length;
}
