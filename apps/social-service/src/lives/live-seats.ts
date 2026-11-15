import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../common/redis';
import {
  LIVE_ARRIVALS_LOG_MAX,
  LIVE_ARRIVALS_PAGE,
  LIVE_ARRIVALS_TTL_MS,
  LIVE_SEAT_LEASE_MS,
  LIVE_VIEWER_CAP,
} from './live.constants';

/**
 * The one Redis key holding every seat of every live on this estate: a sorted set whose member is
 * `<liveId>:<viewerId>` and whose score is the Redis clock (ms) of the seat's last renewal. ONE set
 * for all lives because the cap is the host's uplink, which every live shares.
 */
export const LIVE_SEATS_KEY = 'live:seats';

/**
 * THE LIVES A SEAT MAY BE TAKEN ON: a set of live ids, written by the broadcaster's side at the
 * start and with every stored segment ({@link OPEN_LIVE_LUA}) and emptied of a live by its end
 * ({@link CLOSE_LIVE_LUA}). The take reads it in the SAME evaluation as the grant, so a live that
 * has ended - or one Redis does not know, after losing its data - seats nobody: absence refuses.
 *
 * The name carries the seats key as a HASH TAG, so on a Redis Cluster the keys of one script hash
 * to one slot, as {@link arrivalKeys} does; on a single node the braces are ordinary characters.
 */
export const LIVE_OPEN_KEY = `{${LIVE_SEATS_KEY}}:open`;

/**
 * THE LIVES THAT HAVE ENDED AND ARE NOT PURGED YET - the tombstone that orders an open against a
 * close INSIDE Redis: the close writes it before it empties {@link LIVE_OPEN_KEY}, and the open
 * refuses a live found here. So a broadcaster's write that read its live open in PostgreSQL and
 * then lost to an end cannot reopen it, whatever order the two reach Redis in. Removed with the
 * live's other keys at its purge ({@link FORGET_CLOSED_LUA}).
 */
export const LIVE_CLOSED_KEY = `{${LIVE_SEATS_KEY}}:closed`;

/**
 * THE VIEWERS A BROADCASTER REMOVED, as seat members (`<liveId>:<viewerId>`): the take refuses one in
 * the same evaluation as the grant. Written with the seat's release, in ONE script
 * ({@link BAR_VIEWER_LUA}); a live's entries go with its close.
 */
export const LIVE_BARRED_KEY = `{${LIVE_SEATS_KEY}}:barred`;

/** The three keys the take is given, in this order. */
const TAKE_KEYS = [LIVE_SEATS_KEY, LIVE_OPEN_KEY, LIVE_BARRED_KEY] as const;

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
 * (a rolling deploy runs two) can never both see seat 24 free and both take it, and a seat can
 * never be granted on a live that has closed or to a viewer that was removed: the two facts are
 * read in the evaluation that grants.
 *
 * KEYS as `TAKE_KEYS` (seats, open lives, barred viewers); ARGV[1] the member; ARGV[2] the cap;
 * ARGV[3] the lease in ms; ARGV[4] the live's member prefix `<liveId>:`; ARGV[5] the live id.
 * Reply `{2}` when the live is not open, `{3}` when the viewer is barred - nothing is written for
 * either; `{0, seated}` on a full host; `{1, seated, watching}` on a grant, `watching` being the
 * seats THAT live holds with this one counted - the viewer count the manifest carries, read in the
 * same script as the grant so it can never disagree with the cap. The clock is REDIS's (`TIME`),
 * read once here, so every renewal and every expiry is compared on one clock whatever instance
 * wrote it.
 */
export const TAKE_SEAT_LUA = `${COUNT_PREFIX_LUA}
if redis.call('SISMEMBER', KEYS[2], ARGV[5]) == 0 then return {2} end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then return {3} end
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
 * OPENS A LIVE TO SEATS, and writes the viewers its broadcaster removed - UNLESS IT HAS CLOSED.
 * KEYS[1] the open lives, KEYS[2] the barred viewers, KEYS[3] the closed lives; ARGV[1] the live
 * id, ARGV[2..] one barred member per removed viewer. Reply 1 when the live is open, 0 when it is
 * in the closed set, where nothing is written. Idempotent: the broadcaster's side sends it at the
 * start and with every stored segment, which is what restores both sets after Redis lost them.
 */
export const OPEN_LIVE_LUA = `
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
for i = 2, #ARGV do redis.call('SADD', KEYS[2], ARGV[i]) end
return 1
`;

/**
 * BARS ONE VIEWER FROM ONE LIVE AND GIVES ITS SEAT BACK, the bar FIRST and both in one evaluation:
 * no take can run between them. KEYS[1] the seats set, KEYS[2] the barred viewers; ARGV[1] the
 * member. Reply: 1 if a seat was held.
 */
export const BAR_VIEWER_LUA = `
redis.call('SADD', KEYS[2], ARGV[1])
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

/**
 * CLOSES A LIVE TO SEATS, the tombstone FIRST, in one evaluation: after it no take is granted on
 * that live and no open reopens it, whatever a request read before. KEYS[1] the seats, KEYS[2] the
 * open lives, KEYS[3] the barred viewers, KEYS[4] the closed lives; ARGV[1] the live id; ARGV[2]
 * its member prefix `<liveId>:`; ARGV[3] `1` to give every seat of the live back too (a cut, an
 * erasure, a row-less folder), `0` to keep them (an ordinary end: its purge waits for them). The
 * live's barred entries go either way - a closed live refuses everybody. Reply: how many seats went.
 * Both sets read whole are bounded (the seats by the cap, the bars by the removals of the lives now
 * open), a few dozen members.
 */
export const CLOSE_LIVE_LUA = `
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[1])
for _, m in ipairs(redis.call('SMEMBERS', KEYS[3])) do
  if string.sub(m, 1, #ARGV[2]) == ARGV[2] then redis.call('SREM', KEYS[3], m) end
end
local n = 0
if ARGV[3] == '1' then
  for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
    if string.sub(m, 1, #ARGV[2]) == ARGV[2] then
      redis.call('ZREM', KEYS[1], m)
      n = n + 1
    end
  end
end
return n
`;

/**
 * Forgets a PURGED live's tombstone. KEYS[1] the closed lives; ARGV[1] the live id. The row is gone
 * by then, so the watch rule refuses the live in PostgreSQL before any take is asked.
 */
export const FORGET_CLOSED_LUA = `return redis.call('SREM', KEYS[1], ARGV[1])`;

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

/**
 * HOW MANY SEATS EACH OF SEVERAL LIVES HOLDS, READ ONLY, IN ONE CALL - the feed card's viewer counts
 * (owner, 2026-11-07), one script for the whole list instead of one per live. KEYS[1] the seats set;
 * ARGV[1] the lease in ms; ARGV[2..] one member prefix per live. Reply: one count per prefix, in the
 * order asked. The fresh members are read ONCE, so every count is of the same instant.
 */
export const COUNT_MANY_LIVE_SEATS_LUA = `${COUNT_PREFIX_LUA}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local after = string.format('(%.0f', now - tonumber(ARGV[1]))
local fresh = redis.call('ZRANGEBYSCORE', KEYS[1], after, '+inf')
local reply = {}
for i = 2, #ARGV do reply[#reply + 1] = countPrefix(fresh, ARGV[i]) end
return reply
`;

/** Gives one seat back. KEYS[1] the seats set; ARGV[1] the member. Reply: 1 if it was held. */
export const RELEASE_SEAT_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/**
 * The three Redis keys of one live's arrivals: who arrived (dedupe), the counter, the ordered log.
 * The live id is a HASH TAG (`{...}`): on a Redis Cluster the three keys of one script hash to ONE
 * slot, so the multi-key scripts stay legal. On the single node this estate runs, the braces are
 * ordinary characters of the key name - no cost, no behaviour change.
 */
export const arrivalKeys = (liveId: string): [string, string, string] => {
  const id = liveId.toLowerCase();
  return [`live:{${id}}:arrived`, `live:{${id}}:arrivalseq`, `live:{${id}}:arrivals`];
};

/**
 * NOTE ONE ARRIVAL, ONCE PER VIEWER PER LIVE: `SADD` is the dedupe (a seat that lapsed and was taken
 * again is the same arrival, so a flapping network announces nobody twice), the counter is the
 * cursor's order, the log keeps the newest few. KEYS: the arrived set, the counter, the log; ARGV:
 * the viewer, the TTL in ms, the log's size. Reply 1 for a new arrival, 0 for a known one.
 */
export const NOTE_ARRIVAL_LUA = `
local fresh = redis.call('SADD', KEYS[1], ARGV[1])
if fresh == 1 then
  local seq = redis.call('INCR', KEYS[2])
  redis.call('ZADD', KEYS[3], seq, ARGV[1])
  redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(tonumber(ARGV[3]) + 1))
end
for i = 1, 3 do redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
return fresh
`;

/**
 * READ THE ARRIVALS AFTER A CURSOR. KEYS: the counter, the log; ARGV: the cursor (-1 for a first poll,
 * which reads only the top) and the page. Reply `{top, viewer, seq, viewer, seq, ...}`, ascending.
 */
export const READ_ARRIVALS_LUA = `
local top = tonumber(redis.call('GET', KEYS[1]) or '0')
local reply = {top}
if tonumber(ARGV[1]) < 0 then return reply end
local rows = redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. ARGV[1], '+inf', 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
for _, v in ipairs(rows) do reply[#reply + 1] = v end
return reply
`;

/** Deletes a live's three arrival keys (KEYS as {@link arrivalKeys}). */
export const FORGET_ARRIVALS_LUA = `return redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])`;

/** One arrival as read from the log, before the reader's filters. */
export interface LiveArrivalRow {
  userId: string;
  seq: number;
}

/**
 * The seat member of one viewer on one live. The live id is LOWER-CASED: the take is keyed by the
 * row's id (PostgreSQL's spelling), while a leave or a removal carries the id as the client spelled
 * it in the URL, which the route guard accepts in upper case - and a release that names another
 * member frees nothing. ONE SEAT PER ACCOUNT, not per device (lives.md, "The viewer cap"): the
 * request carries no device id, and an account is what a removal or a block names.
 */
export const seatMember = (liveId: string, viewerId: string): string =>
  `${liveId.toLowerCase()}:${viewerId}`;

/**
 * Why Redis refused a seat that the watch rule had allowed: the live is not in the open set
 * (`closed`: it ended, or Redis does not know it), or the viewer is barred from it. A TYPE, never a
 * message: the caller asks PostgreSQL which refusal it is (`LivesService.takeSeat`).
 */
export class LiveSeatRefused extends Error {
  constructor(readonly why: 'closed' | 'barred') {
    super(`live seat refused: ${why}`);
    this.name = 'LiveSeatRefused';
  }
}

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
   * this one included (the manifest's `viewers`); throws 503 `LIVE_FULL` when no seat is left, and
   * {@link LiveSeatRefused} when the live is not open to seats or the viewer is barred from it.
   */
  async take(liveId: string, viewerId: string): Promise<number> {
    let reply: unknown;
    try {
      reply = await this.redis.evalScript(
        TAKE_SEAT_LUA,
        [...TAKE_KEYS],
        [
          seatMember(liveId, viewerId),
          LIVE_VIEWER_CAP,
          LIVE_SEAT_LEASE_MS,
          seatMember(liveId, ''),
          liveId.toLowerCase(),
        ]
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
    if (granted === 2 || granted === 3) {
      const why = granted === 2 ? 'closed' : 'barred';
      this.logger.debug(`[LIVE_SEAT] ${liveId}: no seat, the live is ${why} to this take`);
      throw new LiveSeatRefused(why);
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

  /**
   * How many viewers hold a seat on each of `liveIds`, read without taking one - the counts the feed
   * card shows (owner, 2026-11-07). ONE script for the whole list ({@link COUNT_MANY_LIVE_SEATS_LUA}).
   * A count and nothing else: no account id leaves Redis for it.
   *
   * `null` when Redis does not answer or answers what this code did not write, logged as an `error`:
   * the card is a list of lives, which a display number must not take down - it then shows no count
   * rather than a wrong one, and the same outage refuses every seat (`LIVE_SEATS_UNAVAILABLE`).
   */
  async watchingMany(liveIds: string[]): Promise<Map<string, number> | null> {
    if (liveIds.length === 0) return new Map();
    let reply: unknown;
    try {
      reply = await this.redis.evalScript(
        COUNT_MANY_LIVE_SEATS_LUA,
        [LIVE_SEATS_KEY],
        [LIVE_SEAT_LEASE_MS, ...liveIds.map((id) => seatMember(id, ''))]
      );
    } catch (e) {
      this.logger.error(
        `[LIVE_SEAT] the counts of ${liveIds.length} live(s) (list) did not answer: ${String(e)}`
      );
      return null;
    }
    const counts = Array.isArray(reply) ? reply.map(Number) : [];
    if (counts.length !== liveIds.length || counts.some((n) => !Number.isInteger(n) || n < 0)) {
      this.logger.error(`[LIVE_SEAT] list counts: unreadable reply ${JSON.stringify(reply)}`);
      return null;
    }
    this.logger.debug(`[LIVE_SEAT] counts read for ${liveIds.length} live(s) (list)`);
    return new Map(liveIds.map((id, i) => [id, counts[i]]));
  }

  /**
   * Records that the viewer arrived on the live, once ({@link NOTE_ARRIVAL_LUA}). Best effort by the
   * caller's choice: it throws, and the caller logs and goes on - an arrival line is a courtesy, not
   * a seat.
   */
  async noteArrival(liveId: string, viewerId: string): Promise<boolean> {
    const fresh = await this.redis.evalScript(
      NOTE_ARRIVAL_LUA,
      [...arrivalKeys(liveId)],
      [viewerId, LIVE_ARRIVALS_TTL_MS, LIVE_ARRIVALS_LOG_MAX]
    );
    return Number(fresh) === 1;
  }

  /**
   * The arrivals after `after` (ascending, at most {@link LIVE_ARRIVALS_PAGE}) and the log's top
   * sequence. `after` null is a first poll: the top only, no history. Throws on a Redis failure or a
   * reply this code did not write.
   */
  async readArrivals(
    liveId: string,
    after: number | null
  ): Promise<{ top: number; rows: LiveArrivalRow[] }> {
    const [, counter, log] = arrivalKeys(liveId);
    const reply = await this.redis.evalScript(
      READ_ARRIVALS_LUA,
      [counter, log],
      [after === null ? -1 : after, LIVE_ARRIVALS_PAGE]
    );
    if (!Array.isArray(reply) || reply.length % 2 !== 1) {
      throw new Error(`unreadable arrivals reply ${JSON.stringify(reply)}`);
    }
    const top = Number(reply[0]);
    const rows: LiveArrivalRow[] = [];
    for (let i = 1; i < reply.length; i += 2) {
      rows.push({ userId: String(reply[i]), seq: Number(reply[i + 1]) });
    }
    if (!Number.isInteger(top) || rows.some((r) => !Number.isInteger(r.seq))) {
      throw new Error(`unreadable arrivals reply ${JSON.stringify(reply)}`);
    }
    return { top, rows };
  }

  /** Forgets a live's arrivals (its purge). Idempotent; throws on a Redis failure. */
  async forgetArrivals(liveId: string): Promise<void> {
    await this.redis.evalScript(FORGET_ARRIVALS_LUA, [...arrivalKeys(liveId)], []);
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
   * Opens the live to seats and writes the viewers its broadcaster removed ({@link OPEN_LIVE_LUA}).
   * Sent at the live's start and with every stored segment. A live that has closed is NOT reopened:
   * the script refuses it by its tombstone, so the order of this write against an end's
   * {@link close} is Redis's own. Throws on a Redis failure; the caller logs it and the next
   * segment sends it again.
   *
   * @returns whether the live is open to seats after the call.
   */
  async open(liveId: string, removedViewers: readonly string[]): Promise<boolean> {
    const opened =
      Number(
        await this.redis.evalScript(
          OPEN_LIVE_LUA,
          [LIVE_OPEN_KEY, LIVE_BARRED_KEY, LIVE_CLOSED_KEY],
          [liveId.toLowerCase(), ...removedViewers.map((v) => seatMember(liveId, v))]
        )
      ) === 1;
    this.logger.debug(
      opened
        ? `[LIVE_SEAT] ${liveId}: open to seats, ${removedViewers.length} viewer(s) barred`
        : `[LIVE_SEAT] ${liveId}: not reopened, it has closed`
    );
    return opened;
  }

  /**
   * Bars a removed viewer from the live and gives its seat back, in one script
   * ({@link BAR_VIEWER_LUA}): no take of that viewer can follow. Throws on a Redis failure.
   */
  async bar(liveId: string, viewerId: string): Promise<void> {
    const was = await this.redis.evalScript(
      BAR_VIEWER_LUA,
      [LIVE_SEATS_KEY, LIVE_BARRED_KEY],
      [seatMember(liveId, viewerId)]
    );
    this.logger.debug(`[LIVE_SEAT] ${liveId}: viewer barred (seat held=${String(was)})`);
  }

  /**
   * Closes an ENDED live to seats ({@link CLOSE_LIVE_LUA}): no take is granted on it afterwards.
   * `releaseSeats` also gives every seat of it back at once - a live CUT or ERASED, whose viewers
   * are owed nothing, so the host's cap does not wait a lease for them. An ordinary end keeps them:
   * they are what its purge waits for (`LivesService.purgeEnded`). Idempotent. Throws on a Redis
   * failure; the caller logs it.
   *
   * @returns how many seats were given back.
   */
  async close(liveId: string, releaseSeats: boolean): Promise<number> {
    const freed = Number(
      await this.redis.evalScript(
        CLOSE_LIVE_LUA,
        [LIVE_SEATS_KEY, LIVE_OPEN_KEY, LIVE_BARRED_KEY, LIVE_CLOSED_KEY],
        [liveId.toLowerCase(), seatMember(liveId, ''), releaseSeats ? '1' : '0']
      )
    );
    this.logger.debug(
      `[LIVE_SEAT] ${liveId}: closed to seats, ${releaseSeats ? `${freed} seat(s) given back` : 'its seats kept for the drain'}`
    );
    return freed;
  }

  /**
   * Forgets a purged live's tombstone ({@link FORGET_CLOSED_LUA}), with its other keys. Idempotent;
   * throws on a Redis failure.
   */
  async forgetClosed(liveId: string): Promise<void> {
    await this.redis.evalScript(FORGET_CLOSED_LUA, [LIVE_CLOSED_KEY], [liveId.toLowerCase()]);
  }
}
