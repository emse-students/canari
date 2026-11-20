import { applySalonEchoChange } from '$lib/utils/chat/salonEcho';
import type { ChannelWritePolicy, WriteVerdicts } from '$lib/services/ChannelService';
import { clearUnsentSalonTexts } from '$lib/utils/chat/salonUnsent';
import { forgetDeliveredSalonSend } from '$lib/utils/chat/messaging';
import { openChannelMessageProving } from '$lib/utils/graine/channelSeal';
import {
  reportUnreadableChannelMessage,
  type DecodedChannelReaction,
} from '$lib/utils/chat/channelCrypto';
import { oweLiveDecision, owedLiveGeneration } from '$lib/utils/chat/owedLiveFrames';
import { channelReactionOf } from '$lib/utils/chat/messageReactions';
import { decodeAppMessage } from '$lib/proto/codec';
import { appMsgToEnvelope } from '$lib/utils/chat/messageUtils';
import { channelSystemEnvelope } from '$lib/utils/chat/channelNotice';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { setTyping } from '$lib/stores/typingStore.svelte';
import { ADMIN_QUEUES_CHANGED_FRAME, adminQueuesChanged } from '$lib/admin/adminQueueCounts.svelte';
import { applyPin } from '$lib/stores/pinStore.svelte';
import { applyChannelEdit } from '$lib/utils/chat/channelEdit';
import { applyChannelReactionFrame } from '$lib/stores/reactionStore.svelte';
import { setPollMeta } from '$lib/stores/pollStore.svelte';
import { mergeReadWatermark, withOwnReadAdvanced } from '$lib/utils/chat/readState';
import { publishReadState } from '$lib/mls-client/tabMessageSync';
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import type { MessageHandlerDeps } from './deps';
import { isJoinAskOutcome } from '../joinAskFrames';
import { salonGrants } from '$lib/utils/chat/memberRemoval';
import { applyCommunityNicknameEvent } from '$lib/utils/chat/nicknameActions';
import { recordNativeReadElsewhere } from '$lib/utils/nativeNotification';

/**
 * Context for handleChannelEvent: MessageHandlerDeps plus the epoch-recovery
 * trigger (a closure over local state in setupMessageHandler).
 */
export interface ChannelEventContext extends Pick<
  MessageHandlerDeps,
  | 'onJoinAsk'
  | 'onJoinAskSettled'
  | 'conversations'
  | 'userId'
  | 'addMessageToChat'
  | 'onChannelMemberJoined'
  | 'onChannelMemberKicked'
  | 'onChannelRemovalReleased'
  | 'onChannelUpdated'
  | 'onRolePermissionsChanged'
  | 'onChannelDeleted'
  | 'onWorkspaceUpdated'
  | 'onSalonUnreadCleared'
  | 'onSalonArrivalUncounted'
  | 'onWorkspaceRoleChanged'
  | 'onWorkspaceDeleted'
  | 'onChannelMessageDeleted'
  | 'onInboundReaction'
  | 'storage'
  | 'deviceKey'
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
    onChannelRemovalReleased,
    onChannelUpdated,
    onRolePermissionsChanged,
    onChannelDeleted,
    onWorkspaceUpdated,
    onSalonUnreadCleared,
    onSalonArrivalUncounted,
    onWorkspaceRoleChanged,
    onWorkspaceDeleted,
    onChannelMessageDeleted,
    log,
    onOutOfSync,
    onJoinAsk,
    onJoinAskSettled,
    onInboundReaction,
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

  // An admin queue this reader may act on changed (owner, 2026-11-18): the frame carries nothing,
  // the badges ask the server for their counts.
  if (event.type === ADMIN_QUEUES_CHANGED_FRAME) {
    adminQueuesChanged('frame');
    return;
  }

  // A new person asks to join a group conversation, announced to every online admitted member.

  if (event.type === 'group.join_ask') {
    const data = event.data || {};
    const groupId = String(data.groupId || '');
    const requesterUserId = String(data.requesterUserId || '');
    const askId = String(data.askId || '');
    if (!groupId || !requesterUserId || !askId) {
      return unaddressable(
        log,
        event.type,
        !groupId ? 'groupId' : !requesterUserId ? 'requesterUserId' : 'askId'
      );
    }
    const requesterDeviceIds = Array.isArray(data.requesterDeviceIds)
      ? (data.requesterDeviceIds as unknown[]).filter(
          (d): d is string => typeof d === 'string' && !!d
        )
      : [];
    onJoinAsk?.({ groupId, askId, requesterUserId, requesterDeviceIds });
    return;
  }

  // That ask ended - answered, withdrawn or expired: the server's outcome takes it off this screen.
  if (event.type === 'group.join_ask.settled') {
    const data = event.data || {};
    const groupId = String(data.groupId || '');
    const userId = String(data.userId || '');
    const askId = String(data.askId || '');
    if (!groupId || !userId || !askId) {
      return unaddressable(log, event.type, !groupId ? 'groupId' : !userId ? 'userId' : 'askId');
    }
    if (!isJoinAskOutcome(data.outcome)) {
      log(
        `[ERROR] ${event.type} carries an unknown outcome "${String(data.outcome)}" - the ask stays`
      );
      return;
    }
    onJoinAskSettled?.({ groupId, userId, askId, outcome: data.outcome });
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
    // The grant's revision, for each person it names, orders it against a removal (`salonGrants`).
    const granted: string[] = Array.isArray(data.grantedUserIds)
      ? data.grantedUserIds.map(String)
      : data.joinedBy
        ? [String(data.joinedBy)]
        : [];
    salonGrants.noteGrant(String(data.channelId || ''), granted, data.accessRevision);
    onChannelMemberJoined?.({
      channelId: String(data.channelId || ''),
      channelName: data.channelName,
      workspaceId: data.workspaceId,
      workspaceSlug: data.workspaceSlug,
      workspaceName: data.workspaceName,
      visibility: data.visibility,
      roleName: data.roleName,
      joinedBy: data.joinedBy,
      // Absent stays absent: a row heard of live must not invent a policy or a verdict.
      writePolicy: isWritePolicy(data.writePolicy) ? data.writePolicy : undefined,
      viewerCanWrite: typeof data.viewerCanWrite === 'boolean' ? data.viewerCanWrite : undefined,
    });
    return;
  }

  // Two server events, one meaning: someone lost access. `channel.member.kicked` covers a kick
  // from a channel and a removal from the whole community (no channelId then), while
  // `channel.member.removed` is the channel settings panel taking a user off one channel. They
  // are normalised here so a single client handler decides what is actually lost.
  if (event.type === 'channel.member.kicked' || event.type === 'channel.member.removed') {
    const data = event.data || {};
    const channelId = String(data.channelId || '');
    const kickedUserId = String(data.kickedUserId ?? data.removedUserId ?? '');
    // A removal OLDER than a grant already seen for the same person and salon (a leave, then a
    // quick re-invitation) changes nothing: acting on it would purge a salon they are back in.
    if (channelId && salonGrants.supersedes(channelId, kickedUserId, data.accessRevision)) {
      log(
        `[CHANNEL] removal of ${kickedUserId.slice(0, 8)} from ${channelId.slice(0, 8)} at access revision ${data.accessRevision} is older than a grant already seen - ignored`
      );
      return;
    }
    onChannelMemberKicked?.({
      channelId,
      channelName: data.channelName,
      workspaceId: data.workspaceId,
      kickedUserId,
      kickedBy: data.kickedBy ?? data.removedBy,
      actorDeviceId: typeof data.actorDeviceId === 'string' ? data.actorDeviceId : undefined,
      channelIsPrivate: data.isPrivate === true,
    });
    return;
  }

  // THE ACTOR RELEASED A REMOVE IT CLAIMED (channel-encryption section 10): it did not commit it, and
  // the scope's remaining members elect a committer - on this event, never on a guess.
  if (event.type === 'channel.member.removal-released') {
    const data = event.data || {};
    const workspaceId = String(data.workspaceId || '');
    const removedUserId = String(data.removedUserId || '');
    // WHO released it: its leaves are out of the election, or the releaser is elected again.
    const releasedBy = String(data.releasedBy || '');
    // ...and BY WHICH DEVICE: only a receiver that deferred to that device's leaf re-decides.
    const releasedByDevice = String(data.releasedByDevice || '');
    if (!workspaceId) return unaddressable(log, event.type, 'workspaceId');
    if (!removedUserId) return unaddressable(log, event.type, 'removedUserId');
    if (!releasedBy) return unaddressable(log, event.type, 'releasedBy');
    if (!releasedByDevice) return unaddressable(log, event.type, 'releasedByDevice');
    onChannelRemovalReleased?.({
      workspaceId,
      channelId: String(data.channelId || ''),
      removedUserId,
      releasedBy,
      releasedByDevice,
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
      // No fallback derivation for this one: an older server that does not send it leaves the
      // cached flag where the last listing put it, which is what "absent" means here.
      canManageChannels:
        typeof data.canManageChannels === 'boolean' ? data.canManageChannels : undefined,
      // Same shape: absent leaves `viewerCanModerate` where the last listing put it.
      canModerate: typeof data.canModerate === 'boolean' ? data.canModerate : undefined,
      // Same shape: absent leaves every salon's `canWrite` where the last listing put it.
      canWriteByPolicy: writeVerdictsOf(data.canWriteByPolicy),
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
      // The community's own name for the role: a string, or null for "none - use the default". ABSENT
      // (a server older than the rename) leaves the name where the last listing put it.
      label: typeof data.label === 'string' ? data.label : data.label === null ? null : undefined,
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
      writePolicy: isWritePolicy(data.writePolicy) ? data.writePolicy : undefined,
    });
    return;
  }

  if (event.type === 'workspace.updated') {
    const data = event.data || {};
    if (data.nickname !== undefined) {
      // A COMMUNITY NICKNAME CHANGED ("Modifier les pseudos"). It rides this type because every
      // client knows it - an older one ignores the field - and the event carries nothing else, so
      // the community entry is not touched.
      applyCommunityNicknameEvent(String(data.workspaceId || ''), data.nickname);
      return;
    }
    onWorkspaceUpdated?.({
      workspaceId: String(data.workspaceId || ''),
      imageMediaId: data.imageMediaId,
      channelsReordered: data.channelsReordered === true,
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
      `[EPOCH] Commit rejected for group ${groupId.slice(0, 8)}… (server epoch: ${currentEpoch}) - re-add`
    );
    if (groupId) await onOutOfSync(groupId);
    return;
  }

  // A SALON'S READ RECEIPT, the server's twin of the DM `read_watermark` frame: one reader's mark
  // moved, merged as max into the same `readWatermarks` the "Lu par" row and the unread badge read,
  // so a salon renders exactly as a group does. It includes this user's OWN mark from another
  // device, which is what moves the in-thread badge here. No read tone: a salon of two hundred
  // would ring for ever.
  if (event.type === 'channel.read') {
    const data = event.data || {};
    const channelId = String(data.channelId || '');
    const userId = String(data.userId || '');
    if (!channelId) return unaddressable(log, event.type, 'channelId');
    if (!userId) return unaddressable(log, event.type, 'userId');
    const key = `channel_${channelId}`;
    const convo = conversations.get(key);
    // Not held here: nothing draws it, and its next load reads every mark from the server.
    if (!convo) return;
    // MY OWN MARK FROM ANOTHER DEVICE ALSO CLEARS THE COUNT THIS DEVICE DRAWS. It used to merge the
    // watermark and stop, so a salon read on the phone stayed unread here - tile, nav dot and tab
    // title `(N)` - until it was opened on this device too.
    const next =
      userId.toLowerCase() === ctx.userId.toLowerCase()
        ? // A salon's marks are on the stamped map, where a salon row's stamp IS its server time.
          withOwnReadAdvanced(convo, userId, Number(data.at), 'stamped')
        : (() => {
            const merged = mergeReadWatermark(convo.readWatermarks, userId, Number(data.at));
            return merged ? { ...convo, readWatermarks: merged } : convo;
          })();
    // MY OWN MARK: the salon's Android banner goes too, by the socket as well as by the
    // `channel_read` push - the WebView posted it, and the push alone left it standing in front
    // (owner's report, 2026-11-20). OUTSIDE `next !== convo`: a mark already held moves nothing here
    // and its banner still has to go. Recorded on every own read, dismissed only at zero unread.
    if (userId.toLowerCase() === ctx.userId.toLowerCase()) {
      void recordNativeReadElsewhere(
        key,
        'channel.read',
        Number(data.at),
        'stamped',
        next.unreadCount === 0
      );
    }
    if (next !== convo) {
      conversations.set(key, next);
      // A follower tab of this browser has no socket: it learns the mark from here (`read_state`).
      publishReadState(key, userId.toLowerCase(), Number(data.at), 'stamped');
    }
    return;
  }

  // THIS ACCOUNT EMPTIED A COMMUNITY'S UNREAD ("Marquer tout comme lu") on one of its devices. The
  // server addresses it to this account alone - the salon's other members learn nothing, which is
  // why it is not a `channel.read`. The marks it carries are the CLEARING device's bound; a device
  // holding other messages cannot apply them locally without guessing, so it re-reads the counts.
  if (event.type === 'channel.unread.cleared') {
    const data = event.data || {};
    const workspaceId = String(data.workspaceId || '');
    if (!workspaceId) return unaddressable(log, event.type, 'workspaceId');
    log(
      `[CHANNEL_CLEAR] community ${workspaceId.slice(0, 8)} cleared on a device of this account (${Object.keys(data.cleared || {}).length} salon(s)) - re-reading counts`
    );
    onSalonUnreadCleared?.({ workspaceId });
    return;
  }

  if (event.type === 'channel.message.created') {
    const data = event.data;
    const channelId = `channel_${data.channelId}`;
    const sender = data.senderId;
    // THE ROW'S SERVER ID, the one key every path names it by - the frame carries it as `messageId`
    // and nothing else (`ChannelService.runFanout`). Without it the bubble has no address.
    const messageId = data.messageId ? String(data.messageId) : '';
    if (!messageId) return unaddressable(log, event.type, 'messageId');
    const convoKey: string | undefined = conversations.has(channelId) ? channelId : undefined;

    if (convoKey) {
      let content: string | undefined;
      let isSystemNotice = false;
      // The client UUID sealed INSIDE the ciphertext: what this device's own echo is keyed by.
      let innerMessageId: string | undefined;
      // Whether the open PROVED the author (a v2 session): the native banner names a speaker only
      // then, and the push trigger decides from the same fact - see `openChannelMessageProving`.
      let authorProven = false;
      const channelServerMs = parseServerTimestampMs(data.createdAt);
      // Set when the frame could not be OPENED - as opposed to opened and found to be no bubble.
      let unopened = false;
      // Captured before the open's await: a session ending meanwhile must not receive this frame's
      // parked decision (`owedLiveFrames.ts`).
      const parkGeneration = owedLiveGeneration();
      try {
        if (data.ciphertext) {
          // Opened here rather than left to the history reload: a live bubble that only appeared
          // after a refetch is the symptom the epoch-key path used to have.
          const opening = await openChannelMessageProving(data.channelId, {
            // The same id the bubble is keyed by below, and the history load reads: a row opened
            // on both paths is one row, never its own replay.
            id: messageId,
            senderId: String(sender || ''),
            signature: data.signature ?? null,
            ciphertext: data.ciphertext,
            nonce: data.nonce ?? null,
            senderSessionId: data.senderSessionId ?? null,
            messageIndex:
              data.messageIndex === undefined || data.messageIndex === null
                ? null
                : Number(data.messageIndex),
          });
          authorProven = opening.authorProven;
          const msg = decodeAppMessage(opening.bytes);
          // A reaction is a channel message now (WP-40), so it arrives on this very path. It
          // changes a bubble instead of adding one, and it is the ONLY live route reactions have -
          // there is no server tally left to broadcast.
          if (msg?.reaction) {
            log(
              `Channel reaction applied to ${String(msg.reaction.messageId ?? '')} (removed=${msg.reaction.removed === true})`
            );
            const reaction = channelReactionOf(msg.reaction, String(sender || ''));
            const changed = applyChannelReactionFrame(
              reaction.targetMessageId,
              reaction.senderId,
              reaction.emoji,
              reaction.at,
              reaction.removed
            );
            // The frame trigger of a reaction notification. A salon frame on this path is LIVE by
            // construction - the server fans it out the moment it is posted; a page of history is
            // read by `useConversations`, which raises nothing.
            await raiseLiveChannelReaction(channelId, reaction, changed, ctx);
            return;
          }
          // An edit is a silent row as well, and changes a bubble instead of adding one. The
          // sender is the row's - proven by Graine v2 - and `applyChannelEdit` compares it with
          // the target's author. A bubble not loaded here is picked up by the next history load,
          // which reads the same row.
          if (msg?.edit) {
            log(`Channel edit received for ${String(msg.edit.messageId ?? '')}`);
            const current = conversations.get(channelId);
            if (current) {
              const { messages, applied } = applyChannelEdit(
                current.messages,
                {
                  targetMessageId: String(msg.edit.messageId ?? ''),
                  senderId: String(sender || '').toLowerCase(),
                  newContent: String(msg.edit.newContent ?? ''),
                  editedAt: Number(msg.edit.editedAt ?? 0),
                },
                log
              );
              if (applied) conversations.set(channelId, { ...current, messages });
            }
            return;
          }
          if (msg) {
            innerMessageId = msg.messageId ? String(msg.messageId) : undefined;
            const envelope =
              appMsgToEnvelope(msg, channelServerMs) ??
              (await channelSystemEnvelope(
                msg,
                channelServerMs,
                String(sender || '').toLowerCase()
              ));
            if (envelope) {
              content = envelope.content;
              isSystemNotice = !!msg.system;
            }
          }
        } else {
          // A SALON MESSAGE IS SEALED, ALWAYS: its author is proven only by opening it, and neither
          // the server nor the history path has anything else. A frame without a ciphertext names an
          // author nobody proved, so it accuses the server and is rendered nowhere.
          const refused = `[CHANNEL] Message ${messageId} of ${String(data.channelId).slice(0, 8)} is REFUSED and not rendered - a live frame without a ciphertext (sender named: ${String(sender || '').slice(0, 8)})`;
          log(`[ERROR] ${refused}`);
          console.error(refused);
          return;
        }
      } catch (e) {
        unopened = true;
        // The SAME decision the history path takes, and for the same reason a live bubble is opened
        // here at all: a message whose seed has not landed yet must ASK for it, not wait for a
        // history reload to notice. `content` stays undefined, so the row is not rendered until the
        // repair announces it - which is the behaviour the comment below already described.
        const repairable = reportUnreadableChannelMessage(
          data.channelId,
          messageId,
          String(sender || ''),
          channelServerMs,
          e
        );
        // THIS ROW ARRIVED LIVE, AND THE READER THAT WILL OPEN IT IS NOT. The repair re-reads the
        // salon as history, which raises no reaction by design - so a reaction that was the first
        // frame of its sender's new seed session was drawn by nobody while the push was dropped in
        // front (Mi 9T, 1.7.0-alpha.10). Its live decision is parked under its id and taken by the
        // reader that opens it (`owedLiveFrames.ts`). Only a SILENT row can be a reaction (the
        // server knows nothing else about a body it cannot read), so a line never parks.
        if (repairable && data.silent === true && onInboundReaction) {
          oweLiveDecision(
            String(data.channelId),
            messageId,
            parkGeneration,
            (reaction, changed) => {
              void raiseLiveChannelReaction(channelId, reaction, changed, ctx).catch((err) =>
                console.error(
                  `[NOTIF] the owed live decision of ${messageId.slice(0, 8)} failed: ${String(err)}`
                )
              );
            }
          );
        }
      }

      // Only persist if decryption succeeded - a missing key means loadChannelHistory
      // will replay it cleanly after a fresh key hydration.
      if (content === undefined) {
        // AN UNOPENED FRAME IS STILL AN ARRIVAL, AND ITS BADGE IS OWED NOW. The live tally counts
        // a ROW, so a message whose seed had not landed raised nothing, and the repair that later
        // draws it is a history load, which counts nothing either: a salon granted (or a community
        // joined) a moment ago showed no badge for every message sent before its seed arrived,
        // until it was opened once (Mi 9T and iPhone, 1.7.0-alpha.5 / 1.6.12-alpha.2). The frame
        // says in the clear what the server's count asks - its author and `silent` - so the
        // decision is taken here, and the count is the server's, which already holds this row.
        const fromOther = String(sender || '').toLowerCase() !== ctx.userId.toLowerCase();
        if (unopened && fromOther && data.silent !== true) {
          log(
            `[UNREAD] ${messageId.slice(0, 8)} of ${String(data.channelId).slice(0, 8)} could not be opened here - its badge is asked of the server's count`
          );
          onSalonArrivalUncounted?.({ channelId: String(data.channelId), messageId });
        } else if (unopened) {
          log(
            `[UNREAD] ${messageId.slice(0, 8)} of ${String(data.channelId).slice(0, 8)} could not be opened here - ${fromOther ? 'silent' : 'own'}, no badge owed`
          );
        }
        return;
      }

      // Keyed by the SERVER row id, exactly like the history load (`decodeChannelMessageRow`).
      // Every server-side operation on a channel message - delete, pin, poll vote, reaction -
      // addresses it by that id; the author's own echo, shown under the AppMessage id, is
      // re-keyed to it just below (WP-OFF-2), so the AppMessage id never names a live bubble.
      const renderedId = messageId;
      const poll = data.poll as ChannelPollMeta | undefined;
      if (poll) setPollMeta(renderedId, poll);

      // THIS DEVICE'S OWN ECHO of the message, if it is still showing one under the client UUID: it
      // takes the server's id here instead of being drawn a second time (WP-OFF-2). A no-op for every
      // message that is not an echo - only a row flagged `awaitingServerId` is ever touched.
      // ONLY THE AUTHOR HAS ONE: the frame names its sender in the clear (and Graine v2 proves it),
      // so another member sealing a message under the same client UUID cannot re-key this device's
      // echo - `applySalonEchoChange` would otherwise swap any awaiting row for that id.
      const ownClientId =
        innerMessageId &&
        innerMessageId !== renderedId &&
        String(sender || '').toLowerCase() === ctx.userId.toLowerCase()
          ? innerMessageId
          : undefined;
      if (ownClientId) {
        applySalonEchoChange(
          conversations,
          convoKey,
          ownClientId,
          { kind: 'settled', serverId: renderedId, serverMs: channelServerMs },
          log
        );
        // The frame is the proof the server holds it: the unsent ledger must not hand it back, and
        // the send must stop - its hold for the server, its ladder step, its debt to the reconnect -
        // or a delivered message is POSTed again, and with a lasting "not now", for ever (review of
        // #3189, D3). The ledger is cleared on its own too: an entry of a past page life has no send.
        forgetDeliveredSalonSend(ownClientId, ctx.userId);
        clearUnsentSalonTexts(ctx.userId, [ownClientId]);
      }

      // A membership notice is attributed to nobody, exactly like `decodeChannelMessageRow` does
      // on the history path - otherwise the same event reads as a message from its trigger.
      addMessageToChat(isSystemNotice ? 'system' : sender, content, convoKey, {
        messageId: renderedId,
        timestamp: channelServerMs !== undefined ? new Date(channelServerMs) : undefined,
        // The row's own clock, kept beside the displayed one so the read receipt and the unread
        // reconcile can compare with the server's rows (see `reconcileSalonUnread`).
        serverTimestamp: channelServerMs,
        skipDbSave: true,
        authorProven,
        // A follower tab may be the one that composed it: the id lets it settle its echo.
        ...(ownClientId ? { clientMessageId: ownClientId } : {}),
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

/**
 * Hands one applied salon reaction to the frame trigger as LIVE, with the author of the message it
 * landed on (`salonMessageAuthor`). Two callers: the live frame opened at once, and a live frame
 * whose seed arrived after it, opened later by the reader that took its owed decision
 * (`owedLiveFrames.ts`). A context without `onInboundReaction` raises nothing.
 */
async function raiseLiveChannelReaction(
  channelId: string,
  reaction: DecodedChannelReaction,
  changed: boolean,
  ctx: Pick<ChannelEventContext, 'conversations' | 'storage' | 'deviceKey' | 'onInboundReaction'>
): Promise<void> {
  if (!ctx.onInboundReaction) return;
  const author = await salonMessageAuthor(
    channelId,
    reaction.targetMessageId,
    reaction.targetAuthorId,
    // Only NEWS pays for a store read: a replay or a removal is discarded by the trigger whoever
    // wrote the message.
    changed && !reaction.removed,
    ctx
  );
  ctx.onInboundReaction({
    conversationKey: channelId,
    messageId: reaction.targetMessageId,
    reactorId: reaction.senderId,
    emoji: reaction.emoji,
    at: reaction.at,
    removed: reaction.removed,
    changed,
    messageAuthorId: author.id,
    authorLookupFailed: author.lookupFailed,
    live: true,
  });
}

/**
 * The author of a salon row a reaction landed on, in the order `InboundReaction.messageAuthorId`
 * states and the MLS path follows (`setupMessageHandler`: the held row, else the stated author):
 * SCREEN, STORE, CLAIM. The row in memory (its sender proven by Graine), else - for a frame that is
 * news, and only then - the salon's stored page (`storeSalonPage` in `useConversations`, the last
 * page an earlier session drew), else the author the frame STATES (`ReactionMsg.target_author_id`, the
 * reactor's own claim - the one its push to the author already rests on). A row this device holds
 * outranks a claim (review of #3792, round 3). `lookupFailed` says the store was asked and could not
 * answer; it is warned here, and it decides only when no claim stands in (`unresolved`).
 */
async function salonMessageAuthor(
  channelId: string,
  messageId: string,
  statedAuthorId: string | null,
  isNews: boolean,
  ctx: Pick<ChannelEventContext, 'conversations' | 'storage' | 'deviceKey'>
): Promise<{ id: string | null; lookupFailed: boolean }> {
  const shown = ctx.conversations.get(channelId)?.messages.find((m) => m.id === messageId);
  if (shown) return { id: shown.senderId, lookupFailed: false };
  // A frame that is no news, or a session with no store: nothing to ask, and nothing failed.
  if (!isNews || !ctx.storage) return { id: statedAuthorId, lookupFailed: false };
  try {
    const found = await ctx.storage.getMessagesByIds(channelId, [messageId], ctx.deviceKey());
    if (found.unreadable.has(messageId)) {
      console.warn(
        `[REACTION] ${messageId.slice(0, 8)} is stored under a key this device cannot open - its author is ${statedAuthorId ? 'the one the frame states' : 'unknown'}`
      );
      return { id: statedAuthorId, lookupFailed: true };
    }
    return { id: found.rows.get(messageId)?.senderId ?? statedAuthorId, lookupFailed: false };
  } catch (e) {
    console.warn(
      `[REACTION] the stored row of ${messageId.slice(0, 8)} could not be read - its author is ${statedAuthorId ? 'the one the frame states' : 'unknown'}: ${String(e)}`
    );
    return { id: statedAuthorId, lookupFailed: true };
  }
}

/** Whether `value` is one of the three salon write policies. */
function isWritePolicy(value: unknown): value is ChannelWritePolicy {
  return value === 'everyone' || value === 'admins_moderators' || value === 'admins';
}

/**
 * The `canWriteByPolicy` table of a `workspace.role.changed`, or undefined unless it states a
 * boolean for EVERY policy - a partial table would leave some salons judged and others not.
 */
export function writeVerdictsOf(value: unknown): WriteVerdicts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.everyone !== 'boolean' ||
    typeof v.admins_moderators !== 'boolean' ||
    typeof v.admins !== 'boolean'
  ) {
    return undefined;
  }
  return { everyone: v.everyone, admins_moderators: v.admins_moderators, admins: v.admins };
}
