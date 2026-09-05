import { openChannelMessage } from '$lib/utils/graine/channelSeal';
import { reportUnreadableChannelMessage } from '$lib/utils/chat/channelCrypto';
import { decodeAppMessage } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope } from '$lib/envelope';
import { appMsgToEnvelope, appMsgToChannelSystemEnvelope } from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { setTyping } from '$lib/stores/typingStore.svelte';
import { applyPin } from '$lib/stores/pinStore.svelte';
import { applyChannelReactionFrame } from '$lib/stores/reactionStore.svelte';
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
  | 'onRolePermissionsChanged'
  | 'onChannelDeleted'
  | 'onWorkspaceUpdated'
  | 'onWorkspaceRoleChanged'
  | 'onWorkspaceDeleted'
  | 'onChannelMessageDeleted'
  | 'log'
> {
  /** Called when a commit is rejected (desynced epoch) - triggers a re-add request. */
  onOutOfSync: (groupId: string) => Promise<void>;
}

/**
 * An event of a type this bundle DOES handle, dropped because the field that addresses it is absent.
 *
 * The tail of the dispatcher already accuses on an unhandled TYPE, for a reason that applies word
 * for word one level down: it is silent data loss dressed as a no-op, and it can never fire on a
 * matched pair. A `workspace.role.changed` carrying no `workspaceId` is not a smaller version of
 * that - it is the same event lost with the same consequence, and the consequence is named in this
 * file's own comment twelve lines above the branch: a demoted administrator keeps every control
 * they have just lost, until they reload.
 *
 * It accuses rather than informs, and it is per-field rather than per-type, because "which one was
 * missing" is the whole content of the report - a server sending an event with no id and a server
 * sending one with an empty string are the same bug, and neither is visible from a count.
 */
function unaddressable(log: ChannelEventContext['log'], type: string, field: string): void {
  log(`[ERROR] ${type} arrived with no ${field} - nothing to address it to, the event is lost`);
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
    onRolePermissionsChanged,
    onChannelDeleted,
    onWorkspaceUpdated,
    onWorkspaceRoleChanged,
    onWorkspaceDeleted,
    onChannelMessageDeleted,
    log,
    onOutOfSync,
  } = ctx;

  // NO LINE ON ENTRY. It used to log every event here, which meant a line per `typing` and
  // `channel.typing` signal - the most frequent event on the transport by an order of magnitude,
  // and the noisiest line in the chat console during the MUT campaign. It said only that the
  // dispatcher had been reached, which the branch that follows says better and only when something
  // actually happened. The accusing line is now at the TAIL, where it names a type nobody handles:
  // that one can only fire if the server and this client disagree about the protocol, and it fired
  // nowhere before, because the function simply fell out of its last `if` in silence.

  // Ephemeral typing signal: `typing` (DM/group, keyed by groupId) and
  // `channel.typing` (community channel, keyed by channel_<id>). Both update the
  // shared typing store keyed by `conversation.id`.
  if (event.type === 'typing' || event.type === 'channel.typing') {
    const data = event.data || {};
    const userId = String(data.userId || '');
    if (!userId) return unaddressable(log, event.type, 'userId');
    const conversationId =
      event.type === 'channel.typing'
        ? `channel_${String(data.channelId || '')}`
        : String(data.groupId || '');
    // `channel_` is a prefix this client puts on, so the emptiness to test is the SERVER's field.
    if (!(event.type === 'channel.typing' ? data.channelId : data.groupId)) {
      return unaddressable(
        log,
        event.type,
        event.type === 'channel.typing' ? 'channelId' : 'groupId'
      );
    }
    setTyping(conversationId, userId, data.state !== 'stop');
    return;
  }

  if (event.type === 'channel.pin') {
    const data = event.data || {};
    const channelId = String(data.channelId || '');
    const messageId = String(data.messageId || '');
    // Stamped on receipt: a channel pin is server-authoritative and arrives in the server's own
    // order, so there is nothing to merge it against - the date only has to beat what we hold.
    if (channelId && messageId)
      applyPin(`channel_${channelId}`, messageId, !!data.pinned, Date.now());
    else unaddressable(log, event.type, channelId ? 'messageId' : 'channelId');
    return;
  }

  // Live poll tally update broadcast after a member votes. Keyed by the server
  // message id (same id used for the bubble + the vote endpoint).
  if (event.type === 'channel.poll.vote') {
    const data = event.data || {};
    const messageId = String(data.messageId || '');
    const poll = data.poll as ChannelPollMeta | undefined;
    if (messageId && poll) setPollMeta(messageId, poll);
    else unaddressable(log, event.type, messageId ? 'poll' : 'messageId');
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

  // Two server events, one meaning: someone lost access. `channel.member.kicked` covers a kick
  // from a channel and a removal from the whole community (no channelId then), while
  // `channel.member.removed` is the channel settings panel taking a user off one channel. They
  // are normalised here so a single client handler decides what is actually lost.
  if (event.type === 'channel.member.kicked' || event.type === 'channel.member.removed') {
    const data = event.data || {};
    onChannelMemberKicked?.({
      channelId: String(data.channelId || ''),
      channelName: data.channelName,
      workspaceId: data.workspaceId,
      kickedUserId: String(data.kickedUserId ?? data.removedUserId ?? ''),
      kickedBy: data.kickedBy ?? data.removedBy,
      channelIsPrivate: data.isPrivate === true,
    });
    return;
  }

  // THIS DEVICE'S OWN ROLE CHANGED, and the server addressed the event to it alone. Until this
  // existed the answer arrived on the next full load and not before: a demoted administrator kept
  // every control they had just lost until they reloaded. The permissions travel with the event, so
  // nothing has to be fetched back and there is no window in which the screen and the server
  // disagree.
  if (event.type === 'workspace.role.changed') {
    const data = event.data || {};
    const workspaceId = String(data.workspaceId || '');
    if (!workspaceId) return unaddressable(log, event.type, 'workspaceId');
    onWorkspaceRoleChanged?.({
      workspaceId,
      roleName: String(data.roleName || ''),
      // Read from the flag the server computed, and only from the list when it is absent - an older
      // server sends one or the other, and re-deriving it here would be a second copy of a rule
      // that already exists on the side that owns it.
      canManage:
        typeof data.canManage === 'boolean'
          ? data.canManage
          : Array.isArray(data.permissions) && data.permissions.includes('workspace.manage'),
      permissions: Array.isArray(data.permissions) ? data.permissions.map(String) : [],
    });
    return;
  }

  // WHAT A ROLE GRANTS CHANGED, and it is addressed to the whole community rather than to one
  // member: this is not "your role changed", it is "this role now grants X", which every open
  // permission grid in the community is drawing.
  if (event.type === 'workspace.role.permissions') {
    const data = event.data || {};
    const roleId = String(data.roleId || '');
    if (!roleId) return unaddressable(log, event.type, 'roleId');
    onRolePermissionsChanged?.({
      roleId,
      permissions: Array.isArray(data.permissions) ? data.permissions.map(String) : [],
    });
    return;
  }

  if (event.type === 'channel.updated') {
    const data = event.data || {};
    onChannelUpdated?.({
      channelId: String(data.channelId || ''),
      name: data.name,
      workspaceId: data.workspaceId,
      // ONLY WHEN THE SERVER ACTUALLY DECIDED. A rename carries no verdict about writing, and
      // reading an absent field as `false` would silence the composer of everyone in a salon
      // somebody renamed. Absent means unchanged, and the handler must treat it that way.
      viewerCanWrite: typeof data.viewerCanWrite === 'boolean' ? data.viewerCanWrite : undefined,
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

  if (event.type === 'channel.message.deleted') {
    const data = event.data || {};
    onChannelMessageDeleted?.({
      channelId: String(data.channelId || ''),
      messageId: String(data.messageId || ''),
      deletedBy: data.deletedBy,
    });
    return;
  }

  if (event.type === 'workspace.deleted') {
    const data = event.data || {};
    onWorkspaceDeleted?.({
      workspaceId: String(data.workspaceId || ''),
      deletedBy: data.deletedBy,
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
      let isSystemNotice = false;
      const channelServerMs = parseServerTimestampMs(data.createdAt);
      try {
        if (data.ciphertext) {
          // Opened here rather than left to the history reload: a live bubble that only appeared
          // after a refetch is the symptom the epoch-key path used to have.
          const bytes = await openChannelMessage(data.channelId, {
            ciphertext: data.ciphertext,
            nonce: data.nonce ?? null,
            senderSessionId: data.senderSessionId ?? null,
            messageIndex:
              data.messageIndex === undefined || data.messageIndex === null
                ? null
                : Number(data.messageIndex),
          });
          const msg = decodeAppMessage(bytes);
          // A reaction is a channel message now (WP-40), so it arrives on this very path. It
          // changes a bubble instead of adding one, and it is the ONLY live route reactions have -
          // there is no server tally left to broadcast.
          if (msg?.reaction) {
            applyChannelReactionFrame(
              String(msg.reaction.messageId ?? ''),
              String(sender || '').toLowerCase(),
              String(msg.reaction.emoji ?? ''),
              Number(msg.reaction.at ?? 0),
              msg.reaction.removed === true
            );
            return;
          }
          if (msg) {
            const envelope =
              appMsgToEnvelope(msg, channelServerMs) ??
              appMsgToChannelSystemEnvelope(msg, channelServerMs);
            if (envelope) {
              content = envelope.content;
              isSystemNotice = !!msg.system;
            }
          }
        } else if (data.plaintext) {
          content = serializeEnvelope(mkTextEnvelope(data.plaintext));
        }
      } catch (e) {
        // The SAME decision the history path takes, and for the same reason a live bubble is opened
        // here at all: a message whose seed has not landed yet must ASK for it, not wait for a
        // history reload to notice. `content` stays undefined, so the row is not rendered until the
        // repair announces it - which is the behaviour the comment below already described.
        reportUnreadableChannelMessage(
          data.channelId,
          String(data.messageId || data.id),
          String(sender || ''),
          channelServerMs,
          e
        );
      }

      // Only persist if decryption succeeded - a missing key means loadChannelHistory
      // will replay it cleanly after a fresh key hydration.
      if (content === undefined) return;

      // Keyed by the SERVER row id, exactly like the history load (`decodeChannelMessageRow`).
      // Every server-side operation on a channel message - delete, pin, poll vote, reaction -
      // addresses it by that id, and a channel send has no optimistic echo to reconcile
      // (see `sendChatMessage`), so the AppMessage id would only make the live bubble
      // unaddressable until the next reload.
      const renderedId = String(data.messageId || data.id);
      const poll = data.poll as ChannelPollMeta | undefined;
      if (poll) setPollMeta(renderedId, poll);

      // A membership notice is attributed to nobody, exactly like `decodeChannelMessageRow` does
      // on the history path - otherwise the same event reads as a message from its trigger.
      addMessageToChat(isSystemNotice ? 'system' : sender, content, convoKey, {
        messageId: renderedId,
        timestamp: channelServerMs !== undefined ? new Date(channelServerMs) : undefined,
        skipDbSave: true,
        ...(isSystemNotice ? { isSystem: true } : {}),
      }).catch((e) => console.error(e));
    } else {
      log(`Message received for an unknown channel: ${channelId}`);
    }
    return;
  }

  // NOTHING HANDLED IT. Every branch above returns, so reaching here means the delivery service
  // broadcast an event type this bundle does not know - a client older than the server, or a type
  // added on one side only. It is silent data loss dressed as a no-op, so it accuses rather than
  // informs, and it can never fire on a matched pair.
  log(`[ERROR] Unhandled channel event type: ${event?.type}`);
  console.error('[Channel Event] no handler for type', event?.type);
}
