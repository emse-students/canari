import axios from 'axios';
import { coreUrl } from '../internal/service-urls';
import { internalCoreRequestConfig } from '../internal/core-request';
import { toRequestState, type RequestState } from './seat-hold';

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
 */
export type VerifiedRequestRead =
  | { verification: 'no-key' }
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
 * issued to, `expectedAmountCents` the amount the caller's row says it was issued for. A failed
 * call THROWS: an unreachable core or Lydia is not a verdict about the request.
 */
export async function readVerifiedRequestState(
  lookup: { sessionId: string } | { orderRef: string },
  connectAccountId: string,
  expectedAmountCents: number
): Promise<VerifiedRequestRead> {
  const { data } = await axios.post<{ verification?: unknown; state?: unknown; raw?: unknown }>(
    coreUrl('payments/request-state'),
    { ...lookup, connectAccountId, expectedAmountCents },
    { ...internalCoreRequestConfig(), timeout: VERIFIED_READ_TIMEOUT_MS }
  );
  if (data?.verification === 'no-key') return { verification: 'no-key' };
  const verification =
    typeof data?.verification === 'string' && VERDICTS.has(data.verification)
      ? (data.verification as 'verified' | 'mismatch' | 'unsigned')
      : 'unknown';
  const state = data?.state === 'not-found' ? 'not-found' : toRequestState(data?.state);
  return { verification, state, raw: typeof data?.raw === 'string' ? data.raw : '' };
}
