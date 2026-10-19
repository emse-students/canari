import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../common/redis';
import { LIVE_SEAT_LEASE_MS, LIVE_VIEWER_CAP } from './live.constants';

/**
 * The one Redis key holding every seat of every live on this estate: a sorted set whose member is
 * `<liveId>:<viewerId>` and whose score is the Redis clock (ms) of the seat's last renewal. ONE set
 * for all lives because the cap is the host's uplink, which every live shares.
 */
export const LIVE_SEATS_KEY = 'live:seats';

/**
 * TAKE OR RENEW ONE SEAT, ATOMICALLY - the check and the write are one script, so two instances
 * (a rolling deploy runs two) can never both see seat 24 free and both take it.
 *
 * KEYS[1] the seats set; ARGV[1] the member; ARGV[2] the cap; ARGV[3] the lease in ms.
 * Reply `{granted (1|0), seated}`. The clock is REDIS's (`TIME`), read once here, so every renewal
 * and every expiry is compared on one clock whatever instance wrote it.
 */
export const TAKE_SEAT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lease = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - lease)
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
local seated = redis.call('ZCARD', KEYS[1])
if (not held) and seated >= tonumber(ARGV[2]) then
  return {0, seated}
end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], lease)
if held then return {1, seated} end
return {1, seated + 1}
`;

/** Gives one seat back. KEYS[1] the seats set; ARGV[1] the member. Reply: 1 if it was held. */
export const RELEASE_SEAT_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/** The seat member of one viewer on one live. */
export const seatMember = (liveId: string, viewerId: string): string => `${liveId}:${viewerId}`;

/**
 * THE HOST'S VIEWER CAP (WP-L4, docs/wiki/services/lives.md "The viewer cap"): at most
 * {@link LIVE_VIEWER_CAP} viewers across every live at once, each holding a SEAT taken at the key
 * read and renewed by every manifest poll, released by `DELETE /api/lives/:id/seat` or after
 * {@link LIVE_SEAT_LEASE_MS} without a poll.
 *
 * Refusals are TYPED, never prose: 503 `LIVE_FULL` (with `viewerCap`) is the "live complet" screen;
 * 503 `LIVE_SEATS_UNAVAILABLE` is Redis not answering - not a full live, and the client must not
 * show it as one. Redis down refuses rather than seats everybody: an uncounted audience is exactly
 * the uplink overrun the cap exists to prevent.
 */
@Injectable()
export class LiveSeats {
  private readonly logger = new Logger(LiveSeats.name);

  constructor(private readonly redis: RedisService) {}

  /** Takes or renews the viewer's seat on the live; throws 503 `LIVE_FULL` when none is left. */
  async take(liveId: string, viewerId: string): Promise<void> {
    let reply: unknown;
    try {
      reply = await this.redis.evalScript(
        TAKE_SEAT_LUA,
        [LIVE_SEATS_KEY],
        [seatMember(liveId, viewerId), LIVE_VIEWER_CAP, LIVE_SEAT_LEASE_MS]
      );
    } catch (e) {
      this.logger.error(`[LIVE_SEAT] ${liveId}: the seat count did not answer: ${String(e)}`);
      throw new ServiceUnavailableException({ code: 'LIVE_SEATS_UNAVAILABLE' });
    }
    const [granted, seated] = Array.isArray(reply) ? reply.map(Number) : [NaN, NaN];
    if (granted === 1) {
      this.logger.debug(`[LIVE_SEAT] ${liveId}: seat held, ${seated}/${LIVE_VIEWER_CAP} seated`);
      return;
    }
    if (granted === 0) {
      this.logger.log(`[LIVE_SEAT] ${liveId}: FULL, ${seated}/${LIVE_VIEWER_CAP} seated - refused`);
      throw new ServiceUnavailableException({ code: 'LIVE_FULL', viewerCap: LIVE_VIEWER_CAP });
    }
    this.logger.error(`[LIVE_SEAT] ${liveId}: unreadable reply ${JSON.stringify(reply)}`);
    throw new ServiceUnavailableException({ code: 'LIVE_SEATS_UNAVAILABLE' });
  }

  /** Gives the viewer's seat on the live back. Idempotent; throws 503 when Redis does not answer. */
  async release(liveId: string, viewerId: string): Promise<void> {
    try {
      const was = await this.redis.evalScript(
        RELEASE_SEAT_LUA,
        [LIVE_SEATS_KEY],
        [seatMember(liveId, viewerId)]
      );
      this.logger.debug(`[LIVE_SEAT] ${liveId}: seat released (held=${String(was)})`);
    } catch (e) {
      this.logger.error(`[LIVE_SEAT] ${liveId}: the seat release did not answer: ${String(e)}`);
      throw new ServiceUnavailableException({ code: 'LIVE_SEATS_UNAVAILABLE' });
    }
  }
}
