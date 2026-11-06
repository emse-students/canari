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
 * How long a TRANSIENT failed lookup (missing key, network error, timeout, 5xx) is remembered,
 * distinct from a genuine clean verdict - short, so a transient outage self-heals on the next
 * request rather than silently disabling the check for as long as a real answer would be.
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a CONFIGURATION REFUSAL (401/403) is remembered: one hour. A refusal is an answer,
 * not an outage - it ends only when someone fixes the key or the project, so asking again every
 * 5 minutes would spend quota and log an ERROR per URL for nothing, while a whole day would hide
 * a fix. An hour bounds both.
 */
const REFUSAL_TTL_MS = 60 * 60 * 1000;

/**
 * HTTP statuses that mean Google refused OUR configuration (bad key, API not allowed). A 400 is
 * NOT among them: INVALID_ARGUMENT can be a malformed URL, so it cannot prove the key is bad.
 */
const CONFIGURATION_REFUSAL_STATUSES = new Set([401, 403]);

/**
 * What a lookup came to, decided at the return and never read back from a message:
 * - `answered`: Google answered about the URL (flagged or clean);
 * - `refused`: Google refused our configuration (401/403) - the check is DEAD until fixed;
 * - `unavailable`: network error, timeout, 5xx, 429 (quota) or any other non-2xx - transient, fails open;
 * - `unconfigured`: no API key set, no lookup made.
 */
export type SafeBrowsingVerdictKind = 'answered' | 'refused' | 'unavailable' | 'unconfigured';

export interface SafeBrowsingVerdict {
  /** True only when Google's Lookup API returned at least one threat match. */
  flagged: boolean;
  /** How long this verdict may be cached. */
  cacheTtlMs: number;
  /** What the lookup came to; see {@link SafeBrowsingVerdictKind}. */
  kind: SafeBrowsingVerdictKind;
}

interface ThreatMatchesResponse {
  matches?: Array<{ cacheDuration?: string }>;
}

let refusalsSinceReport = 0;

/**
 * Returns the number of configuration refusals since the last call and resets it. The daily report
 * reads it, so a dead check is found the day it dies rather than by reading logs.
 */
export function takeSafeBrowsingRefusalCount(): number {
  const count = refusalsSinceReport;
  refusalsSinceReport = 0;
  return count;
}

/** Google's error envelope: `{ error: { code, message, status } }`. Best effort, never throws. */
async function readGoogleError(res: Response): Promise<{ status: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: { status?: unknown; message?: unknown } };
    return {
      status: typeof body.error?.status === 'string' ? body.error.status : 'unknown',
      message: typeof body.error?.message === 'string' ? body.error.message : 'unknown',
    };
  } catch {
    return { status: 'unreadable', message: 'unreadable' };
  }
}

/**
 * Checks a URL against Google Safe Browsing's Lookup API (threatMatches:find).
 *
 * Fails OPEN: a missing key, a network error, a timeout or a non-2xx response all resolve to
 * "not flagged" - a safety check that is unreachable must never become an outage for every link
 * in the app (WP-SAFELINK-1). A 401/403 is different in KIND, not in outcome: Google answered
 * and refused our configuration, so it is classified `refused`, logged at ERROR and counted for
 * the daily report, instead of sharing the transient branch's warn and short retry. No SSRF guard
 * is needed here: unlike the link-preview fetch, the target of this request is Google's own fixed
 * endpoint, never the caller-supplied URL - that URL only ever appears as a JSON string in the POST
 * body.
 */
export async function checkSafeBrowsing(url: string): Promise<SafeBrowsingVerdict> {
  const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY?.trim();
  if (!apiKey) {
    return { flagged: false, cacheTtlMs: FAILURE_TTL_MS, kind: 'unconfigured' };
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

    if (CONFIGURATION_REFUSAL_STATUSES.has(res.status)) {
      // The key and the request URL are deliberately absent: only Google's own diagnosis is logged.
      const google = await readGoogleError(res);
      refusalsSinceReport += 1;
      logger.error(
        `[SAFE_BROWSING] configuration refused: http=${res.status} status=${google.status} message=${google.message}`
      );
      return { flagged: false, cacheTtlMs: REFUSAL_TTL_MS, kind: 'refused' };
    }

    if (res.status === 400) {
      // Ambiguous (malformed URL or bad request): ERROR with Google's diagnosis, but transient and uncounted.
      const google = await readGoogleError(res);
      logger.error(
        `[SAFE_BROWSING] lookup rejected: http=400 status=${google.status} message=${google.message}`
      );
      return { flagged: false, cacheTtlMs: FAILURE_TTL_MS, kind: 'unavailable' };
    }

    if (!res.ok) {
      logger.warn(`[SAFE_BROWSING] lookup failed with status ${res.status}`);
      return { flagged: false, cacheTtlMs: FAILURE_TTL_MS, kind: 'unavailable' };
    }

    const data = (await res.json()) as ThreatMatchesResponse;
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      return { flagged: false, cacheTtlMs: CLEAN_VERDICT_TTL_MS, kind: 'answered' };
    }

    // cacheDuration looks like "300s" - the longest one wins so a URL flagged by several lists
    // at once is not re-checked before the strictest of them expects.
    const seconds = Math.max(...matches.map((m) => parseInt(m.cacheDuration ?? '', 10) || 300));
    return { flagged: true, cacheTtlMs: seconds * 1000, kind: 'answered' };
  } catch (error) {
    logger.warn(`[SAFE_BROWSING] lookup error: ${String(error)}`);
    return { flagged: false, cacheTtlMs: FAILURE_TTL_MS, kind: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
