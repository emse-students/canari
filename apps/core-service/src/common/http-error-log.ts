/**
 * THE ONE WAY A FAILED OUTBOUND HTTP CALL BECOMES A LOG LINE.
 *
 * This file is BYTE-IDENTICAL in core-service and social-service, declared in
 * `.github/scripts/lib/declared-duplicates.mjs` (there is no shared TypeScript package, see
 * docs/wiki/libs.md).
 *
 * WHY IT EXISTS: an `AxiosError` carries its own `config`, and `config.headers` carries the
 * `x-internal-secret` the call authenticated with. Handing the error object to `logger.error(msg, e)`
 * - or leaving it uncaught so Nest's exception filter prints it - wrote that secret into the logs
 * (5 times in 40 minutes on dev, 2026-10-07). The fix is not a redaction pass over the object: NO
 * path may log an axios error, a config, headers or a provider token object wholesale, and this
 * function renders the only four things worth reading - method, URL without its query, status and
 * the provider's own message - so there is nothing to leak.
 *
 * It is duck-typed on purpose (no `axios` import) so the two copies stay identical and cheap.
 */

/** Field names whose VALUE must never reach a log, wherever it turns up in a message string. */
const SECRET_FIELD_RE =
  /(x-internal-secret|api_token_id|api_token|private_token|vendor_token|provider_token|authorization|secret)(["']?\s*[:=]\s*["']?)([^"'\s,;&}]+)/gi;

const MAX_MESSAGE_LENGTH = 300;

interface HttpErrorShape {
  message?: unknown;
  config?: { method?: unknown; url?: unknown; baseURL?: unknown };
  response?: { status?: unknown; data?: unknown };
}

/** Blanks the value of any `secret-ish: value` pair in free text, and bounds its length. */
export function redactSecrets(text: string): string {
  const cleaned = text.replace(SECRET_FIELD_RE, '$1$2[redacted]');
  return cleaned.length > MAX_MESSAGE_LENGTH
    ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}...`
    : cleaned;
}

/** Drops credentials and the query string (where a token may ride) from a URL. */
function safeUrl(config: HttpErrorShape['config']): string {
  const raw = typeof config?.url === 'string' ? config.url : '';
  const base = typeof config?.baseURL === 'string' && !/^https?:/i.test(raw) ? config.baseURL : '';
  const full = `${base}${raw}`;
  return full
    .replace(/^(https?:\/\/)[^/@]*@/i, '$1')
    .split(/[?#]/)[0]
    .trim();
}

/** The provider's own words from a response body, never the body itself. */
function providerMessage(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() || null;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['message', 'error', 'error_description']) {
      const v = d[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('; ');
    }
  }
  return null;
}

/**
 * Renders any caught value for a log line. An HTTP error becomes
 * `METHOD url -> status: provider message`; anything else becomes its `message` (or the string form
 * of a non-Error). Never the object, never headers, never a response body.
 */
export function describeHttpError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err !== 'object') return redactSecrets(String(err));
  const e = err as HttpErrorShape;
  const isHttp = e.response !== undefined || e.config !== undefined;
  if (!isHttp) {
    return redactSecrets(typeof e.message === 'string' ? e.message : 'non-Error value thrown');
  }
  const method = typeof e.config?.method === 'string' ? e.config.method.toUpperCase() : 'HTTP';
  const url = safeUrl(e.config) || '(unknown url)';
  const status = typeof e.response?.status === 'number' ? String(e.response.status) : 'no response';
  const detail =
    providerMessage(e.response?.data) ?? (typeof e.message === 'string' ? e.message : '');
  return redactSecrets(`${method} ${url} -> ${status}${detail ? `: ${detail}` : ''}`);
}
