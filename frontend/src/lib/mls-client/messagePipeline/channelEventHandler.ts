import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { decodeAppMessage } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope } from '$lib/envelope';
import { appMsgToEnvelope } from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { setTyping } from '$lib/stores/typingStore.svelte';
import { applyPin } from '$lib/stores/pinStore.svelte';
import { setPollMeta } from '$lib/stores/pollStore.svelte';
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import type { MessageHandlerDeps } from './deps';

/**
 * Context for handleChannelEvent: MessageHandlerDeps plus the epoch-recovery
 * trigger (a closure over local state in setupMessageHandler).
 */
export interface ChannelEventContext extends Pick<
  MessageHandlerDeps,
  | 'conversations'
  | 'addMessageToChat'
  | 'onChannelMemberJoined'
  | 'onChannelMemberKicked'
  | 'onChannelUpdated'
  | 'onChannelDeleted'
  | 'onWorkspaceUpdated'
  | 'log'
> {
  /** Appelé quand un commit est rejeté (epoch désynchronisée) - déclenche une demande de re-add. */
  onOutOfSync: (groupId: string) => Promise<void>;
}

/**
 * Dispatches a server-push channel event (received via mlsService.onChannelEvent) to
 * the appropriate UI callback or local key-store mutation.
 *
 * The `epoch_rejected` event is also handled here because it arrives on the same
 * transport as channel events from the delivery service.
 */

export async function handleChannelEvent(event: any, ctx: ChannelEventContext): Promise<void> {
  const {
    conversations,
    addMessageToChat,
    onChannelMemberJoined,
    onChannelMemberKicked,
    onChannelUpdated,
    onChannelDeleted,
    onWorkspaceUpdated,
    log,
    onOutOfSync,
  } = ctx;

  log(`[Channel Event] ${event.type}`);

  // Ephemeral typing signal: `typing` (DM/group, keyed by groupId) and
  // `channel.typing` (community channel, keyed by channel_<id>). Both update the
  // shared typing store keyed by `conversation.id`.
  if (event.type === 'typing' || event.type === 'channel.typing') {
    const data = event.data || {};
    const userId = String(data.userId || '');
    if (!userId) return;
    const conversationId =
      event.type === 'channel.typing'
        ? `channel_${String(data.channelId || '')}`
        : String(data.groupId || '');
    if (!conversationId) return;
    setTyping(conversationId, userId, data.state !== 'stop');
    return;
  }

  if (event.type === 'channel.pin') {
    const data = event.data || {};
    const channelId = String(data.channelId || '');
    const messageId = String(data.messageId || '');
    if (channelId && messageId) applyPin(`channel_${channelId}`, messageId, !!data.pinned);
    return;
  }

  // Live poll tally update broadcast after a member votes. Keyed by the server
  // message id (same id used for the bubble + the vote endpoint).
  if (event.type === 'channel.poll.vote') {
    const data = event.data || {};
    const messageId = String(data.messageId || '');
    const poll = data.poll as ChannelPollMeta | undefined;
    if (messageId && poll) setPollMeta(messageId, poll);
    return;
  }

  if (event.type === 'channel.member.joined') {
    const data = event.data || {};
    onChannelMemberJoined?.({
      channelId: String(data.channelId || ''),
      channelName: data.channelName,
      workspaceId: data.workspaceId,
      workspaceSlug: data.workspaceSlug,
      workspaceName: data.workspaceName,
      visibility: data.visibility,
      roleName: data.roleName,
      joinedBy: data.joinedBy,
    });
    return;
  }

  if (event.type === 'channel.member.kicked') {
    const data = event.data || {};
    onChannelMemberKicked?.({
      channelId: String(data.channelId || ''),
      channelName: data.channelName,
      workspaceId: data.workspaceId,
      kickedBy: data.kickedBy,
    });
    return;
  }

  if (event.type === 'channel.updated') {
    const data = event.data || {};
    onChannelUpdated?.({
      channelId: String(data.channelId || ''),
      name: data.name,
      workspaceId: data.workspaceId,
      imageMediaId: data.imageMediaId,
    });
    return;
  }

  if (event.type === 'workspace.updated') {
    const data = event.data || {};
    onWorkspaceUpdated?.({
      workspaceId: String(data.workspaceId || ''),
      imageMediaId: data.imageMediaId,
    });
    return;
  }

  if (event.type === 'channel.deleted') {
    const data = event.data || {};
    onChannelDeleted?.({
      channelId: String(data.channelId || ''),
      workspaceId: data.workspaceId,
    });
    return;
  }

  if (event.type === 'channel.key.rotated') {
    const data = event.data || {};
    const channelId = String(data.channelId || '');
    const newEpochBaseKey = data.newEpochBaseKey;
    const keyVersion = data.keyVersion;
    if (channelId && newEpochBaseKey && keyVersion !== undefined) {
      try {
        if (!Number.isInteger(keyVersion) || keyVersion < 0) {
          throw new Error(`Invalid keyVersion: ${keyVersion}`);
        }
        if (
          typeof newEpochBaseKey !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(newEpochBaseKey)
        ) {
          throw new Error('Invalid base64 format for epoch key');
        }
        const vault = channelKeyManager.getVault(channelId);
        const rawKeyMat = new Uint8Array(
          atob(newEpochBaseKey)
            .split('')
            .map((c) => c.charCodeAt(0))
        );
        if (rawKeyMat.length < 32) {
          throw new Error(`Key material too short: ${rawKeyMat.length} bytes`);
        }
        await vault.rotateKey(keyVersion, rawKeyMat);
        log(`[Key Rotation] Epoch ${keyVersion} stored for Channel ${channelId}`);
      } catch (e) {
        log(`[ERROR] Key rotation failed for channel ${channelId}: ${e}`);
        console.error('[Key Rotation] failed for channel', channelId, e);
      }
    }
    return;
  }

  if (event.type === 'epoch_rejected') {
    const data = event.data || {};
    const groupId = String(data.groupId || '');
    const currentEpoch = Number(data.currentEpoch || 0);
    log(
      `[EPOCH] Commit rejeté pour groupe ${groupId.slice(0, 8)}… (epoch serveur: ${currentEpoch}) - re-add`
    );
    if (groupId) await onOutOfSync(groupId);
    return;
  }

  if (event.type === 'channel.message.created') {
    const data = event.data;
    const channelId = `channel_${data.channelId}`;
    const sender = data.senderId;
    const convoKey: string | undefined = conversations.has(channelId) ? channelId : undefined;

    if (convoKey) {
      let content: string | undefined;
      let appMessageId: string | undefined;
      const channelServerMs = parseServerTimestampMs(data.createdAt);
      try {
        if (data.ciphertext) {
          if (!data.nonce || data.keyVersion === undefined) return;
          const bytes = await channelKeyManager.decryptMessage(
            data.channelId,
            data.ciphertext,
            data.nonce,
            data.keyVersion
          );
          const msg = decodeAppMessage(bytes);
          appMessageId = msg?.messageId || undefined;
          if (msg) {
            const envelope = appMsgToEnvelope(msg, channelServerMs);
            if (envelope) content = envelope.content;
          }
        } else if (data.plaintext) {
          content = serializeEnvelope(mkTextEnvelope(data.plaintext));
        }
      } catch (e) {
        console.error('Failed to parse channel message:', e);
      }

      // Only persist if decryption succeeded - a missing key means loadChannelHistory
      // will replay it cleanly after a fresh key hydration.
      if (content === undefined) return;

      // Polls are keyed by the server message id (not the AppMessage id) so the
      // bubble, the vote endpoint and the live vote events all agree on one id.
      const poll = data.poll as ChannelPollMeta | undefined;
      const renderedId = poll
        ? String(data.messageId || data.id)
        : appMessageId || data.messageId || data.id;
      if (poll && renderedId) setPollMeta(renderedId, poll);

      addMessageToChat(sender, content, convoKey, {
        messageId: renderedId,
        timestamp: channelServerMs !== undefined ? new Date(channelServerMs) : undefined,
        skipDbSave: true,
      }).catch((e) => console.error(e));
    } else {
      log(`Canal inconnu reçu: ${channelId}`);
    }
  }
}
