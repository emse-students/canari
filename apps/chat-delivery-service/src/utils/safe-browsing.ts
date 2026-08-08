import { Logger } from '@nestjs/common';

const logger = new Logger('SafeBrowsing');

const SAFE_BROWSING_ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const SAFE_BROWSING_TIMEOUT_MS = 3000;

/**
 * Google's Lookup API gives no cache guidance for a CLEAN result - only a flagged match carries
 * a `cacheDuration`. This is our own, conservative choice for how long "not flagged" may be
 * trusted before asking again.
 */
const CLEAN_VERDICT_TTL_MS = 30 * 60 * 1000;

/**
 * How long a FAILED lookup (missing key, network error, timeout, non-2xx) is remembered, distinct
 * from a genuine clean verdict - short, so a transient outage or a misconfigured key self-heals
 * on the next request rather than silently disabling the check for as long as a real answer would be.
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

export interface SafeBrowsingVerdict {
  /** True only when Google's Lookup API returned at least one threat match. */
  flagged: boolean;
  /** How long this verdict may be cached. */
  cacheTtlMs: number;
}

interface ThreatMatchesResponse {
  matches?: Array<{ cacheDuration?: string }>;
}

/**
 * Checks a URL against Google Safe Browsing's Lookup API (threatMatches:find).
 *
 * Fails OPEN: a missing key, a network error, a timeout or a non-2xx response all resolve to
 * "not flagged" - a safety check that is unreachable must never become an outage for every link
 * in the app (WP-SAFELINK-1). No SSRF guard is needed here: unlike the link-preview fetch, the
 * target of this request is Google's own fixed endpoint, never the caller-supplied URL - that
 * URL only ever appears as a JSON string in the POST body.
 */
export async function checkSafeBrowsing(url: string): Promise<SafeBrowsingVerdict> {
  const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY?.trim();
  if (!apiKey) {
    return { flagged: false, cacheTtlMs: FAILURE_TTL_MS };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), SAFE_BROWSING_TIMEOUT_MS);

  try {
    const res = await fetch(`${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'canari-emse', clientVersion: '1.0.0' },
        threatInfo: {
          threatTypes: [
            'MALWARE',
            'SOCIAL_ENGINEERING',
            'UNWANTED_SOFTWARE',
            'POTENTIALLY_HARMFUL_APPLICATION',
          ],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
      signal: abortController.signal,
    });

    if (!res.ok) {
      logger.warn(`[SAFE_BROWSING] lookup failed with status ${res.status}`);
      return { flagged: false, cacheTtlMs: FAILURE_TTL_MS };
    }

    const data = (await res.json()) as ThreatMatchesResponse;
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      return { flagged: false, cacheTtlMs: CLEAN_VERDICT_TTL_MS };
    }

    // cacheDuration looks like "300s" - the longest one wins so a URL flagged by several lists
    // at once is not re-checked before the strictest of them expects.
    const seconds = Math.max(...matches.map((m) => parseInt(m.cacheDuration ?? '', 10) || 300));
    return { flagged: true, cacheTtlMs: seconds * 1000 };
  } catch (error) {
    logger.warn(`[SAFE_BROWSING] lookup error: ${String(error)}`);
    return { flagged: false, cacheTtlMs: FAILURE_TTL_MS };
  } finally {
    clearTimeout(timeout);
  }
}
