/**
 * Whether a dependency is KNOWN to be down, as durable state rather than a clock.
 *
 * WHY (2026-11-05): the avatar gallery answered Cloudflare 530 for five hours and every avatar request
 * asked it again and logged again - about 2 000 502s and 4 600 warnings an hour, for an answer nobody
 * could change. The state is written by the failure that proves the outage, cleared by the first
 * success, and in between exactly ONE request at a time (the probe) asks the dependency; every other
 * request is answered from the state. No timer decides anything: a probe is the next request that
 * arrives, so recovery is seen at the first request after it happens, and a quiet period costs nothing.
 *
 * The only moments worth a log line are the two transitions, returned by `recordFailure` and
 * `recordSuccess` for the caller to log with its own wording.
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

export class UpstreamHealth {
  private downSince: number | null = null;
  private probing = false;
  private skipped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while the dependency is known to be down. */
  isDown(): boolean {
    return this.downSince !== null;
  }

  /**
   * Decide what to do with one request. `ask` while the dependency is believed up; once it is down the
   * FIRST caller is the `probe` and the rest `skip` until that probe reports back.
   */
  admit(): UpstreamAdmission {
    if (this.downSince === null) return 'ask';
    if (!this.probing) {
      this.probing = true;
      return 'probe';
    }
    this.skipped += 1;
    return 'skip';
  }

  /** The dependency failed to ANSWER (transport failure, timeout, 5xx). Returns a value only on the flip to down. */
  recordFailure(): WentDown | null {
    this.probing = false;
    if (this.downSince !== null) return null;
    this.downSince = this.now();
    this.skipped = 0;
    return { since: this.downSince };
  }

  /** The dependency ANSWERED, whatever the answer. Returns a value only on the flip back to up. */
  recordSuccess(): CameBack | null {
    this.probing = false;
    if (this.downSince === null) return null;
    const back = { downForMs: this.now() - this.downSince, skipped: this.skipped };
    this.downSince = null;
    this.skipped = 0;
    return back;
  }
}
