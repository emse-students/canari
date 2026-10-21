import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * How long one reading of Cloudflare's meter is reused, in seconds. NOT a freshness guarantee -
 * Cloudflare's own analytics trail the traffic by minutes anyway - but a bound on how often
 * `ice-servers` asks the GraphQL API, whose per-token quota a member hammering the endpoint must not
 * be able to spend. Being wrong by this much costs at most a minute of relayed traffic past the
 * budget.
 */
const METER_CACHE_SEC = 60;

/**
 * How long a FAILED reading is remembered, in seconds (the negative cache). While it stands, the
 * meter answers "unavailable" without asking Cloudflare again: an outage must not turn every call
 * setup into one more failing API request and one more identical error line. Short, because the
 * cost of being wrong is only that TURN stays withheld this much longer after Cloudflare recovers.
 */
const METER_FAILURE_CACHE_SEC = 30;

/**
 * How long the dataset's query limits (`settings`) are reused, in seconds. They are account plan
 * properties that change on a plan change, never call to call.
 */
const SETTINGS_CACHE_SEC = 60 * 60;

const DAY_SEC = 24 * 60 * 60;

/** Cloudflare's account ids are 32 lowercase hex characters; anything else is a misconfiguration. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** `turn:metered:2026-10` - the cached reading for one UTC calendar month. */
function meterCacheKey(month: string): string {
  return `turn:metered:${month}`;
}

/** Present while a recent reading failed: its value is the reason, for the log. */
const METER_FAILURE_KEY = 'turn:metered:unavailable';

/** The dataset's query limits as `settings` reported them, JSON. */
const METER_SETTINGS_KEY = 'turn:metered:settings';

/**
 * The meter could not give a number. TYPED, so its one consumer (`CallsService.getIceServers`)
 * catches exactly this and nothing else: it withholds TURN and still answers for a direct call.
 */
export class TurnMeterUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`the TURN usage meter is unavailable: ${reason}`);
    this.name = 'TurnMeterUnavailableError';
  }
}

/** The dataset's limits, from `settings { callsTurnUsageAdaptiveGroups { ... } }`. */
interface DatasetLimits {
  /** Widest time range one query may ask, in seconds. */
  maxDuration: number;
  /** How far back a query may read, in seconds. */
  notOlderThan: number;
}

/** One inclusive range of UTC dates, `YYYY-MM-DD`, as the `date_geq` / `date_leq` filter takes. */
interface DateChunk {
  from: string;
  to: string;
}

type GraphqlAnswer = {
  data?: {
    viewer?: { accounts?: Record<string, unknown>[] };
  } | null;
  errors?: { message?: string }[] | null;
};

/** `2026-10-21` for a Date, in UTC. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Splits the UTC dates from the first of `now`'s month to `now`'s date into ranges no wider than
 * `maxDuration` allows, whole days each (the `date` filter has day granularity). Exported for the
 * test: this arithmetic is where a clamp would silently drop days.
 *
 * @throws TurnMeterUnavailableError when the dataset cannot answer a whole month: a window under a
 *   day, or a retention (`notOlderThan`) that does not reach back to the first of the month. Reading
 *   a PART of the month would under-count, and an under-counted budget is an unbounded one.
 */
export function monthDateChunks(now: Date, limits: DatasetLimits): DateChunk[] {
  const daysPerChunk = Math.floor(limits.maxDuration / DAY_SEC);
  if (daysPerChunk < 1) {
    throw new TurnMeterUnavailableError(
      `the dataset allows ${limits.maxDuration}s per query, under the one day a date filter needs`
    );
  }
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const ageSec = (now.getTime() - first.getTime()) / 1000;
  if (ageSec > limits.notOlderThan) {
    throw new TurnMeterUnavailableError(
      `the dataset keeps ${limits.notOlderThan}s, less than the ${Math.ceil(ageSec)}s back to ${utcDate(first)}`
    );
  }
  const today = utcDate(now);
  const chunks: DateChunk[] = [];
  let cursor = first;
  for (;;) {
    const end = new Date(cursor.getTime() + (daysPerChunk - 1) * DAY_SEC * 1000);
    const to = utcDate(end) < today ? utcDate(end) : today;
    chunks.push({ from: utcDate(cursor), to });
    if (to === today) return chunks;
    cursor = new Date(end.getTime() + DAY_SEC * 1000);
  }
}

/**
 * THE TURN BUDGET'S EVIDENCE: what Cloudflare itself metered, never an estimate (B7).
 *
 * WHY NOT AN ESTIMATE. The budget used to be `call duration x CALL_RELAY_KBPS_PER_DEVICE (3000)`
 * summed in Redis from the clients' presence reports: every call counted as relayed, at a video
 * rate. In peer-to-peer mode only a call whose selected ICE pair is a RELAY candidate costs anything,
 * and an audio call is tens of kbps. Counting "relayed calls only" from the CLIENT's final path was
 * the other way, and it is a claim the server cannot verify (CALL-PATH-LINE showed the client's own
 * line can be wrong without any malice). Cloudflare's GraphQL analytics count the bytes its TURN
 * servers actually carried; direct calls contribute zero by construction, and no client says
 * anything.
 *
 * WHAT IS COUNTED. `sum { egressBytes }` of `callsTurnUsageAdaptiveGroups` (TURN server -> clients),
 * for the WHOLE ACCOUNT, from the first of the current UTC month to today: egress is what Cloudflare
 * bills, and its free allowance is per account.
 *
 * THE QUERY (docs read 2026-10-21): the dataset and its `date_geq` / `date_leq` filter are the ones
 * of https://developers.cloudflare.com/realtime/turn/analytics/ ; the window is clamped to the
 * dataset's own limits, read from the `settings` node
 * (https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/):
 * `maxDuration` splits the month into aliased sub-queries summed here, `notOlderThan` must reach
 * the first of the month. Every literal is validated (the account id) or computed (the dates).
 *
 * WHAT IT CANNOT BOUND. Credentials already issued stay valid for their TTL
 * (`CLOUDFLARE_TURN_TTL_SECONDS`, 2 h): reaching the budget withholds NEW credentials, so the
 * overshoot is what the credentials outstanding at that moment relay, plus the meter's lag.
 *
 * Unconfigured or unreadable, it throws {@link TurnMeterUnavailableError}: `ice-servers` then mints
 * no TURN credential (none without a budget behind it) and still answers for a direct call.
 */
@Injectable()
export class TurnUsageMeter {
  private readonly logger = new Logger(TurnUsageMeter.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Bytes Cloudflare's TURN servers sent to clients this UTC month, account-wide.
   *
   * @param now The instant whose month is read (injectable for tests).
   * @throws TurnMeterUnavailableError when the meter is not configured, failed, or failed recently.
   */
  async monthEgressBytes(now: Date = new Date()): Promise<number> {
    const month = now.toISOString().slice(0, 7);
    const cached = await this.redis.get(meterCacheKey(month));
    if (cached !== null) {
      const bytes = Number(cached);
      if (Number.isFinite(bytes) && bytes >= 0) return bytes;
      // Only this class writes the key, so an unreadable value is a defect here, named as one.
      this.logger.error(
        `[ICE] cached TURN meter for ${month} is unreadable (${cached}) - re-reading`
      );
    }
    const recentFailure = await this.redis.get(METER_FAILURE_KEY);
    if (recentFailure !== null) {
      // Already logged at error when it happened; the caller logs the withheld TURN per call.
      throw new TurnMeterUnavailableError(
        `failed less than ${METER_FAILURE_CACHE_SEC}s ago: ${recentFailure}`
      );
    }

    try {
      const { accountId, token } = this.config();
      const limits = await this.limits(accountId, token);
      const bytes = await this.query(accountId, token, monthDateChunks(now, limits));
      await this.redis.set(meterCacheKey(month), String(bytes), 'EX', METER_CACHE_SEC);
      this.logger.debug(`[ICE] TURN meter ${month}: ${bytes} egress bytes (account-wide)`);
      return bytes;
    } catch (e) {
      const reason = e instanceof TurnMeterUnavailableError ? e.reason : String(e);
      this.logger.error(`[ICE] the TURN usage meter is unavailable: ${reason}`);
      await this.redis.set(METER_FAILURE_KEY, reason.slice(0, 300), 'EX', METER_FAILURE_CACHE_SEC);
      throw e instanceof TurnMeterUnavailableError ? e : new TurnMeterUnavailableError(reason);
    }
  }

  private config(): { accountId: string; token: string } {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
    const token = process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN?.trim() ?? '';
    if (!ACCOUNT_ID.test(accountId) || !token) {
      throw new TurnMeterUnavailableError(
        'not configured (CLOUDFLARE_ACCOUNT_ID, 32 hex, and CLOUDFLARE_TURN_ANALYTICS_TOKEN with Account Analytics read)'
      );
    }
    return { accountId, token };
  }

  /** The dataset's `maxDuration` / `notOlderThan`, from the `settings` node, cached an hour. */
  private async limits(accountId: string, token: string): Promise<DatasetLimits> {
    const cached = await this.redis.get(METER_SETTINGS_KEY);
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as DatasetLimits;
        if (parsed.maxDuration > 0 && parsed.notOlderThan > 0) return parsed;
      } catch {
        // Only this class writes the key; a value it cannot read is re-asked rather than trusted.
      }
      this.logger.error(`[ICE] cached TURN dataset limits are unreadable (${cached}) - re-reading`);
    }
    const account = await this.ask(
      accountId,
      token,
      'settings { callsTurnUsageAdaptiveGroups { enabled maxDuration notOlderThan } }'
    );
    const node = (account.settings as Record<string, unknown> | undefined)
      ?.callsTurnUsageAdaptiveGroups as
      | { enabled?: unknown; maxDuration?: unknown; notOlderThan?: unknown }
      | undefined;
    if (node?.enabled !== true) {
      throw new TurnMeterUnavailableError('the dataset is not enabled for this token');
    }
    const maxDuration = Number(node.maxDuration);
    const notOlderThan = Number(node.notOlderThan);
    if (!(maxDuration > 0) || !(notOlderThan > 0)) {
      throw new TurnMeterUnavailableError(`unreadable limits: ${JSON.stringify(node)}`);
    }
    const limits = { maxDuration, notOlderThan };
    await this.redis.set(METER_SETTINGS_KEY, JSON.stringify(limits), 'EX', SETTINGS_CACHE_SEC);
    return limits;
  }

  /** The month's egress: one aliased sub-query per chunk, summed. */
  private async query(accountId: string, token: string, chunks: DateChunk[]): Promise<number> {
    const body = chunks
      .map(
        (c, i) =>
          `c${i}: callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: "${c.from}", date_leq: "${c.to}" }) { sum { egressBytes } }`
      )
      .join('\n');
    const account = await this.ask(accountId, token, body);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const groups = account[`c${i}`];
      if (!Array.isArray(groups)) {
        throw new TurnMeterUnavailableError(`no answer for ${chunks[i].from}..${chunks[i].to}`);
      }
      // No group at all is a range with no TURN traffic: the dataset returns nothing to sum.
      if (groups.length === 0) continue;
      const egress = Number((groups[0] as { sum?: { egressBytes?: unknown } }).sum?.egressBytes);
      if (!Number.isFinite(egress) || egress < 0) {
        throw new TurnMeterUnavailableError(`a non-number: ${JSON.stringify(groups[0])}`);
      }
      total += egress;
    }
    return total;
  }

  /** One GraphQL round trip under `viewer.accounts(filter: { accountTag })`; the one account node. */
  private async ask(
    accountId: string,
    token: string,
    selection: string
  ): Promise<Record<string, unknown>> {
    const query = `query TurnMeter { viewer { accounts(filter: { accountTag: "${accountId}" }) {\n${selection}\n} } }`;
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }).catch((e: unknown) => {
      throw new TurnMeterUnavailableError(`no answer: ${String(e)}`);
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new TurnMeterUnavailableError(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const answer = (await response.json()) as GraphqlAnswer;
    if (answer.errors && answer.errors.length > 0) {
      throw new TurnMeterUnavailableError(
        `the query was refused: ${answer.errors.map((e) => e.message).join('; ')}`
      );
    }
    const accounts = answer.data?.viewer?.accounts;
    if (!accounts || accounts.length !== 1) {
      // The filter names one account; none means the token cannot see it.
      throw new TurnMeterUnavailableError(
        `${accounts?.length ?? 'no'} account(s) for the configured id`
      );
    }
    return accounts[0];
  }
}
