import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { inspect } from 'util';

/**
 * Redis service for publishing events to the chat gateway.
 * Used to notify connected clients of channel events in real-time.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    /*
     * THE DEFAULT IS A SIGNAL, AND FOR SEVEN DAYS IT WAS A SILENT PATH.
     *
     * `dev.canari-emse.fr` ran this service with no `REDIS_URL` at all - the variable is set for
     * social-service on production and on the local stack, and was simply absent from the dev
     * compose. So this dialled `localhost`, which is this container, and failed for ever: 3 657
     * error lines in one hour on 2026-09-09, and a member creating a post got a 500. The error
     * line below already named the destination (it was rewritten for exactly this failure on
     * 2026-09-02, on a local stack that had no `REDIS_URL` either) and it still took a person
     * hitting the bug, because nobody reads a dev log that has been shouting since it started.
     *
     * The default stays, because a laptop running the service outside compose is a real workflow
     * and a hard failure there would be worse. What changes is that choosing it now ACCUSES, once,
     * at startup, before any connection is attempted - so the cause is at the top of the log rather
     * than inferred from the address in a repeating error. A fallback is a signal, never a path.
     */
    const configuredUrl = process.env.REDIS_URL;
    const redisUrl = configuredUrl || 'redis://localhost:6379';
    if (!configuredUrl) {
      this.logger.error(
        `REDIS_URL is not set - falling back to ${redisUrl}. Inside a container that is the ` +
          'container itself, so every publish will fail and real-time channel events will not ' +
          'reach the gateway. Set REDIS_URL in this environment.'
      );
    }
    this.client = new Redis(redisUrl, {
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 3,
      commandTimeout: 1000,
    });

    this.client.on('connect', () => {
      this.logger.log('Connected to Redis');
    });

    // THE MESSAGE ALONE IS OFTEN EMPTY, AND AN ERROR LINE THAT NAMES NOTHING IS NOT A REPORT.
    // Measured 2026-09-02 on a local stack that had no `REDIS_URL`: this printed `Redis error: `
    // with nothing after it, every two seconds, because ioredis raises AggregateError on a failed
    // connection attempt and its `message` is blank - the cause lives in `code` and in the address
    // it dialled. Finding out which host it was even trying took reading this file. So the line
    // carries the DESTINATION, which is what a misconfiguration gets wrong, plus whatever
    // discriminator the error actually holds, and it falls back to the error's own name rather than
    // to an empty string.
    //
    // THE DESTINATION IS THE HOST AND PORT, NEVER THE URL. A Redis URL may carry `user:password@`,
    // and a log line is the last place a credential should be reconstructible from.
    const target = RedisService.describeTarget(redisUrl);
    this.client.on('error', (err: NodeJS.ErrnoException) => {
      const cause = err.message || err.code || err.name || 'no cause reported';
      const detail = err.code && err.message ? ` (${err.code})` : '';
      this.logger.error(`Redis error against ${target}: ${cause}${detail}`);
    });
  }

  /**
   * The `host:port` a Redis URL points at, with any credential removed.
   *
   * A connection error has to name where it was going - that is the part a misconfiguration gets
   * wrong - but a Redis URL may embed `user:password@`, so the userinfo never reaches a log. An
   * unparseable value is reported as such rather than echoed: whatever it is, it is not a URL, and
   * printing it raw would put an arbitrary environment value into the logs.
   */
  private static describeTarget(redisUrl: string): string {
    try {
      const parsed = new URL(redisUrl);
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      return 'an unparseable REDIS_URL';
    }
  }

  /** Gracefully closes the Redis connection when the NestJS module is destroyed. */
  async onModuleDestroy() {
    await this.client.quit();
  }

  /** Publishes a JSON message to a Redis Pub/Sub channel. Logs errors but does not throw. */
  async publish(channel: string, message: Record<string, unknown>): Promise<void> {
    try {
      const payload = JSON.stringify(message);
      await this.client.publish(channel, payload);
      // THE SHAPE, NEVER THE BODY. This reprinted the whole event on every publish - the channel
      // ciphertext and the entire recipient list - which is a debugging aid that outlived its
      // session: it says nothing a size does not, and it puts payloads in a log read by people
      // who are not entitled to them.
      this.logger.debug(`Published to ${channel}: ${payload.length} bytes`);
    } catch (err) {
      const trace =
        err instanceof Error ? (err.stack ?? err.message) : inspect(err, { depth: null });
      this.logger.error(`Failed to publish to ${channel}`, trace);
    }
  }

  /** Returns the string value stored at key, or null if the key does not exist. */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Stores a string value with an expiry (TTL in seconds). */
  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.client.setex(key, ttlSeconds, value);
  }

  /** Deletes one or more keys. No-op if the keys array is empty. */
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /** SCAN + DEL - use sparingly (e.g. cache bust after association branding changes). */
  async deleteByPattern(match: string): Promise<number> {
    let deleted = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        deleted += await this.client.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }

  /** Wraps publish for channel events: emits to `chat:channel_events` with the target userIds so the gateway delivers only to matching WebSocket connections. */
  async publishChannelEvent(
    eventType: string,
    data: Record<string, unknown>,
    userIds: string[]
  ): Promise<void> {
    const event = {
      type: eventType,
      data,
      userIds,
      timestamp: new Date().toISOString(),
    };
    await this.publish('chat:channel_events', event);
  }
}
