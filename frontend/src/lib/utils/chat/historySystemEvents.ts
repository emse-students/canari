import { canari } from '$lib/proto/canari.js';
import type {
  AddMessageToChatOptions,
  Conversation,
  MessageReaction,
  ReadWatermarks,
} from '$lib/types';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { applyReaction, mergeReactions } from '$lib/utils/chat/messageReactions';
import {
  mergeReadWatermark,
  parseReadWatermarks,
  watermarkAfterReading,
} from '$lib/utils/chat/readState';
import {
  chat_system_message_deleted,
  chat_system_group_renamed,
  chat_system_member_removed,
  chat_system_member_left,
  chat_system_member_added,
  chat_system_conversation_deleted,
} from '$lib/paraglide/messages';
import {
  serializeEnvelope,
  mkChannelInviteEnvelope,
  mkChannelInviteSentEnvelope,
  channelInviteMessageId,
} from '$lib/envelope';

/**
 * System events that are live negotiation only and must never be acted on during a replay.
 *
 * See the guard in {@link applyReplaySystemEvent} for why.
 */
const REPLAY_IGNORED_EVENTS = new Set(['history_digest', 'history_pull']);

/** One Redis-stream history row as returned by `IMlsService.fetchHistory`. */
export type HistoryRow = { id?: string; sender_id: string; content: string; timestamp: string };

/** A decoded message queued for the single batched UI/DB write at the end of a replay page. */
export type PendingHistoryMessage = {
  senderId: string;
  content: string;
} & AddMessageToChatOptions & {
    reactions?: MessageReaction[];
    isDeleted?: boolean;
    isEdited?: boolean;
    /** Unix ms of the last edit, as carried by a history_bundle. */
    editedAt?: number;
  };

/**
 * Replay-side mutation sinks. Unlike the live path ({@link handleSystemEvent}), history
 * replay does not touch the DB per event: it accumulates mutations here and flushes them
 * once per page. Maps/sets/arrays are mutated by reference; messages to display go through
 * {@link ReplaySystemEventCtx.pushPendingMessage}.
 */
export interface ReplaySystemEventCtx {
  parsed: canari.AppMessage;
  msg: HistoryRow;
  contactName: string;
  /** Local user id, used to tell an invitation we SENT from one we received. */
  userId: string;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  messageReactions: Map<string, MessageReaction[]>;
  /** msgId -> final reaction list, applied to DB after the batch save. */
  reactionUpdates: Map<string, MessageReaction[]>;
  /**
   * Messages deleted via a `delete_message` event during this replay, each with the id of the
   * member that sent the event. The author check cannot always happen here - the message may not be
   * in memory yet - so the claim is carried to whoever can verify it against the stored row.
   */
  deletedMessages: Map<string, { by: string }>;
  /** Messages edited via an `edit_message` event, with their new content and who claims to edit. */
  editedMessages: Map<string, { content: string; editedAt: Date; by: string }>;
  /**
   * Read state accumulated over the page, one instant per participant, merged as `max`. Written to
   * the conversation once at the end of the replay rather than message by message - which is the
   * whole economy of the watermark: a page of a thousand messages costs one entry per reader.
   */
  readWatermarkUpdates: ReadWatermarks;
  /** Queues a decoded message for the page batch (assigns ingestSequence + bumps the added count). */
  pushPendingMessage: (entry: Omit<PendingHistoryMessage, 'ingestSequence'>) => void;
}

/**
 * May `senderNorm` rewrite or remove `target`? Only its own author may - the replay twin of
 * `mutationIsAuthorised` in `systemMessageHandler.ts`, where the reasoning is written out.
 *
 * The identity here is the shared log's `sender_id`, which the server now binds to the
 * authenticated caller on send. It is weaker than the live path's, which is the identity MLS itself
 * authenticated for the frame - so this is a second line, not a replacement for that one.
 *
 * Silent to the user and never silent in the log, for the same reason as the live check.
 */
export function replayMutationIsAuthorised(
  target: { senderId?: string },
  senderNorm: string,
  kind: 'edit' | 'delete'
): boolean {
  const owner = (target.senderId ?? '').toLowerCase();
  if (owner && owner === senderNorm.toLowerCase()) return true;
  console.warn(
    `[HISTORY_REPLAY] Refused ${kind === 'edit' ? 'an edit' : 'a delete'} of a message owned by ` +
      `${owner.slice(0, 8) || 'unknown'} from ${senderNorm.slice(0, 8)} - only the author may mutate it`
  );
  return false;
}

/**
 * Interprets a decoded MLS `system` event during history replay and routes its effect to the
 * accumulators in {@link ReplaySystemEventCtx}. Behaviour mirrors the live
 * {@link handleSystemEvent} but defers all writes to the page batch. Malformed control
 * payloads are swallowed so a single bad event never aborts the replay.
 */
export async function applyReplaySystemEvent(ctx: ReplaySystemEventCtx): Promise<void> {
  const {
    parsed,
    msg,
    contactName,
    userId,
    getConversation,
    setConversation,
    messageReactions,
    reactionUpdates,
    deletedMessages,
    editedMessages,
    readWatermarkUpdates,
    pushPendingMessage,
  } = ctx;

  /** Records a participant's read state into the page accumulator, keeping the later instant. */
  const noteReadUpTo = (userNorm: string, at: number): void => {
    const merged = mergeReadWatermark(readWatermarkUpdates, userNorm, at);
    if (merged) Object.assign(readWatermarkUpdates, merged);
  };

  if (!parsed.system) return;

  // Transient negotiation, meaningless once re-read from the stream: a digest describes what a
  // device held at one instant, and a pull asks for something that was either answered days ago or
  // never will be. Replaying either would diff against a store that has moved on, or broadcast a
  // bundle nobody is waiting for. They are named here rather than left to fall through the chain
  // unhandled, so that adding a branch for them later has to be a decision instead of an accident.
  if (REPLAY_IGNORED_EVENTS.has(parsed.system.event ?? '')) return;

  const senderNorm = msg.sender_id.toLowerCase();
  // Plain text for a membership notice, a serialized envelope for a card (channel invitation).
  let systemContent: string | null = null;
  // Defaults to the MLS frame id; a card overrides it with an id derived from the invitation so
  // the replay converges on the bubble the live path already wrote instead of duplicating it.
  let systemMessageId: string | undefined = parsed.messageId || undefined;

  try {
    const data = parsed.system.data ? JSON.parse(parsed.system.data) : {};

    if (parsed.system.event === 'groupRenamed' && data.newName) {
      const convo = getConversation(contactName);
      if (convo && convo.name !== data.newName) {
        setConversation(contactName, { ...convo, name: data.newName });
      }
      const getName = await resolveDisplayNames([senderNorm]);
      systemContent = chat_system_group_renamed({
        sender: getName(senderNorm),
        name: data.newName,
      });
    } else if (parsed.system.event === 'memberRemoved' && data.targetUser) {
      const getName = await resolveDisplayNames([senderNorm, data.targetUser]);
      systemContent = chat_system_member_removed({
        sender: getName(senderNorm),
        target: getName(data.targetUser),
      });
    } else if (parsed.system.event === 'memberLeft' && data.userId) {
      const getName = await resolveDisplayNames([data.userId]);
      systemContent = chat_system_member_left({ user: getName(data.userId) });
    } else if (parsed.system.event === 'memberAdded') {
      const newUserIds: string[] =
        data.newUsers && Array.isArray(data.newUsers)
          ? data.newUsers
          : data.newUser
            ? [data.newUser]
            : [];
      const getName = await resolveDisplayNames([senderNorm, ...newUserIds]);
      const added = newUserIds.map((u: string) => getName(u)).join(', ');
      if (added)
        systemContent = chat_system_member_added({ sender: getName(senderNorm), members: added });
    } else if (parsed.system.event === 'channel_invitation' && data.channelId) {
      // Mirrors the live handler: both sides render the same card, the inviter's copy without a
      // Join button (`invitedName` is the discriminator). Replayed rather than ignored because an
      // invitation that lands while the device is offline only ever reaches it through the stream.
      // Its sibling `channel_key_distribution` needs no replay: `hydrateChannelHistoryKeys` pulls
      // every epoch key from the server when the channel is opened.
      const channelId = String(data.channelId);
      const channelName = String(data.channelName || channelId);
      const workspaceName = data.workspaceName ? String(data.workspaceName) : undefined;
      const workspaceImageMediaId = data.workspaceImageMediaId
        ? String(data.workspaceImageMediaId)
        : undefined;
      systemMessageId = channelInviteMessageId(channelId, String(data.inviteeId || ''));
      systemContent = serializeEnvelope(
        senderNorm === userId.toLowerCase()
          ? mkChannelInviteSentEnvelope(
              channelId,
              workspaceName ?? channelName,
              workspaceName,
              String(data.inviteeName || data.inviteeId || ''),
              workspaceImageMediaId
            )
          : mkChannelInviteEnvelope(
              channelId,
              workspaceName ?? channelName,
              workspaceName,
              String(data.inviterName || ''),
              workspaceImageMediaId
            )
      );
    } else if (parsed.system.event === 'groupDeleted') {
      const getName = await resolveDisplayNames([senderNorm]);
      systemContent = chat_system_conversation_deleted({ sender: getName(senderNorm) });
    } else if (parsed.system.event === 'read_watermark') {
      noteReadUpTo(senderNorm, Number(data.at));
    } else if (parsed.system.event === 'read_receipt') {
      // The pre-watermark shape, which names message ids instead of an instant. Translated using
      // the messages we hold: an id we do not have says nothing this could act on.
      const msgIds: string[] = data.messageIds ?? [];
      const convo = getConversation(contactName);
      if (convo && msgIds.length > 0) {
        const idSet = new Set(msgIds);
        noteReadUpTo(
          senderNorm,
          watermarkAfterReading(
            convo.messages.filter((mm) => idSet.has(mm.id)),
            0
          )
        );
      }
    } else if (parsed.system.event === 'delete_message' && data.messageId) {
      const convo = getConversation(contactName);
      const known = convo?.messages.find((m) => m.id === data.messageId);
      // Only the author may delete. The live path has enforced this since the mutation-ownership
      // fix; the replay path never did, because these frames could not reach the shared log and so
      // this branch was dead. The durability split made it live again, hole and all.
      if (known && !replayMutationIsAuthorised(known, senderNorm, 'delete')) return;
      if (convo && known) {
        setConversation(contactName, {
          ...convo,
          messages: convo.messages.map((mm) =>
            mm.id === data.messageId
              ? { ...mm, isDeleted: true, content: chat_system_message_deleted() }
              : mm
          ),
        });
      }
      // Recorded with the claimed author when the message is not in memory: the row it applies to
      // is read later, and that is where the claim can still be checked.
      deletedMessages.set(data.messageId, { by: senderNorm });
    } else if (parsed.system.event === 'edit_message' && data.messageId && data.newContent) {
      const editedAt = typeof data.editedAt === 'number' ? new Date(data.editedAt) : new Date();
      const convo = getConversation(contactName);
      const known = convo?.messages.find((m) => m.id === data.messageId);
      if (known && !replayMutationIsAuthorised(known, senderNorm, 'edit')) return;
      if (convo && known) {
        setConversation(contactName, {
          ...convo,
          messages: convo.messages.map((mm) =>
            mm.id === data.messageId
              ? { ...mm, isEdited: true, editedAt, content: data.newContent }
              : mm
          ),
        });
      }
      editedMessages.set(data.messageId, {
        content: data.newContent,
        editedAt,
        by: senderNorm,
      });
    } else if (parsed.system.event === 'remove_reaction' && data.messageId && data.emoji) {
      // LEGACY FRAME, replay side. Taking a reaction back now travels as a `ReactionMsg` with
      // `removed` set; this only ever sees log entries written before that change. Dated with the
      // entry's own time, so it orders after the placements that precede it in the log.
      const updated = applyReaction(
        messageReactions.get(data.messageId) || [],
        msg.sender_id,
        String(data.emoji),
        parseServerTimestampMs(msg.timestamp) ?? 0,
        true
      );
      if (updated) {
        messageReactions.set(data.messageId, updated);
        reactionUpdates.set(data.messageId, updated);
      }
    } else if (parsed.system.event === 'history_bundle') {
      // The bundle is delivered via the message queue; handling it here guarantees that a
      // device coming online after the queue TTL (7 days) still recovers the history
      // from Redis Streams.
      const bundleData = data.messages;
      // Read state travels once for the whole conversation, so it is taken even from a bundle
      // carrying no messages at all - "you are missing nothing, and here is who has read what".
      const bundleWatermarks = parseReadWatermarks(data.readWatermarks);
      if (bundleWatermarks) {
        for (const [userNorm, at] of Object.entries(bundleWatermarks)) noteReadUpTo(userNorm, at);
      }
      if (Array.isArray(bundleData) && bundleData.length > 0) {
        const existingIds = new Set(
          (getConversation(contactName)?.messages ?? []).map((m) => m.id)
        );
        const serverMs = parseServerTimestampMs(msg.timestamp);
        // Merge transport-carried reactions and edit times onto messages we ALREADY have (e.g. our
        // own sent messages): they are skipped by the "add new" loop below, so without this their
        // bundle metadata would be lost.
        const convoForMerge = getConversation(contactName);
        if (convoForMerge) {
          type BundleMeta = {
            id?: string;
            reactions?: MessageReaction[];
            editedAt?: number;
          };
          const bundleById = new Map<string, BundleMeta>();
          for (const m of bundleData as BundleMeta[]) {
            if (m?.id) bundleById.set(m.id, m);
          }
          let mergedAny = false;
          const mergedMsgs = convoForMerge.messages.map((existing) => {
            const b = bundleById.get(existing.id);
            if (!b) return existing;
            let next = existing;
            // Merged pair by pair, larger timestamp wins - the same rule as the live path. Seeding
            // only when we held nothing left a removal unable to reach a stale placement (D3).
            if (Array.isArray(b.reactions) && b.reactions.length > 0) {
              const merged = mergeReactions(
                messageReactions.get(existing.id) ?? next.reactions ?? [],
                b.reactions
              );
              if (merged) {
                next = { ...next, reactions: merged };
                messageReactions.set(existing.id, merged);
                reactionUpdates.set(existing.id, merged);
                mergedAny = true;
              }
            }
            // The edit time, which only the bundle can supply: the sender's own edit is never
            // echoed back over MLS, so a device restored this way has no other source for it.
            if (typeof b.editedAt === 'number' && b.editedAt > 0 && next.editedAt == null) {
              next = { ...next, editedAt: new Date(b.editedAt) };
              mergedAny = true;
            }
            return next;
          });
          if (mergedAny) setConversation(contactName, { ...convoForMerge, messages: mergedMsgs });
        }
        for (const m of bundleData) {
          if (m?.id && !existingIds.has(m.id) && m.senderId && m.content) {
            pushPendingMessage({
              senderId: String(m.senderId).toLowerCase(),
              content: String(m.content),
              messageId: String(m.id),
              timestamp: typeof m.timestamp === 'number' ? new Date(m.timestamp) : undefined,
              // Preserve each message's original serverTimestamp (stable ordering).
              // Fall back on serverMs (bundle timestamp) only when absent.
              serverTimestamp: typeof m.serverTimestamp === 'number' ? m.serverTimestamp : serverMs,
              // Metadata transferred from the source device: reactions, deletions and edits -
              // full state at migration time. Read state is not here: it belongs to the
              // conversation, not to any one message.
              ...(Array.isArray(m.reactions) && m.reactions.length > 0
                ? { reactions: m.reactions }
                : {}),
              ...(m.isDeleted === true ? { isDeleted: true } : {}),
              ...(m.isEdited === true ? { isEdited: true } : {}),
              // Carried with the flag, or the message shows "edited" with no time for ever.
              ...(typeof m.editedAt === 'number' && m.editedAt > 0 ? { editedAt: m.editedAt } : {}),
            });
          }
        }
        // Seed messageReactions from the bundle so later reaction stream events
        // apply on top of it, rather than onto an empty array.
        for (const m of bundleData) {
          if (m?.id && Array.isArray(m.reactions) && m.reactions.length > 0) {
            const msgId = String(m.id);
            if (!messageReactions.has(msgId)) {
              messageReactions.set(msgId, m.reactions);
            }
          }
        }
      }
    }
  } catch {
    // Keep history replay robust even if a control payload is malformed.
  }

  if (systemContent) {
    const systemServerMs = parseServerTimestampMs(msg.timestamp);
    pushPendingMessage({
      senderId: 'system',
      content: systemContent,
      isSystem: true,
      messageId: systemMessageId,
      timestamp: systemServerMs !== undefined ? new Date(systemServerMs) : undefined,
    });
  }
}
