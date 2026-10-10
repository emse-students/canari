import { UploadAnswerTimeoutError } from '$lib/utils/uploadXhr';

/** Time granted to any upload for the server to answer once its body is fully sent. */
export const UPLOAD_ANSWER_BASE_MS = 30_000;

/**
 * The slowest sustained upload rate the deadline tolerates: 16 KiB/s (~128 kbit/s). Below it a
 * member's own link is the cause and the transfer is not worth waiting for either.
 */
export const UPLOAD_MIN_BYTES_PER_SECOND = 16 * 1024;

/**
 * The byte length of an upload body, or 0 when it cannot be known without reading it.
 * `FormData` counts its blob parts; a string counts as UTF-16 code units (an upper bound is enough).
 */
export function uploadBodyBytes(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const [, value] of body.entries())
      total += typeof value === 'string' ? value.length : value.size;
    return total;
  }
  return 0;
}

/**
 * How long an upload of `bytes` may take before it is declared stalled: a fixed answer allowance
 * plus the time the body needs at {@link UPLOAD_MIN_BYTES_PER_SECOND}. A function of the SIZE, so
 * the same request always gets the same deadline - nothing here is tuned to an incident.
 */
export function uploadDeadlineMs(bytes: number): number {
  return UPLOAD_ANSWER_BASE_MS + Math.ceil((bytes / UPLOAD_MIN_BYTES_PER_SECOND) * 1000);
}

/**
 * `fetch` for an upload that can NEVER wait for ever.
 *
 * A native `fetch` that pushes a body into a proxy which refuses it early (an nginx
 * `client_max_body_size` answering 413 and closing while the client still writes) can see the
 * connection reset or the answer lost instead of reading the 413, and then neither resolves nor
 * rejects in a bounded time. The request is aborted after {@link uploadDeadlineMs} and surfaces as
 * a typed {@link UploadAnswerTimeoutError}, so a caller classifies it by TYPE.
 *
 * `AbortController` and not `AbortSignal.timeout`, which the oldest WKWebView this ships to lacks.
 *
 * @param url   Absolute upload URL.
 * @param init  Request init; its own `signal` is not supported (an upload owns its cancellation).
 * @param send  The `fetch` to use; defaults to the CURRENT global, read at call time.
 */
export async function fetchWithAnswerDeadline(
  url: string,
  init: RequestInit,
  send: typeof fetch = (...args) => fetch(...args)
): Promise<Response> {
  const bytes = uploadBodyBytes(init.body as BodyInit | null | undefined);
  const deadline = uploadDeadlineMs(bytes);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  try {
    return await send(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) {
      console.error(
        `[media] upload to ${url.replace(/^https?:\/\/[^/]+/, '')} unanswered after ${deadline} ms (${bytes} bytes) - aborted`
      );
      throw new UploadAnswerTimeoutError(deadline, url.replace(/^https?:\/\/[^/]+/, ''), bytes);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
