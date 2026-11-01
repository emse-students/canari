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
 * A Lua function counting the members of a list that start with a prefix - how many seats ONE live
 * holds in the one set every live shares. Spliced into the two scripts below that answer a viewer
 * count, so the count is written once. Linear in the set, which the host's cap bounds (24); what has
 * to change when the cap goes is in lives.md, "The viewer count".
 */
const COUNT_PREFIX_LUA = `
local function countPrefix(members, prefix)
  local n = 0
  for _, m in ipairs(members) do
    if string.sub(m, 1, #prefix) == prefix then n = n + 1 end
  end
  return n
end
`;

/**
 * TAKE OR RENEW ONE SEAT, ATOMICALLY - the check and the write are one script, so two instances
 * (a rolling deploy runs two) can never both see seat 24 free and both take it.
 *
 * KEYS[1] the seats set; ARGV[1] the member; ARGV[2] the cap; ARGV[3] the lease in ms; ARGV[4] the
 * live's member prefix `<liveId>:`. Reply `{0, seated}` on a refusal and `{1, seated, watching}` on
 * a grant, `watching` being the seats THAT live holds with this one counted - the viewer count the
 * manifest carries, read in the same script as the grant so it can never disagree with the cap. The
 * clock is REDIS's (`TIME`), read once here, so every renewal and every expiry is compared on one
 * clock whatever instance wrote it.
 */
export const TAKE_SEAT_LUA = `${COUNT_PREFIX_LUA}
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
local watching = countPrefix(redis.call('ZRANGE', KEYS[1], 0, -1), ARGV[4])
if held then return {1, seated, watching} end
return {1, seated + 1, watching}
`;

/**
 * HOW MANY SEATS ONE LIVE HOLDS, READ ONLY - the broadcaster's viewer count (it takes no seat, so
 * the take above never answers it). KEYS[1] the seats set; ARGV[1] the lease in ms; ARGV[2] the
 * live's member prefix. Counts the seats renewed within the lease on Redis's clock - exactly the
 * ones the take's sweep keeps - and writes nothing.
 */
export const COUNT_LIVE_SEATS_LUA = `${COUNT_PREFIX_LUA}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local after = string.format('(%.0f', now - tonumber(ARGV[1]))
local fresh = redis.call('ZRANGEBYSCORE', KEYS[1], after, '+inf')
return countPrefix(fresh, ARGV[2])
`;

/** Gives one seat back. KEYS[1] the seats set; ARGV[1] the member. Reply: 1 if it was held. */
export const RELEASE_SEAT_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/**
 * Gives back every seat of ONE live (an ended one). KEYS[1] the seats set; ARGV[1] the member prefix
 * `<liveId>:`. Reply: how many went. The set is bounded by the cap (a seat is added only when one is
 * free, and a lapsed one is swept at the next take), so reading it whole is a few dozen members.
 */
export const RELEASE_LIVE_SEATS_LUA = `
local n = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  if string.sub(m, 1, #ARGV[1]) == ARGV[1] then
    redis.call('ZREM', KEYS[1], m)
    n = n + 1
  end
end
return n
`;

/**
 * The seat member of one viewer on one live. The live id is LOWER-CASED: the take is keyed by the
 * row's id (PostgreSQL's spelling), while a leave or a removal carries the id as the client spelled
 * it in the URL, which `ParseUUIDPipe` accepts in upper case - and a release that names another
 * member frees nothing. ONE SEAT PER ACCOUNT, not per device (lives.md, "The viewer cap"): the
 * request carries no device id, and an account is what a removal or a block names.
 */
export const seatMember = (liveId: string, viewerId: string): string =>
  `${liveId.toLowerCase()}:${viewerId}`;

/**
 * THE HOST'S VIEWER CAP (WP-L4, docs/wiki/services/lives.md "The viewer cap"): at most
 * {@link LIVE_VIEWER_CAP} viewers across every live at once, each holding a SEAT taken at the key
 * read and renewed by every manifest poll, released by `DELETE /api/lives/:id/seat` or after
 * {@link LIVE_SEAT_LEASE_MS} without a poll. The same seats are THE VIEWER COUNT of a live (lives.md,
 * "The viewer count"): a number read inside Redis, never the accounts behind it.
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

  /**
   * Takes or renews the viewer's seat on the live and answers how many viewers THAT live has now,
   * this one included (the manifest's `viewers`); throws 503 `LIVE_FULL` when no seat is left.
   */
  async take(liveId: string, viewerId: string): Promise<number> {
    let reply: unknown;
    try {
      reply = await this.redis.evalScript(
        TAKE_SEAT_LUA,
        [LIVE_SEATS_KEY],
        [seatMember(liveId, viewerId), LIVE_VIEWER_CAP, LIVE_SEAT_LEASE_MS, seatMember(liveId, '')]
      );
    } catch (e) {
      this.logger.error(`[LIVE_SEAT] ${liveId}: the seat count did not answer: ${String(e)}`);
      throw new ServiceUnavailableException({ code: 'LIVE_SEATS_UNAVAILABLE' });
    }
    const [granted, seated, watching] = Array.isArray(reply) ? reply.map(Number) : [NaN, NaN];
    // A grant always counts its own seat, so a count below 1 is a reply this code did not write.
    if (granted === 1 && Number.isInteger(watching) && watching >= 1) {
      this.logger.debug(
        `[LIVE_SEAT] ${liveId}: seat held, ${watching} on this live, ${seated}/${LIVE_VIEWER_CAP} seated`
      );
      return watching;
    }
    if (granted === 0) {
      this.logger.log(`[LIVE_SEAT] ${liveId}: FULL, ${seated}/${LIVE_VIEWER_CAP} seated - refused`);
      throw new ServiceUnavailableException({ code: 'LIVE_FULL', viewerCap: LIVE_VIEWER_CAP });
    }
    this.logger.error(`[LIVE_SEAT] ${liveId}: unreadable reply ${JSON.stringify(reply)}`);
    throw new ServiceUnavailableException({ code: 'LIVE_SEATS_UNAVAILABLE' });
  }

  /**
   * How many viewers hold a seat on the live, read without taking one - the BROADCASTER's count (it
   * holds no seat). A COUNT AND NOTHING ELSE: the members are read inside the script and never leave
   * Redis, so no account id reaches this process for it.
   *
   * `null` when Redis does not answer or answers what this code did not write, logged as an `error`:
   * the broadcaster's poll is also its chat, which a display number must not take down - the viewers'
   * own polls already fail closed on the same outage (`LIVE_SEATS_UNAVAILABLE`), so the accusing line
   * is the signal, and the screen shows no number rather than a wrong one.
   *
   * `reader` names who asks, in every line: the broadcaster's poll (`broadcaster`, whose count is
   * logged at debug) or the purge of an ended live (`purge`, whose own line says what it decided, so
   * this one says nothing on success - one line per sweep would be noise).
   */
  async watching(
    liveId: string,
    reader: 'broadcaster' | 'purge' = 'broadcaster'
  ): Promise<number | null> {
    const what = reader === 'purge' ? "the ended live's seat count (purge)" : 'the viewer count';
    let reply: unknown;
    try {
      reply = await this.redis.evalScript(
        COUNT_LIVE_SEATS_LUA,
        [LIVE_SEATS_KEY],
        [LIVE_SEAT_LEASE_MS, seatMember(liveId, '')]
      );
    } catch (e) {
      this.logger.error(`[LIVE_SEAT] ${liveId}: ${what} did not answer: ${String(e)}`);
      return null;
    }
    const count = Number(reply);
    if (!Number.isInteger(count) || count < 0) {
      this.logger.error(
        `[LIVE_SEAT] ${liveId}: ${what}: unreadable reply ${JSON.stringify(reply)}`
      );
      return null;
    }
    if (reader === 'broadcaster') {
      this.logger.debug(`[LIVE_SEAT] ${liveId}: ${count} watching (broadcaster's read)`);
    }
    return count;
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

  /**
   * Gives back every seat of a live CUT or ERASED at once, so the host's cap does not wait a lease
   * for viewers whose next poll is a 410. An ordinary end keeps them: they are what its purge waits
   * for (`LivesService.purgeEnded`). Throws on a Redis failure; the caller logs it and lets the seats
   * lapse.
   */
  async releaseLive(liveId: string): Promise<number> {
    const freed = Number(
      await this.redis.evalScript(
        RELEASE_LIVE_SEATS_LUA,
        [LIVE_SEATS_KEY],
        [seatMember(liveId, '')]
      )
    );
    this.logger.debug(`[LIVE_SEAT] ${liveId}: ended, ${freed} seat(s) given back`);
    return freed;
  }
}
