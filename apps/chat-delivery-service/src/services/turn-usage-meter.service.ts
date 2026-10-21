import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * How long one reading of Cloudflare's meter is reused, in seconds. NOT a freshness guarantee -
 * Cloudflare's own analytics trail the traffic by minutes anyway - but a bound on how often
 * `ice-servers` asks the GraphQL API, whose per-token quota a member hammering the endpoint must not
 * be able to spend: a spent quota would refuse EVERY call on the estate (the meter would be
 * unreadable). Being wrong by this much costs at most a minute of relayed traffic past the budget.
 */
const METER_CACHE_SEC = 60;

/** Cloudflare's account ids are 32 lowercase hex characters; anything else is a misconfiguration. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** `turn:metered:2026-10` - the cached reading for one UTC calendar month. */
function meterCacheKey(month: string): string {
  return `turn:metered:${month}`;
}

/** The shape of the one aggregate group the query asks for (no dimensions = one group). */
interface TurnUsageAnswer {
  data?: {
    viewer?: {
      accounts?: {
        callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: unknown } }[];
      }[];
    };
  } | null;
  errors?: { message?: string }[] | null;
}

/**
 * THE TURN BUDGET'S EVIDENCE: what Cloudflare itself metered, never an estimate (B7).
 *
 * WHY NOT AN ESTIMATE. The budget used to be `call duration x CALL_RELAY_KBPS_PER_DEVICE (3000)`
 * summed in Redis from the clients' presence reports: every call counted as relayed, at a video
 * rate. In peer-to-peer mode only a call whose selected ICE pair is a RELAY candidate costs anything,
 * and an audio call is tens of kbps - so 950 GB would have read as ~350 call-hours and `ice-servers`
 * would then have refused every call of the month. Counting "relayed calls only" from the CLIENT's
 * final path was the other way, and it is a claim the server cannot verify: a client that says
 * `relayed=no` and relays is not counted (and CALL-PATH-LINE showed the client's own line can be
 * wrong without any malice). Cloudflare's GraphQL analytics (`callsTurnUsageAdaptiveGroups`) count
 * the bytes its TURN servers actually carried, direct calls contribute zero by construction, and no
 * client says anything.
 *
 * WHAT IS COUNTED. `egressBytes` (TURN server -> clients), summed over the WHOLE ACCOUNT for the
 * current UTC calendar month: egress is what Cloudflare bills, and its free allowance is per account,
 * so another key on the same account (dev's, if it shares the account) spends the same allowance.
 *
 * WHAT IT CANNOT BOUND. Credentials already issued stay valid for their TTL
 * (`CLOUDFLARE_TURN_TTL_SECONDS`, 2 h): reaching the budget refuses NEW credentials, so the overshoot
 * is what the credentials outstanding at that moment relay before they expire, plus the meter's lag.
 *
 * NO FALLBACK. Unconfigured or unreadable, the meter THROWS a 503 and `ice-servers` mints nothing:
 * credentials with no budget behind them are exactly what this replaced.
 */
@Injectable()
export class TurnUsageMeter {
  private readonly logger = new Logger(TurnUsageMeter.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Bytes Cloudflare's TURN servers sent to clients this UTC month, account-wide.
   *
   * @param now The instant whose month is read (injectable for tests).
   * @throws ServiceUnavailableException when the meter is not configured or does not answer.
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

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
    const token = process.env.CLOUDFLARE_TURN_ANALYTICS_TOKEN?.trim() ?? '';
    if (!ACCOUNT_ID.test(accountId) || !token) {
      this.logger.error(
        '[ICE] the TURN usage meter is not configured (CLOUDFLARE_ACCOUNT_ID, 32 hex, and ' +
          'CLOUDFLARE_TURN_ANALYTICS_TOKEN with Account Analytics read are required) - refusing credentials'
      );
      throw new ServiceUnavailableException('The call relay budget cannot be read on this server');
    }

    const bytes = await this.query(accountId, token, month, now);
    await this.redis.set(meterCacheKey(month), String(bytes), 'EX', METER_CACHE_SEC);
    this.logger.debug(`[ICE] TURN meter ${month}: ${bytes} egress bytes (account-wide)`);
    return bytes;
  }

  /** One GraphQL round trip; every answer that is not a number is a 503, named in the log. */
  private async query(accountId: string, token: string, month: string, now: Date): Promise<number> {
    const dateFrom = `${month}-01`;
    const dateTo = now.toISOString().slice(0, 10);
    // Inlined rather than declared as variables: the three values are validated above (the id) or
    // computed here (the dates), and inlining spares a dependency on the schema's scalar names.
    const query = `query TurnMonth { viewer { accounts(filter: { accountTag: "${accountId}" }) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: "${dateFrom}", date_leq: "${dateTo}" }) {
        sum { egressBytes }
      } } } }`;

    let answer: TurnUsageAnswer;
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
      }
      answer = (await response.json()) as TurnUsageAnswer;
    } catch (e) {
      this.logger.error(`[ICE] the TURN usage meter did not answer: ${String(e)}`);
      throw new ServiceUnavailableException('The call relay budget cannot be read on this server');
    }

    if (answer.errors && answer.errors.length > 0) {
      this.logger.error(
        `[ICE] the TURN usage meter refused the query: ${answer.errors.map((e) => e.message).join('; ')}`
      );
      throw new ServiceUnavailableException('The call relay budget cannot be read on this server');
    }
    const accounts = answer.data?.viewer?.accounts;
    if (!accounts || accounts.length !== 1) {
      // The filter names one account; none means the token cannot see it.
      this.logger.error(
        `[ICE] the TURN usage meter returned ${accounts?.length ?? 'no'} account(s) for the configured id`
      );
      throw new ServiceUnavailableException('The call relay budget cannot be read on this server');
    }
    const groups = accounts[0].callsTurnUsageAdaptiveGroups ?? [];
    // No group at all is a month with no TURN traffic: the dataset returns nothing to sum.
    if (groups.length === 0) return 0;
    const egress = Number(groups[0].sum?.egressBytes);
    if (!Number.isFinite(egress) || egress < 0) {
      this.logger.error(
        `[ICE] the TURN usage meter returned a non-number: ${JSON.stringify(groups[0])}`
      );
      throw new ServiceUnavailableException('The call relay budget cannot be read on this server');
    }
    return egress;
  }
}
