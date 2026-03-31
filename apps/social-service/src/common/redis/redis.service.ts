import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis service for publishing events to the chat gateway.
 * Used to notify connected clients of channel events in real-time.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = new Redis(redisUrl, {
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 3,
    });

    this.client.on('connect', () => {
      this.logger.log('Connected to Redis');
    });

    this.client.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  /**
   * Publish an event to a Redis channel.
   * The chat-gateway listens on 'chat:channel_events' for real-time delivery.
   */
  async publish(channel: string, message: Record<string, unknown>): Promise<void> {
    try {
      await this.client.publish(channel, JSON.stringify(message));
      this.logger.debug(`Published to ${channel}: ${JSON.stringify(message)}`);
    } catch (err) {
      this.logger.error(`Failed to publish to ${channel}: ${err}`);
    }
  }

  /**
   * Publish a channel event to the chat gateway.
   * Events are delivered to connected WebSocket clients that match the userIds.
   * @param eventType The event type (e.g., 'channel.member.joined')
   * @param data Event-specific data
   * @param userIds List of user IDs to notify (the gateway filters connections by this)
   */
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
