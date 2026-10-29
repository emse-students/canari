/**
 * Reactive composable owning all message-level operations:
 * - Incoming message append + unread tracking
 * - Text send, media upload, reactions, edit, delete
 * - Read receipts (debounced)
 * - Reply/cancel-reply state
 * - File selection + validation
 */
import { isAppInForeground } from '$lib/utils/appForeground';
import { isSalonMuted } from '$lib/utils/chat/salonUnread';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { SvelteMap, SvelteDate } from 'svelte/reactivity';
import { getToken, signOutGeneration } from '$lib/stores/auth';
import { fromHex } from '$lib/utils/hex';
import { systemNotificationsBlockedAnnounceOnce } from '$lib/utils/systemNotificationsBlocked';
import {
  sendChatMessage,
  retrySalonSend,
  discardSalonSend,
  takeBackSalonSend,
  resumeUnsentSalonSends,
  forgetSalonSendsOfEndedSession,
  type SendMessageDeps,
  addReaction,
  removeReaction,
  editMessage,
  deleteMessage,
  setMessagePinned,
} from '$lib/utils/chat/messaging';
import { applySalonEchoChange } from '$lib/utils/chat/salonEcho';
import type { UnsentSalonText } from '$lib/utils/chat/salonUnsent';
import { resetOwedSalonWrites } from '$lib/utils/chat/salonOwed';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';
import { applyPin, isMessagePinned, pinEntries } from '$lib/stores/pinStore.svelte';
import {
  indexMessagesById,
  isStaleInboundMessage,
  isSystemSender,
  normalizeMessageId,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import {
  advanceLastMessageAt,
  insertMessageOrdered,
  mergeMessagesInInputOrder,
  tabSeed,
} from '$lib/utils/chat/messageOrder';
import { isOwnMessage } from '$lib/utils/chat/messageUtils';
import { isUnreadForUser, watermarkFor } from '$lib/utils/chat/readState';
import { canSeeArrivalNow, isReadingConversationNow } from '$lib/utils/chat/arrivalRuntime';
import {
  MAX_DISTINCT_MESSAGE_REACTIONS,
  activeReactions,
  applyReaction,
  canAddDistinctReactionEmoji,
} from '$lib/utils/chat/messageReactions';
import {
  notificationGroupName,
  type NativeMessageNotification,
} from '$lib/utils/nativeNotification';
import {
  getUserDisplayNameSync,
  resolveNotificationSenderName,
} from '$lib/utils/users/displayName';
import { chat_system_message_deleted, m } from '$lib/paraglide/messages';
import { describeApiRefusal, refusalStatus } from '$lib/utils/apiRefusal';
import {
  readSalonSendGate,
  SalonNotLoadableError,
  whenSalonSendable,
} from '$lib/utils/graine/salonSendGate';
import { salonGateRefusalMessage } from '$lib/utils/graine/sealUnavailableMessage';
import { MediaService, refusedBeforePreparation } from '$lib/media';
import { isReelMessage } from '$lib/reels/chatReel';
import { chatReelPendingDeclaration, isChatReelTake } from '$lib/reels/chatReelWriter';
import { capturePosterOf } from '$lib/reels/capturePoster';
import {
  applyEditToBody,
  envelopeBodyText,
  getPreviewText,
  mkMediaEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';
import {
  encodeAppMessage,
  mediaEncodingProtoField,
  mediaPlaceholderProtoField,
  mkMedia,
  MediaKind,
} from '$lib/proto/codec';
import type {
  AddMessageToChatOptions,
  ChatMessage,
  MessageBatchOrigin,
  MessageReaction,
  Conversation,
} from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { BulkIngestPhase } from '$lib/mls-client';
import type { IStorage, OutboxEntry, StoredMessage } from '$lib/db';
import { enqueueOutboxMessage, isEnqueueQuotaFailure } from '$lib/utils/chat/outbox';
import { beginOutboxEnqueue } from '$lib/utils/chat/outboxActivity.svelte';
import { unregisterDeviceNotices } from '$lib/utils/chat/deviceNoticeWiring';
import { resetJoinRequests } from '$lib/utils/chat/joinRequests.svelte';
import {
  clearControlRefusal,
  clearMessageControlRefusals,
  forgetControlRefusals,
  recordControlRefusal,
  type ControlAct,
  type ControlRefusal,
} from '$lib/utils/chat/controlRefusals.svelte';
import { ChannelService } from '$lib/services/ChannelService';
import {
  isChannelConversationId,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { beginBulkUiFlushBench, finishBulkUiFlushBench } from '$lib/mls-client/catchupBenchmark';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';
import { publishComposedMessage, publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';
import { claimChannelReadSignal } from '$lib/utils/chat/channelReadSignal';
import { isVideoPrepareError, prepareVideoForUpload } from '$lib/video/prepareVideoForUpload';
import { videoPrepareFailureMessage } from '$lib/video/videoPrepareMessages';
import { categoryOfConversation } from '$lib/notifications/categories';
import {
  conversationLevelRefusal,
  mentionsUser,
  type ConversationNotificationLevel,
} from '$lib/notifications/conversationLevel';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { VideoPreparationState } from '$lib/video/videoPreparationState.svelte';

/** Runtime dependencies injected into all messaging operations. */
export interface MessagingContext {
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  /** Reactive map of all open conversations (DMs + channels). */
  conversations: SvelteMap<string, Conversation>;
  userId: string;
  deviceKeyB64: string;
  authToken: string;
  setAuthToken: (v: string) => void;
  selectedContact: string | null;
  getSendError: () => string;
  setSendError: (v: string) => void;
  storage: IStorage | null;
  log: (msg: string) => void;
  saveConversation: (contactName: string) => Promise<void>;
  verifyCurrentUserMembership: (contactName: string) => Promise<boolean>;
  playNotificationTone: () => void;
  playSendTone?: () => void;
  /** `mentionsMe` selects the mention trill over the message one. */
  playReceiveTone?: (mentionsMe?: boolean) => void;
  playReadTone?: () => void;
  sendSystemNotification: (
    title: string,
    body: string,
    conversationId?: string,
    mentionsMe?: boolean,
    native?: NativeMessageNotification
  ) => Promise<void>;
  /**
   * Tells this user's OTHER devices that a salon has been read, so any of them still showing its
   * notification drops it. Optional: only the layer holding a channel client can provide it, and
   * a context without one simply never signals rather than failing.
   */
  signalChannelRead?: (channelId: string) => void;
}

/**
 * Maps an envelope media type to its protobuf {@link MediaKind}. A file has no dedicated kind,
 * so anything unrecognised falls through to UNSPECIFIED, which is what the renderer treats as
 * "generic attachment".
 */
function mediaKindFromEnvelope(type: string): number {
  switch (type) {
    case 'image':
      return MediaKind.MEDIA_KIND_IMAGE;
    case 'video':
      return MediaKind.MEDIA_KIND_VIDEO;
    case 'audio':
      return MediaKind.MEDIA_KIND_AUDIO;
    default:
      return MediaKind.MEDIA_KIND_UNSPECIFIED;
  }
}

/** Creates and returns the reactive messaging store covering send, receive, reactions, edit, delete, replies, and media uploads. */
export function useMessaging() {
  const messageReactions = new SvelteMap<string, MessageReaction[]>();
  /**
   * The reply armed in each conversation, keyed by conversation id. A reply belongs to ONE
   * conversation: the composer shows (and a send consumes) only the entry of the conversation
   * that is open, so opening another one never carries the quote along.
   */
  const replyByConversation = new SvelteMap<string, ChatMessage>();
  /**
   * The files STAGED in each conversation's composer, keyed by conversation id - the same rule as
   * {@link replyByConversation}. It was ONE queue for every conversation, so a photo staged in A
   * and not sent sat in B's composer after a switch, and B's next Send posted it there (PR #1859
   * review, 2026-10-15: the in-app camera made staging a photo and walking away an ordinary act).
   */
  const pendingByConversation = new SvelteMap<string, import('$lib/media').PendingMediaFile[]>();
  /**
   * The TEXT typed in each conversation's composer, keyed by conversation id - the same rule as
   * {@link pendingByConversation}. It was one field for every conversation, so a draft left in A
   * (or a share staged there) sat in B's composer after a switch, and B's Send posted it there
   * (Mi 9T, 2026-10-27).
   */
  const draftByConversation = new SvelteMap<string, string>();

  /** The text typed in `conversationKey`'s composer ('' when none or no conversation). */
  function draftFor(conversationKey: string | null | undefined): string {
    return conversationKey ? (draftByConversation.get(conversationKey) ?? '') : '';
  }

  /** Replaces the text of `conversationKey`'s composer; an empty text leaves no entry. */
  function setDraft(conversationKey: string | null | undefined, text: string): void {
    if (!conversationKey) {
      if (text)
        console.warn(`[DRAFT] ${text.length} char(s) typed with no conversation open - dropped`);
      return;
    }
    if (text) draftByConversation.set(conversationKey, text);
    else draftByConversation.delete(conversationKey);
  }

  /**
   * A writer of `conversationKey`'s draft for text that comes back LATER - an edit's saved draft, a
   * refused send, a salon text resumed after an await. It is bound to the account signed in NOW: a
   * sign-out in between (`signOutGeneration`) makes it drop the text, because {@link forgetAccount}
   * has cleared the drafts and a write after it would hand the leaving account's text to the next
   * one opening the same conversation (review of #2614, 2026-10-27).
   */
  function lateDraftWriter(
    conversationKey: string | null | undefined,
    origin: string
  ): (text: string) => void {
    const generation = signOutGeneration();
    return (text) => {
      if (signOutGeneration() !== generation) {
        if (text)
          console.info(`[DRAFT] ${origin}: ${text.length} char(s) dropped - signed out since`);
        return;
      }
      setDraft(conversationKey, text);
    };
  }

  /** The staged files of `conversationKey`, oldest first ([] when none or no conversation). */
  function pendingMediaFilesFor(
    conversationKey: string | null | undefined
  ): import('$lib/media').PendingMediaFile[] {
    return conversationKey ? (pendingByConversation.get(conversationKey) ?? []) : [];
  }

  /**
   * THE ACCOUNT SIGNED OUT: its staged files, armed replies and drafts leave the memory. This composable is
   * a singleton that outlives a sign-out without a page reload, and the maps are keyed by
   * conversation ids the NEXT account may open too - a DM between the two accounts, a salon of a
   * shared community - whose composer would then show, and send, what the previous one staged.
   */
  function forgetAccount(log: (msg: string) => void): void {
    const staged = pendingByConversation.size;
    const replies = replyByConversation.size;
    const drafts = draftByConversation.size;
    pendingByConversation.clear();
    replyByConversation.clear();
    draftByConversation.clear();
    log(
      `[COMPOSER] signed out: staging of ${staged}, replies of ${replies} and drafts of ${drafts} conversation(s) forgotten`
    );
    // Salon writes owed to a reconnect were the leaving account's: none may go out under the next.
    resetOwedSalonWrites();
    forgetSalonSendsOfEndedSession();
    // The refused control actions shown are the leaving account's; its persisted list stays its own.
    forgetControlRefusals();
    // So are the new-device alerts on screen; its unseen ones stay persisted for its next session.
    unregisterDeviceNotices();
    // And the join asks on screen: a member of the NEXT account must not answer them.
    resetJoinRequests();
  }

  /** Replaces the staged files of `conversationKey`; an empty list removes its entry. */
  function setPendingMediaFiles(
    conversationKey: string,
    files: import('$lib/media').PendingMediaFile[]
  ) {
    if (files.length === 0) pendingByConversation.delete(conversationKey);
    else pendingByConversation.set(conversationKey, files);
  }
  /** A picked video being re-encoded on the device before it joins the queue (decision C3). */
  const videoPreparation = new VideoPreparationState();
  /** The video preparations queued behind each other - see `prepareChatVideo`. */
  let videoPreparationChain: Promise<unknown> = Promise.resolve();
  let isUploadingMedia = $state(false);

  /** Depth of nested MLS queue catch-up sessions (overlay stays until zero). */
  let messageCatchupDepth = 0;
  let isMessageCatchupActive = $state(false);

  /**
   * How many real messages a drain must actually produce before it is ANNOUNCED to the user.
   *
   * Below this the insertion is fast enough that a banner would say less than it costs: it would
   * appear and vanish, and the user would have learnt nothing they could not see.
   */
  const OVERLAY_MIN_MESSAGES = 5;

  /**
   * Whether the "synchronisation" banner is up - a DIFFERENT question from
   * {@link isMessageCatchupActive}, and separating the two is the whole point.
   *
   * `isMessageCatchupActive` answers "is a multi-frame drain running", which is what the three
   * concurrency guards that read it actually need (the FCM cache flush, its poll, and the media
   * send). This one answers "is there something worth telling the user about", and only that.
   *
   * They were one flag, decided at drain START from `pendingCount` - a count of CIPHERTEXTS. Nothing
   * downstream can classify a frame before decrypting it: `MlsQueuedMessage` carries no delivery
   * class and the server's envelope carries neither `silent` nor `durable`. So the banner was
   * counting frames it could not read, and a reconnect whose nine frames were all history probes
   * announced a synchronisation of exactly zero messages - for four seconds, every time the app came
   * back to the foreground. It is raised from the BUFFER instead, which holds decrypted messages and
   * therefore knows what it has.
   */
  let isCatchupOverlayVisible = $state(false);
  /** When true, incoming messages are buffered and flushed in one UI update (MLS queue catch-up). */
  let bulkIngestActive = false;
  /** Global MLS catch-up sequence (reset when bulk buffer starts). */
  let bulkIngestSeq = 0;
  const bulkIngestBuffer = new SvelteMap<
    string,
    Array<{ senderId: string; content: string } & AddMessageToChatOptions>
  >();

  /** Buffer of orphan messages that arrived before their conversation was in the map.
   *  Capped per conversation to avoid memory leaks. */
  const MAX_ORPHAN_MESSAGES_PER_CONVERSATION = 50;
  const orphanBuffer = new SvelteMap<
    string,
    Array<{
      senderId: string;
      content: string;
      contactName: string;
      options: AddMessageToChatOptions & { skipDbSave?: boolean };
    }>
  >();

  const mediaService = new MediaService();

  // ── Incoming message ──────────────────────────────────────────────────────

  /**
   * Opens a UI catch-up window for a bulk-ingest phase: buffers incoming messages for one grouped
   * flush per conversation (`bufferUi`) and/or shows the blocking sync overlay (`showOverlay`).
   */
  function beginBulkMessageIngest(phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    if (showOverlay) {
      messageCatchupDepth += 1;
      isMessageCatchupActive = true;
    }
    if (bufferUi) {
      bulkIngestActive = true;
      bulkIngestSeq = 0;
      warnIfDiscardingBuffered('beginBulkMessageIngest');
      bulkIngestBuffer.clear();
    }
  }

  /**
   * Both clear sites below discard whatever is still buffered, and a drain restarting before the
   * previous one ended is exactly that shape. Discarding is the deliberate behaviour - a flush here
   * would re-enter the ingest path from inside its own reset - but it must never be SILENT, because
   * a dropped buffer is indistinguishable from a message that never arrived. This is the only trace
   * it leaves.
   */
  function warnIfDiscardingBuffered(where: string) {
    if (bulkIngestBuffer.size === 0) return;
    const count = [...bulkIngestBuffer.values()].reduce((sum, msgs) => sum + msgs.length, 0);
    console.warn(
      `[ADD_MSG] ${where}: discarding ${count} buffered message(s) across ${bulkIngestBuffer.size} conversation(s) - they were never rendered nor persisted`
    );
  }

  /**
   * Raises the banner once the buffer holds enough real messages to be worth announcing.
   *
   * Called on every buffered message, and deliberately cheap: it stops scanning for good once the
   * banner is up, and the scan itself is over CONVERSATIONS rather than messages.
   */
  function raiseOverlayIfWorthAnnouncing() {
    if (isCatchupOverlayVisible || messageCatchupDepth === 0) return;
    let buffered = 0;
    for (const msgs of bulkIngestBuffer.values()) {
      buffered += msgs.length;
      if (buffered >= OVERLAY_MIN_MESSAGES) {
        isCatchupOverlayVisible = true;
        return;
      }
    }
  }

  /** Clears catch-up UI state (safety net if begin/end ever desync). */
  function resetMessageCatchupState() {
    messageCatchupDepth = 0;
    isMessageCatchupActive = false;
    isCatchupOverlayVisible = false;
    bulkIngestActive = false;
    warnIfDiscardingBuffered('resetMessageCatchupState');
    bulkIngestBuffer.clear();
  }

  /** Ends catch-up: flushes bulk buffer when used, then hides the loading overlay. */
  async function endBulkMessageIngest(ctx: MessagingContext, phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    try {
      if (bufferUi && bulkIngestActive) {
        // Disable buffering BEFORE the await loop: any message that arrives during the flush
        // (e.g. a channel event calling addMessageToChat outside the drain queue) then takes
        // the live path and renders immediately, instead of landing in a buffer the finally
        // block is about to discard - which would silently drop it.
        bulkIngestActive = false;
        const entries = [...bulkIngestBuffer.entries()].sort(([, a], [, b]) => {
          const seqA = a[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          const seqB = b[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          return seqA - seqB;
        });
        const benchMessageCount = entries.reduce((sum, [, msgs]) => sum + msgs.length, 0);
        beginBulkUiFlushBench(entries.length, benchMessageCount);
        bulkIngestBuffer.clear();
        for (const [contactName, messages] of entries) {
          if (messages.length > 0) {
            // ARRIVALS. The bulk buffer holds messages that came over the wire while a drain was
            // running - they are new to the reader, and until 2026-09-05 this path told nobody
            // (TAB-1). The restore case is the OTHER caller, in `systemMessageHandler`.
            await batchAddMessages(messages, contactName, ctx, 'arrival');
            await yieldToMainThread();
          }
        }
        finishBulkUiFlushBench();
        // AND THE DRAIN DOES NOT MOVE IT EITHER. This ended with the same blind jump, at the
        // worst possible moment: a catch-up finishing is exactly when a bad connection has just
        // recovered, so the reader who spent the outage scrolled up reading history was teleported
        // to the bottom by the recovery itself. `ChatArea` sees the list grow and decides.
      }
    } catch (e) {
      console.error('[CATCHUP] endBulkMessageIngest failed:', e);
    } finally {
      if (bufferUi) {
        bulkIngestActive = false;
        bulkIngestBuffer.clear();
      }
      if (showOverlay) {
        messageCatchupDepth = Math.max(0, messageCatchupDepth - 1);
        if (messageCatchupDepth === 0) {
          isMessageCatchupActive = false;
          isCatchupOverlayVisible = false;
        }
      }
    }
  }

  /**
   * Appends a single message to the conversation, updates `lastMessageAt`, persists to
   * IndexedDB, and scrolls to bottom. Deduplicates by id. No-op if the conversation is
   * not in the map.
   */
  /**
   * The OS notification for ONE inbound message, and the only place that decides to raise it.
   *
   * IT LIVED INSIDE `addMessageToChat` AND THEREFORE COVERED ONE OF THE TWO INBOUND PATHS. The
   * other is the bulk buffer: while a catch-up is draining, `addMessageToChat` files an inbound
   * message into `bulkIngestBuffer` and RETURNS - above this decision - and the flush hands it to
   * `batchAddMessages`, which never had one. So a message that arrived inside a drain window
   * notified nobody, and a backgrounded tab is exactly the state that produces a drain: TAB-1
   * recorded permission `granted`, the tab hidden, the message arrived, and zero notifications
   * constructed (2026-09-05). The probe's evidence was one line - `[ADD_MSG] Batch into "...":
   * 1 added` - which named the path that had no branch.
   *
   * Per-conversation throttling belongs to `sendSystemNotification` (800 ms) and is not repeated
   * here, so a batch that ends in several messages for one conversation still raises one.
   */
  /**
   * WHETHER THE READER IS LOOKING AT THE PLACE THIS MESSAGE JUST APPEARED.
   *
   * Gathers the four runtime facts `readerCanSeeArrival` reasons over and nothing else - the rule
   * itself is pure and lives in `arrivalVisibility.ts`, with the whole matrix asserted beside it.
   *
   * TWO CONSUMERS, AND THEY ARE MUTUALLY EXCLUSIVE: the tone fires when this is true, the OS
   * notification when it is false. They used to be decided separately - the tone always, the
   * notification on app-foreground alone - and the gap between them was audible on a phone sitting
   * inside conversation A while B wrote: a sound, and an unread badge in a list the narrow layout
   * does not render.
   *
   * `isAppInForeground` rather than the document, for the reason spelt out in `notifyInbound`: a
   * backgrounded Tauri app reports `visible`/`hasFocus` exactly as a foregrounded one does.
   */
  function canSeeArrival(ctx: MessagingContext, conversationKey: string): boolean {
    return canSeeArrivalNow(conversationKey, ctx.selectedContact);
  }

  function notifyInbound(
    ctx: MessagingContext,
    conversationKey: string,
    /**
     * The conversation ROW, not just its name.
     *
     * The native builder needs to know whether this is a group and what it is called, and the row
     * is where both already are - deriving it from the name would be `deriveConversationIdentity`
     * run a second time, in a second place, against a string that is a `me::peer` key for a DM.
     */
    convo: Pick<
      Conversation,
      'id' | 'name' | 'contactName' | 'conversationType' | 'readWatermarks'
    >,
    senderId: string,
    content: string,
    /**
     * Whether what this ONE banner stands for names the reader - the message itself on the live path,
     * ANY inbound message of the flush on the batch path. A catch-up bringing "@me look", "ok", "lol"
     * is a mention even though its banner shows "lol": computed by the caller, which holds them all.
     */
    mentionsMe: boolean,
    isSystem: boolean,
    isOwn: boolean,
    /** The SENDER's instant in ms - what lets the native builder recognise one message. */
    sentAt: number,
    /** How many inbound messages the ONE banner stands for - see `NativeMessageNotification.covers`. */
    covers: number,
    /** True on the re-entry that follows the read of a salon's level - see the salon branch below. */
    salonLevelRead = false
  ): void {
    if (isOwn || isSystem) return;
    if (typeof document === 'undefined') return;
    // A MESSAGE THIS ACCOUNT HAS ALREADY READ IS NOT NEWS, asked with the predicate the unread badge
    // uses. It is reachable: a reply or "mark as read" from the shade answers a message whose row is
    // still queued for this device, the next connection delivers it, and it used to be announced
    // again - the reply's banner came back 2.5 s later without the reply line (Mi 9T, 2026-10-01).
    if (
      !isUnreadForUser(
        { isOwn, isSystem, senderId, timestamp: new SvelteDate(sentAt) },
        watermarkFor(convo.readWatermarks, ctx.userId.toLowerCase())
      )
    ) {
      console.log(
        `[NOTIF] Inbound in ${conversationKey} at ${sentAt} is already read here - nothing raised.`
      );
      return;
    }

    // THE ACCOUNT'S OWN SWITCH for this kind of notification. The server already refuses to PUSH a muted
    // category; this is the half it cannot reach - a frame received over the socket raises its
    // notification here, with no push involved, and it must obey the same set.
    const category = categoryOfConversation(conversationKey);
    if (!notificationPreferences.isEnabled(category)) {
      console.log(
        `[NOTIF] Inbound in ${conversationKey} - category "${category}" is switched off for this account; nothing raised.`
      );
      return;
    }

    // THE CONVERSATION'S OWN LEVEL (all / mentions / none), the salon's three for a private
    // conversation. The server applies `none` to every push and hands `mentions` to the device; a
    // frame received here involves no push, so this is the client's half - the ONE place it decides,
    // with the plaintext already in hand. A salon is read from its own cache - see below.
    //
    // `mentionsMe` (see `mentionsUser`) decides the level here and picks the notification channel,
    // which is the reader's own mute, sound and DND switch. `CanariFirebaseMessagingService` makes the
    // same decision from the same token for messages that arrive as a push; this is the WebSocket
    // half of one rule (NOTIF-16).
    //
    // LOOKED UP BY THE GROUP ID (`convo.id`), NEVER THE CONVERSATION KEY: a DM may be keyed
    // `me::peer`, and the server's levels are keyed by the MLS group.
    //
    // A SALON'S LEVEL IS THE SAME THREE VALUES AND THE SAME DECISION (`conversationLevelRefusal`), read
    // from the social service rather than the sign-in list, so it is cached per channel: read ONCE
    // when the first frame of a salon arrives (one shared request, no read per message), refreshed
    // whenever its settings panel opens. The frame that triggers the read waits for the answer and
    // re-enters with `salonLevelRead`; if the read FAILED it is raised as `all`, the account default,
    // and the failure is said by the store - the same rule as the groups' store.
    let level: ConversationNotificationLevel | undefined;
    if (category === 'messages') {
      level = notificationPreferences.groupLevel(convo.id);
    } else {
      level = notificationPreferences.channelLevel(conversationKey);
      if (level === undefined && !salonLevelRead) {
        void notificationPreferences.loadChannelLevel(conversationKey).then(() => {
          notifyInbound(
            ctx,
            conversationKey,
            convo,
            senderId,
            content,
            mentionsMe,
            isSystem,
            isOwn,
            sentAt,
            covers,
            true
          );
        });
        return;
      }
      if (level === undefined) {
        console.warn(
          `[NOTIF] Inbound in ${conversationKey} - the salon's level is unreadable; raised as "all".`
        );
      }
    }
    if (level !== undefined) {
      const refusal = conversationLevelRefusal(level, mentionsMe);
      if (refusal) {
        console.log(`[NOTIF] Inbound in ${conversationKey} - ${refusal}; nothing raised.`);
        return;
      }
    }

    // NATIVE MOBILE USED TO RETURN HERE, AND THAT IS WHY A PHONE IN A POCKET NEVER NOTIFIED.
    //
    // The premise was "the background push handler posts its own, so the user would get two". It
    // holds only when there IS a push, and for the ordinary backgrounded case there is none. The
    // server pushes a message only when the device has not ACKNOWLEDGED it after 10 s
    // (`scheduleDeferredPush`); a backgrounded Android app keeps its WebSocket, receives the frame
    // and ACKs it - so no push is ever sent, the push handler never runs, and this early return
    // meant nobody notified at all. Measured on device 2026-09-05, all three sources correlated on
    // one message: `[SEND] PUBLISHED recipient=...:tauri-...` with NO `[PUSH_DEFERRED]` after it,
    // an empty shade, and the app holding the message the whole time.
    //
    // That also explains the pair the campaign had backwards: LIFE-8 (`am kill` - the user killing
    // it) measured a decrypted push in 4.7 s, because a killed app cannot ACK, so the push does fire
    // and the handler notifies. The phone in a pocket was the failing case and the phone the user
    // had killed the passing one. (NOT LIFE-3, which force-stops: a force-stopped package sits in
    // Android's STOPPED state and the framework cancels every FCM broadcast to it, so that row
    // expects no notification at all and says nothing about this.)
    //
    // AND THE MOBILE CONDITION IS NOT THE DOCUMENT'S, BECAUSE THE DOCUMENT LIES THERE. Measured on
    // device: a backgrounded Tauri app reports `visibilityState: "visible"`, `hidden: false` and
    // `hasFocus: true` - byte for byte its foreground answer - so BOTH halves of the check below
    // would return early and this fix would have been inert. `isAppInForeground` reads the fact the
    // Android activity states for itself; see `appForeground.ts` for the measurement.
    // ONE PREDICATE FOR BOTH SIGNALS - see `canSeeArrival`. This used to ask only whether the app
    // was in front of the reader, which answered the wrong question: on a narrow screen an app in
    // the foreground still shows exactly one conversation, so a message for any OTHER conversation
    // was visible nowhere and notified nobody.
    if (canSeeArrival(ctx, conversationKey)) return;
    // A NOTIFICATION IS ONLY "EXPECTED" IF ONE CAN BE RAISED AT ALL. The line below exists to make
    // "no notification" distinguishable from "never asked for one", and on a session the browser has
    // permanently refused it did the opposite: it announced an ask, per message, for something that
    // could never happen - 12 messages, 33 `[NOTIF]` lines, measured on HEAL-REVOKE-9. The refusal is
    // said ONCE by `sendSystemNotification`, so silence here is now attributable to that one line
    // rather than to nothing. `default` is not blocked and still narrates: asking is real there.
    if (systemNotificationsBlockedAnnounceOnce()) return;
    // THE DECISION LINE, and it fires only when a notification is actually expected - the reader
    // cannot see this message land. Everything downstream of here already speaks (`[NOTIF] Raised`,
    // `Throttled`, `permission is ...`), and everything upstream is the ordinary case of a message
    // arriving in plain sight. Without it "no notification" and "never asked for one" are the same
    // silence, which is what left TAB-1 unattributable across three probes.
    //
    // AND IT NAMES WHICH OF THE THREE REASONS APPLIES, because they are no longer one. Until
    // 2026-09-07 this branch meant "the app is backgrounded" and said so; it now also covers a
    // foregrounded app whose narrow layout is showing a DIFFERENT conversation, and one sitting on
    // another route entirely. A line that asserts the old reason would misattribute the new ones.
    const away = isMobileTauriRuntime()
      ? !isAppInForeground()
        ? 'the app is backgrounded (no push is sent for a frame this client ACKed)'
        : `the app is open on ${window.location.pathname} showing ${ctx.selectedContact || 'the list'}`
      : document.visibilityState !== 'visible' || !document.hasFocus()
        ? `the tab is ${document.visibilityState}${document.hasFocus() ? '' : ' and unfocused'}`
        : `the window is open on ${window.location.pathname} showing ${ctx.selectedContact || 'the list'}`;
    console.log(`[NOTIF] Inbound in ${conversationKey} while ${away} - asking.`);
    const preview = getPreviewText(parseEnvelope(content));
    const notificationBody = preview || m.notif_new_message();
    // The sender's name is ASKED for, not just read: see `resolveNotificationSenderName`.
    void resolveNotificationSenderName(senderId, convo).then((senderName) =>
      ctx.sendSystemNotification(senderName, notificationBody, conversationKey, mentionsMe, {
        // ON ANDROID THIS IS THE CALL, not an enrichment of it: the frame no longer builds its own
        // plain notification, it asks the native builder for the SAME one a push would raise. See
        // `nativeNotification.ts` for the pair of notifications this replaced.
        conversationId: conversationKey,
        senderId,
        senderName,
        groupName: notificationGroupName(convo.conversationType, convo.contactName, convo.name),
        body: notificationBody,
        mentionsMe,
        sentAt,
        covers,
      })
    );
  }

  /**
   * What `sendChatMessage` needs from this composable: the echo writer and the one that moves a salon
   * echo along. One place, so the composer, a forward and a retry cannot disagree on either.
   */
  function makeSendDeps(ctx: MessagingContext, convo: Conversation): SendMessageDeps {
    return {
      userId: ctx.userId,
      conversation: convo,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        addMessageToChat(sid, content, contactName, ctx, options),
      patchSalonEcho: (key, id, change) =>
        void applySalonEchoChange(ctx.conversations, key, id, change, ctx.log),
      log: ctx.log,
    };
  }

  /**
   * Retries a salon message whose send was refused (the "Reessayer" of its row). The refusal is
   * shown on the same banner the first attempt used; the row itself carries the state.
   */
  async function retrySend(ctx: MessagingContext, messageId: string): Promise<void> {
    const key = ctx.selectedContact;
    const convo = key ? ctx.conversations.get(key) : undefined;
    if (!key || !convo) return;
    ctx.setSendError('');
    const refusal = await retrySalonSend(messageId, makeSendDeps(ctx, convo));
    if (!refusal) return;
    // A retry may wait for its salon to load: the banner goes to the conversation still on screen.
    if (ctx.selectedContact === key) ctx.setSendError(refusal);
    else ctx.log(`[SEND] retry refusal not shown: the conversation changed (${refusal})`);
  }

  /**
   * Sends again the salon messages a past page life left unanswered (WP-OFF-3): every salon's when
   * `conversationKey` is null (the session is up), one salon's when it was just opened. Each echo is
   * drawn in its own conversation, looked up when its salon is sendable. Returns the texts written
   * before the ledger kept enough to rebuild them, for the caller to hand back to the composer.
   */
  function resumeUnsentSends(
    ctx: MessagingContext,
    conversationKey: string | null
  ): Promise<UnsentSalonText[]> {
    return resumeUnsentSalonSends(
      ctx.userId,
      (key) => {
        const convo = ctx.conversations.get(key);
        return convo ? makeSendDeps(ctx, convo) : null;
      },
      conversationKey
    );
  }

  /** Drops a failed salon message the member gave up on: its registration and its row. */
  function discardSend(ctx: MessagingContext, messageId: string): void {
    const key = ctx.selectedContact;
    const convo = key ? ctx.conversations.get(key) : undefined;
    if (!key || !convo) return;
    discardSalonSend(messageId, ctx.userId);
    ctx.conversations.set(key, {
      ...convo,
      messages: convo.messages.filter((m) => !(m.id === messageId && m.awaitingServerId)),
    });
    ctx.log(`[SEND] salon message ${messageId.slice(0, 8)}... discarded by its author`);
  }

  /**
   * Takes an UNCONFIRMED salon message back: its row goes, and its text is returned for the composer
   * (the caller restores it as WP-OFF-1 does). `null` when nothing is registered under the id.
   */
  function takeBackSend(ctx: MessagingContext, messageId: string): string | null {
    const key = ctx.selectedContact;
    const convo = key ? ctx.conversations.get(key) : undefined;
    if (!key || !convo) return null;
    const text = takeBackSalonSend(messageId, ctx.userId);
    if (text === null) {
      ctx.log(`[SEND] take back ${messageId.slice(0, 8)}...: no salon send registered`);
      return null;
    }
    ctx.conversations.set(key, {
      ...convo,
      messages: convo.messages.filter((m) => !(m.id === messageId && m.awaitingServerId)),
    });
    ctx.log(
      `[SEND] unconfirmed salon message ${messageId.slice(0, 8)}... put back in the composer`
    );
    return text;
  }

  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    ctx: MessagingContext,
    options: AddMessageToChatOptions & { skipDbSave?: boolean } = {}
  ) {
    const normalized = contactName.toLowerCase();

    // An OWN message is never deferred, and that is a difference in kind rather than a tuning
    // choice. The bulk buffer exists to stop a large inbound drain re-rendering the list message by
    // message - but MLS gives no echo of your own message, so THIS call is the only writer the
    // sender's copy will ever get, and the buffer is discarded without flushing by a second drain
    // (`beginBulkMessageIngest` clears unconditionally) and by `resetMessageCatchupState`. The
    // outbox cannot repair it either: `persistSent` looks the message up in `conversations`, which a
    // buffered message never reached, and returns without writing. So a send composed during any
    // drain window died before it was persisted - the receiver had it and the sender lost it at the
    // next load (WP-ECHO-1). It also explains why the OFFLINE path was always correct: offline there
    // is no inbound drain, so the echo took the live path. One extra item costs nothing to render.
    // The acting device's own visible notice is the same case under a `system` sender
    // (`soleWriter`): nothing echoes it either, so the buffer would be its only copy.
    if (bulkIngestActive && !isOwnMessage(senderId, ctx.userId) && options.soleWriter !== true) {
      const convo = ctx.conversations.get(normalized);
      if (!convo) {
        console.warn(
          `[ADD_MSG] conversation "${normalized}" introuvable (bulk) — bufferisation orpheline`
        );
        const buffer = orphanBuffer.get(normalized) ?? [];
        if (buffer.length < MAX_ORPHAN_MESSAGES_PER_CONVERSATION) {
          buffer.push({ senderId, content, contactName, options });
          orphanBuffer.set(normalized, buffer);
        }
        return;
      }
      const id = normalizeMessageId(options.messageId) ?? crypto.randomUUID();
      const existing = bulkIngestBuffer.get(normalized) ?? [];
      const held = convo.messages.find((m) => m.id === id);
      /**
       * **AN UPGRADE IS NOT A DUPLICATE, AND CALLING IT ONE COSTS THE MESSAGE FOR EVER.**
       *
       * The row this envelope meets may be the FCM notification's caption, put in memory a few
       * hundred milliseconds earlier by `mergeFcmMessagesIntoConversations` - the same id, and
       * deliberately so. The live path below asks `shouldUpgradeMessage` and replaces it; this one
       * only asked whether the id was known, so on every launch where the push preview landed
       * BEFORE the drain reached the frame, the envelope was dropped here as a duplicate. The
       * handler then returned `true`, the frame was acknowledged, and the server deleted the only
       * copy: the bubble reads the caption for good, and nothing can ever repair it.
       *
       * Measured on the Mi 9T, 2026-09-23 (`archive/photoprev.mjs --mode restored`): preview
       * injected at 04:51:34, `[ADD_MSG] Duplicate ignored during a bulk ingest id=57187590` at
       * 04:51:44, `messageCallback → true` in the same millisecond. It is the user's 2026-09-22
       * report, reproduced.
       *
       * The upgrade FALLS THROUGH to the live path rather than being buffered, and that is not a
       * shortcut: buffering exists to stop a bulk arrival re-rendering the list once per message,
       * and an upgrade adds no row - it replaces the content of one already on screen. There is no
       * jank to avoid, and there IS a write to do that only the live path performs.
       */
      const upgrades = held !== undefined && shouldUpgradeMessage(held, content);
      if (!upgrades && (existing.some((m) => m.messageId === id) || held !== undefined)) {
        // A duplicate is ordinary and this is not an accusation - but it is the FIRST of two silent
        // returns on the only path an inbound message can take, and between them they can absorb a
        // message without leaving anything behind. A card that never appeared has to be explainable
        // from a log, and "we already had it" is one of the explanations.
        console.log(`[ADD_MSG] Duplicate ignored during a bulk ingest id=${id}`);
        return;
      }
      if (!upgrades) {
        existing.push({
          senderId,
          content,
          ...options,
          messageId: id,
          ingestSequence: options.ingestSequence ?? bulkIngestSeq++,
        });
        bulkIngestBuffer.set(normalized, existing);
        raiseOverlayIfWorthAnnouncing();
        return;
      }
      console.log(`[ADD_MSG] Preview upgrade during a bulk ingest id=${id} - taking the live path`);
    }

    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      console.warn(`[ADD_MSG] conversation "${normalized}" introuvable — bufferisation orpheline`);
      const buffer = orphanBuffer.get(normalized) ?? [];
      if (buffer.length < MAX_ORPHAN_MESSAGES_PER_CONVERSATION) {
        buffer.push({ senderId, content, contactName, options });
        orphanBuffer.set(normalized, buffer);
      }
      return;
    }

    const isOwn = isOwnMessage(senderId, ctx.userId);
    // ONE BELIEF, ONE DERIVATION - and this is the seam that MATERIALISES the row, so it is derived
    // here rather than trusted from the caller. `isSystemSender`'s own docblock says why: a writer
    // that sets the sender without the flag produces a notice rendered as an ORDINARY BUBBLE
    // labelled "Utilisateur", because no display name resolves for the sentinel. The `history_bundle`
    // is exactly that writer - `serializeForBundle` carries reactions, tombstones and the edit
    // instant, and has never carried this flag - and the 2026-09-14 fix derived it in the REPLAY's
    // `pushPendingMessage` only, leaving the LIVE bundle merge restating it here. Both halves of one
    // invariant, one of them held.
    //
    // AND THE RENDER IS THE SMALLEST OF THE THREE THINGS IT DECIDES. The same flag gates the unread
    // badge, the arrival tone and the OS notification below, so a notice arriving through a bundle
    // rang a phone and raised a count for a line nobody sent.
    const isSystem = options.isSystem === true || isSystemSender(senderId);
    // One arriving message, so one scan: building an index here would cost the same walk and throw
    // it away. The batch path below is the one that had to change.
    const resolvedTimestamp = resolveMessageTimestamp(
      options,
      (id) => convo.messages.find((m) => m.id === id),
      isOwn
    );
    const newMsg: ChatMessage = {
      id: normalizeMessageId(options.messageId) ?? crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: new SvelteDate(resolvedTimestamp),
      isOwn,
      replyTo: options.replyTo,
      isSystem,
      status: options.status,
      isFcmPreview: options.isFcmPreview,
      serverTimestamp: options.serverTimestamp,
      ...(options.salonEcho ? { awaitingServerId: true } : {}),
      ...(options.restoredUnverified ? { restoredUnverified: true } : {}),
    };
    // The author's signature and the unverified marker live in the STORED row only (sealed), so
    // every write of this message below carries them.
    const proofFields = {
      ...(options.authorship ? { authorship: options.authorship } : {}),
      ...(options.restoredUnverified ? { restoredUnverified: true } : {}),
    };

    const dupIdx = convo.messages.findIndex((m) => m.id === newMsg.id);
    if (dupIdx !== -1) {
      const existing = convo.messages[dupIdx];
      if (shouldUpgradeMessage(existing, content)) {
        const upgraded = mergeMessageUpgrade(existing, newMsg);
        const nextMessages = insertMessageOrdered(
          convo.messages.filter((m) => m.id !== newMsg.id),
          upgraded
        );
        ctx.conversations.set(normalized, {
          ...convo,
          messages: nextMessages,
          lastMessageAt: advanceLastMessageAt(convo.lastMessageAt, [upgraded]),
        });
        if (ctx.storage && !(options.skipDbSave ?? isChannelConversationId(normalized))) {
          try {
            // The row is replaced wholesale, so everything the merged message still carries has to
            // be written back: a reaction that landed on the FCM preview before the real body
            // arrived would otherwise be erased by the upgrade.
            await ctx.storage.saveMessage(
              {
                id: upgraded.id,
                conversationId: normalized,
                senderId: upgraded.senderId,
                content: upgraded.content,
                timestamp: upgraded.timestamp.getTime(),
                serverTimestamp: upgraded.serverTimestamp,
                reactions: upgraded.reactions,
                isDeleted: upgraded.isDeleted,
                isEdited: upgraded.isEdited,
                ...(upgraded.editedAt ? { editedAt: upgraded.editedAt.getTime() } : {}),
                isFcmPreview: false,
                ...proofFields,
              },
              ctx.deviceKeyB64
            );
          } catch (e) {
            console.error('[DB] Failed to upgrade message:', e);
          }
        }
        const updatedConvo = ctx.conversations.get(normalized);
        if (updatedConvo) {
          publishTabMessageUpdate({
            type: 'message_added',
            conversationId: normalized,
            message: upgraded,
            ...(updatedConvo.lastMessageAt !== undefined
              ? { lastMessageAt: updatedConvo.lastMessageAt }
              : {}),
            unreadCount: updatedConvo.unreadCount ?? 0,
            ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
          });
        }
        console.log(`[ADD_MSG] ✓ Message upgraded: id=${newMsg.id}`);
        return;
      }
      console.log(`[ADD_MSG] Duplicate ignored id=${newMsg.id}`);
      return;
    }

    // READ ON ARRIVAL ONLY WHERE THE READER IS READING. The bare selection stays true after they walk
    // to another route or put the window away, which counted a message nobody saw as read.
    const isConversationOpen = isReadingConversationNow(normalized, ctx.selectedContact);
    // The same question the batch path asks, which until 2026-08-30 it did not: this one forgot
    // the watermark AND counted system messages, so a replayed frame taking the single path could
    // still raise a badge for something already read, and a "X joined" notice raised one for
    // something nobody reads at all.
    const shouldMarkUnread =
      !isConversationOpen &&
      !isSalonMuted(normalized) &&
      isUnreadForUser(newMsg, watermarkFor(convo.readWatermarks, ctx.userId.toLowerCase()));
    const nextUnreadCount = shouldMarkUnread
      ? (convo.unreadCount ?? 0) + 1
      : isConversationOpen
        ? 0
        : (convo.unreadCount ?? 0);

    ctx.conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: insertMessageOrdered(convo.messages, newMsg),
      lastMessageAt: advanceLastMessageAt(convo.lastMessageAt, [newMsg]),
    });
    console.log(`[ADD_MSG] ✓ Message added: id=${newMsg.id}`);

    // A salon echo has no server id yet: announced to the sibling tabs now, it would be a row they
    // can never reconcile. `applySalonEchoChange` announces it once it is re-keyed.
    if (!options.salonEcho) {
      publishTabMessageUpdate({
        type: 'message_added',
        conversationId: normalized,
        message: newMsg,
        ...tabSeed(advanceLastMessageAt(convo.lastMessageAt, [newMsg])),
        unreadCount: nextUnreadCount,
        ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      });
    }

    // AND THE ONE ANNOUNCEMENT THAT TRAVELS THE OTHER WAY. The call above is leader-only, because
    // only the leader receives inbound frames and only it can speak for the conversation's counts.
    // A message composed HERE is the exception: whichever tab composed it is the only one that
    // knows, and a follower composing one used to tell nobody - TAB-4b, 2026-09-05. `isOwn` is the
    // discriminator and it is already computed above.
    if (isOwn && !options.salonEcho) {
      publishComposedMessage({
        type: 'own_message_composed',
        conversationId: normalized,
        message: newMsg,
        ...tabSeed(advanceLastMessageAt(convo.lastMessageAt, [newMsg])),
      });
    }

    // READ ON ARRIVAL IS STILL READ. This is the case the unread counter cannot see: the salon is
    // already open, so the message is read the instant it lands and `nextUnreadCount` stays 0 - and
    // a sibling device holding its banner has been told nothing. See `channelReadSignal`.
    if (
      isConversationOpen &&
      !isOwn &&
      !isSystem &&
      isChannelConversationId(normalized) &&
      claimChannelReadSignal(normalized, newMsg.timestamp.getTime())
    ) {
      ctx.signalChannelRead?.(normalized);
    }

    // A TONE ONLY WHERE THE MESSAGE CAN BE SEEN LANDING. Unconditional, it was a ghost: a sound on
    // a phone whose screen shows another conversation, or none, tells the reader something happened
    // and gives them nothing to look at. Where this is false the OS notification is raised instead
    // and carries its channel's own sound, so exactly one audible signal is produced either way.
    if (
      !isOwn &&
      !isSystem &&
      !isStaleInboundMessage(resolvedTimestamp) &&
      canSeeArrival(ctx, normalized)
    ) {
      if (ctx.playReceiveTone) {
        ctx.playReceiveTone(mentionsUser(content, ctx.userId));
      } else {
        ctx.playNotificationTone();
      }
    }

    // ONE DECISION, ASKED BY BOTH INBOUND PATHS - see `notifyInbound`.
    notifyInbound(
      ctx,
      normalized,
      convo,
      senderId,
      content,
      mentionsUser(content, ctx.userId),
      isSystem,
      isOwn,
      resolvedTimestamp.getTime(),
      1
    );

    const skipDbSave = options.skipDbSave ?? isChannelConversationId(normalized);
    if (ctx.storage && !skipDbSave) {
      try {
        const row = {
          id: newMsg.id,
          conversationId: normalized,
          senderId: newMsg.senderId,
          content,
          timestamp: newMsg.timestamp.getTime(),
          serverTimestamp: options.serverTimestamp,
          ...(options.isFcmPreview ? { isFcmPreview: true } : {}),
          ...proofFields,
        };
        // AN OWN MESSAGE AND THE ENTRY THAT SENDS IT ARE ONE FACT, so they are one write. Persisting
        // the echo and then queuing it was two awaits, and a document torn down between them left a
        // message the sender could see and no queue would ever send (TAB-5, 2026-09-05). Every other
        // caller - an inbound message, an FCM upgrade - has no entry and takes the single-store path.
        if (options.outboxEntry) {
          await ctx.storage.saveMessageWithOutboxEntry(row, options.outboxEntry, ctx.deviceKeyB64);
        } else {
          await ctx.storage.saveMessage(row, ctx.deviceKeyB64);
        }
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] Failed to persist message:', e);
      }
    }

    // NOTHING HERE MOVES THE PANE. Persisting a message used to end with a bare
    // `chatContainer.scrollTop = chatContainer.scrollHeight`, asking nobody - not whether the
    // reader had scrolled up to read, and not even whether this message belongs to the thread they
    // have open, since `getChatContainer()` is whichever one that is. `ChatArea` owns the position
    // and decides it with `respondToNewMessage`, from the one stick-to-bottom flag.
  }

  /**
   * Appends multiple messages in a single reactive update and one batch IndexedDB write.
   * Used by history replay and bulk catch-up to avoid O(n) individual updates that would
   * cause UI jank. Advances `lastMessageAt` to the newest REAL (non-notice) message of the batch.
   */
  async function batchAddMessages(
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string,
    ctx: MessagingContext,
    origin: MessageBatchOrigin
  ) {
    if (messages.length === 0) return;
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      // THE SECOND SILENT RETURN, and the more dangerous one: these messages were ACCEPTED into the
      // bulk buffer, which means the conversation was in the map when they arrived and is not any
      // more. They are dropped here without being rendered or persisted, and nothing else in the
      // system would ever mention them again. Same rule as `warnIfDiscardingBuffered`: discarding
      // may be right, being silent about it never is.
      console.warn(
        `[ADD_MSG] conversation "${normalized}" vanished between buffering and flush - dropping ${messages.length} message(s), never rendered nor persisted`
      );
      return;
    }

    // ONE index, built once, for the two questions this loop asks of every incoming message: "do we
    // already hold it" and "what timestamp did we give it". Both used to be a linear scan of the
    // rendered list, so a catch-up of `m` messages into a conversation of `n` cost `2·n·m`
    // comparisons on the main thread - the post-ingest freeze, and a cost that grows with the
    // conversation rather than with the batch. It has to work at any size, so it is an index.
    // Ids seen during THIS batch are added to it too, which is what the separate dedup set did.
    const byId = indexMessagesById(convo.messages);
    const toStore: StoredMessage[] = [];
    const upgradedById = new SvelteMap<string, ChatMessage>();
    const brandNew: ChatMessage[] = [];

    let processedCount = 0;
    for (const pm of messages) {
      // Yield to the main thread every 50 messages to avoid UI freeze during large catch-ups.
      processedCount++;
      if (processedCount % 50 === 0) await yieldToMainThread();

      const id = normalizeMessageId(pm.messageId) ?? crypto.randomUUID();
      // Derived per row, for the reason spelt out in `addMessageToChat` above: this is the OTHER
      // seam that materialises a row, and the `history_bundle` reaches BOTH of them.
      const isSystem = pm.isSystem === true || isSystemSender(pm.senderId);
      const existingMsg = byId.get(id);
      if (existingMsg && shouldUpgradeMessage(existingMsg, pm.content)) {
        const upgraded = mergeMessageUpgrade(existingMsg, {
          content: pm.content,
          replyTo: pm.replyTo,
          isSystem,
          serverTimestamp: pm.serverTimestamp,
        });
        upgradedById.set(id, upgraded);
        if (ctx.storage) {
          toStore.push({
            id,
            conversationId: normalized,
            senderId: upgraded.senderId,
            content: pm.content,
            timestamp: upgraded.timestamp.getTime(),
            serverTimestamp: pm.serverTimestamp,
            isFcmPreview: false,
            ...(pm.authorship ? { authorship: pm.authorship } : {}),
            ...(pm.restoredUnverified ? { restoredUnverified: true } : {}),
          });
        }
        continue;
      }
      if (existingMsg) continue;

      const isOwn = isOwnMessage(pm.senderId, ctx.userId);
      const resolvedTimestamp = resolveMessageTimestamp(pm, (mid) => byId.get(mid), isOwn);
      const newMsg: ChatMessage = {
        id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: new SvelteDate(resolvedTimestamp),
        isOwn,
        replyTo: pm.replyTo,
        isSystem,
        ingestSequence: pm.ingestSequence,
        ...(pm.restoredUnverified ? { restoredUnverified: true } : {}),
      };
      brandNew.push(newMsg);
      // The index is also the dedup set: a batch carrying the same id twice must add it once.
      byId.set(id, newMsg);

      if (ctx.storage) {
        toStore.push({
          id,
          conversationId: normalized,
          senderId: newMsg.senderId,
          content: pm.content,
          timestamp: (newMsg.timestamp instanceof Date
            ? newMsg.timestamp
            : new SvelteDate(newMsg.timestamp)
          ).getTime(),
          serverTimestamp: pm.serverTimestamp,
          ...(isSystem ? { readBy: [] } : {}),
          ...(pm.authorship ? { authorship: pm.authorship } : {}),
          ...(pm.restoredUnverified ? { restoredUnverified: true } : {}),
        });
      }
    }

    if (upgradedById.size === 0 && brandNew.length === 0) {
      // Ordinary - a re-drain of frames this device already holds - and still not silent: it is the
      // difference between "the batch arrived and we had it all" and "the batch never arrived".
      console.log(
        `[ADD_MSG] Batch into "${normalized}": ${messages.length} message(s), all already held`
      );
      return;
    }

    // READ ON ARRIVAL ONLY WHERE THE READER IS READING. The bare selection stays true after they walk
    // to another route or put the window away, which counted a message nobody saw as read.
    const isConversationOpen = isReadingConversationNow(normalized, ctx.selectedContact);
    // COUNTED AGAINST THIS USER'S OWN WATERMARK, not against "arrived just now". The two are the
    // same thing only for live traffic; a reconciliation delivers frames that are new to THIS
    // device and were read long ago on another one, and counting those raised a badge the next
    // read receipt in the same replay immediately cleared. Interleaved, the pair made a
    // conversation flash read/unread for the whole reconciliation. The watermark is persisted on
    // the conversation, so it is already loaded before any of this runs - the count was ignoring a
    // fact it held. Deriving it here makes the result independent of the order frames arrive in.
    //
    // AND AGAINST THE ROW AS IT IS NOW, NOT AS IT WAS BEFORE THE LOOP. The loop yields every 50
    // messages, and the boot restore's second phase may merge its stored page into this row in
    // between - the restore asks for the frames it refused as soon as the rows exist
    // (`notifyConversationRowsSeeded`), so the two do overlap. Writing back the copy read before the
    // loop would erase that page; a message the row gained meanwhile is not added a second time.
    const current = ctx.conversations.get(normalized);
    const base = current ?? convo;
    const heldNow = current && current !== convo ? indexMessagesById(current.messages) : null;
    const toAdd = heldNow ? brandNew.filter((m) => !heldNow.has(m.id)) : brandNew;
    const myWatermark = watermarkFor(base.readWatermarks, ctx.userId.toLowerCase());
    // A MUTED SALON RAISES NOTHING, the server's count of it being zero by the same rule.
    const addedUnread = isSalonMuted(normalized)
      ? 0
      : toAdd.filter((msg) => isUnreadForUser(msg, myWatermark)).length;
    const nextUnreadCount = isConversationOpen ? 0 : (base.unreadCount ?? 0) + addedUnread;

    const withUpgrades = base.messages.map((m) => upgradedById.get(m.id) ?? m);
    const merged = mergeMessagesInInputOrder(withUpgrades, toAdd);

    if (current) {
      ctx.conversations.set(normalized, {
        ...current,
        unreadCount: nextUnreadCount,
        messages: merged,
        lastMessageAt: advanceLastMessageAt(current.lastMessageAt, merged),
      });
    } else {
      // Same rule as the vanished-conversation return at the top: never silent. The rows are still
      // persisted below, so the store keeps what the map could not show.
      console.warn(
        `[ADD_MSG] conversation "${normalized}" vanished during the batch - ${brandNew.length} message(s) persisted, not rendered`
      );
    }

    // THE ONLY INBOUND PATH WITH NO SUCCESS LINE, until 2026-08-20. The live path says
    // `Message added` per message; this one said nothing at all, so a message that took the buffered
    // path was invisible whether it landed or not - which is exactly the state an invitation card
    // that never appeared left the log in. One line per FLUSH rather than per message: a catch-up
    // carries thousands, and the question a reader has is which conversation received how many.
    // System messages are named individually because they are few, and because a card is one.
    const systemIds = brandNew.filter((m) => m.isSystem).map((m) => m.id);
    console.log(
      `[ADD_MSG] Batch into "${normalized}": ${brandNew.length} added, ${upgradedById.size} upgraded, selected=${ctx.selectedContact === normalized}` +
        (systemIds.length > 0 ? ` - system: ${systemIds.join(', ')}` : '')
    );

    // THE SAME QUESTION THE LIVE PATH ASKS, and until 2026-09-05 this path never asked it. A message
    // buffered during a catch-up reaches the user through here and through nowhere else, so a tab
    // in the background - the state that produces a catch-up in the first place - was told about
    // nothing at all (TAB-1). ONE notification per flush, for the LAST inbound message: the
    // 800 ms throttle in `sendSystemNotification` would collapse a per-message loop to one anyway,
    // and the one a reader wants is the most recent, not the oldest.
    const lastInbound = [...brandNew]
      .reverse()
      .find((msg) => !msg.isSystem && !isOwnMessage(msg.senderId, ctx.userId));
    // AND IT ASKS THE APP, NOT THE DOCUMENT - THIS GUARD WAS THE ONE SITE IN THIS FILE THAT STILL
    // DID NOT (2026-09-24). `document.visibilityState` is permanently `'visible'` in a backgrounded
    // Android Tauri WebView - `hidden: false` and `hasFocus: true` too, byte for byte its
    // foreground answer, measured on device - so `!== 'visible'` was permanently FALSE there and
    // this line never printed on mobile at all. Not a misleading report: an ABSENT one, on the
    // platform where a catch-up flush is the common case and where the notification behaviour is
    // read from logs. `canSeeArrival` and the `away` label above already route mobile through
    // `isAppInForeground`, which reads the fact the Android activity states for itself; this is the
    // same predicate, and the label names the state it actually observed rather than the
    // document's opinion of it.
    const appAway = isMobileTauriRuntime()
      ? !isAppInForeground()
      : typeof document !== 'undefined' && document.visibilityState !== 'visible';
    if (!lastInbound && brandNew.length && appAway) {
      // The other half of the same question: a flush that added messages while the app was away and
      // raised nothing has either seen only own/system rows, or lost them to a predicate.
      const awayState = isMobileTauriRuntime() ? 'backgrounded' : document.visibilityState;
      console.log(
        `[NOTIF] Batch into "${normalized}" added ${brandNew.length} while ${awayState}, none of them an inbound message - nothing to raise.`
      );
    }
    // AND ONLY AN ARRIVAL IS NEWS. `brandNew` means "not already in the in-memory map", which on a
    // cold start is EVERY message a peer sends back - the map is being filled for the first time.
    // So the history bundle that repairs a device (`[HISTORY_BUNDLE]`, `systemMessageHandler`) came
    // through here at every launch and raised a notification for its last message: the one the user
    // had already read the notification for, and dismissed. That is `G2` in the user's words -
    // "une notification que j'ai ignoree se raffiche au lancement de l'app" - and the timing said
    // so, because a dismissal only survives until the next launch.
    //
    // The fix is not a clock and not a ledger: the caller KNOWS which of the two it is handing over,
    // and used to throw that away at the door. A restore is silent here, always, on every platform.
    if (lastInbound && origin === 'restore') {
      console.log(
        `[NOTIF] Batch into "${normalized}" restored ${brandNew.length} message(s) from an archive - a replay is not an arrival, nothing raised.`
      );
    } else if (lastInbound) {
      const inbound = brandNew.filter(
        (msg) => !msg.isSystem && !isOwnMessage(msg.senderId, ctx.userId)
      );
      notifyInbound(
        ctx,
        normalized,
        convo,
        lastInbound.senderId,
        lastInbound.content,
        // ANY message of the flush, not the last one: at `mentions` a catch-up whose mention is not
        // its final line is still a mention, and the one banner must say so.
        inbound.some((msg) => mentionsUser(msg.content, ctx.userId)),
        false,
        false,
        lastInbound.timestamp.getTime(),
        // THE FLUSH RAISES ONE BANNER FOR N MESSAGES, and the server may have pushed each of them.
        inbound.length
      );
    }

    publishTabMessageUpdate({
      type: 'messages_batch',
      conversationId: normalized,
      messages: brandNew,
      ...tabSeed(advanceLastMessageAt(convo.lastMessageAt, brandNew)),
      unreadCount: nextUnreadCount,
    });

    // Single batch DB write (community channels are server-authoritative)
    if (ctx.storage && toStore.length > 0 && !isChannelConversationId(normalized)) {
      try {
        await ctx.storage.saveMessages(toStore, ctx.deviceKeyB64);
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] batchAddMessages failed:', e);
      }
    }

    // NOTHING HERE MOVES THE PANE. Persisting a message used to end with a bare
    // `chatContainer.scrollTop = chatContainer.scrollHeight`, asking nobody - not whether the
    // reader had scrolled up to read, and not even whether this message belongs to the thread they
    // have open, since `getChatContainer()` is whichever one that is. `ChatArea` owns the position
    // and decides it with `respondToNewMessage`, from the one stick-to-bottom flag.
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /** Main send handler: verifies MLS membership, uploads any pending media files (with client-side AES-GCM encryption), then sends a text message. Handles channel (REST) and DM/group (MLS) paths. */
  /**
   * @param opts.files Send exactly these instead of draining the pending queue, and leave the
   *        queue untouched. One caller: a voice note, which the recorder's gesture has already
   *        committed and which must not carry along whatever else the composer happens to hold.
   */
  async function handleSendChat(
    ctx: MessagingContext,
    messageText: string,
    opts?: { files?: import('$lib/media').PendingMediaFile[] }
  ): Promise<boolean | undefined> {
    const text = messageText.trim();
    const sendsQueue = !opts?.files;
    const filesToSend = opts?.files ?? [...pendingMediaFilesFor(ctx.selectedContact)];
    const fileEntries = filesToSend;
    const mediaCaption = text || undefined;
    let sentMediaMessageCount = 0;
    /** A held salon upload was refused because the account signed out - see the media catch. */
    let sessionEndedDuringSend = false;

    // JSON-quoted: a `"` in a member's text closes a hand-written quote, and the in-app log's
    // redaction then keeps the words after it as ordinary log words (appLogRedact, 2026-10-14).
    ctx.log(
      `[SEND] handleSendChat: contact=${JSON.stringify(ctx.selectedContact)} chars=${text.length} files=${filesToSend.length}`
    );

    if (!text && filesToSend.length === 0) {
      ctx.log('[SEND] Abort: no text and no file');
      return;
    }
    if (!ctx.selectedContact) {
      ctx.log('[SEND] Abort: no contact selected.');
      return;
    }
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) {
      ctx.log(`[SEND] Abort: no conversation found for "${ctx.selectedContact}".`);
      return;
    }

    const sentFrom = ctx.selectedContact;
    const isChannel = isChannelConversationId(ctx.selectedContact);
    ctx.log(
      `[SEND] convo: groupId="${convo.id}" lifecycle=${convo.lifecycle} isChannel=${isChannel}`
    );

    // Media (inline upload+send) still requires a ready MLS group; queuing media is a later
    // increment. Text/reply are captured into the outbox and never blocked here - they flush
    // automatically once the group becomes sendable.
    if (filesToSend.length > 0 && !isChannel) {
      // WAIT FOR THE DRAIN, DO NOT REFUSE BECAUSE OF IT.
      //
      // This used to bail out on `isMessageCatchupActive` and tell the user "Synchronisation en
      // cours - reessayez dans un instant". That flag is raised from `pendingCount > 1`, a count of
      // CIPHERTEXTS taken before anything is decrypted, so it cannot tell an arriving message from
      // the reconciliation's own probe: two probe frames on a server carrying no other traffic were
      // enough to refuse a photo. The requirement was never "no drain is running" - it is "encrypt
      // at the current epoch", and `waitForMessageQueueIdle` states exactly that, as a fact rather
      // than a guess. It is the same barrier the outbox flusher takes before every send, and it
      // costs nothing when there is no drain to wait for.
      await ctx
        .ensureMls()
        // `null`: a click on the send button, never a stack inside a decrypt session.
        .waitForMessageQueueIdle('media send', null)
        .catch((e) => ctx.log(`[SEND] queue-idle barrier failed, sending anyway: ${String(e)}`));
      const stillMember = await ctx.verifyCurrentUserMembership(sentFrom);
      if (!stillMember || convo.lifecycle !== 'active') {
        ctx.setSendError(m.chat_send_session_establishing());
        return;
      }
    }

    const currentReplyingTo = replyByConversation.get(sentFrom) ?? null;
    replyByConversation.delete(sentFrom);
    ctx.setSendError('');
    const channelSvc = isChannel ? new ChannelService() : null;

    const mediaTypeFromMime = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
      mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'file';

    if (fileEntries.length > 0) {
      // Only the queue's own send empties it; a voice note never entered it.
      // ONLY WHAT THIS SEND TOOK leaves the staging: the membership barrier above awaits, and a file
      // staged in the same conversation meanwhile belongs to the NEXT send, not to this one's clear.
      if (sendsQueue) {
        setPendingMediaFiles(
          sentFrom,
          pendingMediaFilesFor(sentFrom).filter((entry) => !fileEntries.includes(entry))
        );
      }
      try {
        for (let index = 0; index < fileEntries.length; index++) {
          const entry = fileEntries[index];
          const captionForFile = index === 0 ? mediaCaption : undefined;
          const messageId = crypto.randomUUID();
          const sentAt = Date.now();

          if (isChannel && channelSvc) {
            // Channels are server-authoritative + always available: encrypt + upload + send inline.
            isUploadingMedia = true;
            // THE SALON MUST BE LOADED BEFORE ANYTHING IS UPLOADED OR SEALED, and one that is not
            // yet is WAITED FOR, as a text is (`salonSendGate.ts`): the upload indicator stays up
            // meanwhile, and a refusal re-stages the file below. Before the upload, so a salon that
            // never loads leaves no orphan blob behind.
            const gateReading = readSalonSendGate(sentFrom);
            if (gateReading.kind === 'wait') {
              ctx.log(
                `[MEDIA] ${messageId.slice(0, 8)}... HELD: salon ${sentFrom.slice(0, 16)} is not loaded on this device yet`
              );
            }
            const gate =
              gateReading.kind === 'wait' ? await whenSalonSendable(sentFrom) : gateReading;
            if (gate.kind === 'refused') throw new SalonNotLoadableError(gate.reason);
            // `ctx.authToken` is a COPY taken at sign-in: it is empty or EXPIRED far more often than it
            // is live, and a 15-minute-old copy sent the upload out as `401 JWT expired` ("your session
            // expired") on a tab that was perfectly signed in. `getToken` is the one place that knows
            // the real expiry and renews it, exactly as the DM outbox path already does.
            const authToken = await getToken();
            ctx.setAuthToken(authToken);
            const mediaRef = await mediaService.encryptAndUpload(
              entry.file,
              authToken,
              { width: entry.width, height: entry.height },
              'ephemeral'
            );
            const protoBytes = encodeAppMessage({
              ...mkMedia({
                kind: mediaKindFromEnvelope(mediaRef.type),
                mediaId: mediaRef.mediaId,
                key: fromHex(mediaRef.key),
                iv: fromHex(mediaRef.iv),
                mimeType: mediaRef.mimeType,
                size: mediaRef.size,
                fileName: mediaRef.fileName ?? '',
                caption: captionForFile,
                voiceNote: entry.voiceNote ?? false,
                ...(mediaRef.width && mediaRef.height
                  ? { width: mediaRef.width, height: mediaRef.height }
                  : {}),
                ...mediaPlaceholderProtoField(entry.placeholder),
                ...mediaEncodingProtoField(mediaRef.encoding),
              }),
              messageId,
              sentAt,
            });
            // The salon the send was MADE in: the selection may have moved during the wait above.
            const actualChannelId = sentFrom.replace('channel_', '');
            await sendEncryptedChannelMessage(actualChannelId, protoBytes, messageId);
          } else {
            // MLS: queue the media. The flusher uploads then sends once the group is ready
            // (the optimistic message shows a skeleton + pending clock until then).
            const type = mediaTypeFromMime(entry.file.type);
            // A chat reel's declaration, made at the send so its 30 days count from it. Empty for
            // anything else: an ordinary attachment is encoded exactly as before. The take is RAW
            // (RC-5): its intent and expiry are declared now, its LENGTH once the outbox has
            // prepared it - the encoder is what measures it.
            const reelDeclaration = entry.prepareRaw ? chatReelPendingDeclaration(sentAt) : {};
            const placeholder = serializeEnvelope(
              mkMediaEnvelope(
                {
                  type,
                  mediaId: '',
                  key: '',
                  iv: '',
                  mimeType: entry.file.type,
                  size: entry.file.size,
                  fileName: entry.file.name,
                  width: entry.width,
                  height: entry.height,
                  ...(entry.placeholder ? { placeholder: entry.placeholder } : {}),
                  ...(entry.voiceNote ? { voiceNote: true } : {}),
                  ...reelDeclaration,
                },
                captionForFile
              )
            );
            // READ BEFORE THE PLACEHOLDER IS WRITTEN: a read that throws (revoked file, no memory)
            // after it left a `mediaId: ''` row with no outbox entry - an orphan the bubble could only
            // draw as a spinner for ever. The catch below re-stages the file when this throws.
            // IN FLIGHT FROM BEFORE THE PLACEHOLDER: the bubble must not read the outbox's "absent"
            // during the durable INSERT as an orphan (outboxActivity).
            const endInflight = beginOutboxEnqueue(messageId);
            try {
              const fileBytes = new Uint8Array(await entry.file.arrayBuffer());
              await addMessageToChat(ctx.userId, placeholder, sentFrom, ctx, {
                messageId,
                status: 'pending',
                timestamp: new SvelteDate(sentAt),
              });
              const outboxEntry: OutboxEntry = {
                id: messageId,
                conversationId: convo.id,
                sentAt,
                kind: 'media',
                media: {
                  kind: mediaKindFromEnvelope(type),
                  mimeType: entry.file.type,
                  size: entry.file.size,
                  fileName: entry.file.name,
                  width: entry.width,
                  height: entry.height,
                  ...(entry.placeholder ? { placeholder: entry.placeholder } : {}),
                  caption: captionForFile,
                  ...(entry.voiceNote ? { voiceNote: true } : {}),
                  ...reelDeclaration,
                  ...(entry.prepareRaw ? { prepare: entry.prepareRaw } : {}),
                  fileBytes,
                },
                status: 'pending',
                attempts: 0,
                createdAt: sentAt,
              };
              try {
                await enqueueOutboxMessage(outboxEntry);
              } catch (enqueueError) {
                // The placeholder is on screen and in the store, and the catch below re-stages the
                // file: leaving the row would be an orphan that a second Send then duplicates.
                ctx.log(
                  `[MEDIA] ${messageId.slice(0, 8)}… not queued, withdrawing its placeholder: ${String(enqueueError)}`
                );
                const current = ctx.conversations.get(sentFrom);
                if (current) {
                  ctx.conversations.set(sentFrom, {
                    ...current,
                    messages: current.messages.filter((m) => m.id !== messageId),
                  });
                }
                await forgetLocalMessage(messageId, convo.id, ctx);
                throw enqueueError;
              }
            } finally {
              endInflight();
            }
          }
          sentMediaMessageCount++;
        }
        if (sentMediaMessageCount > 0) {
          ctx.playSendTone?.();
        }
      } catch (error) {
        // BOTH BRANCHES OF THE LOOP ABOVE LAND HERE AND ONLY ONE OF THEM ASKS A SERVER ANYTHING.
        // The MLS branch writes bytes to IndexedDB and returns; the channel branch uploads and
        // sends inline, and both of those now throw a typed refusal. So the status is READ rather
        // than assumed: `refusalStatus` answers null for the queue's own failures, which is
        // correct - nothing refused anything - and the generic line stands. The 413 the upload
        // route answers for an oversized file is the one a member can act on, and it is the
        // reason this catch gained a status instead of a second sentence.
        const status = refusalStatus(error);
        const mediaRefusal =
          error instanceof SalonNotLoadableError
            ? salonGateRefusalMessage(error.reason)
            : (describeApiRefusal(status, m.chat_media_action_send()) ??
              (isEnqueueQuotaFailure(error)
                ? m.chat_media_send_error_storage_full()
                : m.chat_media_send_error_generic()));
        const unsent = fileEntries.length - sentMediaMessageCount;
        // The staging is per conversation, but the refusal is said on the banner of the conversation
        // ON SCREEN, and a held salon upload may be refused long after the click: an unsent file goes
        // back only where the member still is, so the banner and the file are seen together.
        if (error instanceof SalonNotLoadableError && error.reason === 'session-ended') {
          // THE ACCOUNT THAT MADE THIS SEND HAS LEFT. Nothing of it may reach the next account: this
          // composable outlives a sign-out, so a re-staged file would sit in the NEXT account's
          // composer, and the caption below would be held for the next session's gate and sealed
          // by whoever signs in. No banner either - it would be the next account's.
          sessionEndedDuringSend = true;
          ctx.log(
            `[MEDIA] ${unsent} file(s) dropped, not re-staged: the session ended while the salon was loading`
          );
        } else if (ctx.selectedContact === sentFrom) {
          if (unsent > 0) {
            setPendingMediaFiles(sentFrom, [
              ...fileEntries.slice(sentMediaMessageCount),
              ...pendingMediaFilesFor(sentFrom),
            ]);
          }
          ctx.setSendError(mediaRefusal);
          ctx.log(
            `[MEDIA] send failed (status=${status ?? 'none'}), ${unsent} file(s) re-staged: ${String(error)}`
          );
        } else {
          // THE MEMBER MOVED ON. The refusal can only be said on the banner of the conversation now
          // on screen, so the file is dropped and that banner names the cause, rather than waiting
          // unexplained in a composer the member is not looking at.
          ctx.setSendError(m.chat_media_dropped_other_conversation({ cause: mediaRefusal }));
          ctx.log(
            `[MEDIA] send failed (status=${status ?? 'none'}), ${unsent} file(s) DROPPED, not re-staged: the conversation changed since the send: ${String(error)}`
          );
        }
      } finally {
        isUploadingMedia = false;
      }
    }

    if (sessionEndedDuringSend) {
      ctx.log('[SEND] caption not sent: the session ended while its upload was held');
      return;
    }
    if (sentMediaMessageCount > 0 || !text) return;

    // THE CONVERSATION THE SEND WAS MADE IN, never the one on screen now: a salon upload may have
    // been held for its salon above, and a caption falling through to here after a refused upload
    // went to whichever conversation the member had moved to meanwhile.
    const result = await sendChatMessage(
      text,
      sentFrom,
      currentReplyingTo,
      makeSendDeps(ctx, convo)
    );

    // Text/reply now always succeed (captured into the outbox); only a hard block
    // (deleted group) or a channel error surfaces a message to the user.
    if (!result.success) {
      if (result.error) {
        ctx.log(`[SEND] Failed: ${result.error}`);
        // A SALON SEND MAY ANSWER LONG AFTER THE CLICK - held until its salon loads - and the
        // banner belongs to the conversation on screen. Its row keeps the failure either way.
        if (ctx.selectedContact === sentFrom) ctx.setSendError(result.error);
        else ctx.log(`[SEND] banner not shown: the conversation changed since the send`);
      }
      // THE TEXT LIVES IN A ROW (failed, with its retry) when the send was echoed: the composer has
      // nothing to take back, and restoring it would put the message in the thread twice (WP-OFF-2).
      if (result.echoed) return true;
      // Nothing was drawn: the reply target goes back too, so the caller can restore the draft and
      // lose nothing (WP-OFF-1).
      if (isChannel && currentReplyingTo) {
        replyByConversation.set(sentFrom, currentReplyingTo);
      }
      return false;
    }

    ctx.log('[SEND] handleSendChat completed (message queued).');
    ctx.playSendTone?.();
    return true;
  }

  // ── File handling ─────────────────────────────────────────────────────────

  /** Validates and enqueues files for sending. Images are auto-compressed with canvas API before queuing. Files exceeding the configured size limit are rejected with an error message. */
  /**
   * The size ceiling and the image compression, applied to picked files - and NOTHING staged.
   *
   * Split out of {@link handleFilesSelected} because a voice note is sent the moment the finger
   * lifts and never joins the pending queue, yet it must obey exactly the same ceiling and the
   * same refusal message. Two call sites, one rule: a second copy of the size check is a thing
   * that can disagree with the first.
   *
   * A file over the limit is REFUSED, not shrunk: the caller gets a shorter array than it passed.
   */
  async function prepareMediaFiles(
    files: File[],
    ctx: MessagingContext
  ): Promise<import('$lib/media').PendingMediaFile[]> {
    const readyFiles: import('$lib/media').PendingMediaFile[] = [];
    // THE CEILING IS THE SERVER'S, ASKED FOR RATHER THAN BUILT IN, and `null` means it could not be
    // asked - in which case nothing is refused here and the server's 413 decides, as it always did.
    // It is one request per origin per page, awaited here because this function is already async and
    // a picker that has not yet been answered has nothing to refuse.
    const limits = await mediaService.uploadLimits();
    for (const file of files) {
      // A VIDEO IS RE-ENCODED ON THE DEVICE FIRST (decision C3), so its PICKED size says nothing
      // about what is uploaded: a 200 MB camera clip leaves as ~30 MB. The ceiling is the encoder's
      // budget instead, and a video that cannot fit it is refused there, by its own fault.
      if (file.type.startsWith('video/')) {
        const prepared = await prepareChatVideo(file, limits?.maxPlaintextBytes, ctx);
        if (prepared) readyFiles.push(prepared);
        continue;
      }
      if (limits !== null && refusedBeforePreparation(file, limits)) {
        const size = (file.size / 1024 / 1024).toFixed(1);
        // TOLD the configured ceiling, COMPARED against it minus the AES-GCM tag - see
        // `uploadLimits`. Announcing the compared number would say "49 Mo" of a 50 MB server.
        const mediaMaxSizeMb = Math.round(limits.maxBytes / 1024 / 1024);
        ctx.setSendError(m.chat_media_too_large({ size, limit: mediaMaxSizeMb }));
        // The LOG is dev-facing and stays English, and it names the file the banner cannot: the
        // banner tells the user one file was too big, this says WHICH, so a report of "it refused my
        // picture" is answerable without asking them to reproduce it.
        ctx.log(
          `[MEDIA] refused a ${file.type || 'typeless'} file - ${size} Mo over the ${mediaMaxSizeMb} Mo limit`
        );
        continue;
      }
      let entry: import('$lib/media').PendingMediaFile = { file };
      // Never re-encode GIFs: canvas compression renders a single frame and would drop the
      // animation (matters for both picked GIFs and keyboard-committed GIFs). They are already
      // small and optimized, so they are sent as-is.
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        try {
          const { compressImage, IMAGE_COMPRESS_PRESETS } = await import('$lib/media');
          const originalSize = file.size;
          const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.chat;
          const compressed = await compressImage(file, maxWidth, maxHeight, quality);
          entry = {
            file: compressed.file,
            width: compressed.width > 0 ? compressed.width : undefined,
            height: compressed.height > 0 ? compressed.height : undefined,
          };
          if (compressed.file.size < originalSize) {
            const savedPercent = ((1 - compressed.file.size / originalSize) * 100).toFixed(0);
            ctx.log(
              `Image compressee: ${(originalSize / 1024 / 1024).toFixed(1)} Mo -> ${(compressed.file.size / 1024 / 1024).toFixed(1)} Mo (-${savedPercent}%)`
            );
          }
        } catch (e) {
          console.warn('Compression failed, using original:', e);
        }
      } else if (file.type === 'image/gif') {
        // A GIF IS SENT AS IT IS - but not without its size (2026-10-02). It skipped the compressor,
        // which is the only thing that measured a picture, so every GIF file reached the receiver
        // with no `width` / `height` and its box was a guess until the bytes landed.
        const { readImageDimensions } = await import('$lib/media');
        const dims = await readImageDimensions(file);
        if (dims) entry = { file, width: dims.width, height: dims.height };
        else ctx.log(`[MEDIA] a GIF of ${file.size} bytes has no readable size - sent without one`);
      }
      if (entry.file.type.startsWith('image/')) {
        // The receiver's box shows this while the blob downloads (`MediaMsg.placeholder`).
        const { placeholderForImageFile } = await import('$lib/utils/mediaPlaceholder');
        const placeholder = await placeholderForImageFile(entry.file);
        if (placeholder) entry = { ...entry, placeholder };
      }
      readyFiles.push(entry);
    }
    return readyFiles;
  }

  /**
   * Re-encodes one picked video for the chat (`prepareVideoForUpload`), its progress and cancel
   * drawn by the composer through {@link videoPreparation}.
   *
   * @returns The entry to stage, or `null` when it was refused (said on the banner) or cancelled
   *          (nothing said: the member asked for it).
   */
  function prepareChatVideo(
    file: File,
    maxBytes: number | undefined,
    ctx: MessagingContext
  ): Promise<import('$lib/media').PendingMediaFile | null> {
    // ONE AT A TIME: a second pick while a video is encoding waits for it, so the one progress
    // line and its cancel always belong to the video actually running.
    const run = videoPreparationChain.then(() => prepareOneChatVideo(file, maxBytes, ctx));
    videoPreparationChain = run.catch(() => undefined);
    return run;
  }

  async function prepareOneChatVideo(
    file: File,
    maxBytes: number | undefined,
    ctx: MessagingContext
  ): Promise<import('$lib/media').PendingMediaFile | null> {
    try {
      const prepared = await prepareVideoForUpload(file, videoPreparation.optionsFor(maxBytes));
      ctx.log(
        `[MEDIA] video prepared: ${(prepared.sourceBytes / 1024 / 1024).toFixed(1)} Mo -> ` +
          `${(prepared.outputBytes / 1024 / 1024).toFixed(1)} Mo, ${prepared.width}x${prepared.height}`
      );
      return { file: prepared.file, width: prepared.width, height: prepared.height };
    } catch (e) {
      if (!isVideoPrepareError(e)) throw e;
      const message = videoPrepareFailureMessage(e);
      if (message === null) {
        ctx.log(`[MEDIA] video of ${file.size} bytes not staged: cancelled`);
        return null;
      }
      ctx.log(`[MEDIA] video of ${file.size} bytes refused: ${e.fault} - ${e.message}`);
      ctx.setSendError(message);
      return null;
    } finally {
      videoPreparation.finish();
    }
  }

  /** Stages picked files in the pending queue, to be sent with the next message. */
  async function handleFilesSelected(
    files: File[],
    ctx: MessagingContext,
    opts?: { stillWanted?: () => boolean }
  ) {
    // The conversation the files were picked IN, read before the preparation (a video re-encode)
    // gives the member time to open another one.
    const stagedIn = ctx.selectedContact;
    if (!stagedIn) {
      ctx.log(`[MEDIA] ${files.length} file(s) not staged: no conversation is open`);
      return;
    }
    // A CANAREEL FILMED IN A DM OR A GROUP IS SENT AT ONCE, RAW (RC-5): the review's "Send" was the
    // send, and the take is safer in the outbox - durable, encrypted, prepared there and resumed
    // after a kill - than in a staging list a reload empties. A salon never takes one (RC-8).
    const takes = isChannelConversationId(stagedIn) ? [] : files.filter(isChatReelTake);
    for (const take of takes) await sendChatReelTake(take, ctx);
    const others = files.filter((f) => !takes.includes(f));
    if (others.length === 0) return;
    const readyFiles = await prepareMediaFiles(others, ctx);
    if (readyFiles.length === 0) return;
    // ASKED AFTER THE PREPARATION, which can take seconds: a sign-out during it has already emptied
    // the queues (`forgetAccount`), and staging now would hand this account's file to the next one.
    if (opts?.stillWanted && !opts.stillWanted()) {
      ctx.log(`[MEDIA] ${readyFiles.length} file(s) not staged: no longer wanted (signed out)`);
      return;
    }
    ctx.log(`[MEDIA] ${readyFiles.length} file(s) staged in ${stagedIn}`);
    setPendingMediaFiles(stagedIn, [...pendingMediaFilesFor(stagedIn), ...readyFiles]);
  }

  /**
   * Sends a finished recording immediately, as its own message.
   *
   * THE GESTURE ALREADY MEANT SEND. `VoiceRecorder` is hold-to-talk with slide-to-cancel: by the
   * time a blob reaches here the user has held the microphone, watched the clock run and lifted
   * their finger AWAY from the bin - three deliberate acts whose only reading is "send this". The
   * recording nevertheless landed in the pending queue and waited for a fourth act, behind a
   * "1 fichier(s) en attente" banner, which is a confirmation the gesture had already given.
   *
   * It goes out ALONE, and that is the reason for the `files` override rather than a stage-then-
   * send: draining the pending queue here would post a half-written caption and any photo staged
   * beside it, neither of which the user asked to send by lifting their finger off a microphone.
   */
  async function sendVoiceNote(file: File, ctx: MessagingContext) {
    const ready = await prepareMediaFiles([file], ctx);
    // Empty means the ceiling refused it - `prepareMediaFiles` has already said so on both surfaces.
    if (ready.length === 0) return;
    // THIS IS THE ONLY PLACE IN THE APPLICATION THAT KNOWS. Past it, a recording and an imported
    // audio file are the same bytes with the same mime type, and the only thing left to read is a
    // file name the recorder chose - which is a distinction carried in prose. So the gesture is
    // declared here and travels with the message; see `MediaRef.voiceNote`.
    await handleSendChat(ctx, '', { files: ready.map((f) => ({ ...f, voiceNote: true })) });
  }

  /**
   * Queues the chat camera's RAW take as its own message, at once (reels-in-chat RC-5). Nothing is
   * prepared here: the outbox prepares it inside the upload task, where a kill, a cancel and a weak
   * link are already handled, and the bubble shows the preparation's progress. Only the ThumbHash
   * of the camera's first picture is computed now, so the tile has its picture from the first frame.
   */
  async function sendChatReelTake(file: File, ctx: MessagingContext) {
    let placeholder: string | undefined;
    const poster = capturePosterOf(file);
    if (poster) {
      const { placeholderForImageFile } = await import('$lib/utils/mediaPlaceholder');
      placeholder =
        (await placeholderForImageFile(new File([poster], 'poster.jpg', { type: poster.type }))) ??
        undefined;
    }
    ctx.log(
      `[MEDIA] a chat reel take of ${file.size} bytes sent raw - the outbox prepares it${placeholder ? '' : ' (no poster)'}`
    );
    await handleSendChat(ctx, '', {
      files: [{ file, prepareRaw: 'chat-reel', ...(placeholder ? { placeholder } : {}) }],
    });
  }

  /** Removes a staged (not yet sent) file from the pending media queue by its index. */
  function removePendingMediaFile(conversationKey: string | null, index: number) {
    if (!conversationKey) return;
    setPendingMediaFiles(
      conversationKey,
      pendingMediaFilesFor(conversationKey).filter((_, i) => i !== index)
    );
  }

  // ── Reactions / edit / delete ─────────────────────────────────────────────

  /**
   * Writes a locally-applied mutation (reaction, edit, delete) back to the encrypted store.
   *
   * The sender never receives an MLS echo of their own control event, so this is the ONLY thing
   * that makes the mutation survive a reload on the device that issued it - the peers get theirs
   * from `systemMessageHandler`. Without it the optimistic in-memory update is dropped on the next
   * load and the pre-edit body comes back.
   *
   * Best-effort by design: the control event is already durable in the outbox, so a failed write
   * costs a stale local row, never a lost mutation for the group.
   */
  async function persistLocalMutation(msg: ChatMessage, ctx: MessagingContext): Promise<void> {
    if (!ctx.storage) return;
    try {
      // A patch, not a rewrite: `serverTimestamp` is known to the delivery path and not to this
      // one, and a full-row write erased it every time the user reacted.
      await ctx.storage.updateMessage(
        msg.id,
        {
          content: msg.content,
          reactions: messageReactions.get(msg.id),
          isDeleted: msg.isDeleted,
          isEdited: msg.isEdited,
          ...(msg.editedAt ? { editedAt: msg.editedAt.getTime() } : {}),
        },
        ctx.deviceKeyB64
      );
    } catch (e) {
      ctx.log(`[DB] Failed to persist local mutation on ${msg.id}: ${String(e)}`);
    }
  }

  /** Toggles an emoji reaction on a message: adds it if absent, removes it if the user already used that emoji. Updates state optimistically in memory and DB before sending the MLS message. */
  async function handleAddReaction(messageId: string, emoji: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const conversationKey = ctx.selectedContact.toLowerCase();
    const convo = ctx.conversations.get(conversationKey);
    if (!convo) return;
    const meNorm = ctx.userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const alreadyReacted = activeReactions(existing).some(
      (r) => r.userId === meNorm && r.emoji === emoji
    );

    // The cap is enforced HERE and nowhere else: it limits what the user may place, and a device
    // refusing a frame that already reached the group would never converge with one that took it.
    if (!alreadyReacted && !canAddDistinctReactionEmoji(existing, emoji)) {
      ctx.log(
        `[REACTION] Maximum of ${MAX_DISTINCT_MESSAGE_REACTIONS} distinct reactions reached on this message.`
      );
      return;
    }

    // One clock reading for the optimistic update and the frame, so this device and its peers hold
    // the same timestamp for this pair and the merge is a no-op when the echo comes back.
    const at = Date.now();
    const updated = applyReaction(existing, meNorm, emoji, at, alreadyReacted);
    if (!updated) return;

    messageReactions.set(messageId, updated);

    // Immediate in-memory and DB update to survive page reload.
    const msgIdx = convo.messages.findIndex((m) => m.id === messageId);
    if (msgIdx !== -1) {
      const nextMsgs = [...convo.messages];
      nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
      ctx.conversations.set(conversationKey, { ...convo, messages: nextMsgs });
      await persistLocalMutation(nextMsgs[msgIdx], ctx);
    }

    const act: ControlAct = { kind: 'reaction', emoji, remove: alreadyReacted, at };
    const queued = await sendControlAct(messageId, act, controlDeps(ctx, convo));
    settleControl(ctx, convo.id, messageId, act, queued);
  }

  /** The deps every control act is sent with, from the context of the moment. */
  function controlDeps(ctx: MessagingContext, convo: Conversation) {
    return {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversation: convo,
      currentUserDisplayName: getUserDisplayNameSync(ctx.userId),
    };
  }

  /**
   * Sends one reaction, edit or pin act (a delete has its own outcome - see `deleteMessage`). `text`
   * is an edit's new body text, the one piece of an act a refusal does not store.
   *
   * @returns whether the durable queue took it.
   */
  async function sendControlAct(
    messageId: string,
    act: Exclude<ControlAct, { kind: 'delete' }>,
    deps: ReturnType<typeof controlDeps>,
    text = ''
  ): Promise<boolean> {
    switch (act.kind) {
      case 'reaction':
        return act.remove
          ? removeReaction(messageId, act.emoji, act.at, deps)
          : addReaction(messageId, act.emoji, act.at, deps);
      case 'edit':
        return editMessage(messageId, text, act.editedAt, deps);
      case 'pin':
        return setMessagePinned(messageId, act.pinned, act.at, deps);
    }
  }

  /**
   * Settles the mention of one control act: a refusal by the durable queue records a notice for THAT
   * act (message, kind, emoji); a taken act clears only the refusal it supersedes - the same key, or
   * every refusal on the message for a delete. A 👍 refused then a pin taken keeps the 👍's notice.
   * `ctx` is the one the act was issued with, so `ctx.userId` is the ISSUING account: a slow act that
   * settles after an account switch writes to that account's list and never rebinds the store.
   */
  function settleControl(
    ctx: MessagingContext,
    conversationId: string,
    messageId: string,
    act: ControlAct,
    queued: boolean
  ): void {
    if (!queued) {
      recordControlRefusal(ctx.userId, { conversationId, messageId, act });
    } else if (act.kind === 'delete') {
      clearMessageControlRefusals(messageId, ctx.userId);
    } else {
      clearControlRefusal(ctx.userId, messageId, act);
    }
  }

  /**
   * Whether the local state still SHOWS the refused act. A refusal outlives a reload, the optimistic
   * state it describes may not have (a failed row write): retrying an act this device no longer shows
   * would hand the peers what this device lacks. Not standing = moot, dropped, nothing sent.
   */
  function refusalStillStands(refusal: ControlRefusal, msg: ChatMessage, me: string): boolean {
    const { act } = refusal;
    if (msg.isDeleted) return false;
    switch (act.kind) {
      case 'delete':
        return true;
      case 'edit':
        return msg.editedAt?.getTime() === act.editedAt;
      case 'pin': {
        const held = pinEntries(refusal.conversationId).find((e) => e.id === msg.id);
        return held?.at === act.at && held.pinned === act.pinned;
      }
      case 'reaction':
        return (messageReactions.get(msg.id) ?? msg.reactions ?? []).some(
          (r) =>
            r.userId.toLowerCase() === me &&
            r.emoji === act.emoji &&
            (r.at ?? 0) === act.at &&
            (r.removed === true) === act.remove
        );
    }
  }

  /**
   * Runs a refused act again (the Retry of `ControlRefusedNotice`), with the context and the
   * conversation of THIS moment - never a snapshot taken when it was refused. The refusal is cleared
   * as soon as the queue takes the act and BEFORE any local follow-up, so a follow-up that throws
   * cannot leave a mention whose second tap would queue the act twice.
   *
   * @returns true when the queue took it.
   */
  async function retryRefusedControl(
    refusal: ControlRefusal,
    ctx: MessagingContext
  ): Promise<boolean> {
    const { messageId, act } = refusal;
    const tag = `[OUTBOX] retry "${act.kind}" on ${messageId.slice(0, 8)}`;
    const found = [...ctx.conversations.entries()].find(([, c]) => c.id === refusal.conversationId);
    if (!found) {
      ctx.log(`${tag}: its conversation is gone here, the refusal is dropped`);
      clearMessageControlRefusals(messageId, ctx.userId);
      return false;
    }
    const [convoKey, convo] = found;
    const msg = convo.messages.find((m) => m.id === messageId);
    if (!msg) {
      ctx.log(`${tag}: the message is not loaded, kept for a later Retry`);
      return false;
    }
    if (!refusalStillStands(refusal, msg, ctx.userId.toLowerCase())) {
      ctx.log(`${tag}: no longer shown locally, the refusal is moot and dropped`);
      clearControlRefusal(ctx.userId, messageId, act);
      return false;
    }
    const deps = controlDeps(ctx, convo);
    if (act.kind === 'delete') {
      const outcome = await deleteMessage(messageId, deps);
      if (outcome === 'refused') return false;
      settleControl(ctx, convo.id, messageId, act, true);
      await applyDeleteLocally(outcome, messageId, convoKey, ctx);
      return true;
    }
    const text = act.kind === 'edit' ? envelopeBodyText(msg.content) : undefined;
    const queued = await sendControlAct(messageId, act, deps, text);
    if (queued) settleControl(ctx, convo.id, messageId, act, true);
    else ctx.log(`${tag}: refused again, the notice stays`);
    return queued;
  }

  /**
   * Drops a message row from the encrypted store.
   *
   * Only for a message WITHDRAWN before it was sent: a deletion the peers know about keeps its row,
   * because the tombstone has to survive a reload. Best-effort like `persistLocalMutation`, and for
   * the same reason - but the cost of a failure is the opposite one, a row that comes back on the
   * next load and that no peer can ever match.
   */
  async function forgetLocalMessage(
    messageId: string,
    conversationId: string,
    ctx: MessagingContext
  ): Promise<void> {
    if (!ctx.storage) return;
    try {
      await ctx.storage.deleteMessage(messageId, conversationId);
    } catch (e) {
      ctx.log(`[DB] Failed to drop withdrawn message ${messageId}: ${String(e)}`);
    }
  }

  /** Sends a "delete_message" MLS system message and marks the message as deleted in the local conversation state. Only the original sender can delete their own message. */
  async function handleDeleteMessage(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can delete their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    const convoKey = ctx.selectedContact;
    const act: ControlAct = { kind: 'delete' };
    const outcome = await deleteMessage(messageId, controlDeps(ctx, convo));
    // THE QUEUE REFUSED THE DELETE: the peers still hold the message, so it is NOT shown as deleted
    // here. The mention carries Retry, and only a retry the queue takes writes the tombstone.
    settleControl(ctx, convo.id, messageId, act, outcome !== 'refused');
    if (outcome === 'refused') return;
    await applyDeleteLocally(outcome, messageId, convoKey, ctx);
  }

  /**
   * The local half of a delete the queue took (or that never needed it): a withdrawal drops the row,
   * a broadcast tombstones it. Reads the conversation from the map at THIS moment, by key.
   */
  async function applyDeleteLocally(
    outcome: 'withdrawn' | 'broadcast',
    messageId: string,
    convoKey: string,
    ctx: MessagingContext
  ): Promise<void> {
    // A withdrawal is not a deletion the peers have to be told about - it is a message that never
    // existed anywhere but here, so the row goes, rather than becoming a tombstone standing for
    // nothing. Measured before the fix: every withdrawal left a row no other device held, which
    // `recon.mjs` reports as a loss on the sender for ever.
    if (outcome === 'withdrawn') {
      const convo = ctx.conversations.get(convoKey);
      if (!convo) {
        ctx.log(`[DELETE] withdrawn ${messageId.slice(0, 8)}: its conversation left the map`);
        return;
      }
      ctx.conversations.set(convoKey, {
        ...convo,
        messages: convo.messages.filter((m) => m.id !== messageId),
      });
      await forgetLocalMessage(messageId, convo.id, ctx);
      return;
    }
    await tombstoneLocalMessage(messageId, ctx, convoKey);
  }

  /**
   * Marks `messageId` deleted in the local conversation (the row stays: the tombstone survives a
   * reload). The conversation is read from the map NOW: writing back a snapshot taken before an await
   * would resurrect whatever arrived meanwhile, and a conversation that left the map stays gone.
   */
  async function tombstoneLocalMessage(
    messageId: string,
    ctx: MessagingContext,
    key: string
  ): Promise<void> {
    const convo = ctx.conversations.get(key);
    if (!convo) {
      ctx.log(
        `[DELETE] tombstone of ${messageId.slice(0, 8)} skipped: its conversation left the map`
      );
      return;
    }
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], isDeleted: true, content: chat_system_message_deleted() };
      ctx.conversations.set(key, { ...convo, messages: msgs });
      await persistLocalMutation(msgs[idx], ctx);
    }
  }

  /** Sends an "edit_message" MLS system message and updates the message content and editedAt in the local conversation state. Only the original sender can edit their own message. */
  async function handleEditMessage(messageId: string, text: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can edit their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    // ONE INSTANT FOR BOTH HALVES - see handleTogglePin below, which has always done this. Taking
    // it twice dated the local apply and the broadcast differently for the same act, and now that
    // the timestamp decides which of two concurrent edits survives, the difference is a device that
    // can lose to its own frame.
    const editedAt = Date.now();
    const act: ControlAct = { kind: 'edit', editedAt };
    const queued = await sendControlAct(messageId, act, controlDeps(ctx, convo), text);
    settleControl(ctx, convo.id, messageId, act, queued);
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    // The row is defended against our own edit by the same rule that defends it against a peer's:
    // if it already holds a later one, this edit lost and the broadcast above will lose everywhere.
    if (idx !== -1 && editSupersedes({ editedAt, content: text }, msgs[idx])) {
      msgs[idx] = {
        ...msgs[idx],
        isEdited: true,
        editedAt: new SvelteDate(editedAt),
        // The edited TEXT goes back into the body this row already holds - see `applyEditToBody`.
        // Writing `text` straight into `content` dropped the reply reference, which is carried by
        // that body and by nothing else; this device kept showing the quote from its in-memory
        // `replyTo` until the first reload, which is why the loss was first seen on the PEER's PC.
        content: applyEditToBody(msgs[idx].content, text),
      };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
      await persistLocalMutation(msgs[idx], ctx);
    }
  }

  /**
   * Toggles a message's pinned state: applies it locally (optimistic - the sender gets no
   * MLS echo) and broadcasts a "pin"/"unpin" system message so all members converge.
   */
  async function handleTogglePin(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
    const next = !isMessagePinned(convo.id, messageId);
    // One instant for both halves - see setMessagePinned. Taking it twice would date the local
    // apply and the broadcast differently, for the same act.
    const at = Date.now();
    applyPin(convo.id, messageId, next, at);
    const act: ControlAct = { kind: 'pin', pinned: next, at };
    const queued = await sendControlAct(messageId, act, controlDeps(ctx, convo));
    settleControl(ctx, convo.id, messageId, act, queued);
  }

  // ── Reply ─────────────────────────────────────────────────────────────────

  /** Sets the message the user is replying to, which will be embedded as a quote preview in the next send. */
  function handleReply(conversationKey: string, message: ChatMessage) {
    if (!conversationKey) {
      console.log('[REPLY] handleReply ignored: no conversation is open');
      return;
    }
    console.log(`[REPLY] armed in "${conversationKey}" on message ${message.id}`);
    replyByConversation.set(conversationKey, message);
  }

  /** The reply armed in `conversationKey`, or null: what that conversation's composer shows. */
  function replyFor(conversationKey: string | null | undefined): ChatMessage | null {
    return conversationKey ? (replyByConversation.get(conversationKey) ?? null) : null;
  }

  /** Clears the pending reply of ONE conversation (user dismissed its reply banner). */
  function cancelReply(conversationKey: string) {
    if (!conversationKey) return;
    console.log(`[REPLY] cancelled in "${conversationKey}"`);
    replyByConversation.delete(conversationKey);
  }

  /**
   * Forwards a message (text OR media) to ANOTHER conversation, without touching
   * the current composition state (reply / pending files).
   *
   * Media: the envelope already carries the encrypted blob reference (mediaId) + the
   * decryption key (CEK/iv). The SAME media envelope is re-sent (no re-upload),
   * giving members of the target conversation access to the same blob via the forwarded key.
   *
   * The target may be a DM, a group OR a community channel; the source may equally be any of
   * them. Only the transport differs - MLS for the first two, the channel epoch key for the
   * third - and both directions cross freely, so a channel message can be forwarded into a DM
   * and vice versa. A channel target re-encrypts under its own key, and the blob stays reachable
   * because the CEK travels inside the forwarded envelope.
   */
  async function forwardMessage(
    sourceContent: string,
    targetName: string,
    ctx: MessagingContext
  ): Promise<{ success: boolean; error?: string }> {
    const convo = ctx.conversations.get(targetName);
    if (!convo) return { success: false, error: m.chat_forward_error_conversation_missing() };

    const env = parseEnvelope(sourceContent);

    // A reel message is never relayed: the forward would copy its key and ref into a conversation
    // that outlives the reel's 30-day audience. The bubble hides the button; THIS is the rule.
    if (env.kind === 'media' && isReelMessage(env.media)) {
      ctx.log(`[FORWARD] refused: a reel message is never forwarded (target "${targetName}")`);
      return { success: false, error: m.chat_forward_error_reel() };
    }

    // Channels are server-authoritative and always sendable: no MLS group, no outbox, and no
    // local echo (the `channel.message.created` broadcast is what renders the bubble).
    if (isChannelConversationId(targetName)) {
      try {
        if (env.kind === 'media') {
          await sendEncryptedChannelMessage(
            targetName,
            encodeAppMessage({
              ...mkMedia({
                kind: mediaKindFromEnvelope(env.media.type),
                mediaId: env.media.mediaId,
                key: fromHex(env.media.key),
                iv: fromHex(env.media.iv),
                mimeType: env.media.mimeType,
                size: env.media.size,
                fileName: env.media.fileName ?? '',
                caption: env.caption,
                ...(env.media.width && env.media.height
                  ? { width: env.media.width, height: env.media.height }
                  : {}),
                ...mediaPlaceholderProtoField(env.media.placeholder),
                // A forward relays the blob as it was sealed, so it must relay how.
                ...mediaEncodingProtoField(env.media.encoding),
              }),
              messageId: crypto.randomUUID(),
              sentAt: Date.now(),
            })
          );
          return { success: true };
        }
        const channelText = env.kind === 'text' ? env.text.trim() : '';
        if (!channelText)
          return { success: false, error: m.chat_forward_error_nothing_to_forward() };
        return await sendChatMessage(channelText, targetName, null, makeSendDeps(ctx, convo));
      } catch (e) {
        // `sendChatMessage` RETURNS its refusal, already localized, rather than throwing it - so
        // anything reaching this catch is unexpected and has nothing to add beyond "it failed".
        ctx.log(`[FORWARD] channel forward failed for "${targetName}": ${String(e)}`);
        return { success: false, error: m.chat_forward_error_fallback() };
      }
    }

    const mlsService = ctx.ensureMls();

    try {
      if (env.kind === 'media') {
        // Media forward is an inline upload+send: it still needs a ready MLS group.
        if (convo.lifecycle !== 'active')
          return { success: false, error: m.chat_forward_error_conversation_not_ready() };
        const media = env.media;
        const messageId = crypto.randomUUID();
        const protoBytes = encodeAppMessage({
          ...mkMedia({
            kind: mediaKindFromEnvelope(media.type),
            mediaId: media.mediaId,
            key: fromHex(media.key),
            iv: fromHex(media.iv),
            mimeType: media.mimeType,
            size: media.size,
            fileName: media.fileName ?? '',
            caption: env.caption,
            ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
            ...mediaPlaceholderProtoField(media.placeholder),
            ...mediaEncodingProtoField(media.encoding),
          }),
          messageId,
          sentAt: Date.now(),
        });
        await mlsService.sendMessage(convo.id, protoBytes, messageId);
        const payload = serializeEnvelope(mkMediaEnvelope({ ...media }, env.caption));
        await addMessageToChat(ctx.userId, payload, targetName, ctx, { messageId });
        return { success: true };
      }

      const text = env.kind === 'text' ? env.text.trim() : '';
      if (!text) return { success: false, error: m.chat_forward_error_nothing_to_forward() };
      return await sendChatMessage(text, targetName, null, makeSendDeps(ctx, convo));
    } catch (e) {
      // Same as the channel branch above, and for the same reason.
      ctx.log(`[FORWARD] MLS forward failed for "${targetName}": ${String(e)}`);
      return { success: false, error: m.chat_forward_error_fallback() };
    }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    /** Reactive map of emoji reactions keyed by message ID. */
    messageReactions,

    /** The message the user is replying to IN a given conversation (null when none is pending there). */
    replyFor,
    /** The text typed in a given conversation's composer. */
    draftFor,
    lateDraftWriter,
    /** Replaces the text of a given conversation's composer. */
    setDraft,
    /** The files staged IN a given conversation, sent by its next handleSendChat. */
    pendingMediaFilesFor,
    /** Forgets every staged file and armed reply of the account that signed out. */
    forgetAccount,
    videoPreparation,
    /** True while a media file is being encrypted and uploaded. */
    get isUploadingMedia() {
      return isUploadingMedia;
    },
    /** True while the MLS queue is draining after reconnect (catch-up in progress). */
    get isCatchupOverlayVisible() {
      return isCatchupOverlayVisible;
    },
    get isMessageCatchupActive() {
      return isMessageCatchupActive;
    },

    /** Appends a single message to a conversation's reactive state and persists it to DB. */
    addMessageToChat,
    /** Buffers incoming messages during MLS queue catch-up (pair with endBulkMessageIngest). */
    beginBulkMessageIngest,
    /** Flushes buffered messages after MLS queue catch-up. */
    endBulkMessageIngest,
    /** Resets overlay + bulk buffer (e.g. after a desynced catch-up on mobile). */
    resetMessageCatchupState,
    /**
     * Replays the buffered orphan messages for a conversation that has just been added to the
     * map (e.g. after processing an MLS Welcome).
     * Called via MessageHandlerDeps.drainOrphanMessages.
     */
    drainOrphanMessages: (convoKey: string, ctx: MessagingContext) => {
      const normalized = convoKey.toLowerCase();
      const messages = orphanBuffer.get(normalized);
      if (!messages || messages.length === 0) return;
      orphanBuffer.delete(normalized);
      console.log(`[ORPHAN] Draining ${messages.length} buffered message(s) for "${normalized}"`);
      for (const msg of messages) {
        addMessageToChat(msg.senderId, msg.content, msg.contactName, ctx, msg.options);
      }
    },
    /** Appends multiple messages in one reactive update and one batch DB write. */
    batchAddMessages,
    /** Main send handler: uploads pending media then sends a text message. */
    handleSendChat,
    retrySend,
    discardSend,
    takeBackSend,
    resumeUnsentSends,
    forwardMessage,
    /** Validates and enqueues files (with image compression) for the next send. */
    handleFilesSelected,
    /** Sends a finished recording straight out, alone - the microphone gesture already said send. */
    sendVoiceNote,
    /** Removes a staged file from the pending media queue by index. */
    removePendingMediaFile,
    /** Toggles an emoji reaction on a message (add if absent, remove if present). */
    handleAddReaction,
    /** Sends a delete_message MLS event and marks the message as deleted locally. */
    handleDeleteMessage,
    /** Sends an edit_message MLS event and updates the message content locally. */
    handleEditMessage,
    /** Toggles a message's pinned state (optimistic local + pin/unpin MLS system event). */
    handleTogglePin,
    /** Runs a refused reaction/edit/pin/delete again (the notice's Retry), with a fresh context. */
    retryRefusedControl,
    /** Sets the message to reply to (shown as a quote in the next send). */
    handleReply,
    /** Clears the pending reply state. */
    cancelReply,
  };
}
