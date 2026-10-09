/**
 * The one transport for a request whose BODY is big: it reports how many bytes have left, can be
 * cancelled, and gives up on SILENCE rather than on a clock (offline-and-weak-network, WP-OFF-8).
 *
 * WHY `fetch` CANNOT BE USED HERE. A `fetch` upload exposes no progress at all - the promise settles
 * when the response head arrives, so a 13 MB file on a poor link is one spinner of unknown length
 * (reported 2026-10-10, iPhone, a 13.4 MB PDF). `XMLHttpRequest.upload.onprogress` is the only
 * browser API that says how much of a request body has been handed to the network, and it is the
 * same engine and the same cookie/CORS rules on every shell this app ships in (browsers, WKWebView,
 * Android WebView), so it is not a second path: it is the one that can be measured.
 *
 * WHAT BOUNDS IT, in two parts that must not be confused. WHILE THE BODY LEAVES: {@link
 * DEFAULT_UPLOAD_IDLE_MS} without a single byte moving. ONCE IT HAS LEFT: the server's processing is
 * NOT silence - a `complete` streams up to 100 MB to storage with nothing moving on the wire, and
 * abandoning it at 45 s made the client retry while the server finished - so the wait for the answer
 * has its own, much longer bound ({@link DEFAULT_UPLOAD_ANSWER_MS}), and its expiry is a typed
 * transport failure, never a signal that anything was NOT stored. NEVER A TOTAL: a 50 MB file on a 50 kbit/s link legitimately
 * takes seven minutes, and a total deadline would abandon it for being big - the failure that
 * `mls-client/progressDeadline.ts` and `requestDeadline.ts` already refuse. A stall is typed
 * ({@link UploadStalledError}, a `RequestDeadlineError`, so `isTransportFailure` reads it by TYPE
 * and it can never be mistaken for an answer or log anyone out).
 */

import { RequestDeadlineError } from '$lib/utils/requestDeadline';

/** Bytes handed to the network so far, out of the whole body. `total` is 0 when it is unknown. */
export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * How long an upload may go without ONE byte of progress before it is abandoned as stalled.
 *
 * 45 s: the TCP retransmission backoff of a link that has actually died passes 30 s within two
 * attempts, while a link that is merely slow (the measured 2G-like profile moves 6 kB/s) still
 * reports progress every few hundred milliseconds. Eight times the 2G-like RTT would be 6 s, so
 * 45 s leaves a long margin for a radio handover and still ends a dead socket in under a minute.
 */
export const DEFAULT_UPLOAD_IDLE_MS = 45_000;

/**
 * How long the server may take to ANSWER once the whole body has been sent. Five minutes: a chunked
 * `complete` of 100 MB to object storage is the slowest thing the media service does. The route is
 * idempotent (a repeated `complete` returns the same mediaId), so a client that does give up and
 * asks again cannot duplicate the object.
 */
export const DEFAULT_UPLOAD_ANSWER_MS = 300_000;

/** The server took longer than {@link DEFAULT_UPLOAD_ANSWER_MS} to answer a fully sent body. */
export class UploadAnswerTimeoutError extends RequestDeadlineError {
  constructor(answerMs: number, path: string, bodyBytes: number) {
    super('write', answerMs, 'POST', path, bodyBytes);
    this.name = 'UploadAnswerTimeoutError';
  }
}

/** An upload that moved no byte for its idle window. A transport failure, never an answer. */
export class UploadStalledError extends RequestDeadlineError {
  constructor(idleMs: number, path: string, bodyBytes: number) {
    super('write', idleMs, 'POST', path, bodyBytes);
    this.name = 'UploadStalledError';
  }
}

/**
 * The caller cancelled this upload ({@link XhrUploadOptions.signal}). Typed so the outbox can tell
 * "the member pressed cancel" from "the link broke" without reading a sentence.
 */
export class UploadAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('Upload aborted');
    this.name = 'UploadAbortedError';
  }
}

export interface XhrUploadOptions {
  /** Cancels the request; the promise rejects with {@link UploadAbortedError}. */
  signal?: AbortSignal;
  /** Called as bytes leave, and once more with `loaded === total` when the body is fully sent. */
  onProgress?: (progress: UploadProgress) => void;
  /** Overrides {@link DEFAULT_UPLOAD_IDLE_MS}; `0` disables the stall guard. */
  idleMs?: number;
  /** Overrides {@link DEFAULT_UPLOAD_ANSWER_MS}; `0` waits for the answer without a bound. */
  answerMs?: number;
}

/** What the transport needs of a request: no `RequestInit` fields it cannot honour. */
export interface XhrUploadInit {
  method?: string;
  headers?: Record<string, string>;
  body?: FormData | Blob | string | null;
}

/** Size of a body for the stall error's log line; unknown shapes count as zero. */
function sizeOf(body: XhrUploadInit['body']): number {
  if (body == null) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob) return body.size;
  let total = 0;
  for (const value of body.values()) total += typeof value === 'string' ? value.length : value.size;
  return total;
}

/**
 * Sends one request and resolves with a real `Response`, so a caller written against `fetch` reads
 * `ok`, `status` and the body unchanged.
 *
 * A network error rejects with a `TypeError` (what `fetch` throws, and what `isTransportFailure`
 * already reads); a stall with {@link UploadStalledError}; a cancel with {@link UploadAbortedError}.
 */
export function xhrUpload(
  url: string,
  init: XhrUploadInit,
  opts: XhrUploadOptions = {}
): Promise<Response> {
  const {
    signal,
    onProgress,
    idleMs = DEFAULT_UPLOAD_IDLE_MS,
    answerMs = DEFAULT_UPLOAD_ANSWER_MS,
  } = opts;
  const where = url.replace(/^https?:\/\/[^/]+/, '');
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError(signal.reason));
      return;
    }
    const xhr = new XMLHttpRequest();
    let idle: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    /** True once the whole body has left: from then on silence is the server working, not a stall. */
    let bodySent = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    /** The body is out; wait for the answer under its own, longer bound. */
    const awaitAnswer = () => {
      bodySent = true;
      if (idle) clearTimeout(idle);
      idle = null;
      if (answerMs <= 0 || settled) return;
      idle = setTimeout(() => {
        console.warn(`[upload] ${where}: no answer ${answerMs} ms after the body was sent`);
        finish(() => {
          xhr.abort();
          reject(new UploadAnswerTimeoutError(answerMs, where, sizeOf(init.body)));
        });
      }, answerMs);
    };
    /** Every sign of life while the body leaves pushes the stall deadline out. */
    const touch = () => {
      if (bodySent || idleMs <= 0 || settled) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        console.warn(`[upload] ${where}: no byte moved for ${idleMs} ms - abandoning as stalled`);
        finish(() => {
          xhr.abort();
          reject(new UploadStalledError(idleMs, where, sizeOf(init.body)));
        });
      }, idleMs);
    };
    function onAbort() {
      console.debug(`[upload] ${where}: cancelled by the caller`);
      finish(() => {
        xhr.abort();
        reject(new UploadAbortedError(signal?.reason));
      });
    }

    xhr.open(init.method ?? 'POST', url);
    for (const [name, value] of Object.entries(init.headers ?? {}))
      xhr.setRequestHeader(name, value);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      touch();
      onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
    };
    // The body is fully handed over: what remains is the server's work, not silence.
    xhr.upload.onload = () => awaitAnswer();
    xhr.onload = () =>
      finish(() => {
        // `Response` refuses a body for a null-body status; an upload never gets one, but a 204
        // from a proxy must not throw here.
        const nullBody = xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
        // The Content-Type is carried so a caller can tell the application's JSON answer from a
        // gateway's HTML page (a WAF's ban page) by HEADER, never by reading prose.
        const contentType = xhr.getResponseHeader('Content-Type');
        resolve(
          new Response(nullBody ? null : xhr.responseText, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers: contentType ? { 'Content-Type': contentType } : undefined,
          })
        );
      });
    xhr.onerror = () =>
      finish(() => {
        console.warn(`[upload] ${where}: network error`);
        reject(new TypeError(`Network request failed: POST ${where}`));
      });
    xhr.ontimeout = xhr.onerror;
    signal?.addEventListener('abort', onAbort, { once: true });

    // A request with no body has nothing to send: it is already waiting for the answer.
    if (sizeOf(init.body) === 0) awaitAnswer();
    else touch();
    xhr.send(init.body ?? null);
  });
}
