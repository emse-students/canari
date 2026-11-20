import { m } from '$lib/paraglide/messages';
import { fetchOrUnreachable } from '$lib/utils/fetchOrUnreachable';

/**
 * THE ONE PLACE THE APP REACHES THE SERVER'S PIN ROUTES.
 *
 * Every PIN request runs under the request deadline (`fetchOrUnreachable`, PIN audit row 11): one
 * the network swallows ends as the typed "unreachable", never as a keypad spinning for ever. The
 * guarantee used to be one call per site, and a site written later with a bare `fetch` lost it with
 * every test green. So the route path exists HERE and nowhere else - a caller names a
 * {@link PinRoute}, never a URL - and `pinRequestsWiring.test.ts` fails on the path written anywhere
 * else, whatever builds it.
 */

/** The PIN routes of the delivery service (`security.controller.ts`). */
type PinRoute = 'pin-salt' | 'pin-check' | 'pin-status' | 'pin-reset' | 'pin-change';

/** The routes whose path names the account (`/:userId`). */
const ROUTES_NAMING_THE_ACCOUNT: ReadonlySet<PinRoute> = new Set(['pin-salt', 'pin-status']);

/** One PIN request. */
export interface PinRequest {
  /** The delivery service's origin (`deliveryUrl()`, `ctx.getHistoryBaseUrl()`). */
  baseUrl: string;
  route: PinRoute;
  /** The account a per-account route names (`pin-salt`, `pin-status`); absent for the others. */
  userId?: string;
  init?: RequestInit;
  /** The localized line an unanswered request ends with; the generic "unreachable" by default. */
  unreachable?: string;
}

/** A transport a test injects in place of the real one; it receives the URL built here. */
export type PinTransport = (url: string, init: RequestInit) => Promise<Response>;

/** The URL of `route`, for `userId` where the route names the account. */
function pinRouteUrl({ baseUrl, route, userId }: PinRequest): string {
  const namesAccount = ROUTES_NAMING_THE_ACCOUNT.has(route);
  if (namesAccount !== (userId !== undefined)) {
    throw new Error(`PIN route ${route} ${namesAccount ? 'needs' : 'takes no'} account id`);
  }
  const path = `/api/mls/security/${route}`;
  return `${baseUrl}${path}${namesAccount ? `/${encodeURIComponent(userId ?? '')}` : ''}`;
}

/**
 * Sends one PIN request under the request deadline. Rejects as `ServerUnreachableError` (carrying
 * `request.unreachable`) when no answer comes; a caller's abort passes through unchanged.
 *
 * @param transport a test double; the real path is always `fetchOrUnreachable`.
 */
export function pinServerRequest(request: PinRequest, transport?: PinTransport): Promise<Response> {
  const url = pinRouteUrl(request);
  const init = request.init ?? {};
  if (transport) return transport(url, init);
  return fetchOrUnreachable(url, init, request.unreachable ?? m.auth_server_unreachable());
}
