import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis';
import { parisSlot } from './paris-time';
import { activityKey, USAGE_DAY_KEY_TTL_SECS, type UsageActivityMetric } from './usage-contract';

/** The metrics this service is where the fact is known (messages and calls are chat-delivery's). */
export type SocialActivityMetric = Extract<
  UsageActivityMetric,
  'posts' | 'reels' | 'lives' | 'forms'
>;

/** `HINCRBY` and its `EXPIRE` in one call, so the day's hash never exists without an expiry. */
const COUNT = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

/**
 * THE USAGE DASHBOARD'S DAILY ACTIVITY TOTALS for posts, CanaReels, lives and forms answered
 * (docs/wiki/usage-dashboard.md, owner 2026-11-16): one counter per (Paris day, metric), for the
 * whole platform - no author, no association, no hour, no content. chat-delivery-service counts
 * `messages` and `calls` into the same hash (its `utils/usage-activity.ts`).
 *
 * Injected as the LAST constructor parameter of the services that count, declared optional so the
 * specs that build those services by hand need not name it; Nest provides it everywhere else
 * ({@link UsageModule} is global), and a service that does not receive one counts nothing.
 */
@Injectable()
export class UsageActivity {
  private readonly logger = new Logger(UsageActivity.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Adds one to `metric` for the Paris day of `at` (the caller's clock; a test passes one). NEVER
   * THROWS and is not awaited by the counting path: a lost count is a warn naming it, never a
   * failed publish.
   */
  async count(metric: SocialActivityMetric, at: Date = new Date()): Promise<void> {
    const { day } = parisSlot(at);
    try {
      await this.redis.evalScript(COUNT, [activityKey(day)], [metric, USAGE_DAY_KEY_TTL_SECS]);
      this.logger.debug(`[USAGE] ${metric} +1 on ${day}`);
    } catch (e) {
      this.logger.warn(
        `[USAGE] ${metric} NOT counted on ${day} - the dashboard's total is one short: ${String(e)}`
      );
    }
  }
}
