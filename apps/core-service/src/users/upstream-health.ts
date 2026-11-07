/**
 * Whether a dependency is KNOWN to be down, as durable state rather than a clock.
 *
 * WHY (2026-11-05): the avatar gallery answered Cloudflare 530 for five hours and every avatar request
 * asked it again and logged again - about 2 000 502s and 4 600 warnings an hour, for an answer nobody
 * could change. The state is written by the failure that proves the outage and cleared by the first
 * answer. While it is set, requests are answered from the state and only a PROBE asks the dependency.
 *
 * ## Probes are spaced by a COUNT of skipped requests, never by a clock
 *
 * "One probe in flight" is not enough: on a fast-failing outage (Cloudflare 530 answers in a few ms,
 * requests arrive every couple of seconds and rarely overlap) the next request would find the slot free
 * and probe again, so nearly every request would still ask. The n-th probe is therefore admitted only
 * after 1, 2, 4, 8 ... (capped at `MAX_PROBE_GAP`) skipped requests, and the gap resets on recovery.
 * Traffic itself is the clock: a busy outage is probed often enough to notice recovery quickly, a quiet
 * one costs nothing, and no timer decides anything.
 *
 * ## What bounds a probe, and who releases it
 *
 * The transport timeout of the caller (axios `timeout`, a socket-inactivity timer) bounds a probe, so
 * the slot cannot stay taken for ever. EVERY path out of `admit()` must reach `recordFailure`,
 * `recordSuccess` or `release` with the admission it was given: only the PROBE's own report frees the
 * slot, so a request admitted as `ask` before the flip that fails late cannot free it under the real
 * probe. A late SUCCESS from an `ask` may still clear the outage: it is real evidence.
 *
 * The only log-worthy moments are the two transitions, returned for the caller to word.
 */

/** What a caller does with the request in hand. */
export type UpstreamAdmission = 'ask' | 'probe' | 'skip';

/** Returned once, by the failure that flips the dependency to down. */
export interface WentDown {
  readonly since: number;
}

/** Returned once, by the success that flips it back: how long and how many requests never left. */
export interface CameBack {
  readonly downForMs: number;
  readonly skipped: number;
}

/** The most skipped requests between two probes. */
export const MAX_PROBE_GAP = 64;

/**
 * Whether a failed call PROVES the dependency is unreachable, or is merely an answer about one
 * request. ONE classifier for every path that talks to the dependency: two paths that disagree write
 * a false outage the moment a single bad request arrives.
 *
 * Only these prove an outage: no HTTP response at all (a timeout or transport error), or a gateway or
 * edge status (502, 503, 504, Cloudflare's 520-530). Every other status - a 400, 404, 410, 429, a 500
 * for one record, a redirect - is the dependency ANSWERING, whatever it said about that id. A local
 * exception (not an HTTP failure at all) is neither: the caller passes `isHttpFailure = false` and
 * gets `local`, which must never flip anything.
 */
export function classifyUpstreamFailure(
  isHttpFailure: boolean,
  status: number | undefined
): 'outage' | 'answer' | 'local' {
  if (!isHttpFailure) return 'local';
  if (status === undefined) return 'outage';
  if (status === 502 || status === 503 || status === 504) return 'outage';
  if (status >= 520 && status <= 530) return 'outage';
  return 'answer';
}

export class UpstreamHealth {
  private downSince: number | null = null;
  private probing = false;
  private skipped = 0;
  private skippedSinceProbe = 0;
  private gap = 1;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while the dependency is known to be down. */
  isDown(): boolean {
    return this.downSince !== null;
  }

  /**
   * Decide what to do with one request: `ask` while the dependency is believed up; once down, `skip`
   * until the gap since the last probe is spent and no probe is in flight, then `probe`.
   */
  admit(): UpstreamAdmission {
    if (this.downSince === null) return 'ask';
    if (!this.probing && this.skippedSinceProbe >= this.gap) {
      this.probing = true;
      this.skippedSinceProbe = 0;
      this.gap = Math.min(this.gap * 2, MAX_PROBE_GAP);
      return 'probe';
    }
    this.skippedSinceProbe += 1;
    this.skipped += 1;
    return 'skip';
  }

  /**
   * The dependency failed to ANSWER (an outage per `classifyUpstreamFailure`). Returns a value only on
   * the flip to down. Only a probe's report frees the probe slot.
   */
  recordFailure(admission: UpstreamAdmission): WentDown | null {
    if (admission === 'probe') this.probing = false;
    if (this.downSince !== null) return null;
    this.downSince = this.now();
    this.skipped = 0;
    this.skippedSinceProbe = 0;
    this.gap = 1;
    return { since: this.downSince };
  }

  /** The dependency ANSWERED, whatever the answer. Returns a value only on the flip back to up. */
  recordSuccess(admission: UpstreamAdmission): CameBack | null {
    if (admission === 'probe') this.probing = false;
    if (this.downSince === null) return null;
    const back = { downForMs: this.now() - this.downSince, skipped: this.skipped };
    this.downSince = null;
    this.skipped = 0;
    this.skippedSinceProbe = 0;
    this.gap = 1;
    return back;
  }

  /** The request ended on a LOCAL fault that says nothing about the dependency: only frees a probe slot. */
  release(admission: UpstreamAdmission): void {
    if (admission === 'probe') this.probing = false;
  }
}
