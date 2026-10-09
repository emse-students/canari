/**
 * THE LARGEST REQUEST BODY THE PRODUCTION HOST ACCEPTS, and the budget every upload stays under.
 *
 * MEASURED 2026-10-10 (a 13.4 MB PDF that never went up for one user, whatever his connection): the
 * school-managed CrowdSec AppSec in the HOST nginx (`/etc/nginx/conf.d/crowdsec_nginx.conf`, not
 * ours) drops ANY request body over 10 MiB - `request body exceeds limit 10485760 bytes, will drop
 * request` - and the client reads back a 403 with a `<title>CrowdSec Ban</title>` HTML page. The
 * evidence, the owed question to the host admins and the consequences are in
 * docs/wiki/infrastructure/host-waf-body-limit.md.
 *
 * So a body is NEVER allowed to approach it: {@link MEDIA_REQUEST_BODY_BUDGET_BYTES} is both the
 * largest single-request upload and the size of one chunk, which leaves ~2 MiB for the multipart
 * envelope (a few hundred bytes) and any proxy framing. Raise it only after the host's limit is
 * raised AND re-measured - never because a unit test passes.
 */

/** What the host WAF drops: 10 MiB. A request at or above this never reaches the application. */
export const GATEWAY_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * The most ciphertext one request carries: a whole small upload, or one chunk of a big one. 8 MiB
 * leaves 2 MiB of margin under {@link GATEWAY_MAX_BODY_BYTES} for the multipart envelope.
 */
export const MEDIA_REQUEST_BODY_BUDGET_BYTES = 8 * 1024 * 1024;

/** Best-effort size of a request body in bytes (a `FormData` is the sum of its parts). */
export function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const [name, value] of body.entries()) {
      total += name.length + (typeof value === 'string' ? value.length : value.size);
    }
    return total;
  }
  return 0;
}
