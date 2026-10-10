import type { SvelteMap } from 'svelte/reactivity';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, OutboxEntry } from '$lib/db';
import { OutboxPayloadUnreadableError } from '$lib/db/outboxCodec';
import type { AddMessageToChatOptions, ChatMessage, Conversation } from '$lib/types';
import type { MediaRef } from '$lib/media';
import {
  encodeAppMessage,
  mediaEncodingProtoField,
  mediaReelProtoFields,
  mediaKindToType,
  mediaPlaceholderProtoField,
  mkMedia,
  mkReply,
  mkText,
} from '$lib/proto/codec';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { fromHex } from '$lib/utils/hex';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { m } from '$lib/paraglide/messages';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { uploadRefusalCause } from '$lib/utils/mediaErrors';
import { logMlsMetric } from '$lib/mls-client/mlsRecoveryMetrics';
import { classifyOutgoingSendError } from '$lib/mls-client/mlsSendError';
import { recordEviction } from '$lib/utils/chat/eviction';
import { syncOutboxMirror } from '$lib/utils/chat/outboxMirror';
import { connectivity, isTransportFailure } from '$lib/stores/connectivity.svelte';
import { installReachabilityProbe } from '$lib/utils/reachabilityProbe';
import { DeliveryUnreachableError, SendEdgeRefusedError } from '$lib/mls-client/mlsDeliveryApi';
import {
  UPLOAD_NO_ANSWER_ATTEMPTS,
  UPLOAD_PROGRESS_MARGIN_BYTES,
  UploadAbortedError,
  UploadGaveUpError,
  UploadNetworkError,
  UploadStalledError,
  type XhrUploadOptions,
} from '$lib/utils/uploadXhr';
import {
  clearAllUploads,
  clearUpload,
  patchUpload,
  setUploadRetry,
  uploadViewOf as viewOfUpload,
} from './uploadProgress.svelte';
import {
  getIsTabLeader,
  getTabLeadership,
  whenTabLeadershipDecided,
} from '$lib/mls-client/tabLeader';
import {
  requestLeaderOutboxFlush,
  publishOutboxEntrySent,
  publishOutboxEntryCancelled,
  subscribeTabOutboxEvents,
} from '$lib/mls-client/tabMessageSync';

/**
 * Backoff schedule (ms) between flush attempts for an entry that keeps failing.
 * Indexed by attempt count, clamped to the last value.
 */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Consecutive LOCAL failures of ONE attachment - this device could not read, decode or hold the file
 * (see {@link isLocalAttachmentFailure}) - after which it is parked as `error`. About five minutes of
 * the ladder, short enough that a Pixel 6a is not made to decode a 13 MB file every minute for ever
 * (2026-10-10). NOTHING ELSE COUNTS: a transport failure, a 5xx, a roster repair or an edge refusal
 * is about the network or the server, and a relay outage of five minutes must not tell the member
 * that their file is unreadable.
 */
export const MAX_UNEXPECTED_ATTEMPTS = 8;

/**
 * The queued attachment cannot be read on THIS device: its row failed to load, or it holds no bytes
 * while still owing an upload. Typed, so the outbox never decides "local" from a message.
 */
export class LocalAttachmentError extends Error {
  constructor(why: string, cause?: unknown) {
    super(why, { cause });
    this.name = 'LocalAttachmentError';
  }
}

/**
 * A message could NOT be handed to the queue: there is no storage layer, no controller is active, or
 * the durable write failed. Typed and thrown, never swallowed: the caller still holds the file and
 * the optimistic row, and a swallowed one left a `mediaId: ''` placeholder that nothing would ever
 * upload (the orphan seen on the Mi 9T, alpha.3).
 */
export class OutboxEnqueueError extends Error {
  constructor(why: string, cause?: unknown) {
    super(why, { cause });
    this.name = 'OutboxEnqueueError';
  }
}

/**
 * True for the failures that are about this device and no one else, read from the TYPE: the outbox's
 * own {@link LocalAttachmentError}, the platform's `NotReadableError`/`NotFoundError` on a file, and a
 * `RangeError` (an allocation the renderer refused).
 */
export function isLocalAttachmentFailure(e: unknown): boolean {
  if (e instanceof LocalAttachmentError || e instanceof RangeError) return true;
  return (
    typeof DOMException !== 'undefined' &&
    e instanceof DOMException &&
    (e.name === 'NotReadableError' || e.name === 'NotFoundError')
  );
}

const textEncoder = new TextEncoder();

/**
 * True when `entry` cannot go out while any of `ids` is unsent: a reply quoting one of them, or a
 * control event (reaction, edit, delete, pin) whose pre-encoded proto carries one of the ids as a
 * string - the protobuf carries a message id as its UTF-8 bytes, so a byte search is exact for a
 * UUID and needs no decoding. An unrelated message is independent and may pass a parked one.
 */
function dependsOnAny(entry: OutboxEntry, ids: Set<string>): boolean {
  if (ids.size === 0) return false;
  if (entry.kind === 'reply' && entry.replyTo && ids.has(entry.replyTo.id)) return true;
  if (entry.kind !== 'control' || !entry.controlProto) return false;
  const proto = entry.controlProto;
  for (const id of ids) {
    const needle = textEncoder.encode(id);
    outer: for (let i = 0; i + needle.length <= proto.length; i++) {
      for (let j = 0; j < needle.length; j++) if (proto[i + j] !== needle[j]) continue outer;
      return true;
    }
  }
  return false;
}

/** Returns the backoff delay for the given (post-increment) attempt count. */
function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

/**
 * Delivery class of a queued entry.
 *
 * Control events (reaction, edit, delete, pin, read receipt) are mutations of existing history:
 * they must not notify, and they must be durable. Their per-device queue entry is deleted on ACK,
 * so the group's shared log is the only thing left that can hand one to a device that was offline.
 *
 * Shared by the flusher and the native-background mirror, so which path happens to deliver a frame
 * never changes how it is classified.
 */
export function deliveryForOutboxEntry(entry: OutboxEntry): FrameDelivery {
  return entry.kind === 'control' ? DELIVERY.mutation : DELIVERY.visible;
}

/**
 * Build the plaintext proto AppMessage for a queued text/reply entry (sentAt = original compose
 * time). Returns null for media (whose proto can only be built once the file is uploaded). Shared
 * by the flusher and the native-background mirror so both encode the exact same bytes.
 */
export function buildOutboxProto(entry: OutboxEntry): Uint8Array | null {
  if (entry.kind === 'media') return null;
  // Control events (reaction/edit/delete/pin/read-receipt) carry their AppMessage proto verbatim:
  // it was encoded once at enqueue time and is epoch-independent, so it is sent as-is.
  if (entry.kind === 'control') return entry.controlProto ?? null;
  if (entry.kind === 'reply' && entry.replyTo) {
    return encodeAppMessage({
      ...mkReply(entry.text ?? '', {
        id: entry.replyTo.id,
        senderId: entry.replyTo.senderId,
        preview: entry.replyTo.preview,
      }),
      messageId: entry.id,
      sentAt: entry.sentAt,
    });
  }
  return encodeAppMessage({
    ...mkText(entry.text ?? ''),
    messageId: entry.id,
    sentAt: entry.sentAt,
  });
}

/** Dependencies driving the outbox flusher. Built once per session and registered globally. */
export interface OutboxDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKey: () => string;
  conversations: SvelteMap<string, Conversation>;
  log: (msg: string) => void;
  /** Emit a non-destructive welcome_request for a group missing from the WASM. */
  requestReAdd: (groupId: string) => Promise<void>;
  /**
   * Repair a group the SERVER refuses our frames for while the WASM still holds it.
   *
   * SEPARATE FROM `requestReAdd` BECAUSE THE PROOF IS DIFFERENT, not because the action is. That one
   * is entered when this device notices it holds no tree; this one is entered on the server's own
   * refusal, which is the only evidence that a tree we DO hold is worthless. `requestReAdd` alone
   * cannot serve here - it skips any group still in the WASM, which is every group in this
   * population.
   */
  recoverRosterDisagreement: (groupId: string) => Promise<void>;
  /** True when the group can be sent into (in the WASM, not in an unresolved epoch gap). */
  isGroupHealthy: (groupId: string) => boolean;
  /** Mark a conversation deletedRemotely (banner) when the group is gone server-side. */
  markDeletedRemotely?: (groupId: string) => void;
  /**
   * Posts a system message into a conversation, for {@link recordEviction}'s removal notice.
   *
   * The outbox had no chat surface at all, which is why a queue killed by an eviction used to leave
   * a red bubble and no explanation of it anywhere.
   */
  addMessageToChat?: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  /**
   * Persists a conversation row, so a retire written here survives the reload.
   *
   * Without it `recordEviction` would leave `lifecycle: 'removed'` in memory only, and the next
   * load would bring back the conversation whose queue had just been killed by the eviction.
   */
  saveConversation?: (key: string) => Promise<void>;
  /** Encrypt + upload a queued media file, returning the server media ref (queued-media flush). */
  uploadMedia?: (
    media: NonNullable<OutboxEntry['media']>,
    transport?: XhrUploadOptions
  ) => Promise<MediaRef>;
  /**
   * True when the session is in a state where sending can succeed. Returns false for a session
   * unlocked offline that has no access token yet: the browser can report `online` before the
   * token is reissued, and a flush in that window fails every entry for a reason that has nothing
   * to do with the entry. `promoteOfflineSession` flushes explicitly once it is ready.
   */
  canFlush?: () => boolean;
}

/** Public surface of the per-session outbox controller. */
export interface OutboxController {
  /**
   * Persist a queued message and schedule a flush.
   *
   * `alreadyDurable` says the row reached disk in the transaction that wrote the message it echoes
   * ({@link IStorage.saveMessageWithOutboxEntry}), so only the live half - the mirror and the flush
   * - is still owed.
   */
  enqueue: (entry: OutboxEntry, opts?: { alreadyDurable?: boolean }) => Promise<void>;
  /**
   * Withdraw a queued message that has not left this device yet.
   *
   * Returns whether the message is GUARANTEED never to have been sent, which is the discriminator
   * the caller needs and cannot compute itself: `false` means either that nothing was queued under
   * that id (it went out on an earlier flush) or that this very entry is inside its send right now.
   * Both of those are "the peers have it", and both are answered by a `delete_message` event; only
   * `true` means there is nothing out there to tell anyone about.
   */
  cancelPending: (messageId: string) => Promise<boolean>;
  /**
   * Whether the durable queue holds an entry for this message id: `true`/`false` from the light read
   * (no payload decode), `null` when the queue could not be read - which is NOT "absent".
   */
  hasEntry: (messageId: string) => Promise<boolean | null>;
  /** Drain the outbox. Gated on tab leadership here, not by the caller. Coalesces concurrent calls. */
  flush: () => Promise<void>;
  /**
   * "Try this attachment again NOW" (a bubble's retry): skips its backoff, and abandons a transfer
   * that is on the wire but stalled. The bytes already sent are lost - the media route has no
   * offset - so a retry restarts the upload at zero.
   */
  retryUpload: (messageId: string) => void;
  /** Mark already-loaded messages whose id is still queued as `pending` (reload / history load). */
  applyPendingStatuses: () => Promise<void>;
  /** Stop the internal backoff timer. */
  dispose: () => void;
}

/** Result of attempting to flush a single entry. */
type FlushOutcome = 'sent' | 'retry' | 'error' | 'skip' | 'gone' | 'parked';

/**
 * How many conversations may have a frame on the wire at once. Lanes (below) remove head-of-line
 * blocking between conversations; this bounds what they may cost a weak link: three concurrent POSTs
 * is enough that one stalled lane never freezes the rest, and few enough that a 50 kbit/s uplink is
 * not carved into slivers each of which then misses its deadline.
 */
export const MAX_CONCURRENT_SENDS = 3;

/**
 * How long an attachment may move no byte before its bubble says so (`stalled`). DISPLAY ONLY: the
 * transport's own guard (`DEFAULT_UPLOAD_IDLE_MS`) is what abandons the attempt, and this merely
 * tells the member sooner than that that nothing is moving and a retry is on offer.
 */
export const UPLOAD_STALL_HINT_MS = 10_000;

/**
 * Creates the outbox controller. The flusher re-encodes the proto against the current epoch at
 * send time (so epoch changes are transparent), is idempotent on the stable messageId (a re-send
 * after a crash is deduplicated by the receiver), and never sends into an unhealthy group.
 *
 * It has ONE flusher, `runFlush`, and every trigger - the five wired below and the three outside
 * this module - reaches it. Which they are and why the three outside cannot be folded in is on
 * {@link flushOutbox}.
 */
export function createOutbox(deps: OutboxDeps): OutboxController {
  const { conversations, storage, mlsService, deviceKey, log, canFlush } = deps;

  /**
   * ONE LANE PER CONVERSATION (WP-OFF-5). The flush used to await its entries one by one across the
   * whole queue, so one stalled POST - measured: no deadline, no limit - froze every message queued
   * behind it, in every conversation. Conversations share nothing a send needs (each group has its
   * own ratchet, and `runAsEpochSend` is per group), so each one drains in its own lane while a
   * stalled one holds only itself.
   *
   * ORDER IS PER CONVERSATION AND IT IS KEPT BY CONSTRUCTION: inside a lane the next entry is not
   * attempted until the previous one SENT (or is gone). An entry that must retry or is backing off
   * holds its successors, which the old loop did not - it attempted the later ones anyway, so a
   * failed message could be overtaken by the next one.
   */
  /**
   * Ids whose last attempt failed for want of an ANSWER (a transport failure or a deadline), as
   * opposed to a refusal or a held group. Only those may skip their backoff when the link comes
   * back (WP-OFF-6): the ladder exists to keep a dead link from being hammered, and a link that has
   * just proven itself alive is no longer that. A refusal (`sender-not-active`, a group not yet
   * sendable) is a fact about the GROUP and no reconnect changes it, so those keep their clock.
   * In memory only, on purpose: after a reload the ladder is at most 60 s and the boot flush is
   * the trigger.
   */
  const transportHeld = new Set<string>();
  /**
   * Ids that were answered 403: parked, never re-posted by this controller. In memory on purpose -
   * a restart earns ONE more attempt per entry (bounded), and a sign-in builds a new controller.
   */
  const forbiddenParked = new Set<string>();
  /** Conversations already told (once) that the edge is blocking their sends. */
  const edgeNoticed = new Set<string>();
  /** The subset armed by a reconnect: each id skips its backoff ONCE, then is forgotten. */
  const resuming = new Set<string>();
  /**
   * Entries whose upload the GATEWAY blocked (a CrowdSec 403 ban page). A ban is time-limited and
   * says nothing about the file, so the entry is KEPT - never deleted, never auto-retried in a loop -
   * until the member taps retry (or deletes it). In memory by design: a reload makes ONE new attempt,
   * which re-parks it if the ban still stands.
   */
  const parked = new Set<string>();
  /**
   * Consecutive upload attempts per entry that ended with NO ANSWER (typed: a stall, an unanswered
   * body, a rejected `fetch`). At {@link UPLOAD_NO_ANSWER_ATTEMPTS} the entry is parked as `failed`.
   * In memory by design, like `parked`: a reload earns one more bounded round, and a manual retry,
   * a success or a cancel starts the count again.
   */
  const noAnswer = new Map<string, number>();
  /** The furthest an attempt of this entry has got, so only a NO-FURTHER attempt is counted. */
  const bestLoaded = new Map<string, number>();
  /**
   * Consecutive ONLINE failures per attachment that are not a typed no-answer upload (see
   * {@link MAX_UNEXPECTED_ATTEMPTS}). In memory by design, like `noAnswer`: a reload, a manual retry
   * or a success starts the count again.
   */
  const unexpected = new Map<string, number>();
  const lanes = new Map<string, Promise<void>>();
  /** Conversations whose running lane must look at the queue once more (an enqueue or wake-up arrived). */
  const laneRerun = new Set<string>();
  let activeSends = 0;
  const sendWaiters: Array<() => void> = [];
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The ONE wait on the tab election, shared by every flush that arrives while it is undecided.
   *
   * BOOT REQUESTS MANY FLUSHES AND THERE IS ONLY ONE ELECTION. Each recovering conversation, each
   * enqueue and each wake-up calls `runFlush`, so on a device coming up with twenty-odd groups,
   * twenty of them landed on `getTabLeadership() === 'undecided'` and each awaited the election on
   * its own. Measured on HEAL-REVOKE-5, 2026-08-29: ONE `Flush deferred` line (identical, so the
   * dedup key folded it) and TWENTY `Leadership decided as leader after N ms` lines inside one
   * second, each carrying its own start offset - 6017 ms down to 3871 ms. The flush itself already
   * coalesces through the per-conversation lanes, but only AFTER this gate, so the coalescing could not
   * reach the waiting.
   *
   * NOT A CORRECTNESS FIX AND THAT IS THE POINT. Every waiter resumed and no message was lost; what
   * twenty lines cost is the reader, and a line its reader learns to skip is the one that hides the
   * next defect. One election is one event, so it is logged once and waited on once.
   *
   * IT IS NEVER RESET, BECAUSE THE ELECTION DOES NOT REOPEN. Once decided, the guard below returns
   * before this is read at all, so a stale promise cannot be awaited by a later flush.
   */
  let theElection: Promise<void> | null = null;

  /**
   * Ids withdrawn by `cancelPending` that a flush already running may still be holding.
   *
   * The durable row is deleted by the cancellation itself, which is what stops every FUTURE flush -
   * this set stops the CURRENT one, whose loop is walking a snapshot of the queue read before the
   * user pressed delete. Entries leave it as they are dropped, and it is bounded by the queue.
   */
  const cancelled = new Set<string>();

  /**
   * The id inside `mlsService.sendMessage` right now, or null.
   *
   * A cancellation is only a cancellation if it arrives before the frame does; past this point the
   * peers are getting the message whatever the queue says, and saying so is what lets the caller
   * fall back to a `delete_message` event instead of silently losing the delete.
   */
  let inFlight: string | null = null;

  /**
   * The transfer of each queued attachment that is being uploaded right now, by message id. It is
   * what lets a bubble's cancel and retry reach a request already on the wire: withdrawing the row
   * alone would leave a 13 MB body leaving a weak uplink for a message nobody wants any more.
   * Reasons: `'cancel'` (the member withdrew it) and `'retry'` (try again now, skip the backoff).
   */
  const uploads = new Map<string, AbortController>();

  /**
   * Read the queue. A failure here is indistinguishable from an empty queue to every caller, so
   * it is the one place a queued message can vanish without a trace - hence the log.
   */
  async function readQueue(where: string): Promise<OutboxEntry[]> {
    if (!storage) return [];
    return storage.getOutboxQueue(deviceKey()).catch((e) => {
      log(`[OUTBOX] ${where}: reading the queue failed, treating it as empty: ${String(e)}`);
      return [] as OutboxEntry[];
    });
  }

  /** Rewrite the native background-send mirror from the current queue (Tauri only; best-effort). */
  async function refreshMirror(): Promise<void> {
    if (!storage) return;
    // syncOutboxMirror swallows and logs its own failures ([OUTBOX_MIRROR]); it never rejects.
    await syncOutboxMirror(await readQueue('mirror refresh'));
  }

  /**
   * THE RETRY IS BOUND TO THE CONDITION THAT BLOCKED IT, not to an event that merely precedes it.
   *
   * `runFlush` refuses on `connectivity.isOffline`, which is `!isOnline || !serverReachable` - two
   * facts, restored by two different events at two different times. This used to retry on the raw
   * `window.online` event, which restores only the FIRST of them: `serverReachable` is deliberately
   * left alone there, because a browser regaining a link says nothing about the backend, and only
   * the next successful call can say. So the retry fired while the guard was still shut, was
   * refused, and the event that actually opened the guard - `notifyServerReachable` - reached
   * nobody here.
   *
   * Measured on production 2026-08-14 (MSG-10, WP-OUTBOX-1). A message queued offline at 14:25:38;
   * the browser reported online at 14:25:41.295 and this listener ran and was refused, because
   * `serverReachable` did not come back until 14:25:51.233 - ten seconds later, on a different
   * event. Nothing retried after that. The message left at **14:28:49**, three minutes and eleven
   * seconds after the link returned, and only because an unrelated socket close forced a reconnect
   * that happened to flush. The socket had been alive and delivering the whole time, which is what
   * makes this the outbox's fault and nobody else's.
   *
   * `connectivity.onReconnect` is the seam that means exactly "the condition that blocked you has
   * cleared". It fires on BOTH transitions - the store emits it from the `online` handler and from
   * `notifyServerReachable` - so it strictly supersedes the listener it replaces rather than adding
   * a second one. Listeners here must stay idempotent and cheap: a flapping link fires it often,
   * and `runFlush` already collapses re-entry through the per-conversation lanes.
   */
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') runFlush();
  };
  const unsubscribeReconnect = connectivity.onReconnect(() => {
    // THE RESUME IS PROMPT, AND IDEMPOTENT BECAUSE OF DURABLE STATE, NEVER A CLOCK (WP-OFF-6): an
    // entry leaves the queue only after the server answered 2xx, and one lane per conversation means
    // no entry is ever on the wire twice at once, so skipping a backoff can at worst re-send a frame
    // whose answer was lost - which the receiver deduplicates on the inner `messageId`, exactly as
    // for any retry. Nothing here waits for a timer to expire.
    for (const id of transportHeld) {
      resuming.add(id);
      // The link is back: the stale "waiting for the connection" is false from now on, the entry is
      // simply next in line until its attempt starts and says `preparing`.
      if (viewOfUpload(id)?.phase === 'waiting') patchUpload(id, { phase: 'queued' });
    }
    transportHeld.clear();
    runFlush();
  });
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }

  // Cross-tab half of the leader gate: the leader drains on a follower's behalf, and the follower
  // settles the echo it is still showing as `pending` once the leader reports the send.
  const unsubscribeTabOutbox = subscribeTabOutboxEvents((event) => {
    if (event.type === 'outbox_flush_request') {
      if (!getIsTabLeader()) return;
      log('[OUTBOX] Flush requested by a follower tab.');
      runFlush();
      return;
    }
    // Not leader-gated, and deliberately ahead of the one that is: the tab that must forget a
    // withdrawn entry is whichever one is draining, which is exactly the leader.
    if (event.type === 'outbox_entry_cancelled') {
      cancelled.add(event.messageId);
      log(
        `[OUTBOX] ${event.messageId.slice(0, 8)}… cancelled by another tab - it will not be sent.`
      );
      return;
    }
    if (getIsTabLeader()) return;
    patchStatus(event.messageId, 'sent');
    if (event.content) updateMessageContent(event.messageId, event.content);
  });

  /** Locate a message by id across all conversations (it may have been re-keyed to a duplicate). */
  function findMessage(
    messageId: string
  ): { key: string; convo: Conversation; idx: number } | null {
    for (const [key, convo] of conversations) {
      const idx = convo.messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) return { key, convo, idx };
    }
    return null;
  }

  /** Patch a message's status in the reactive map (in-memory; status is derived, not persisted). */
  function patchStatus(messageId: string, status: ChatMessage['status']): void {
    const found = findMessage(messageId);
    if (!found) return;
    const messages = [...found.convo.messages];
    if (messages[found.idx].status === status) return;
    messages[found.idx] = { ...messages[found.idx], status };
    conversations.set(found.key, { ...found.convo, messages });
  }

  /** Persist the sent message to the encrypted messages store under the live conversation key. */
  async function persistSent(liveConvId: string, messageId: string): Promise<void> {
    if (!storage) return;
    const found = findMessage(messageId);
    if (!found) return;
    const m = found.convo.messages[found.idx];
    // A full-row write, not a patch: `liveConvId` may differ from the key the optimistic row was
    // written under (the group was re-keyed mid-send), and a patch cannot move a row. So every
    // field the in-memory message still carries is written back rather than dropped.
    await storage
      .saveMessage(
        {
          id: m.id,
          conversationId: liveConvId,
          senderId: m.senderId,
          content: m.content,
          timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
          reactions: m.reactions,
          serverTimestamp: m.serverTimestamp,
          isDeleted: m.isDeleted,
          isEdited: m.isEdited,
          ...(m.editedAt ? { editedAt: m.editedAt.getTime() } : {}),
        },
        deviceKey()
      )
      .catch((e) => log(`[OUTBOX] Persist sent ${messageId.slice(0, 8)}… failed: ${String(e)}`));
  }

  /** Replace a message's rendered content in memory (queued media -> real attachment on send). */
  function updateMessageContent(messageId: string, content: string): void {
    const found = findMessage(messageId);
    if (!found) return;
    const messages = [...found.convo.messages];
    messages[found.idx] = { ...messages[found.idx], content };
    conversations.set(found.key, { ...found.convo, messages });
  }

  /**
   * Uploads the queued media file if needed (idempotent via `uploadedRef`), then builds both the
   * proto to send and the real media envelope to swap into the optimistic placeholder message.
   */
  async function prepareMedia(entry: OutboxEntry): Promise<{ proto: Uint8Array; content: string }> {
    const media = entry.media;
    if (!media) throw new Error('media entry without payload');
    let ref = media.uploadedRef;
    if (!ref) {
      if (!deps.uploadMedia) throw new Error('uploadMedia callback not provided');
      if (!media.fileBytes || media.fileBytes.length === 0) {
        throw new LocalAttachmentError('the queued attachment holds no bytes to upload');
      }
      logMlsMetric({ kind: 'outbox_upload_attempt', conversationId: entry.conversationId });
      const control = new AbortController();
      uploads.set(entry.id, control);
      patchUpload(entry.id, {
        phase: 'preparing',
        loaded: 0,
        total: 0,
        attempt: entry.attempts + 1,
      });
      // The hint only: the transport abandons a dead transfer on its own, this says so earlier.
      let lastMoved = Date.now();
      const hint = setInterval(() => {
        if (Date.now() - lastMoved > UPLOAD_STALL_HINT_MS)
          patchUpload(entry.id, { phase: 'stalled' });
      }, 2_000);
      let uploaded: MediaRef;
      let attemptLoaded = 0;
      try {
        uploaded = await deps.uploadMedia(media, {
          signal: control.signal,
          onProgress: ({ loaded, total }) => {
            lastMoved = Date.now();
            attemptLoaded = Math.max(attemptLoaded, loaded);
            patchUpload(entry.id, { phase: 'uploading', loaded, total });
          },
        });
      } catch (e) {
        // NO ANSWER, read from the TYPE the TRANSPORT threw - `UploadStalledError` (no byte moved)
        // or `UploadNetworkError` (the connection broke) - never from a message and never from a
        // bare `TypeError`, which preparation and encryption can throw too. A status is an answer
        // (`uploadRefusalCause` reads it in the flush), a cancel is the member's act, and an
        // `UploadAnswerTimeoutError` means the BODY WAS DELIVERED and the server is slow: not this.
        if (e instanceof UploadStalledError || e instanceof UploadNetworkError) {
          // AN ATTEMPT THAT MOVED MORE BYTES THAN ANY BEFORE IS PROGRESS, NOT A VERDICT: a slow
          // link advances a little each time and must never be given up on. Only an attempt that
          // fails no further than the best so far counts - the signature of a refusal at a fixed
          // point (a relay's body limit), which is what the count exists to end.
          const best = bestLoaded.get(entry.id) ?? 0;
          let count: number;
          if (attemptLoaded > best + UPLOAD_PROGRESS_MARGIN_BYTES) {
            bestLoaded.set(entry.id, attemptLoaded);
            count = 0;
          } else {
            count = (noAnswer.get(entry.id) ?? 0) + 1;
          }
          noAnswer.set(entry.id, count);
          if (count >= UPLOAD_NO_ANSWER_ATTEMPTS) throw new UploadGaveUpError(count, e);
        }
        throw e;
      } finally {
        clearInterval(hint);
        uploads.delete(entry.id);
      }
      noAnswer.delete(entry.id);
      bestLoaded.delete(entry.id);
      unexpected.delete(entry.id);
      clearUpload(entry.id);
      ref = {
        mediaId: uploaded.mediaId,
        key: uploaded.key,
        iv: uploaded.iv,
        ...(uploaded.encoding ? { encoding: uploaded.encoding } : {}),
      };
      // Persist the ref + drop the raw bytes BEFORE sending: a crash after upload must not re-upload.
      await storage
        ?.updateOutboxEntry(
          entry.id,
          { media: { ...media, uploadedRef: ref, fileBytes: undefined } },
          deviceKey()
        )
        // Losing this write means a crash before the send re-uploads the same file.
        .catch((e) =>
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… media ref not persisted: ${String(e)}`)
        );
    }
    // What the sender declared (a reel message's intent, length and expiry hint): empty for an
    // ordinary attachment, which therefore encodes exactly as before.
    const declaration = {
      ...(media.intent ? { intent: media.intent } : {}),
      ...(media.durationMs ? { durationMs: media.durationMs } : {}),
      ...(media.expiresAtMs ? { expiresAtMs: media.expiresAtMs } : {}),
    };
    const fullRef: MediaRef = {
      type: mediaKindToType(media.kind),
      mediaId: ref.mediaId,
      key: ref.key,
      iv: ref.iv,
      mimeType: media.mimeType,
      size: media.size,
      fileName: media.fileName,
      width: media.width,
      height: media.height,
      ...(media.placeholder ? { placeholder: media.placeholder } : {}),
      ...(media.voiceNote ? { voiceNote: true } : {}),
      ...(ref.encoding ? { encoding: ref.encoding } : {}),
      ...declaration,
    };
    const proto = encodeAppMessage({
      ...mkMedia({
        kind: media.kind,
        mediaId: ref.mediaId,
        key: fromHex(ref.key),
        iv: fromHex(ref.iv),
        mimeType: media.mimeType,
        size: media.size,
        fileName: media.fileName ?? '',
        voiceNote: media.voiceNote ?? false,
        caption: media.caption,
        ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
        ...mediaPlaceholderProtoField(media.placeholder),
        ...mediaEncodingProtoField(ref.encoding),
        ...mediaReelProtoFields(declaration),
      }),
      messageId: entry.id,
      sentAt: entry.sentAt,
    });
    return { proto, content: serializeEnvelope(mkMediaEnvelope(fullRef, media.caption)) };
  }

  /**
   * Retires an entry that can never be sent, whatever is retried and however long is waited.
   *
   * There are exactly two such causes: the group was deleted server-side, or this device was
   * removed from it. Both leave the message undeliverable for good, so both take the same three
   * steps - error status, the banner (never raised by a reaction or a read receipt, only by a
   * user-visible send), and the row gone from the queue.
   *
   * THEY STOPPED BEING INDISTINGUISHABLE AT THE POINT THEY STOPPED BEING RECORDED THE SAME WAY. An
   * eviction is a fact about THIS DEVICE's membership and it has one disposition wherever it is
   * learnt ({@link recordEviction}) - including the notice in the thread, which is what tells the
   * user why the message they wrote will never go. A deletion is a fact about the GROUP, learnt by
   * everyone, and its own handler owns it; the hook here is the backstop for the race the outbox
   * alone can see.
   */
  async function failPermanently(
    entry: OutboxEntry,
    terminalId: string,
    cause: 'group-deleted' | 'evicted' | 'evicted-late' | 'too-large' | 'refused'
  ): Promise<FlushOutcome> {
    // THE KIND IS THE SEVERITY, and this line used to omit the one thing that decides it. A
    // `control` entry dying with its group is a read receipt or a reaction that lost a race to a
    // deletion - expected, harmless, and the reason the very next line exempts it from marking the
    // conversation deleted. A `text`, `reply` or `media` entry dying is a message the user WROTE
    // and will never see sent. Both printed the same sentence, so a reader meeting one had to go
    // and find the entry by hand to learn which had happened. GRP-7 did exactly that on 2026-08-24.
    log(
      `[OUTBOX] ${entry.id.slice(0, 8)}… ${entry.kind} entry in ${terminalId.slice(0, 8)}…, ${cause} - permanent failure` +
        (entry.kind === 'control' ? ' (control: nothing the user wrote is lost)' : '')
    );
    patchStatus(entry.id, 'error');
    clearUpload(entry.id);
    if (entry.kind !== 'control') {
      if (cause === 'too-large' || cause === 'refused') {
        // THE ONE PERMANENT FAILURE THAT IS ABOUT THE OBJECT, NOT THE GROUP: nothing about the
        // conversation changed, so no banner and no eviction - only a line in the thread that tells
        // the author which message will never go and what to do about it. Best-effort, and logged.
        await deps
          .addMessageToChat?.(
            'system',
            cause === 'too-large' ? m.outbox_upload_too_large() : m.outbox_upload_refused(),
            entry.conversationId,
            { isSystem: true }
          )
          .catch((e: unknown) =>
            log(`[OUTBOX] ${entry.id.slice(0, 8)}… too-large notice not posted: ${String(e)}`)
          );
      } else if (cause === 'group-deleted') {
        deps.markDeletedRemotely?.(terminalId);
      } else {
        // `evicted` was read from `isGroupActive` before the wire was touched; `evicted-late` from
        // the server's own refusal, which means the commit never arrived. One disposition, and the
        // evidence is what separates them in the log.
        await recordEviction({
          conversations: deps.conversations,
          groupId: terminalId,
          evidence: cause === 'evicted' ? 'membership-check' : 'outbound-refusal',
          saveConversation: deps.saveConversation,
          addMessageToChat: deps.addMessageToChat,
          log,
        });
      }
    }
    await storage?.deleteOutboxEntry(entry.id).catch(() => {});
    logMlsMetric({
      kind: 'outbox_permanent_error',
      conversationId: terminalId,
      entryKind: entry.kind,
      cause,
    });
    return 'error';
  }

  /**
   * Keep an entry pending and back it off DURABLY - the one writer of a retry disposition.
   *
   * **Two arms reach a retry and only one of them wrote anything.** The catch arm below incremented
   * `attempts` and wrote `nextAttemptAt`; the health gate above returned `'retry'` and wrote
   * neither. Those two fields are not bookkeeping, and losing them is not a smaller version of the
   * same behaviour:
   *
   * - **`nextAttemptAt` is the entry's OWN clock.** `scheduleBackoff` wakes the flush at the
   *   earliest one pending, and an entry that never writes one contributes nothing to that list -
   *   so it was never retried on its own account, only when something unrelated happened to flush.
   *   A message held on an unhealthy group was therefore waiting on an event nobody owed it.
   * - **`attempts` is the only durable record of how long this has been going on.** A ceiling, a
   *   report, or a user-visible "this is not getting through" all have to read it, and it stayed at
   *   zero for exactly the entries that would need one. The held case has no terminal disposition
   *   yet - `group-deleted` and `evicted` are the only two, and a group nobody can repair is
   *   neither - and it cannot grow one on top of a counter that does not count.
   *
   * **The happy path does not pay for the backoff.** A group becoming sendable is not something
   * this module can observe, so it has its own trigger: `sessionAuth`'s `onGroupReady` calls
   * `flushOutbox()` the moment a Welcome or an external join completes. The backoff below is what
   * happens when the repair does NOT land, which is the only case that was unbounded.
   */
  async function holdForRetry(
    entry: OutboxEntry,
    describe: (attempts: number) => string,
    opts: { transport?: boolean; repair?: boolean; local?: boolean; quiet?: boolean } = {}
  ): Promise<FlushOutcome> {
    if (opts.transport) transportHeld.add(entry.id);
    else transportHeld.delete(entry.id);
    // The count is of CONSECUTIVE local failures: any other kind of hold breaks the run.
    if (!opts.local) unexpected.delete(entry.id);
    patchStatus(entry.id, 'pending');
    // An attachment still to upload shows that its next attempt is queued (and starts from zero).
    // `quiet` when the payload was not read, so whether the upload already happened is not known.
    if (!opts.quiet && entry.kind === 'media' && !entry.media?.uploadedRef) {
      // THE LABEL IS THE HOLD'S TYPED REASON, never a guess: only a transport failure accuses the
      // network; a group repair and any other failure each say what they are.
      patchUpload(entry.id, {
        phase: opts.transport ? 'waiting' : opts.repair ? 'repairing' : 'retrying',
        loaded: 0,
        attempt: entry.attempts + 1,
      });
    }
    const attempts = entry.attempts + 1;
    await storage
      ?.updateOutboxEntry(
        entry.id,
        {
          status: 'pending',
          attempts,
          lastAttemptAt: Date.now(),
          nextAttemptAt: Date.now() + backoffFor(attempts),
        },
        deviceKey()
      )
      // Losing this write loses the backoff with it, so the entry is retried at full speed.
      .catch((err) =>
        log(`[OUTBOX] ${entry.id.slice(0, 8)}… backoff not persisted: ${String(err)}`)
      );
    // ONE LINE PER HELD ENTRY, and the caller writes it because only the caller knows what is
    // being waited on. A second line here would be the one its reader learns to skip.
    log(describe(attempts));
    return 'retry';
  }

  /**
   * Parks an entry that keeps failing for a reason retrying cannot mend, with a state the member can
   * SEE and act on (`error`: retry or delete). Kept, never deleted - nothing the user wrote is lost -
   * and terminal until the member acts: a reconnect resumes only `transportHeld` entries.
   */
  function parkAsError(entry: OutboxEntry, why: string): FlushOutcome {
    const line = `[OUTBOX] ${entry.id.slice(0, 8)}… ${entry.kind} entry FAILED on this device: ${why} - parked for a manual retry, entry kept`;
    console.error(line);
    log(line);
    parked.add(entry.id);
    transportHeld.delete(entry.id);
    unexpected.delete(entry.id);
    patchStatus(entry.id, 'pending');
    patchUpload(entry.id, { phase: 'error' });
    return 'parked';
  }

  /**
   * The generic retry of an ATTACHMENT, bounded ONLY for local failures (see
   * {@link isLocalAttachmentFailure}): the Nth consecutive one parks the entry. Every other failure
   * is held on the ladder without a count and resets the run - the network and the server are
   * waited out, never held against the file. Any other entry kind is held without a count (cheap
   * now that a queue read decodes no file, and the ladder tops at 60 s).
   */
  function countedHold(
    entry: OutboxEntry,
    e: unknown,
    describe?: (attempts: number) => string,
    opts: { transport?: boolean; repair?: boolean; quiet?: boolean } = {}
  ): Promise<FlushOutcome> | FlushOutcome {
    const local = entry.kind === 'media' && isLocalAttachmentFailure(e);
    if (local) {
      const count = (unexpected.get(entry.id) ?? 0) + 1;
      unexpected.set(entry.id, count);
      if (count >= MAX_UNEXPECTED_ATTEMPTS) {
        return parkAsError(entry, `${count} attempts in a row failed (${String(e).slice(0, 120)})`);
      }
    }
    return holdForRetry(
      entry,
      describe ??
        ((attempts) =>
          `[OUTBOX] ${entry.id.slice(0, 8)}… transient failure (attempt ${attempts}): ${String(e).slice(0, 80)}`),
      { ...opts, local }
    );
  }

  /** Flush a single entry. Returns the outcome so the loop can schedule backoff/chaining. */
  async function flushOne(entry: OutboxEntry): Promise<FlushOutcome> {
    // Withdrawn after this flush read its snapshot of the queue. The row is already gone, so this
    // is the only thing standing between a message the user deleted and the wire.
    if (cancelled.has(entry.id)) {
      cancelled.delete(entry.id);
      clearUpload(entry.id);
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… cancelled before it was sent - dropped, not delivered`
      );
      return 'gone';
    }

    // Consumed here, whether or not the backoff was still running, so a stale arming cannot outlive
    // the reconnect it came from.
    if (forbiddenParked.has(entry.id)) return 'skip';
    const resumed = resuming.delete(entry.id);
    // A manual retry (or a reconnect's resume) is a fresh start for the no-answer count.
    if (resumed) {
      noAnswer.delete(entry.id);
      bestLoaded.delete(entry.id);
      unexpected.delete(entry.id);
    }
    // PARKED IS NOT BLOCKING: the entry waits for the member, and what was written after it goes.
    if (!resumed && parked.has(entry.id)) return 'parked';
    parked.delete(entry.id);
    if (!resumed && entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… skipped, backing off for ${entry.nextAttemptAt - Date.now()}ms (attempt ${entry.attempts})`
      );
      return 'skip';
    }

    // The MLS outbox is for DMs/groups only. A channel entry (server-authoritative, no MLS group)
    // can only have leaked in through a bug: it would loop forever on requestReAdd 500s. Drop it so
    // a stale entry cannot storm the delivery service.
    if (isChannelConversationId(entry.conversationId)) {
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… channel entry - dropped (channels do not use MLS)`);
      await storage?.deleteOutboxEntry(entry.id).catch(() => {});
      return 'error';
    }

    // THE PAYLOAD OF AN ATTACHMENT IS READ HERE AND NOWHERE EARLIER: the queue read returns a media
    // entry as its scheduling columns only, because decoding the file is what froze a Pixel 6a once
    // per backoff (2026-10-10). Every skip above returns before this line, so an entry that is not
    // due costs a row of numbers - and a due one is decoded exactly once.
    if (entry.kind === 'media' && !entry.media) {
      try {
        const full = await storage?.getOutboxEntry(entry.id, deviceKey());
        if (!full) {
          // Withdrawn between the `cancelled` check above and this read: consume it, like that check.
          cancelled.delete(entry.id);
          clearUpload(entry.id);
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… no longer queued - nothing to send`);
          return 'gone';
        }
        entry = full;
      } catch (e) {
        if (e instanceof OutboxPayloadUnreadableError) {
          return parkAsError(
            entry,
            `its payload cannot be decrypted (${String(e.cause).slice(0, 80)})`
          );
        }
        // A row that exists but cannot be loaded is a LOCAL failure, and whether the upload already
        // happened is unknown here, so the bubble is left as it is.
        return countedHold(
          entry,
          new LocalAttachmentError('the queued row could not be read', e),
          undefined,
          {
            quiet: true,
          }
        );
      }
    }

    const terminalId = entry.conversationId;
    const groupMeta = await mlsService.getGroupMeta(terminalId).catch(() => null);

    // Group deleted server-side: one of the two permanent failures.
    if (groupMeta?.deletedAt) {
      return failPermanently(entry, terminalId, 'group-deleted');
    }

    // Group not sendable yet: trigger recovery (external join / welcome_request) and retry later.
    // Logged because this branch holds a message back indefinitely while reporting nothing: a
    // conversation stuck here looks, from the outside, exactly like a message that was delivered.
    if (!deps.isGroupHealthy(terminalId)) {
      await deps
        .requestReAdd(terminalId)
        .catch((e) =>
          log(`[OUTBOX] Re-add request for ${terminalId.slice(0, 8)}… failed: ${String(e)}`)
        );
      // Through `holdForRetry`, which is what this branch did not do: it returned `'retry'` having
      // written nothing, so the entry had neither a clock of its own nor a count of how long it had
      // been held. See that function for what each of the two fields actually decides.
      return holdForRetry(
        entry,
        (attempts) =>
          `[OUTBOX] ${entry.id.slice(0, 8)}… held: group ${terminalId.slice(0, 8)}… not sendable, re-add requested (attempt ${attempts})`,
        { repair: true }
      );
    }

    // EVICTED: the other permanent failure, and the reason this is a QUESTION rather than a caught
    // refusal. A Remove commit naming this device is authoritative - signed, ordered, and applied
    // identically by every other member - so there is nothing to confirm and nothing to repair.
    // Asked here, one cheap call before the wire is touched, an evicted group never encrypts and
    // never sends; the `EVICTED` arm in the catch below is left as the accusation it should be.
    //
    // The health gate above has already established the group is held locally, which is the only
    // case `isGroupActive` throws for - so a throw here is a genuine read failure, and a read
    // failure is NOT an eviction. Retried rather than guessed: the two are opposite facts and only
    // one of them destroys a queued message.
    let stillMember: boolean;
    try {
      stillMember = await mlsService.isGroupActive(terminalId);
    } catch (e) {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… membership of ${terminalId.slice(0, 8)}… unreadable: ${String(e).slice(0, 80)} - retrying`
      );
      return 'retry';
    }
    if (!stillMember) {
      return failPermanently(entry, terminalId, 'evicted');
    }

    patchStatus(entry.id, 'sending');
    logMlsMetric({ kind: 'outbox_flush_attempt', conversationId: terminalId });

    try {
      // Media: upload (idempotent) then build proto + the real attachment envelope.
      let proto: Uint8Array;
      let mediaContent: string | undefined;
      if (entry.kind === 'media') {
        const prepared = await prepareMedia(entry);
        proto = prepared.proto;
        mediaContent = prepared.content;
        // The upload has completed, so the blob is readable before MLS acknowledges the message.
        // Replace the optimistic empty ref now; waiting for sendMessage leaves media at `''` during
        // the whole network race and a renderer that observed that state stays on its skeleton.
        updateMessageContent(entry.id, mediaContent);
      } else {
        proto = buildOutboxProto(entry) ?? new Uint8Array(0);
      }

      inFlight = entry.id;
      try {
        await mlsService.sendMessage(terminalId, proto, entry.id, deliveryForOutboxEntry(entry));
      } finally {
        inFlight = null;
      }
      // The media envelope was installed immediately after upload, before the MLS send.
      await persistSent(terminalId, entry.id);
      patchStatus(entry.id, 'sent');
      clearUpload(entry.id);
      transportHeld.delete(entry.id);
      unexpected.delete(entry.id);
      // The tab that composed this may be a follower, whose own echo is still showing `pending`.
      publishOutboxEntrySent(entry.id, mediaContent);
      // A delete that fails leaves a SENT entry in the queue, so the next flush sends it again.
      // The receiver deduplicates on messageId, but the retry is worth seeing in a log.
      await storage
        ?.deleteOutboxEntry(entry.id)
        .catch((e) =>
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… sent but still queued (delete failed): ${String(e)}`
          )
        );
      logMlsMetric({
        kind: 'outbox_flush_success',
        conversationId: terminalId,
        latencyMs: Date.now() - entry.sentAt,
      });
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… sent in ${terminalId.slice(0, 8)}…`);
      return 'sent';
    } catch (e) {
      // EVICTED: permanent, and the second place it can be learnt rather than the first. The Remove
      // commit named this device when it merged, and `retireIfEvicted` acts on it there - so
      // reaching here means the commit never arrived (a device offline across the whole removal,
      // then sending before it drains). The fallback is a SIGNAL: it is logged as the miss it is,
      // and it must never become the path eviction is normally discovered on.
      // NOT A DEFERRAL, and the retry below is not what lifts it: the server says this device holds
      // no leaf in the group, which only a Welcome or an external commit changes. The entry STAYS -
      // the message is never lost, and it goes out intact once the device is a member - but the line
      // has to accuse, because reaching here means `isGroupActive` answered YES one call earlier and
      // the two views of this device's membership disagree. That is the Welcome-livelock signature
      // in `docs/wiki/backlog.md`, and it is the only place a sender can observe it.
      // ONE READ OF THE DISCRIMINATOR, used by all three branches below. It was classified three
      // times for the same error, which is three chances for the arms to drift apart on what they
      // think happened.
      // A TRANSFER THE MEMBER ENDED ON PURPOSE, read from the TYPE the transport threw. Cancel: the
      // row is already withdrawn (`cancelPending` deleted it before aborting), so this is only the
      // flush learning of it. Retry: not a failure at all - the member asked for another attempt
      // now, so the backoff is skipped and the lane re-runs at once.
      if (e instanceof UploadAbortedError) {
        if (e.reason === 'retry') {
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… upload restarted on request`);
          resuming.add(entry.id);
          laneRerun.add(entry.conversationId);
          return 'retry';
        }
        cancelled.delete(entry.id);
        clearUpload(entry.id);
        log(`[OUTBOX] ${entry.id.slice(0, 8)}… upload cancelled - the transfer was aborted`);
        return 'gone';
      }
      const kind = classifyOutgoingSendError(e);
      if (kind === 'sender-not-active') {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… REFUSED by the server: this device holds no leaf in ${terminalId.slice(0, 8)}… while the local MLS state says it is a member - the roster and the tree disagree, and only a Welcome or an external commit lifts it`
        );
        // AND THE REPAIR IS DRIVEN FROM HERE, because this is the only place that holds the proof.
        //
        // Observing the livelock and doing nothing about it is what made it permanent. The entry
        // stayed, the backoff ladder ran to its 60 s ceiling and re-posted for ever, and every
        // mechanism that could have repaired the group declined to look at it: the connection sync
        // and the SYNC_WATCHDOG both skip a group the WASM holds, and the watchdog additionally
        // called `cancelReAdd` on it every 5 s, so the one bit of recovery bookkeeping that might
        // have survived was cleared on a cadence. Measured 2026-09-04 with eight messages at
        // attempt 18-23 against a `pending` roster seat two and a half hours old.
        //
        // A RETRY IS NOT A REPAIR, AND THIS FRAME PROVES WHICH IS OWED. The server has just stated
        // that this device holds no leaf; re-posting the same frame cannot change that, so the
        // ladder below is only what keeps the MESSAGE (it is never lost, and goes out intact once
        // the device is a member again). The seam is what makes that "once" arrive. It is throttled
        // on the shared recovery cooldown, so calling it from a flush that runs every 2 s is safe.
        await deps
          .recoverRosterDisagreement(terminalId)
          .catch((err) =>
            log(
              `[OUTBOX] roster repair for ${terminalId.slice(0, 8)}… failed: ${String(err).slice(0, 120)}`
            )
          );
      }
      // THE GROUP ENDED WHILE THIS FRAME WAS IN FLIGHT, which the pre-flight `deletedAt` check
      // above cannot catch: it reads that fact over a round trip and the deletion lands inside it.
      // The same permanent disposition it would have taken, reached from the server's answer
      // instead of from a local read - one `cause`, so a reader cannot tell the two apart and does
      // not have to.
      if (kind === 'group-deleted') {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… send REFUSED: ${terminalId.slice(0, 8)}… was deleted while this frame was in flight, after the pre-flight check read it as alive`
        );
        return failPermanently(entry, terminalId, 'group-deleted');
      }
      // AN ANSWER IS NEVER TRANSIENT. A refusal the media service (or the gateway in front of it)
      // gave to THIS upload is read from the TYPE the throw carried (status and origin, never the
      // message), and no retry changes it: the ladder used to re-post the same body once a minute for
      // ever (attempt 806 on a 413, 2026-10-07; a 403 CrowdSec ban page on every 10 MiB+ body,
      // 2026-10-10, which spun the bubble for ever). It accuses: each is the visible end of an upload
      // path that shipped something the other side cannot take.
      const refusal = uploadRefusalCause(e);
      if (refusal === 'blocked') {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… upload BLOCKED by the gateway (${String(e).slice(0, 120)}) - parked for a manual retry, entry kept`
        );
        console.error(`[OUTBOX] upload blocked by the gateway: ${String(e).slice(0, 120)}`);
        parked.add(entry.id);
        patchStatus(entry.id, 'pending');
        patchUpload(entry.id, { phase: 'blocked' });
        return 'parked';
      }
      // THE UPLOAD NEVER GOT AN ANSWER, THREE TIMES RUNNING, ONLINE: not a link to wait out but a
      // path that does not work (a relay refusing early and closing mid-body delivers no status).
      // Terminal and member-visible - kept, parked, retry and delete offered - never an endless
      // "sending". It accuses, because it is the visible end of something upstream.
      if (e instanceof UploadGaveUpError) {
        const line = `[OUTBOX] ${entry.id.slice(0, 8)}… upload FAILED: no answer on ${e.attempts} attempts in a row (${String(e.cause).slice(0, 120)}) - parked for a manual retry, entry kept`;
        console.error(line);
        log(line);
        parked.add(entry.id);
        // TERMINAL UNTIL THE MEMBER ACTS: a reconnect resumes every `transportHeld` entry, and the
        // attempt that gave up was held as a transport failure - leaving it there would restart it
        // behind a bubble still saying `failed`.
        transportHeld.delete(entry.id);
        patchStatus(entry.id, 'pending');
        patchUpload(entry.id, { phase: 'failed' });
        return 'parked';
      }
      if (refusal) {
        const detail = `${entry.kind} entry${entry.media ? ` (${entry.media.size} bytes)` : ''}`;
        const line = `[OUTBOX] ${entry.id.slice(0, 8)}… upload REFUSED (${refusal}: ${String(e).slice(0, 120)}) - ${detail} in ${terminalId.slice(0, 8)}…: no retry can succeed, giving up`;
        console.error(line);
        log(line);
        return failPermanently(entry, terminalId, refusal);
      }
      // A 403 IS AN ANSWER ABOUT THE CALLER, read from the TYPE (`SendForbiddenError` is an
      // `ApiRefusalError`), and re-posting the same frame cannot change who the caller is. The
      // ladder re-posted six entries 23 times on a bench phone whose token named another account
      // (2026-10-10). The entry is KEPT - nothing the user wrote is lost, and it goes out after a
      // sign-in - but it is PARKED for this controller's life (a new sign-in builds a new one), and
      // the line accuses: the 403 is the visible end of an identity or authorization defect upstream.
      // A 403 FROM THE EDGE (CrowdSec ban page, not the gateway's JSON) is about the NETWORK PATH,
      // so it is not parked: a sign-in cannot lift it, the ban expiring does. It climbs the ladder
      // on the backoff ladder (a reconnect does not lift it, so it is not `transport`), accuses, and tells the user ONCE per conversation.
      if (e instanceof SendEdgeRefusedError) {
        const line = `[OUTBOX] ${entry.id.slice(0, 8)}… REFUSED with ${e.status} by the EDGE (not the gateway) in ${terminalId.slice(0, 8)}… - a WAF/proxy block on this network path; retrying on the ladder`;
        console.error(line);
        if (edgeNoticed.add(terminalId) && entry.kind !== 'control') {
          await deps
            .addMessageToChat?.('system', m.outbox_edge_blocked(), entry.conversationId, {
              isSystem: true,
            })
            .catch((err: unknown) => log(`[OUTBOX] edge notice not posted: ${String(err)}`));
        }
        return holdForRetry(
          entry,
          (attempts) =>
            `[OUTBOX] ${entry.id.slice(0, 8)}… held on an edge refusal (attempt ${attempts})`
        );
      }
      if (refusalStatus(e) === 403) {
        forbiddenParked.add(entry.id);
        const line = `[OUTBOX] ${entry.id.slice(0, 8)}… REFUSED with 403 in ${terminalId.slice(0, 8)}… - the caller is not allowed to send this; parked, no retry until the next sign-in`;
        console.error(line);
        log(line);
        patchStatus(entry.id, 'pending');
        return 'skip';
      }
      if (kind === 'evicted') {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… send REFUSED as evicted, after isGroupActive answered that this device is still a member of ${terminalId.slice(0, 8)}… - the two disagree, and OpenMLS is the one that is right`
        );
        return failPermanently(entry, terminalId, 'evicted-late');
      }
      // Keep pending, back off. The message is never lost - that is true of both arms that reach
      // here, and it is the only thing they share.
      //
      // A LINE ITS READER LEARNS TO SKIP HIDES THE NEXT DEFECT, so the two arms do not share a
      // sentence. `sender-not-active` is not transient by any reading - the server has refused this
      // device's leaf and will refuse it identically until the repair above lands - and reporting it
      // as "transient failure (attempt 23)" is what let eight stuck messages read as ordinary
      // network noise for two and a half hours. What is retried here is the MESSAGE; what is being
      // waited on is the REPAIR, and the line says which.
      return countedHold(
        entry,
        e,
        (attempts) =>
          kind === 'sender-not-active'
            ? `[OUTBOX] ${entry.id.slice(0, 8)}… held for the roster repair of ${terminalId.slice(0, 8)}… (attempt ${attempts}) - not a transient failure: the server refuses this device's leaf until it is re-admitted`
            : `[OUTBOX] ${entry.id.slice(0, 8)}… transient failure (attempt ${attempts}): ${String(e).slice(0, 80)}`,
        // Classified by TYPE: the delivery API raises `DeliveryUnreachableError` for a POST that got
        // no answer (a deadline expiry included), never a sentence to match.
        {
          transport:
            kind === 'unknown' && (e instanceof DeliveryUnreachableError || isTransportFailure(e)),
          repair: kind === 'sender-not-active',
        }
      );
    }
  }

  /** Schedule a single backoff re-flush at the earliest pending `nextAttemptAt`. */
  function scheduleBackoff(entries: OutboxEntry[]): void {
    const now = Date.now();
    const next = entries
      .map((e) => e.nextAttemptAt ?? 0)
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = setTimeout(
      () => {
        backoffTimer = null;
        runFlush();
      },
      Math.max(1_000, next - now)
    );
  }

  async function runFlush(): Promise<void> {
    if (!storage) return;
    // LEADERSHIP HAS THREE STATES AND THIS USED TO READ TWO. `getIsTabLeader()` answers false while
    // the election is still running, and the follower branch below took that as "another tab will
    // do it" - on a single-tab client, a broadcast to nobody. It then returned before
    // `scheduleBackoff`, which would have armed nothing anyway: a never-attempted entry has no
    // `nextAttemptAt`. So a message enqueued inside the boot gap waited for an unrelated wake-up
    // (WP-OUTBOX-2, observed twice, no message lost).
    //
    // Awaiting the decision is the fix, and it is not a retry: the election always terminates, so
    // this resolves rather than expires. The wait is logged with what it cost, because a gap nobody
    // can see is how this defect survived two sightings.
    if (getTabLeadership() === 'undecided') {
      if (!theElection) {
        const waitedFrom = Date.now();
        log('[OUTBOX] Flush deferred - tab leadership undecided; waiting for the election.');
        theElection = whenTabLeadershipDecided().then((side) => {
          log(`[OUTBOX] Leadership decided as ${side} after ${Date.now() - waitedFrom} ms.`);
        });
      }
      await theElection;
    }
    // Encryption belongs to the leader tab, and to it alone. Both tabs of one account hold their
    // own MLS client loaded from a single snapshot, so a send from the tab whose in-memory ratchet
    // is behind is encrypted at a generation the peer has already consumed: the peer logs
    // `Ciphertext generation out of bounds` and drops it as a duplicate, and the message is gone
    // (WP-MULTITAB-1). Leadership already gated the WebSocket and `initializeConnection`; this is
    // the write path it never covered - the follower was observed flushing the LEADER's entry.
    // The entry itself needs no transfer: the queue is in IndexedDB, which both tabs share.
    if (!getIsTabLeader()) {
      log('[OUTBOX] Flush skipped - follower tab; asking the leader to drain the shared queue.');
      requestLeaderOutboxFlush();
      return;
    }
    // A flush needs a session that can actually send. Two different reasons it may not be able to:
    // there is no network at all, or the session was unlocked offline and holds no token yet
    // (promoteOfflineSession calls back here the moment it does). Attempting anyway is not merely
    // wasted - every entry takes a failed attempt and a longer backoff for a send that never had a
    // chance, so the queue is slowest exactly when connectivity returns.
    if (connectivity.isOffline) {
      log('[OUTBOX] Flush skipped - offline; the queue is kept intact for the next reconnect.');
      return;
    }
    if (canFlush && !canFlush()) {
      log('[OUTBOX] Flush skipped - session not ready to send yet.');
      return;
    }
    const queued = await readQueue('flush');
    if (queued.length === 0) return;
    // CHECK AND CLAIM WITH NO AWAIT BETWEEN THEM: two wake-ups landing together must not both start
    // a lane for one conversation, because two lanes would send one entry twice.
    const started: Promise<void>[] = [];
    for (const conversationId of new Set(queued.map((e) => e.conversationId))) {
      if (lanes.has(conversationId)) {
        laneRerun.add(conversationId);
        continue;
      }
      const lane = drainLane(conversationId).finally(() => lanes.delete(conversationId));
      lanes.set(conversationId, lane);
      started.push(lane);
    }
    if (started.length === 0) return;
    try {
      await Promise.all(started);
      // Re-read for backoff scheduling (statuses/attempts changed during the lanes).
      const remaining = await readQueue('backoff scheduling');
      if (remaining.length > 0) {
        log(
          `[OUTBOX] ${remaining.length} entr${remaining.length === 1 ? 'y' : 'ies'} still queued`
        );
        scheduleBackoff(remaining);
      }
    } finally {
      void refreshMirror();
    }
  }

  /** Runs `fn` while holding one of {@link MAX_CONCURRENT_SENDS} slots; a released slot is handed on, never freed and re-raced. */
  async function withSendSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (activeSends < MAX_CONCURRENT_SENDS) activeSends++;
    else await new Promise<void>((resolve) => sendWaiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = sendWaiters.shift();
      if (next) next();
      else activeSends--;
    }
  }

  /** Drains ONE conversation, oldest entry first, until nothing more can be sent now. */
  async function drainLane(conversationId: string): Promise<void> {
    // Before any send: let the INCOMING message queue drain. fetchPendingMessages
    // (on reconnect/resume) only enqueues the pending frames - their processing (commits
    // that advance the epoch) is asynchronous. Without this barrier, a flush triggered by
    // online/visibilitychange can go out BEFORE the missed commits are applied:
    // the message would be encrypted at a stale epoch, hence undecryptable by up-to-date peers
    // (silent loss - the "cold send on resume" race). Waiting for idle guarantees the local
    // epoch is up to date. In steady state the queue is already idle -> immediate resolution,
    // no added latency. [[DF1c]]
    // `null`: a flush is raised by a reconnect, a visibility change or a session promotion, never
    // from inside a decrypt session - and it is about whatever the queue happens to hold.
    await mlsService.waitForMessageQueueIdle('outbox flush', null).catch((e) =>
      // The barrier failing does NOT stop the flush - a queue that cannot drain must not block
      // sending forever. But it means exactly the condition the barrier exists to prevent, so it
      // is the first thing to look for when a message is accepted locally and never arrives.
      log(`[OUTBOX] Incoming-queue barrier failed, sending at a possibly stale epoch: ${String(e)}`)
    );
    for (;;) {
      laneRerun.delete(conversationId);
      const entries = (await readQueue('flush')).filter((e) => e.conversationId === conversationId);
      if (entries.length === 0) return;
      logMlsMetric({ kind: 'outbox_pending_count', count: entries.length });
      log(
        `[OUTBOX] Flushing ${entries.length} queued entr${entries.length === 1 ? 'y' : 'ies'} for ${conversationId.slice(0, 8)}…`
      );
      let anySent = false;
      // Ids parked or held back in THIS pass: what depends on one of them (a reply to it, a control
      // naming it) is not attempted - it would reference a message the peers never received.
      const heldBack = new Set<string>();
      for (const entry of entries) {
        if (dependsOnAny(entry, heldBack)) {
          heldBack.add(entry.id);
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… waits: it depends on a parked message`);
          continue;
        }
        const outcome = await withSendSlot(() => flushOne(entry));
        if (outcome === 'parked') heldBack.add(entry.id);
        if (outcome === 'sent') anySent = true;
        // Withdrawn or permanently failed: the entry is out of the queue, so what follows it may go.
        else if (outcome === 'gone' || outcome === 'error') continue;
        // Parked for the member (blocked, failed): waiting on a human, not on the network, so what
        // was written after it must not wait too. Only an entry that RETRIES holds its successors.
        else if (outcome === 'parked') continue;
        // Retry or backing off: the successors wait, which is what keeps the conversation in order.
        else break;
      }
      // Chain another pass if a send unblocked dependents, or a concurrent enqueue arrived.
      if (!anySent && !laneRerun.has(conversationId)) return;
    }
  }

  return {
    async enqueue(entry: OutboxEntry, opts: { alreadyDurable?: boolean } = {}): Promise<void> {
      // REJECTS RATHER THAN RETURNS: a no-op here told the caller its message was queued when
      // nothing would ever send it.
      if (!storage) {
        log(`[OUTBOX] Enqueue refused for ${entry.id.slice(0, 8)}…: no storage layer`);
        throw new OutboxEnqueueError('no storage layer');
      }
      // The first trace of a message on this device: without it there is no way to tell a send that
      // never reached the queue from one the queue accepted and lost.
      log(
        `[OUTBOX] Queued ${entry.id.slice(0, 8)}… (${entry.kind}) for ${entry.conversationId.slice(0, 8)}…`
      );
      // Already on disk beside its message when the send path wrote the pair atomically. Repeating
      // the put would be idempotent but not free: a second encryption on the hot path, and a second
      // way to fail AFTER the fact is durable - which is the state this argument exists to make
      // impossible to reach.
      if (!opts.alreadyDurable) {
        try {
          await storage.saveOutboxEntry(entry, deviceKey());
        } catch (e) {
          log(`[OUTBOX] Enqueue failed for ${entry.id.slice(0, 8)}…: ${String(e)}`);
          throw new OutboxEnqueueError('the durable write failed', e);
        }
      }
      await refreshMirror();
      runFlush();
    },

    async hasEntry(messageId: string): Promise<boolean | null> {
      if (!storage) return null;
      try {
        return (await storage.getOutboxQueue(deviceKey())).some((e) => e.id === messageId);
      } catch (e) {
        log(`[OUTBOX] hasEntry ${messageId.slice(0, 8)}…: reading the queue failed: ${String(e)}`);
        return null;
      }
    },

    async cancelPending(messageId: string): Promise<boolean> {
      if (!storage) return false;
      const queued = (await readQueue('cancel')).find((e) => e.id === messageId);
      if (!queued) return false;

      // Three things, and the order between them does not matter because none can undo another:
      // the durable row (every future flush), this tab's snapshot (a flush already walking), and
      // the other tabs' snapshots (a leader draining on our behalf).
      cancelled.add(messageId);
      parked.delete(messageId);
      noAnswer.delete(messageId);
      bestLoaded.delete(messageId);
      unexpected.delete(messageId);
      publishOutboxEntryCancelled(messageId);
      await storage
        .deleteOutboxEntry(messageId)
        // A row that survives is a message that will be sent after the user deleted it, which is
        // the whole defect - so this is reported rather than swallowed, and the caller is told the
        // cancellation did not hold so the `delete_message` event goes out instead.
        .catch((e) => {
          log(`[OUTBOX] ${messageId.slice(0, 8)}… cancel could not delete the row: ${String(e)}`);
          cancelled.delete(messageId);
        });
      if (!cancelled.has(messageId)) return false;
      // A body already on the wire is stopped too, not only forgotten. AFTER the check above: the
      // abort wakes the flush that owns the transfer, which consumes `cancelled`.
      uploads.get(messageId)?.abort('cancel');
      // The mirror is the native background sender's own copy of the queue: leaving the entry in it
      // sends the message from Android after it was withdrawn here.
      await refreshMirror();

      if (inFlight === messageId) {
        log(
          `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn while it was already being sent - the peers` +
            ' will have it, so the delete has to travel as an event'
        );
        return false;
      }
      log(`[OUTBOX] ${messageId.slice(0, 8)}… withdrawn from the queue before it was ever sent`);
      return true;
    },

    flush(): Promise<void> {
      return runFlush();
    },

    retryUpload(messageId: string): void {
      // Skip the backoff for this entry (the one `resuming` already exists for) and, when its
      // transfer is on the wire and stalled, abandon it: the flush then restarts it at once.
      resuming.add(messageId);
      parked.delete(messageId);
      // A 403-parked entry used to ignore this button for the controller's whole life.
      forbiddenParked.delete(messageId);
      const running = uploads.get(messageId);
      if (running) running.abort('retry');
      else runFlush();
    },

    async applyPendingStatuses(): Promise<void> {
      if (!storage) return;
      const entries = await readQueue('pending statuses');
      for (const entry of entries) {
        const found = findMessage(entry.id);
        // Only (re)apply 'pending'; do not clobber a live 'sending' transition.
        if (found && found.convo.messages[found.idx].status !== 'sending') {
          patchStatus(entry.id, 'pending');
        }
      }
    },

    dispose(): void {
      for (const running of uploads.values()) running.abort('cancel');
      uploads.clear();
      clearAllUploads();
      if (backoffTimer) clearTimeout(backoffTimer);
      backoffTimer = null;
      unsubscribeTabOutbox();
      unsubscribeReconnect();
      if (typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    },
  };
}

// ── Registry (module singleton, mirrors mlsStatePersisterRegistry) ────────────

let active: OutboxController | null = null;

/** Register the session's outbox controller, replacing and disposing any previous one. */
export function registerOutbox(deps: OutboxDeps): OutboxController {
  active?.dispose();
  // The prompt resume needs the store to be able to ask the server whether it is back (WP-OFF-6).
  installReachabilityProbe();
  active = createOutbox(deps);
  const controller = active;
  setUploadRetry((messageId) => controller.retryUpload(messageId));
  return active;
}

/** Tear down the active controller (logout). */
export function unregisterOutbox(): void {
  active?.dispose();
  setUploadRetry(null);
  active = null;
}

/** The active controller, or null when logged out. */
export function getOutbox(): OutboxController | null {
  return active;
}

/**
 * Trigger a flush on the active controller (no-op when none).
 *
 * **EIGHT SITES RAISE A FLUSH AND THERE IS ONE FLUSHER - A SWEEP COUNTING SITES WILL FLAG THIS
 * AGAIN.** It was flagged once, as a duplicate path ("6 triggers, 8 sites"), and REFUTED on
 * 2026-09-13 on every axis. The refutation is written here rather than deleted with the row,
 * because the count that raised it is accurate and says nothing.
 *
 * Every one of them funnels into `runFlush`, which is where all the gates live and the only place
 * they live: the tab election, the leader gate, `connectivity.isOffline`, `canFlush`, and the
 * the per-conversation lanes coalescer. There is no second flusher to fuse this with. FIVE sites are
 * internal wake-ups, each bound to the one condition it is the seam for - `connectivity.onReconnect`,
 * `visibilitychange`, a follower tab's `outbox_flush_request`, the backoff timer, and `enqueue`.
 * THREE are external moments nothing inside this module can observe:
 *
 * | Site | The moment, and why nothing in here sees it |
 * | --- | --- |
 * | `promoteOfflineSession` step 4 | a session unlocked offline now has a token AND a socket |
 * | `sessionAuth`'s `onGroupReady` | one GROUP became sendable; the network never changed |
 * | `sessionAuth` after `initializeConnection` | login finished, which is not a reconnection |
 *
 * **THE FUSION THAT LOOKS OBVIOUS IS A REGRESSION, AND IT IS THE FIRST THING ANYONE WILL REACH
 * FOR.** `connectivity.onReconnect` binds a flush to `isOffline` clearing, so binding one to
 * `canFlush` opening reads as the same move - and it would fire at `promoteOfflineSession`'s step 1,
 * where the token is set, THREE steps before `initializeConnection` gives it a socket. Every entry
 * would burn an attempt and a longer backoff on a send that never had a chance, which is the exact
 * defect `canFlush` was added to prevent. **A gate answers "may I send", a trigger answers "now",
 * and only the promotion knows the second.**
 *
 * `outbox.test.ts` drives all five internal triggers plus this one over a single table, and a
 * source check pins the three external sites, so a fourth has to be argued for rather than added.
 */
export function flushOutbox(): void {
  void active?.flush();
}

/** Enqueue a message on the active controller. Rejects with {@link OutboxEnqueueError} when it cannot. */
export function enqueueOutboxMessage(
  entry: OutboxEntry,
  opts?: { alreadyDurable?: boolean }
): Promise<void> {
  if (!active) {
    return Promise.reject(new OutboxEnqueueError('no active outbox controller'));
  }
  return active.enqueue(entry, opts);
}

/**
 * Whether the durable queue still holds `messageId`. `null` when that cannot be known (no controller,
 * unreadable queue) - an unknown is never reported as an absence.
 */
export function isOutboxEntryQueued(messageId: string): Promise<boolean | null> {
  return active ? active.hasEntry(messageId) : Promise.resolve(null);
}

/**
 * Withdraw a queued message on the active controller. `false` when there is no controller, which
 * reads as "not cancelled" - the safe answer, since it sends the delete as an event instead.
 */
export function cancelOutboxMessage(messageId: string): Promise<boolean> {
  return active ? active.cancelPending(messageId) : Promise.resolve(false);
}

/** Mark loaded messages still queued as `pending` (no-op when none). */
export function applyOutboxPendingStatuses(): Promise<void> {
  return active ? active.applyPendingStatuses() : Promise.resolve();
}
