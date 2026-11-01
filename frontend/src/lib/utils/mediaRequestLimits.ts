/**
 * THE LARGEST REQUEST BODY THE PRODUCTION HOST ACCEPTS, and the budget every upload stays under.
 *
 * MEASURED 2026-10-10 (a 13.4 MB PDF that never went up for one user, whatever his connection): the
 * school-managed WAF in front of the HOST proxy (not ours) drops ANY request body over 10 MiB, and
 * the client reads back a 403 with an HTML ban page instead of the gateway's JSON. The
 * evidence, the owed question to the host admins and the consequences are in
 * docs/wiki/infrastructure/host-waf-body-limit.md.
 *
 * So a body is NEVER allowed to approach it: {@link MEDIA_REQUEST_BODY_BUDGET_BYTES} is both the
 * largest single-request upload and the size of one chunk, which leaves ~2 MiB for the multipart
 * envelope (a few hundred bytes) and any proxy framing. Raise it only after the host's limit is
 * raised AND re-measured - never because a unit test passes.
 */

import { m } from '$lib/paraglide/messages';

/** What the host WAF drops: 10 MiB. A request at or above this never reaches the application. */
export const GATEWAY_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * The most ciphertext one request carries: a whole small upload, or one chunk of a big one. 8 MiB
 * leaves 2 MiB of margin under {@link GATEWAY_MAX_BODY_BYTES} for the multipart envelope.
 */
export const MEDIA_REQUEST_BODY_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * Size of a request body in bytes (a `FormData` is the sum of its parts), or `Infinity` for a body
 * whose size cannot be known (a stream): unknown is treated as over budget, never as zero.
 */
export function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
  if (body instanceof FormData) {
    let total = 0;
    for (const [name, value] of body.entries()) {
      total +=
        new Blob([name]).size + (typeof value === 'string' ? new Blob([value]).size : value.size);
    }
    return total;
  }
  // A stream, or any shape this cannot measure, FAILS CLOSED: infinitely large is over every budget,
  // so the guard refuses it rather than waving through a body nobody counted.
  return Number.POSITIVE_INFINITY;
}

/**
 * A request this client refuses to build because its body would exceed
 * {@link MEDIA_REQUEST_BODY_BUDGET_BYTES}. Typed so a caller shows `message` (already localised)
 * instead of its generic failure line: the file is the cause, and retrying cannot change it.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limitBytes: number
  ) {
    super(
      m.chat_media_too_large({
        size: (bytes / (1024 * 1024)).toFixed(1),
        limit: String(Math.floor(limitBytes / (1024 * 1024))),
      })
    );
    this.name = 'RequestBodyTooLargeError';
  }
}

/**
 * Refuses, BEFORE any byte leaves, a single-request body over the 8 MiB budget - for the uploads
 * that have no chunk route (association vault document, raw images). The host WAF would answer a
 * 403 ban page after the whole body was sent (docs/wiki/infrastructure/host-waf-body-limit.md).
 *
 * @throws RequestBodyTooLargeError when the body is over budget or of unknown size.
 */
export function assertWithinRequestBudget(body: BodyInit): void {
  const bytes = requestBodyBytes(body);
  if (bytes > MEDIA_REQUEST_BODY_BUDGET_BYTES) {
    console.warn(
      `[media] refusing a ${bytes}-byte body: over the ${MEDIA_REQUEST_BODY_BUDGET_BYTES}-byte request budget`
    );
    throw new RequestBodyTooLargeError(bytes, MEDIA_REQUEST_BODY_BUDGET_BYTES);
  }
}

/**
 * The text to show for a failed upload: the localised size refusal when the file is the cause,
 * otherwise the caller's own line.
 */
export function uploadFailureText(err: unknown, generic: string): string {
  return err instanceof RequestBodyTooLargeError ? err.message : generic;
}
