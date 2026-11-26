import { ChannelService, type ChannelPollInput } from '$lib/services/ChannelService';
import type { SealedChannelMessage } from '$lib/utils/graine/channelSeal';

/**
 * Built at the first post, not when the module loads: this module is imported by the seal itself
 * (`channelSeal.ts`, for a leader that adopts a request), so it loads early in every graph that seals.
 */
let channelService: ChannelService | null = null;

/**
 * What a salon message is posted WITH, beside its sealed bytes - everything the server row needs that
 * the seal does not produce. Serializable: it travels in a delegated seal request
 * (`tabCommitDelegation`), so the tab that ADOPTS a request whose asking page was reloaded can post
 * it itself ({@link postSealedChannelMessage}).
 */
export interface SalonPost {
  /** The client id the server answers a repeat with (migration 090). */
  messageId?: string;
  poll?: ChannelPollInput;
  mentionedUserIds?: string[];
  /** The text calls every member (`@tous`): the server vouches for it only from a moderator. */
  mentionsEveryone?: boolean;
  /** A silent row (a reaction, an edit): no push, and no seed frame carried. */
  silent?: boolean;
}

/**
 * Posts one sealed salon message - the ONE place its server row is built, for the tab that sealed or
 * asked for it (`sendEncryptedChannelMessage`) and for the leader that adopts a reloaded page's
 * request. Resolves with the server's raw answer; reading it is the caller's.
 */
export function postSealedChannelMessage(
  channel: string,
  sealed: SealedChannelMessage,
  post: SalonPost
): Promise<unknown> {
  channelService ??= new ChannelService();
  return channelService.sendMessage(channel, {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    senderSessionId: sealed.senderSessionId,
    messageIndex: sealed.messageIndex,
    signature: sealed.signature,
    ...(post.messageId ? { messageId: post.messageId } : {}),
    ...(post.poll ? { poll: post.poll } : {}),
    ...(post.mentionedUserIds && post.mentionedUserIds.length
      ? { mentionedUserIds: post.mentionedUserIds }
      : {}),
    ...(post.mentionsEveryone ? { mentionsEveryone: true } : {}),
    ...(post.silent
      ? { silent: true }
      : { seedFrame: sealed.seedFrame, seedGroupId: sealed.seedGroupId }),
  });
}
