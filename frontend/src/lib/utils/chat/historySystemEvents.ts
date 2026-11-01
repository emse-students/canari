import { canari } from '$lib/proto/canari.js';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import type {
  AddMessageToChatOptions,
  Conversation,
  MessageReaction,
  ReadWatermarks,
} from '$lib/types';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { renderVisibleNotice } from '$lib/utils/chat/visibleNotices';
import { applyPin, mergePinEntries } from '$lib/stores/pinStore.svelte';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { boundedByVerifiedSentAt, withVettedBundleServerTimes } from '$lib/utils/chat/messageTime';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';
import { mergeHistoryFloor } from '$lib/utils/chat/historyWindow';
import {
  mergeReadWatermark,
  parseReadWatermarks,
  boundedServerMarks,
  receivedReadWatermarkMark,
  watermarkAfterReading,
  type ReadClock,
} from '$lib/utils/chat/readState';
import {
  chat_system_message_deleted,
  chat_system_member_left,
  chat_system_conversation_deleted,
} from '$lib/paraglide/messages';
import {
  serializeEnvelope,
  applyEditToBody,
  envelopeBodyText,
  mkChannelInviteEnvelope,
  mkChannelInviteSentEnvelope,
  channelInviteMessageId,
} from '$lib/envelope';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { noteIntegrityFinding } from '$lib/mls-client/integrityFindings';
import type { AuthorKeySource } from '$lib/crypto/messageAuthorship';
import type { StoredMessagePatch } from '$lib/db/types';
import {
  mergeVettedRow,
  upgradedRow,
  upgradePatch,
  vetBundle,
  type BundleEntry,
  type BundleHeldRow,
  type BundleRowDecision,
  type BundleUpgrade,
  type ForgedReport,
  type MergeableRow,
  type MergedRow,
} from './bundleVetting';

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
    /** The author's signed edit and tombstone a bundle proved, kept so this device relays them. */
    editProof?: RecordedAuthorship;
    deleteProof?: RecordedAuthorship;
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
  /**
   * The group id, which is what pin state is keyed by everywhere else.
   *
   * Not the same thing as `contactName`: that is the conversation MAP key, and a pinned set written
   * under it would be filed where no reader looks.
   */
  conversationId: string;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  messageReactions: Map<string, MessageReaction[]>;
  /** msgId -> final reaction list, applied to DB after the batch save. */
  reactionUpdates: Map<string, MessageReaction[]>;
  /** The keys this device trusts for an author (the MLS service): what a bundle's proofs verify under. */
  authorKeys: AuthorKeySource;
  /**
   * msgId -> what a replayed `history_bundle` changed on a HELD row (an upgrade, a vetted tombstone
   * or edit), merged onto the stored row in the post-save pass.
   */
  rowPatches: Map<string, StoredMessagePatch>;
  /**
   * The messages this page already queued, by id - the same objects `pushPendingMessage` queued, so
   * a replayed bundle that names one of them updates it in place rather than queueing a second row
   * that the batch write would store last.
   */
  pendingById: Map<string, Omit<PendingHistoryMessage, 'ingestSequence'>>;
  /**
   * Messages deleted via a `delete_message` event during this replay, each with the id of the
   * member that sent the event. The author check cannot always happen here - the message may not be
   * in memory yet - so the claim is carried to whoever can verify it against the stored row.
   */
  deletedMessages: Map<string, { by: string; proof?: RecordedAuthorship }>;
  /** Messages edited via an `edit_message` event, with their new content and who claims to edit. */
  editedMessages: Map<
    string,
    { content: string; editedAt: Date; by: string; proof?: RecordedAuthorship }
  >;
  /**
   * The author's signature on THIS frame, as mls-core verified it ({@link recordAuthorship}) -
   * stored with the edit or the deletion so a bundle this device writes later proves it.
   */
  authorship?: RecordedAuthorship;
  /**
   * Read state accumulated over the page, one instant per participant, merged as `max`. Written to
   * the conversation once at the end of the replay rather than message by message - which is the
   * whole economy of the watermark: a page of a thousand messages costs one entry per reader.
   */
  readWatermarkUpdates: ReadWatermarks;
  /** The same, for the marks on the SERVER's clock (`serverReadWatermarks`, see `readState.ts`). */
  serverReadWatermarkUpdates: ReadWatermarks;
  /**
   * The shared history floor seen over the page, kept as a mutable box because it is ONE value
   * rather than a map: the accumulators are written by the handler and read by the caller once the
   * page is saved, and a number cannot be mutated in place.
   */
  historyFloorUpdate: { at: number };
  /** Queues a decoded message for the page batch (assigns ingestSequence + bumps the added count). */
  pushPendingMessage: (entry: Omit<PendingHistoryMessage, 'ingestSequence'>) => void;
  /**
   * The receiver's hygiene filter of a bundle (a Remove holds against a later re-add, user
   * 2026-10-14): the messages it may keep, or `null` when its windows cannot be read and it keeps
   * none. The same filter the live `history_bundle` handler applies - see `historyEntitlement.ts`.
   */
  dropOwnExcluded: <M extends { id: string; serverTimestamp?: number; timestamp: number | Date }>(
    messages: M[]
  ) => Promise<M[] | null>;
}

/** Writes what the one merge changed back onto a queued message, with the proofs it took. */
function writeMergedPending(
  pm: Omit<PendingHistoryMessage, 'ingestSequence'>,
  merged: MergedRow<MergeableRow>
): void {
  const row = merged.next;
  pm.content = row.content;
  if (merged.reactions) pm.reactions = merged.reactions;
  if (row.isDeleted) {
    // A tombstone keeps only its own proof - the original bytes go with the body.
    pm.isDeleted = true;
    delete pm.authorship;
    delete pm.editProof;
  }
  if (row.isEdited) pm.isEdited = true;
  if (row.editedAt) pm.editedAt = row.editedAt.getTime();
  if (merged.editProof && !row.isDeleted) pm.editProof = merged.editProof;
  if (merged.deleteProof) pm.deleteProof = merged.deleteProof;
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
  const owner = canonicalUserId(target.senderId ?? '');
  if (owner && owner === canonicalUserId(senderNorm)) return true;
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
    conversationId,
    getConversation,
    setConversation,
    messageReactions,
    reactionUpdates,
    rowPatches,
    pendingById,
    deletedMessages,
    editedMessages,
    readWatermarkUpdates,
    serverReadWatermarkUpdates,
    historyFloorUpdate,
    pushPendingMessage,
  } = ctx;

  /**
   * Records a participant's read state into the page accumulator of its clock, keeping the later
   * instant.
   */
  const noteReadUpTo = (userNorm: string, at: number, clock: ReadClock): void => {
    const into = clock === 'server' ? serverReadWatermarkUpdates : readWatermarkUpdates;
    const merged = mergeReadWatermark(into, userNorm, at);
    if (merged) Object.assign(into, merged);
  };

  if (!parsed.system) return;

  // Transient negotiation, meaningless once re-read from the stream: a digest describes what a
  // device held at one instant, and a pull asks for something that was either answered days ago or
  // never will be. Replaying either would diff against a store that has moved on, or broadcast a
  // bundle nobody is waiting for. They are named here rather than left to fall through the chain
  // unhandled, so that adding a branch for them later has to be a decision instead of an accident.
  if (REPLAY_IGNORED_EVENTS.has(parsed.system.event ?? '')) return;

  // The ONE canonical user id (leafIdentity.ts, Rust's): every comparison below goes through it.
  const senderNorm = canonicalUserId(msg.sender_id);
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
      systemContent = await renderVisibleNotice('groupRenamed', data, senderNorm);
    } else if (parsed.system.event === 'memberRemoved' && data.targetUser) {
      systemContent = await renderVisibleNotice('memberRemoved', data, senderNorm);
    } else if (parsed.system.event === 'groupImageChanged') {
      // The notice only, which the replay never drew while the live path always did - so a device
      // that met this frame only in the archive held one row fewer than every other member. The
      // photo itself is the group metadata's, read fresh from the server, never from an old frame.
      systemContent = await renderVisibleNotice('groupImageChanged', data, senderNorm);
    } else if (parsed.system.event === 'memberLeft' && data.userId) {
      // The same cross-check the live handler makes, for the same reason and with the same verdict:
      // the id is a self-asserted payload field, the stream row's sender is the identity MLS
      // authenticated, and only the party that left may say so. Rendering nothing is what an
      // unusable payload already gets here.
      if (canonicalUserId(String(data.userId)) === senderNorm) {
        const getName = await resolveDisplayNames([data.userId]);
        systemContent = chat_system_member_left({ user: getName(data.userId) });
      }
    } else if (parsed.system.event === 'memberAdded') {
      systemContent = await renderVisibleNotice('memberAdded', data, senderNorm);
    } else if (parsed.system.event === 'channel_invitation' && data.channelId) {
      // Mirrors the live handler: both sides render the same card, the inviter's copy without a
      // Join button (`invitedName` is the discriminator). Replayed rather than ignored because an
      // invitation that lands while the device is offline only ever reaches it through the stream.
      // Nothing else has to be replayed alongside it: the invitation carries no key material, and
      // the seeds that open the channel are asked for over the distribution group on join.
      const channelId = String(data.channelId);
      const channelName = String(data.channelName || channelId);
      const workspaceName = data.workspaceName ? String(data.workspaceName) : undefined;
      const workspaceImageMediaId = data.workspaceImageMediaId
        ? String(data.workspaceImageMediaId)
        : undefined;
      systemMessageId = channelInviteMessageId(channelId, String(data.inviteeId || ''));
      systemContent = serializeEnvelope(
        senderNorm === canonicalUserId(userId)
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
      // Bounded by the server's own time for this frame, the history row's (readState.ts).
      const received = receivedReadWatermarkMark(data, parseServerTimestampMs(msg.timestamp));
      if (received.refused) {
        console.error(
          `[HISTORY_REPLAY] REFUSED a read mark from ${senderNorm.slice(0, 8)} in ${conversationId.slice(0, 8)}…: ${received.refused}`
        );
      }
      if (received.mark) noteReadUpTo(senderNorm, received.mark.at, received.mark.clock);
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
          ),
          'server'
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
      deletedMessages.set(data.messageId, {
        by: senderNorm,
        ...(ctx.authorship ? { proof: ctx.authorship } : {}),
      });
    } else if (parsed.system.event === 'edit_message' && data.messageId && data.newContent) {
      // Dated by the sender, exactly as the live path and the pin path are, so a replay cannot undo
      // an edit this device already holds that is newer - and two devices replaying the same log in
      // different orders reach the same body. `editSupersedes` carries the whole rule; a frame from
      // a client too old to send `editedAt` is dated on arrival, which is the best clock a replay
      // has for it. Without this the accumulator below kept whichever event came LAST in page
      // order, which is not an order any two devices share.
      const editedAtMs =
        typeof data.editedAt === 'number'
          ? data.editedAt
          : (parseServerTimestampMs(msg.timestamp) ?? Date.now());
      const editedAt = new Date(editedAtMs);
      const incoming = { editedAt: editedAtMs, content: data.newContent };
      const convo = getConversation(contactName);
      const known = convo?.messages.find((m) => m.id === data.messageId);
      if (known && !replayMutationIsAuthorised(known, senderNorm, 'edit')) return;
      // A DELETE IS ABSORBING - the tombstone wins whatever the order, exactly as the post-save
      // pass in `history.ts` has always had it. The tombstone is carried in `content`, so an edit
      // landing on a deleted row puts the deleted text back on screen. A delete seen earlier in
      // THIS page counts as much as one already on the row.
      if (known?.isDeleted || deletedMessages.has(data.messageId)) return;
      // Both the in-memory row and anything an earlier entry of THIS page already accumulated have
      // to be outranked: the page is walked in log order, which is not edit order.
      const heldInPage = editedMessages.get(data.messageId);
      if (heldInPage && !editSupersedes(incoming, heldInPage)) return;
      if (known && !editSupersedes(incoming, known)) return;
      if (convo && known) {
        setConversation(contactName, {
          ...convo,
          messages: convo.messages.map((mm) =>
            mm.id === data.messageId
              ? {
                  ...mm,
                  isEdited: true,
                  editedAt,
                  // The replacement TEXT, applied to the body this row holds, so the reply
                  // reference inside it survives the edit - see `applyEditToBody`. The accumulator
                  // below keeps the raw text: the row it will be written to is read in the
                  // post-save pass, and that is where its own body is known.
                  content: applyEditToBody(mm.content, data.newContent),
                }
              : mm
          ),
        });
      }
      editedMessages.set(data.messageId, {
        content: data.newContent,
        editedAt,
        by: senderNorm,
        ...(ctx.authorship ? { proof: ctx.authorship } : {}),
      });
    } else if (
      (parsed.system.event === 'pin' || parsed.system.event === 'unpin') &&
      data.messageId
    ) {
      // Dated by the sender, exactly as the live path is, so a replay cannot undo something newer
      // that this device already applied - `applyPin` keeps the larger `at` and answers `false`
      // here, which is the ordinary outcome of re-reading a log already followed. A frame from a
      // client too old to send `at` falls back to its position in the shared log, which is the best
      // clock a replay has. See `docs/wiki/legacy-compatibility.md`.
      applyPin(
        conversationId,
        String(data.messageId),
        parsed.system.event === 'pin',
        Number(data.at) || parseServerTimestampMs(msg.timestamp) || 0
      );
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
      // A bundle in the shared archive: every history answer is sent as transport today and never
      // enters it (history-answer-addressing.md, rule 3), so what reaches this branch was written
      // durably by an older build. It still restores history, under the same rule as a live one.
      const bundleData = data.messages;
      // Read state travels once for the whole conversation, so it is taken even from a bundle
      // carrying no messages at all - "you are missing nothing, and here is who has read what".
      const bundleWatermarks = parseReadWatermarks(data.readWatermarks);
      if (bundleWatermarks) {
        for (const [userNorm, at] of Object.entries(bundleWatermarks)) {
          noteReadUpTo(userNorm, at, 'stamped');
        }
      }
      const bundleServerMarks = boundedServerMarks(
        parseReadWatermarks(data.serverReadWatermarks),
        parseServerTimestampMs(msg.timestamp)
      );
      if (bundleServerMarks.dropped > 0) {
        console.error(
          `[HISTORY_REPLAY] ${bundleServerMarks.dropped} server-clock read mark(s) relayed by ${senderNorm.slice(0, 8)} in ${conversationId.slice(0, 8)}… lie after the bundle's own server time - dropped`
        );
      }
      const bundleServerWatermarks = bundleServerMarks.kept;
      if (bundleServerWatermarks) {
        for (const [userNorm, at] of Object.entries(bundleServerWatermarks)) {
          noteReadUpTo(userNorm, at, 'server');
        }
      }
      // The floor rides on the same frames, for the same reason and with the same merge.
      const mergedFloor = mergeHistoryFloor(historyFloorUpdate.at, data.floor);
      if (mergedFloor !== null) historyFloorUpdate.at = mergedFloor;
      // And so does the pin register. Applied here rather than accumulated over the page: its merge
      // is per message and idempotent, so there is nothing for the end of the page to decide.
      const pinsMerged = mergePinEntries(conversationId, data.pins);
      if (pinsMerged > 0) {
        console.debug(
          `[HISTORY_REPLAY] ${pinsMerged} pin state(s) converged for ${conversationId.slice(0, 8)}…`
        );
      }
      if (Array.isArray(bundleData) && bundleData.length > 0) {
        // THE ONE RULE EVERY BUNDLE GOES THROUGH (`bundleVetting.ts`), the one the live handler
        // applies: a durable bundle an older build wrote keeps restoring history - MARKED when
        // nothing proves its author - and nothing in it is taken on its relayer's word about
        // somebody else. Only the writes differ: they go to this page's accumulators.
        const wellFormed = (bundleData as Array<Record<string, unknown>>).filter(
          (m) =>
            typeof m?.id === 'string' &&
            m.id !== '' &&
            typeof m.senderId === 'string' &&
            m.senderId !== '' &&
            typeof m.content === 'string' &&
            m.content !== ''
        ) as unknown as BundleEntry[];
        // A relayed server time is believed only inside the bundle frame's own (`messageTime.ts`).
        const vettedTimes = withVettedBundleServerTimes(
          wellFormed,
          parseServerTimestampMs(msg.timestamp)
        );
        if (vettedTimes.dropped > 0) {
          console.error(
            `[HISTORY_REPLAY] ${vettedTimes.dropped} server time(s) relayed by ${senderNorm.slice(0, 8)} in ${conversationId.slice(0, 8)}… lie outside the bundle's own server time - dropped, those rows keep their sentAt`
          );
        }
        const entries = vettedTimes.rows;
        // HELD = what memory holds AND what this page already queued. A row queued earlier in the
        // page - a decrypted original, or another bundle's copy - is held like a stored one: it is
        // upgraded by a proof and never queued twice, so a later copy cannot overwrite it.
        const heldRows = new Map<string, BundleHeldRow>(
          (getConversation(contactName)?.messages ?? []).map((row) => [row.id, row])
        );
        for (const [id, pm] of pendingById) {
          heldRows.set(id, {
            id,
            senderId: pm.senderId,
            content: pm.content,
            ...(pm.restoredUnverified ? { restoredUnverified: true } : {}),
            ...(pm.isDeleted ? { isDeleted: true } : {}),
          });
        }
        // The messages we would ADD, through the same hygiene filter the live handler applies - a
        // bundle replayed from the stream is the same answer arriving late, and a message from
        // inside our own exclusion window is no more ours for having waited.
        const admitted =
          (await ctx.dropOwnExcluded(entries.filter((m) => !heldRows.has(m.id)))) ?? [];
        const logReplay = (line: string): void => console.debug(line);
        const refuseForged: ForgedReport = (what, id, why) => {
          console.error(
            `[AUTHORSHIP] REFUSED a replayed ${what} ${id.slice(0, 8)} relayed by ${senderNorm.slice(0, 8)} in ${conversationId.slice(0, 8)}…: ${why}`
          );
          noteIntegrityFinding({
            kind: 'forged-history',
            groupId: conversationId,
            peer: senderNorm,
            detail: what,
            proven: true,
          });
        };
        const vetted = await vetBundle(
          ctx.authorKeys,
          conversationId,
          { entries, fresh: admitted, held: heldRows, relayer: senderNorm, mutateHeld: true },
          logReplay,
          refuseForged
        );
        if (vetted.unverified > 0) {
          console.debug(
            `[AUTHORSHIP] ${vetted.unverified} replayed message(s) in ${conversationId.slice(0, 8)}… relayed by ${senderNorm.slice(0, 8)} carry no author proof - kept, marked unverified`
          );
        }

        // Held MARKED rows a copy proves are replaced ENTIRELY by it (`upgradedRow`): a queued one
        // in place, a stored one in memory and, at the end of the page, at rest (`upgradePatch`).
        const memoryUpgrades = new Map<string, BundleUpgrade>();
        for (const [id, up] of vetted.upgrades) {
          const pm = pendingById.get(id);
          // Memory follows, whether or not the page queued the row: what the stored write misses
          // is patched at the end of the page; a queued row's own write already carries it.
          memoryUpgrades.set(id, up);
          if (!pm) continue;
          const next = upgradedRow(
            { senderId: pm.senderId, content: pm.content, timestamp: new Date(up.timestamp) },
            up,
            userId
          );
          pm.senderId = next.senderId;
          pm.content = next.content;
          pm.timestamp = next.timestamp;
          pm.authorship = up.authorship;
          delete pm.restoredUnverified;
          delete pm.isEdited;
          delete pm.editedAt;
          delete pm.editProof;
        }
        const beforeUpgrade = getConversation(contactName);
        if (memoryUpgrades.size > 0 && beforeUpgrade) {
          setConversation(contactName, {
            ...beforeUpgrade,
            messages: beforeUpgrade.messages.map((row) => {
              const up = memoryUpgrades.get(row.id);
              // A queued row was the held one; memory's copy of it is upgraded only if it is marked
              // too - a proven row in memory is never rewritten by a bundle.
              if (!up || (pendingById.has(row.id) && !row.restoredUnverified)) return row;
              return upgradedRow(row, up, userId);
            }),
          });
          for (const [id, up] of memoryUpgrades) {
            if (pendingById.has(id)) continue;
            rowPatches.set(id, { ...rowPatches.get(id), ...upgradePatch(up) });
          }
        }

        // What each entry may change on a row this page queued, merged by the one merge in place.
        for (const [id, pm] of pendingById) {
          const d = vetted.decisions.get(id);
          if (!d) continue;
          const merged = mergeVettedRow<MergeableRow>(
            {
              id,
              senderId: pm.senderId,
              content: pm.content,
              ...(pm.isDeleted ? { isDeleted: true } : {}),
              ...(pm.isEdited ? { isEdited: true } : {}),
              ...(pm.editedAt ? { editedAt: new Date(pm.editedAt) } : {}),
              ...(pm.reactions ? { reactions: pm.reactions } : {}),
              ...(pm.restoredUnverified ? { restoredUnverified: true } : {}),
            },
            d.entry,
            d.decision,
            senderNorm,
            messageReactions.get(id)
          );
          if (!merged.changed) continue;
          writeMergedPending(pm, merged);
          if (merged.reactions) messageReactions.set(id, merged.reactions);
        }

        // What each entry may change on a row memory holds, merged by the one merge and written at
        // the end of the page (`rowPatches`, `reactionUpdates`).
        const convoForMerge = getConversation(contactName);
        if (convoForMerge) {
          let mergedAny = false;
          const mergedMsgs = convoForMerge.messages.map((existing) => {
            const d = vetted.decisions.get(existing.id);
            if (!d) return existing;
            const queued = pendingById.get(existing.id);
            if (queued) {
              // The page queued this row too, and the queued row's write (`replayedStoredRow`)
              // is what reaches storage - memory takes the same merge so it does not wait for a
              // reload. The decision was vetted against the QUEUED row's author, so it speaks for
              // memory's only when that is the same author; a signed edit's text goes onto
              // memory's own body.
              if (canonicalUserId(existing.senderId) !== canonicalUserId(queued.senderId)) {
                return existing;
              }
              const edit = d.decision.edit;
              const decision: BundleRowDecision =
                edit?.kind === 'apply'
                  ? {
                      ...d.decision,
                      edit: {
                        ...edit,
                        content: applyEditToBody(existing.content, envelopeBodyText(edit.content)),
                      },
                    }
                  : d.decision;
              const merged = mergeVettedRow(
                existing,
                d.entry,
                decision,
                senderNorm,
                existing.reactions
              );
              if (!merged.changed) return existing;
              mergedAny = true;
              return merged.next;
            }
            const merged = mergeVettedRow(
              existing,
              d.entry,
              d.decision,
              senderNorm,
              messageReactions.get(existing.id)
            );
            if (!merged.changed) return existing;
            mergedAny = true;
            if (merged.reactions) {
              messageReactions.set(existing.id, merged.reactions);
              reactionUpdates.set(existing.id, merged.reactions);
            }
            const next = merged.next;
            const patch: StoredMessagePatch = { ...rowPatches.get(existing.id) };
            if (next.isDeleted && !existing.isDeleted) {
              // A tombstone purges the original signed bytes with the body.
              Object.assign(patch, {
                isDeleted: true,
                content: next.content,
                authorship: null,
                editProof: null,
                ...(merged.deleteProof ? { deleteProof: merged.deleteProof } : {}),
              });
            } else if (merged.bodyEdited) {
              Object.assign(patch, { content: next.content, editProof: merged.editProof ?? null });
            }
            if (next.isEdited && !existing.isEdited) patch.isEdited = true;
            if (next.editedAt && next.editedAt !== existing.editedAt) {
              patch.editedAt = next.editedAt.getTime();
            }
            if (Object.keys(patch).length > 0) rowPatches.set(existing.id, patch);
            return next;
          });
          if (mergedAny) setConversation(contactName, { ...convoForMerge, messages: mergedMsgs });
        }

        // The new messages, each merged with what its entry may change before it is queued.
        for (const { entry: m, verdict } of vetted.fresh) {
          const verified = verdict.kind === 'verified';
          // The relayed server time checked once more, against the SIGNED sentAt
          // (`boundedByVerifiedSentAt`): the first check could only read the relayer's `timestamp`.
          const serverTimestamp = verified
            ? boundedByVerifiedSentAt(m.serverTimestamp, verdict.timestamp)
            : m.serverTimestamp;
          if (serverTimestamp === undefined && m.serverTimestamp !== undefined) {
            console.error(
              `[HISTORY_REPLAY] the server time relayed by ${senderNorm.slice(0, 8)} for ${m.id.slice(0, 8)} lies below the SIGNED sentAt - dropped, the row keeps its sentAt`
            );
          }
          const merged = mergeVettedRow<MergeableRow>(
            {
              id: m.id,
              senderId: canonicalUserId(m.senderId),
              content: verified ? verdict.content : m.content,
              ...(verdict.kind === 'unverified' ? { restoredUnverified: true } : {}),
            },
            m,
            vetted.decisions.get(m.id)?.decision ?? {},
            senderNorm,
            undefined
          );
          const row = merged.next;
          if (merged.reactions && !messageReactions.has(m.id)) {
            // Seeded so later reaction stream events apply on top of it, not onto an empty array.
            messageReactions.set(m.id, merged.reactions);
          }
          const pm: Omit<PendingHistoryMessage, 'ingestSequence'> = {
            senderId: row.senderId ?? canonicalUserId(m.senderId),
            content: row.content,
            messageId: m.id,
            timestamp: verified
              ? new Date(verdict.timestamp)
              : typeof m.timestamp === 'number'
                ? new Date(m.timestamp)
                : undefined,
            // The message's own server time, and NOTHING ELSE. This used to fall back on the
            // bundle frame's time, which is when the bundle was sent, not when the message was:
            // an exclusion window placed by it would release a message from inside the window or
            // withhold one from before it. An undated copy stays undated, as on the live path.
            ...(typeof serverTimestamp === 'number' ? { serverTimestamp } : {}),
            ...(m.authorship ? { authorship: m.authorship } : {}),
            ...(row.restoredUnverified ? { restoredUnverified: true } : {}),
          };
          writeMergedPending(pm, merged);
          pushPendingMessage(pm);
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
