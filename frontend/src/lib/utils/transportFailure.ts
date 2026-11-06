/**
 * THE ONE ANSWER TO "DID THIS REQUEST GET AN ANSWER?", decided at the throw and read by type.
 *
 * **A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT.** The `fetch` contract gives a transport
 * failure exactly one shape: a `TypeError` (`Failed to fetch`, `Load failed`, `NetworkError ...`
 * depending on the engine), with no status because nobody answered. Tauri's `plugin-http` does NOT
 * honour that contract: its `fetch` rejects with whatever its Rust side returned - a bare STRING,
 * `error sending request for url (...)` from reqwest - and with `Error('Request cancelled')` for an
 * aborted request. Neither is a `TypeError`, so every consumer that read the type read a network
 * failure on Android and iOS as something final.
 *
 * Measured on the Mi 9T (`v1.2.7-alpha.1`, 2026-10-14, device-verification): after an OFFLINE START,
 * the `online` event's community listing got the reqwest string, `isRetryableLoadError` called it
 * `non-retryable`, and for 2.5 min - online, socket connected - the community rail was empty and
 * every salon send was refused `listing-failed`. The same string also never told the connectivity
 * store the server was unreachable, so no reconnect was ever announced for it.
 *
 * So the plugin's rejection is made to honour the contract WHERE IT IS RAISED
 * ({@link conformPluginFetch}, the one wrapper both Tauri entry points use), and every consumer asks
 * {@link isTransportFailure} - the one predicate - instead of testing a type or a sentence of its own.
 */

import { RequestDeadlineError } from '$lib/utils/requestDeadline';

/**
 * A request that got NO ANSWER: the transport failed before any status came back.
 *
 * A `TypeError` on purpose: that is what the `fetch` contract throws for exactly this case, so code
 * written against the browser's `fetch` reads it correctly without knowing this class exists. The
 * raw rejection is kept in `cause` for the log - never for a decision.
 */
export class TransportFailureError extends TypeError {
  constructor(
    readonly cause: unknown,
    message = `request got no answer: ${String(cause)}`
  ) {
    super(message);
    this.name = 'TransportFailureError';
  }
}

/**
 * True when `error` is the ABSENCE of an answer rather than an answer: a {@link TransportFailureError}
 * (and every class extending it: `DeliveryUnreachableError`, `UploadNetworkError`, `NotFromApiError` -
 * a 2xx a captive portal answered in the API's place, `apiJson.ts`) or a deadline that
 * expired before the response head ({@link RequestDeadlineError}).
 *
 * Decided by TYPE ONLY, and by the NARROW type. A bare `TypeError` is NOT a transport failure: a
 * programming error (`cannot read properties of undefined`) is one too, and a `try` around a request
 * would read it as "no answer" and retry or hold it for ever. The browser's own `fetch` rejection is
 * typed at the place it is raised ({@link conformNativeFetch}, {@link conformPluginFetch},
 * `trackedFetch`), so a `fetch` that bypasses all three would reject with a bare `TypeError` this
 * predicate no longer reads. It used to match `/network|failed to fetch|.../` against the message,
 * then any `TypeError`; both read a sentence or a base class instead of a decision made at the throw.
 */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof TransportFailureError || error instanceof RequestDeadlineError;
}

/**
 * The refresh endpoint ANSWERED, and the answer was not a token.
 *
 * THE MIRROR OF `SessionExpiredError` (`stores/auth.ts`), and the pair is the whole point: only the
 * APP's own 401/403 proves the refresh cookie dead, because a 502 while the backend restarts during a
 * deploy is a hiccup and logging the user out for it costs a full OIDC round trip. That care was
 * spent at the throw and then lost one frame later - the other half arrived as a bare
 * `new Error('Token refresh failed (HTTP 502)')`, and every caller that wanted to know which of the
 * two it held had to read the sentence and find the digits in it. So the status travels as a FIELD.
 *
 * THE BASE, NOT THE VERDICT. Thrown as itself only for an APP-origin 4xx other than 401/403/408/429
 * (a 404 or a 410 in Nest's envelope: the endpoint refuses the request outright and no retry changes
 * that - the boot sends such a user to login, as before). Every answer that is NOT a verdict is the
 * subclass {@link TransientAnswerError}. The two readers split on that line: `useChannelWorkspaces`
 * asks again only on the TRANSIENT subclass (a verdict is asked again for nothing), while
 * `mlsDeliveryApi` wraps the BASE after a delivery 401 as a definitive `DeliveryRenewalFailedError` -
 * the guard's 401 proved the request did nothing, whatever the refresh answered, and an unwrapped app
 * 4xx left a commit's stage unknown. It lives here, beside its subclass, so the boot's predicate
 * ({@link isSessionQuestionOpen}) reads a type without importing the auth store, which re-exports it.
 */
export class RefreshFailedError extends Error {
  constructor(
    /** The HTTP status the refresh endpoint answered with. Never an app 401 or 403 - those are the sibling. */
    readonly status: number,
    message = `Token refresh failed (HTTP ${status})`
  ) {
    super(message);
    this.name = 'RefreshFailedError';
  }
}

/**
 * The refresh endpoint got an answer that is NOT A VERDICT on the session, classified at the throw
 * (`refresh` in `stores/auth.ts`) from the status and from WHO answered (`refusalOrigin`), never from
 * a sentence. Exactly this population:
 * - a 5xx, whoever wrote it (a backend restarting, the edge's 502, core-service's 503 `MAINTENANCE`);
 * - a 408 or a 429 (a proxy timed the request out, or it was rate-limited: ask again later);
 * - any other status written by the EDGE rather than the app (a WAF ban page or a portal's HTML 403,
 *   a JSON block page that is none of our envelopes).
 *
 * None of these touches the credential, so the boot reads them like a transport failure: "you are
 * signed out" would be a lie. `status` and `code` travel as FIELDS so the boot screen can say which
 * one it is (the network path, the server, a maintenance) without reading a sentence.
 */
export class TransientAnswerError extends RefreshFailedError {
  constructor(
    status: number,
    /**
     * The `code` of a JSON-typed body (`{ code, message }`: core-service's 503 `MAINTENANCE`), else
     * null. Read for WORDING only, so the content type is proof enough (`responseOrigin`).
     */
    readonly code: string | null = null,
    /**
     * The OPERATOR's maintenance text (`maintenanceMessage` of the 503 `MAINTENANCE` body), or null
     * when there is none - the screen then words the default in the user's language. Never the
     * body's `message`, which falls back to an English default the client cannot tell apart.
     */
    readonly maintenanceMessage: string | null = null
  ) {
    super(status, `Token refresh answered ${status}${code ? ` (${code})` : ''} - not a verdict`);
    this.name = 'TransientAnswerError';
  }
}

/**
 * True when the session question stays OPEN after `error`: nobody answered
 * ({@link isTransportFailure}) or the answer was not a verdict ({@link TransientAnswerError}). The
 * app's own 401/403 (`SessionExpiredError`) and an app-origin 4xx ({@link RefreshFailedError} itself)
 * close it.
 */
export function isSessionQuestionOpen(error: unknown): boolean {
  return isTransportFailure(error) || error instanceof TransientAnswerError;
}

/** Whether a `fetch` call was aborted by the caller's own signal (on `init` or on a `Request`). */
function abortedSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  const signal =
    init?.signal ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  return signal?.aborted ? signal : null;
}

/**
 * The WebView's / browser's own `fetch`, with its transport rejection typed at the throw.
 *
 * The contract gives a transport failure exactly one shape, a bare `TypeError` (`Failed to fetch`,
 * `Load failed`), indistinguishable from a programming `TypeError`. It becomes a
 * {@link TransportFailureError} here so {@link isTransportFailure} can ask for THAT type. An aborted
 * request keeps the signal's own reason, and every other rejection passes through untouched.
 *
 * Installed as `window.fetch` on the web and as the native branch of `createRoutedFetch` on Tauri, so
 * every bare `fetch(...)` in the app is covered by this one wrapper. One limit: the engine also throws
 * a `TypeError` for a deterministic refusal (an invalid URL, a forbidden header value), typed as a
 * transport failure too - the raw sentence in `cause` names it in the log. A BODY read that loses the
 * link still rejects `res.json()` with the engine's bare `TypeError`, which is NOT read as transport.
 */
export function conformNativeFetch(native: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await native(input, init);
    } catch (raw) {
      if (
        raw instanceof TypeError &&
        !(raw instanceof TransportFailureError) &&
        !abortedSignal(input, init)
      ) {
        throw new TransportFailureError(raw);
      }
      throw raw;
    }
  }) as typeof fetch;
}

/**
 * Tauri `plugin-http`'s `fetch`, made to reject the way the `fetch` contract says:
 *
 * - an ABORTED request rejects with the signal's `reason` (an `AbortError` `DOMException` unless the
 *   caller chose another) - the plugin throws `Error('Request cancelled')`, which nothing reads as a
 *   cancellation;
 * - EVERY OTHER rejection is a {@link TransportFailureError}: the plugin rejects only when no HTTP
 *   answer came back (no route, DNS, a reset socket), since an answered request - any status -
 *   resolves with a `Response`. That includes the plugin's DETERMINISTIC refusals (a URL outside the
 *   scope, an invalid header value, an unsupported scheme): no answer either, but no link will ever
 *   lift them. The plugin hands over only a string, so they are not told apart here; the raw
 *   sentence in `cause` is what names them in the log.
 *
 * Used by BOTH places that hand the plugin to the app - the `window.fetch` override in
 * `hooks.client.ts` (through `createRoutedFetch`) and `TauriMlsService`'s delivery client - so no
 * Tauri `fetch` CALL rejects with the raw shape. READING THE BODY is not covered: a link lost after
 * the head, or an abort during the body, still rejects `res.json()` / `res.text()` with the
 * plugin's bare string (`controller.error(...)` in its `ReadableStream`), where a browser throws a
 * `TypeError` / `AbortError`.
 */
export function conformPluginFetch(plugin: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await plugin(input, init);
    } catch (raw) {
      const aborted = abortedSignal(input, init);
      if (aborted) {
        // An engine without `AbortSignal.reason` (an old Android System WebView) leaves it
        // undefined; the contract's default reason is this exact DOMException.
        throw aborted.reason !== undefined
          ? aborted.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      }
      if (raw instanceof TransportFailureError) throw raw;
      // Not logged here: nothing is swallowed, and the caller's own failure line carries the raw
      // sentence through `cause` - one line per failure, not two.
      throw new TransportFailureError(raw);
    }
  }) as typeof fetch;
}
