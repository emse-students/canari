/**
 * The deadline every REST call lives under, and the typed failure its expiry raises.
 *
 * WHY IT EXISTS (offline-and-weak-network, WP-OFF-5). Nothing in the app had a deadline: a request
 * on a dead-but-not-refused link held one of the browser's six connections and the uplink for as
 * long as the engine tolerates, a spinner of unknown length, and the outbox flush awaited its
 * entries one by one so a single stalled POST froze every message queued behind it.
 *
 * A DEADLINE EXPIRY IS A TRANSPORT FAILURE, NEVER AN ANSWER. Nothing came back, so nothing was
 * decided: it never reaches a status check and therefore can never be read as a 401/403 that logs a
 * user out. It is classified AT THE THROW, as {@link RequestDeadlineError}, and `isTransportFailure`
 * recognises it by type - no caller reads a sentence.
 *
 * WHAT THE DEADLINE BOUNDS. The wait for the RESPONSE HEAD only. Once the head is in, the server has
 * answered and what remains is the transfer, which is honest at any size and any speed - the same
 * reasoning as `mls-client/progressDeadline.ts`, whose silence-based timer cannot be used here
 * because `apiFetch` hands the caller a live `Response` rather than a parsed body.
 */

/** What kind of call a request is, which is what picks its deadline. */
export type RequestClass = 'read' | 'write' | 'probe';

/**
 * Per-class head deadline, with the reason for each number.
 *
 * - `read` 20 s. A GET answers in tens of milliseconds on a good link and ~1 s on the measured
 *   2G-like profile (800 ms RTT: a cold TLS connection alone is 3 round trips, ~2.4 s). 20 s is
 *   eight times that, so a read that has not started answering by then is not slow, it is gone.
 * - `write` 30 s base. A write may do server work (a row, a notification fan-out) before it answers,
 *   so it gets half as much again - plus the time its own body needs to LEAVE, see {@link
 *   MIN_UPLINK_BYTES_PER_S}, because the head cannot come back before the body has gone.
 * - `probe` 6 s. A reachability probe asks one cheap question; a longer wait is not information.
 */
export const DEADLINE_MS: Record<RequestClass, number> = {
  read: 20_000,
  write: 30_000,
  probe: 6_000,
};

/**
 * The uplink a body is assumed to have AT LEAST, which turns a fixed deadline into one that scales
 * with what is being sent. 4 kB/s is below the 2G-like profile measured on this page (50 kbit/s =
 * 6.25 kB/s), so a body that crosses a link even that bad is never abandoned for being big: a 1 MiB
 * upload (the edge's cap) gets ~4.5 minutes, a chat message gets its 30 s.
 */
export const MIN_UPLINK_BYTES_PER_S = 4_096;

/**
 * A request abandoned because its response head did not arrive within its deadline.
 *
 * Typed rather than message-matched: it is the one failure that says "the link is alive enough to
 * accept a socket and dead enough to answer nothing", and only the place that armed the deadline
 * knows that. `bodyBytes` and `deadlineMs` travel with it so a log line can separate a deadline that
 * was too tight for a big upload from a server that never answered.
 */
export class RequestDeadlineError extends Error {
  constructor(
    readonly requestClass: RequestClass,
    readonly deadlineMs: number,
    readonly method: string,
    readonly path: string,
    readonly bodyBytes: number
  ) {
    super(
      `${method} ${path} had no response after ${deadlineMs} ms (${requestClass}, ${bodyBytes} body byte(s))`
    );
    this.name = 'RequestDeadlineError';
  }
}

/** Best-effort size of a request body, in bytes. Unknown shapes count as zero (the base deadline). */
export function bodyByteLength(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const value of body.values())
      total += typeof value === 'string' ? value.length : value.size;
    return total;
  }
  return 0;
}

/**
 * The head deadline for a call, in milliseconds. `override` wins (a caller that knows better, e.g.
 * a route that legitimately computes for a while); otherwise the class and the body size decide.
 */
export function deadlineFor(
  requestClass: RequestClass,
  bodyBytes: number,
  override?: number
): number {
  if (override !== undefined) return override;
  return DEADLINE_MS[requestClass] + Math.ceil((bodyBytes / MIN_UPLINK_BYTES_PER_S) * 1000);
}

/** `read` for a side-effect-free method, `write` for the rest. */
export function classOfMethod(method: string): RequestClass {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' ? 'read' : 'write';
}

/**
 * `fetch` under a head deadline. Resolves with the `Response` as soon as its head arrives; rejects
 * with {@link RequestDeadlineError} when `deadlineMs` passes first, and with whatever `fetch`
 * threw otherwise. A caller's own `signal` still cancels - and a cancellation is NOT a deadline.
 *
 * @param fetchImpl `globalThis.fetch` on web, `plugin-http`'s on Tauri.
 * @param deadlineMs `0` or less disables the deadline (a route the caller knows is long-lived).
 */
export async function fetchUnderDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  requestClass: RequestClass,
  deadlineMs: number
): Promise<Response> {
  if (deadlineMs <= 0) return fetchImpl(url, init);

  const ctrl = new AbortController();
  let expired = false;
  const caller = init.signal;
  const onCallerAbort = (): void => ctrl.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    expired = true;
    ctrl.abort();
  }, deadlineMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    // The abort this function raised is indistinguishable from a caller's at the catch site, so
    // the classification is made HERE, where the reason is known, and travels as a type.
    if (expired) {
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      throw new RequestDeadlineError(
        requestClass,
        deadlineMs,
        (init.method ?? 'GET').toUpperCase(),
        path,
        bodyByteLength(init.body)
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  }
}
