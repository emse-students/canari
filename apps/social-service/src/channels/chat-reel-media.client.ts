import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { purgeChatReelMedia, type ReelPurgeOutcome } from '../internal/reel-media';

/**
 * The media service's `chat-reel-purge`, as `ChannelService` calls it when a moderator deletes a
 * salon message that declares a reel file (reels-in-chat 15.4). A class of its own so the channel
 * service needs no HTTP client of its own and a spec can hand it a fake.
 */
@Injectable()
export class ChatReelMediaClient {
  constructor(private readonly http: HttpService) {}

  /**
   * Purges each file for the row author named beside it; one outcome per id. Throws on a transport
   * failure - see `purgeChatReelMedia`.
   */
  purge(
    items: Array<{ mediaId: string; ownerId: string }>
  ): Promise<Record<string, ReelPurgeOutcome>> {
    return purgeChatReelMedia(this.http, items);
  }
}
