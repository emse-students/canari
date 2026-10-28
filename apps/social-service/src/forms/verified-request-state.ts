import axios from 'axios';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import { toRequestState, type RequestState } from './seat-hold';
import { PAYMENT_PROVIDER_REFUSED } from '../common/core-payment-error';

/**
 * How long one verified read may take: core-service bounds its own call to Lydia at 60 s
 * (`LYDIA_CALL_TIMEOUT_MS`) and fetches the Business key first, so it always answers inside this.
 */
const VERIFIED_READ_TIMEOUT_MS = 90_000;

/**
 * What core-service's `payments/request-state` said about a request when it was asked to VERIFY the
 * answer (`expectedAmountCents`): core checked Lydia's `signature` with the Business private token
 * over that amount and the id read (core's `lydia-state-verification.ts`).
 *
 * - `verified`: the answer is Lydia's, about this request, issued for this amount. `state` may be
 *   acted on.
 * - `mismatch`: a signature that does not verify - another amount, another key, a malformed value.
 *   An anomaly: nothing is settled.
 * - `unsigned`: Lydia answered no signature (an error answer, such as the "not found" of an
 *   order_ref lookup, carries none). Nothing is settled.
 * - `no-key`: no Business key is stored for the vendor token, so core did not even ask Lydia.
 * - `unknown`: a verdict this service does not know (an older core mid-deploy answers none): read
 *   as NOT verified, never guessed.
 * - `refused`: core ANSWERED that the read itself is refused - Lydia's typed refusal
 *   (`PAYMENT_PROVIDER_REFUSED`: an error code, a refusing 4xx, such as a uuid no request carries
 *   under that vendor token, or a blocked Business), or core's own 400 for this row's request.
 *   `providerCode` names it. A status code is an answer: unlike a transport failure, asking again
 *   gets the same one.
 */
export type VerifiedRequestRead =
  | { verification: 'no-key' }
  | { verification: 'refused'; providerCode: string }
  | {
      verification: 'verified' | 'mismatch' | 'unsigned' | 'unknown';
      /** The typed state, or `not-found` for an order_ref no request carries. */
      state: RequestState | 'not-found';
      raw: string;
    };

const VERDICTS: ReadonlySet<string> = new Set(['verified', 'mismatch', 'unsigned']);

/**
 * Asks core-service for a request's state AND the verdict on its signature. `lookup` names the
 * request (`sessionId`, the `request_uuid`, or `orderRef`), `connectAccountId` the Business it was
 * issued to, `expectedAmountCents` the amount the caller's row says it was issued for. A call that
 * got no answer THROWS - no response, a timeout, a 5xx, and a 401/403 (core refusing THIS SERVICE,
 * a configuration fault, not a word about the request): none is a verdict about the request. A 400
 * from core is one, and answers `refused`.
 */
export async function readVerifiedRequestState(
  lookup: { sessionId: string } | { orderRef: string },
  connectAccountId: string,
  expectedAmountCents: number
): Promise<VerifiedRequestRead> {
  let data: { verification?: unknown; state?: unknown; raw?: unknown };
  try {
    ({ data } = await axios.post<{ verification?: unknown; state?: unknown; raw?: unknown }>(
      coreUrl('payments/request-state'),
      { ...lookup, connectAccountId, expectedAmountCents },
      { ...internalCoreRequestConfig(), timeout: VERIFIED_READ_TIMEOUT_MS }
    ));
  } catch (err: unknown) {
    const refused = refusalOf(err);
    if (refused) return { verification: 'refused', providerCode: refused };
    throw err;
  }
  if (data?.verification === 'no-key') return { verification: 'no-key' };
  const verification =
    typeof data?.verification === 'string' && VERDICTS.has(data.verification)
      ? (data.verification as 'verified' | 'mismatch' | 'unsigned')
      : 'unknown';
  const state = data?.state === 'not-found' ? 'not-found' : toRequestState(data?.state);
  return { verification, state, raw: typeof data?.raw === 'string' ? data.raw : '' };
}

/**
 * The code of the refusal core ANSWERED, or null when the call got no answer about the request.
 * Only a 400 is a refusal of the read: core answers its typed provider refusal
 * (`PAYMENT_PROVIDER_REFUSED`, with Lydia's `providerCode`) or its own 400 for a request it will
 * not read. A 401/403 refuses the CALLER (the internal secret) and a 5xx is a fault: both thrown.
 */
function refusalOf(err: unknown): string | null {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (response?.status !== 400) return null;
  const body =
    response.data && typeof response.data === 'object'
      ? (response.data as { code?: unknown; providerCode?: unknown })
      : {};
  if (body.code === PAYMENT_PROVIDER_REFUSED) {
    return typeof body.providerCode === 'string' && body.providerCode
      ? body.providerCode
      : PAYMENT_PROVIDER_REFUSED;
  }
  return 'core-400';
}
