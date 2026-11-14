import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';

/**
 * The retention durations media-service stamps (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * `platform_config.retention_chat_reel_days` and `retention_idle_file_days` are owned by core-service
 * (migration 025, moved at `/admin/platform`) and read from the database by social-service;
 * media-service has no database, so it reads them from social-service's internal relay
 * (`GET /api/internal/retention`, `InternalRetentionController`) and HOLDS THEM IN MEMORY
 * ({@link MediaRetentionHolder}): an upload never waits on a network call (lead's decision after the
 * review of #3521 - a chat upload must not depend on social-service being up at that moment).
 *
 * WHEN IT READS - three events, no clock:
 *  - at BOOT (`RetentionBootstrap`), before the routes listen;
 *  - on a NOTICE (`POST /api/media/internal/retention-changed`): core-service sends one when an admin
 *    changes a duration, and social-service one at its own boot - the deploy replaces social-service
 *    AFTER media-service (`depends_on`), so a media-service that booted beside an older social-service
 *    is told as soon as the new one is up;
 *  - on DEMAND, once, when an upload finds nothing held (a failed boot read): that upload is refused
 *    with a 503 the client retries, and the read runs beside it, never in its path.
 * A failed re-read KEEPS the last values and accuses itself with their age. The value in force is
 * stamped on the file's index entry at its upload, so a lowered duration applies to new files only.
 */
export type MediaRetentionDays = {
  /** A CanaReel sent in a conversation (`chat-reel`), from its upload or its chat hold. */
  chatReelDays: number;
  /** A file sent in a conversation (`ephemeral`), from its last download. */
  idleFileDays: number;
};

/** How long the relay may take, in milliseconds: a Docker-network hop, so anything slower is a failure. */
export const RETENTION_RELAY_TIMEOUT_MS = 2_000;

/** Every Nest service in this repo serves its routes under this prefix (each `main.ts`). */
const GLOBAL_PREFIX = 'api';

/** The relay's URL on social-service, the global prefix inserted exactly once (as `livesModeUrl`). */
export function retentionUrl(): string {
  const base = (process.env.SOCIAL_SERVICE_URL ?? 'http://social-service:3014').replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/internal/retention`;
}

/** A whole number of days of at least one, or an error naming the field. */
function wholeDays(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`social-service relayed an unusable ${name}: ${String(value)}`);
  }
  return value;
}

/**
 * The durations social-service reads RIGHT NOW. AN UNREADABLE VALUE IS AN ERROR, NEVER A DEFAULT: an
 * unreachable relay, a non-2xx answer or a timeout throw a 503 whose message names the cause, and a
 * value that is not a positive whole number throws. It logs nothing itself: its one caller, the
 * holder, logs an outage once when it starts and once when it ends (re-review of #3521).
 */
export async function fetchMediaRetention(): Promise<MediaRetentionDays> {
  let res: Response;
  try {
    res = await fetch(retentionUrl(), {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      signal: AbortSignal.timeout(RETENTION_RELAY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ServiceUnavailableException(
      `social-service unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    throw new ServiceUnavailableException(`social-service answered ${res.status}`);
  }
  const body = (await res.json()) as { chatReelDays?: unknown; idleFileDays?: unknown };
  return {
    chatReelDays: wholeDays(body?.chatReelDays, 'chatReelDays'),
    idleFileDays: wholeDays(body?.idleFileDays, 'idleFileDays'),
  };
}

/** Why a read was asked: named in every line it writes. */
export type RetentionReadReason = 'boot' | 'notice' | 'demand';

/**
 * The durations media-service stamps, HELD IN MEMORY (see the file comment for when it reads).
 *
 * `require` is the upload path: synchronous, no network. `refresh` never throws: a success replaces
 * the values, a failure keeps them.
 *
 * A NOTICE NEVER JOINS A READ ALREADY RUNNING (adversarial review of #3554): that read may have asked
 * social-service before the admin's UPDATE committed, and joining it would answer `refreshed: true`
 * with the OLD values. A `notice` (or `boot`) arriving while a read runs gets a FRESH read started
 * after it - one queued read, shared by every notice that arrives before it starts (core's
 * `updateConfig` drops `configInFlight` after its write for the same reason). A `demand` only needs
 * SOME value, so it joins whatever runs.
 *
 * AN OUTAGE IS LOGGED TWICE, by STATE, never per upload (re-review of #3521): the first failed read
 * opens it - WARN naming the age of the values kept, or ERROR when nothing is held and conversation
 * uploads are refused - and the first successful read after it closes it, with its length and how
 * many uploads it refused. Every read and refusal between the two is a debug line.
 */
export class MediaRetentionHolder {
  private held: { values: MediaRetentionDays; readAt: number } | null = null;
  private inFlight: Promise<boolean> | null = null;
  /** When the current run of failed reads began, or null while reads succeed. */
  private outageSince: number | null = null;
  /** The read queued to start after {@link inFlight}, shared by the notices waiting for it. */
  private queued: Promise<boolean> | null = null;
  /** The uploads refused (nothing held) while {@link outageSince} is set; reset by every success. */
  private refusedInOutage = 0;

  constructor(
    private readonly read: () => Promise<MediaRetentionDays>,
    private readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>,
    private readonly now: () => number = Date.now
  ) {}

  /** The values held and when they were read, or null before the first successful read. */
  snapshot(): { values: MediaRetentionDays; readAt: number } | null {
    return this.held;
  }

  /**
   * The durations in force, for an upload. Nothing held is a 503 - the upload is refused before a
   * byte is stored, never stamped with a default - and asks for one read beside it.
   */
  require(): MediaRetentionDays {
    if (this.held) return this.held.values;
    if (this.outageSince !== null) {
      // Inside an outage already logged: counted for its end line, one debug line each.
      this.refusedInOutage += 1;
      this.logger.debug(
        '[RETENTION] no retention durations held (outage): upload refused (503), a read is asked'
      );
    } else {
      // No outage is open - the boot read is still running, or none has failed yet - so nothing
      // has said why a member's upload is refused: this line does.
      this.logger.warn(
        '[RETENTION] no retention durations held yet (first read still running): upload refused (503), a read is asked'
      );
    }
    void this.refresh('demand');
    throw new ServiceUnavailableException();
  }

  /**
   * Reads the durations; resolves true when they were read. Never rejects. A `demand` joins the read
   * running; a `notice` or `boot` gets one that STARTS after this call (see the class comment).
   */
  refresh(reason: RetentionReadReason): Promise<boolean> {
    if (!this.inFlight) return this.start(reason);
    if (reason === 'demand') return this.inFlight;
    this.queued ??= this.inFlight.then(() => {
      this.queued = null;
      return this.start(reason);
    });
    return this.queued;
  }

  private start(reason: RetentionReadReason): Promise<boolean> {
    const read: Promise<boolean> = this.readOnce(reason).finally(() => {
      if (this.inFlight === read) this.inFlight = null;
    });
    this.inFlight = read;
    return read;
  }

  private async readOnce(reason: RetentionReadReason): Promise<boolean> {
    try {
      const values = await this.read();
      const before = this.held?.values;
      this.held = { values, readAt: this.now() };
      if (this.outageSince !== null) {
        this.logger.log(
          `[RETENTION] the retention durations are readable again (${reason}) after ${Math.round((this.now() - this.outageSince) / 1000)} s: ${this.refusedInOutage} upload(s) refused meanwhile`
        );
        this.outageSince = null;
      }
      this.refusedInOutage = 0;
      this.logger.log(
        `[RETENTION] read (${reason}): chat reels ${values.chatReelDays} days, idle files ${values.idleFileDays} days` +
          (before &&
          (before.chatReelDays !== values.chatReelDays ||
            before.idleFileDays !== values.idleFileDays)
            ? ` (was ${before.chatReelDays} and ${before.idleFileDays})`
            : '')
      );
      return true;
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      if (this.outageSince !== null) {
        this.logger.debug(`[RETENTION] read (${reason}) still failing: ${cause}`);
        return false;
      }
      this.outageSince = this.now();
      if (this.held) {
        const ageS = Math.round((this.now() - this.held.readAt) / 1000);
        this.logger.warn(
          `[RETENTION] re-read (${reason}) FAILED (${cause}): uploads keep the values read ${ageS} s ago - chat reels ${this.held.values.chatReelDays} days, idle files ${this.held.values.idleFileDays} days`
        );
      } else {
        this.logger.error(
          `[RETENTION] read (${reason}) FAILED (${cause}) and nothing is held: conversation uploads are refused (503) until a read succeeds - the next notice or upload asks again; logged once until it ends`
        );
      }
      return false;
    }
  }
}

/** THE process's holder: the upload path reads it, the boot and the notice route refresh it. */
export const mediaRetention = new MediaRetentionHolder(
  fetchMediaRetention,
  new Logger('MediaRetention')
);

/** The boot read, awaited before the routes listen (Nest runs this hook before `listen` resolves). */
@Injectable()
export class RetentionBootstrap implements OnApplicationBootstrap {
  async onApplicationBootstrap(): Promise<void> {
    await mediaRetention.refresh('boot');
  }
}
