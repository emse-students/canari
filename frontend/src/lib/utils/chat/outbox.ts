import type { SvelteMap } from 'svelte/reactivity';
import { bumpOutboxQueueVersion } from './outboxActivity.svelte';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, OutboxEntry } from '$lib/db';
import type { OutboxResumableUpload, PendingGroupExit } from '$lib/db/types';
import { owedFor } from '$lib/utils/chat/pendingGroupExits';
import { OutboxPayloadUnreadableError } from '$lib/db/outboxCodec';
import {
  OutboxBlobCorruptError,
  OutboxBlobMissingError,
  OutboxBlobWriteError,
} from '$lib/db/outboxBlob';
import type { AddMessageToChatOptions, ChatMessage, Conversation } from '$lib/types';
import type { MediaRef } from '$lib/media';
import { recordOwnAuthorship, type RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import {
  decodeAppMessage,
  encodeAppMessage,
  mediaEncodingProtoField,
  mediaReelProtoFields,
  mediaKindToType,
  mediaPlaceholderProtoField,
  mkMedia,
  mkReply,
  mkText,
} from '$lib/proto/codec';
import { serializeEnvelope, mkMediaEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import { quotePreviewEntitled, type PlaceableMessage } from './historyEntitlement';
import { fromHex } from '$lib/utils/hex';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { m } from '$lib/paraglide/messages';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { uploadRefusalCause } from '$lib/utils/mediaErrors';
import { logMlsMetric } from '$lib/mls-client/mlsRecoveryMetrics';
import { classifyOutgoingSendError } from '$lib/mls-client/mlsSendError';
import { awaitsReAdmission, recordEviction } from '$lib/utils/chat/eviction';
import { findConversationKeyByGroupId } from '$lib/utils/chat/conversations';
import { syncOutboxMirror } from '$lib/utils/chat/outboxMirror';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { installReachabilityProbe } from '$lib/utils/reachabilityProbe';
import {
  ExclusionsRefusedError,
  GroupDeletedError,
  SendEdgeRefusedError,
  SenderNotActiveError,
  SendServerError,
  type SentFrame,
} from '$lib/mls-client/mlsDeliveryApi';
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
  publishOutboxEntryFailed,
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
 * CONSECUTIVE 5xx answers after which a text (or reply) is parked as FAILED, with a Retry, instead of
 * climbing the ladder for ever (user, 2026-10-18). Each counted 5xx is held at least
 * {@link SERVER_ERROR_HOLD_MS}, so that is at least four minutes of a server answering errors. Counted in the durable row (`OutboxEntry.serverErrors`), so a
 * reload keeps the run; any other ANSWER, a success or the member's retry resets it, and a transport
 * failure - nobody answered - neither counts nor resets. Attachments and controls (reactions, edits,
 * deletes, pins, read marks) are not bounded by it.
 */
export const MAX_CONSECUTIVE_SERVER_ERRORS = 5;

/**
 * The SHORTEST hold after a counted 5xx: the ladder's top step. On the plain ladder five 5xx land at
 * about 0, 2, 7, 22 and 52 s, so a deploy whose container restarts for a minute (the edge answers 502
 * meanwhile) failed every text sent during it. Held here, five in a row span at least four minutes.
 */
export const SERVER_ERROR_HOLD_MS = 60_000;

/** The longest a server's `Retry-After` may hold a text: a header is not a reason to wait for ever. */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * The hold after the `attempts`-th attempt failed with a COUNTED 5xx: the ladder's own step, raised
 * to {@link SERVER_ERROR_HOLD_MS}, and to the server's `Retry-After` when it sent one (capped at
 * {@link MAX_RETRY_AFTER_MS}). Still a ladder step - the entry's own clock - never a deadline.
 */
export function serverErrorHoldMs(attempts: number, retryAfterMs: number | null): number {
  return Math.max(
    backoffFor(attempts),
    SERVER_ERROR_HOLD_MS,
    Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)
  );
}

/** The kinds {@link MAX_CONSECUTIVE_SERVER_ERRORS} applies to: a message the member typed. */
function boundedOnServerErrors(entry: OutboxEntry): boolean {
  return entry.kind === 'text' || entry.kind === 'reply';
}

/**
 * True when `entry` reached its terminal 5xx state ({@link MAX_CONSECUTIVE_SERVER_ERRORS}) and waits
 * for the member's retry. Read from the DURABLE count, so every reader - the flusher after a reload,
 * the status pass, the native mirror - takes the same decision.
 */
export function isServerFailureTerminal(entry: OutboxEntry): boolean {
  return boundedOnServerErrors(entry) && (entry.serverErrors ?? 0) >= MAX_CONSECUTIVE_SERVER_ERRORS;
}

/**
 * True when the server (or something in front of it) ANSWERED the attempt, read from the TYPE: a
 * status-carrying refusal, `sender_not_active`, an edge refusal, a 410. A transport failure and a
 * local error are not answers.
 */
function isSendAnswer(e: unknown): boolean {
  return (
    refusalStatus(e) !== null ||
    e instanceof SenderNotActiveError ||
    e instanceof SendEdgeRefusedError ||
    e instanceof GroupDeletedError
  );
}

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
 * The raw take of a queued chat reel could not be PREPARED (reels-in-chat RC-5): the encoder refused
 * it, or the prepared file could not be stored. Not an answer and not the link: the entry is parked
 * as failed with the take KEPT, so the member's retry prepares it again and a delete withdraws it.
 */
export class OutboxPrepareError extends Error {
  constructor(why: string, cause?: unknown) {
    super(why, { cause });
    this.name = 'OutboxPrepareError';
  }
}

/**
 * The preparer REFUSED this take for good (RC-5): a fact of the file or of this engine - unreadable,
 * too long, a codec the engine cannot handle - that a new preparation of the same take on the same
 * device answers the same way. Thrown by the PREPARER, classified at its throw; the outbox fails the
 * entry for good with `notice` (a Paraglide sentence the preparer chose) instead of parking a
 * retry that cannot succeed.
 */
export class OutboxPrepareRefusedError extends Error {
  constructor(
    readonly notice: string,
    cause?: unknown
  ) {
    super('the take was refused by its preparer', { cause });
    this.name = 'OutboxPrepareRefusedError';
  }
}

/** What a preparation hands back: the bytes to upload, and what the message says about them. */
export interface PreparedOutboxMedia {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/**
 * A row patch that touches the media DESCRIPTION only. The bytes (`fileBytes`) would make the store
 * re-write the blob, and a `blob` ref held in memory may be older than the one the row names (the
 * prepared file replaced the raw take) - so both are dropped and the store keeps its own.
 */
function mediaDescriptionPatch(
  media: NonNullable<OutboxEntry['media']>,
  extra: Partial<NonNullable<OutboxEntry['media']>>
): Partial<OutboxEntry> {
  const { fileBytes: _bytes, blob: _blob, ...rest } = media;
  return { media: { ...rest, ...extra } };
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
 * True when an enqueue failed because the device is out of storage (the attachment's blob was
 * refused with `QuotaExceededError`): the one enqueue failure a member can act on, read from the
 * TYPE of the cause chain and never from a message.
 */
export function isEnqueueQuotaFailure(e: unknown): boolean {
  return (
    e instanceof OutboxEnqueueError && e.cause instanceof OutboxBlobWriteError && e.cause.quota
  );
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

/** The author proofs a stored row carries, which only the stored row holds. */
interface StoredProofs {
  authorship?: RecordedAuthorship;
  editProof?: RecordedAuthorship;
  deleteProof?: RecordedAuthorship;
  restoredUnverified?: boolean;
}

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

/**
 * Who withdrew a queued entry. A withdrawn entry whose send then FAILS is over whatever the cause,
 * but what that means differs: the author deleted it (`user`), a newer read mark replaced it
 * (`superseded`), the group is being left or deleted (`exit`), or another tab withdrew it.
 */
export type WithdrawReason = 'user' | 'superseded' | 'exit' | 'other-tab';

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
  /**
   * Encrypt + upload a queued media file, returning the server media ref (queued-media flush).
   * `resume.persist` durably records a resumable session's state (`media.upload`) before its first
   * part leaves, so a relaunch resumes it; an uploader that does not resume never calls it.
   */
  uploadMedia?: (
    media: NonNullable<OutboxEntry['media']>,
    transport?: XhrUploadOptions,
    resume?: { persist: (state: OutboxResumableUpload) => Promise<void> }
  ) => Promise<MediaRef>;
  /**
   * Prepares the RAW take of an entry marked `media.prepare` (a chat reel, RC-5): runs inside the
   * upload task, holding its upload slot, cancellable through `signal`. Rejects with
   * `UploadAbortedError` on a cancel, {@link OutboxPrepareRefusedError} when the take can NEVER be
   * prepared here (failed for good), anything else when this attempt failed (parked, retryable).
   */
  prepareMedia?: (
    media: NonNullable<OutboxEntry['media']>,
    opts: { signal: AbortSignal; onProgress: (fraction: number) => void }
  ) => Promise<PreparedOutboxMedia>;
  /**
   * Gives back the resumable upload session `uploadId` of an entry the member WITHDREW (RC-5), so
   * its staged parts, its slot among the owner's four open sessions and its budget are not held for
   * the server's 24 h sweep. Best effort: resolves either way and logs what happened.
   */
  releaseUpload?: (uploadId: string, why: string) => Promise<void>;
  /**
   * True when the session is in a state where sending can succeed. Returns false for a session
   * unlocked offline that has no access token yet: the browser can report `online` before the
   * token is reissued, and a flush in that window fails every entry for a reason that has nothing
   * to do with the entry. `promoteOfflineSession` flushes explicitly once it is ready.
   */
  canFlush?: () => boolean;
}

/**
 * An entry of which only the NEWEST per conversation needs to be sent - a read watermark, merged as
 * `max` on every receiver. See history-reconciliation, "The sender says only what is new".
 */
export interface LatestWins {
  /** What this entry carries; larger is newer. */
  value: number;
  /** What a queued entry carries when it is of the same kind, else null (it is left alone). */
  valueOf: (queued: OutboxEntry) => number | null;
}

/** Options of {@link OutboxController.enqueue}. */
export interface EnqueueOptions {
  /**
   * The row reached disk in the transaction that wrote the message it echoes
   * ({@link IStorage.saveMessageWithOutboxEntry}), so only the live half - the mirror and the flush
   * - is still owed.
   */
  alreadyDurable?: boolean;
  /**
   * Supersede the unsent entries of the same kind in the same conversation: not queued at all when one
   * of them already covers it, otherwise written FIRST and the older ones withdrawn after.
   */
  latestWins?: LatestWins;
}

/** Public surface of the per-session outbox controller. */
export interface OutboxController {
  /** Persist a queued message and schedule a flush. */
  enqueue: (entry: OutboxEntry, opts?: EnqueueOptions) => Promise<void>;
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
   * Settles one conversation's queue before this device leaves or deletes it, and resolves only once
   * nothing of it is queued or on the wire.
   *
   * Once the server has ended the membership no entry of the group can be delivered - its POST is
   * answered 403 and it would sit parked until the next sign-in, for a group this device no longer
   * holds (GRP-6, 2026-10-22: a read watermark queued as the leaver closed the conversation, refused
   * 54 ms after the leave). So the exit calls this BEFORE its server step:
   *  1. a lane already running for the group is AWAITED, so a send in flight settles first;
   *  2. the exit claims the lane, and drains it - the membership and the MLS state still exist, so
   *     a text written just before leaving is sent rather than dropped;
   *  3. what could not be sent (offline, held, backing off, an upload still running) is withdrawn
   *     under the same claim, and logged by kind as lost.
   * An ALLOWLIST by construction: only rows whose `conversationId` is exactly `conversationId`.
   *
   * @returns how many entries were lost (withdrawn unsent).
   */
  drainForExit: (conversationId: string, exitKind: 'leave' | 'delete') => Promise<number>;
  /**
   * Whether the durable queue holds an entry for this message id: `true`/`false` from the light read
   * (no payload decode), `null` when the queue could not be read - which is NOT "absent".
   */
  hasEntry: (messageId: string) => Promise<boolean | null>;
  /** Drain the outbox. Gated on tab leadership here, not by the caller. Coalesces concurrent calls. */
  flush: () => Promise<void>;
  /**
   * ONE GROUP BECAME SENDABLE (a Welcome installed, an external join landed): every entry of it held
   * for that repair skips its backoff ONCE - the `resuming` mark a reconnect gives `transportHeld` -
   * and the queue is drained. An ALLOWLIST: only entries of `conversationId` whose last hold was the
   * group repair. A transport, 5xx or parked hold is about something a group becoming ready does not
   * change, and keeps its clock.
   */
  resumeGroup: (conversationId: string) => Promise<void>;
  /**
   * "Try this attachment again NOW" (a bubble's retry): skips its backoff, and abandons a transfer
   * that is on the wire but stalled. The bytes already sent are lost - the media route has no
   * offset - so a retry restarts the upload at zero; a chat reel's resumable session (RC-5) is the
   * exception, and sends only the parts the server does not hold.
   */
  retryUpload: (messageId: string) => void;
  /** Mark already-loaded messages whose id is still queued as `pending` (reload / history load). */
  applyPendingStatuses: () => Promise<void>;
  /** Stop the internal backoff timer. */
  dispose: () => void;
}

/**
 * Result of attempting to flush a single entry. `uploading`: an attachment whose UPLOAD is running
 * or owed (WP-OFF-9) - it holds back only what depends on it, never the rest of its conversation.
 */
type FlushOutcome = 'sent' | 'retry' | 'error' | 'skip' | 'gone' | 'parked' | 'uploading';

/** What a finished upload left the flusher: the server ref to send, or the failure to classify. */
type SettledUpload =
  | { ok: true; media: NonNullable<OutboxEntry['media']> }
  | { ok: false; error: unknown };

/** One attachment's transfer, running OUTSIDE its conversation's lane (WP-OFF-9). */
interface UploadTask {
  conversationId: string;
  /** `null` while the transfer runs. */
  settled: SettledUpload | null;
  /**
   * The upload ended and its message's send has not been tried yet: that ONE attempt is due at once,
   * whatever backoff the upload attempts left on the row. Cleared when it is tried, so a send that
   * then fails takes the ladder like any message (review of #2061).
   */
  sendDue: boolean;
}

/**
 * How many attachments may be on the wire at once, across conversations. Separate from
 * {@link MAX_CONCURRENT_SENDS} since WP-OFF-9: an upload no longer holds a send slot, so a big file
 * never keeps a text from the wire. Two, not more: on a weak uplink every extra body only makes each
 * of them finish later.
 */
export const MAX_CONCURRENT_UPLOADS = 2;

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
   *
   * ONE EXCEPTION, BY DESIGN (WP-OFF-9): an attachment whose UPLOAD runs or is owed does not hold its
   * successors - only what depends on it. Display order is `sentAt`, so it still sorts at its compose
   * time on every device; only the wire order changes.
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
   * Ids whose last attempt was HELD FOR THEIR GROUP (not sendable yet, or awaiting the Welcome of a
   * re-admission), with their conversation: the entries {@link OutboxController.resumeGroup} resumes
   * when that group becomes ready. In memory, like `transportHeld` and for the same reason.
   */
  const repairHeld = new Map<string, string>();
  /**
   * How many times each conversation was announced ready in this page life. Read at the gate and
   * again after a repair hold is written: a group that became ready BETWEEN the two - an external join
   * completed inside the `requestReAdd` this very attempt awaited, a Welcome processed meanwhile -
   * found nothing in `repairHeld` to resume, so the hold resumes itself. A count of events, not a clock.
   */
  const readyAnnouncements = new Map<string, number>();
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
   * The resumable session (RC-5) each entry's upload opened in THIS page life, by entry id - what a
   * withdrawal releases when the row's own record is missing (its write failed). The row's
   * `media.upload.uploadId` is the durable copy, read for an entry this page life never uploaded.
   */
  const openSessions = new Map<string, string>();
  /**
   * Consecutive ONLINE failures per attachment that are not a typed no-answer upload (see
   * {@link MAX_UNEXPECTED_ATTEMPTS}). In memory by design, like `noAnswer`: a reload, a manual retry
   * or a success starts the count again.
   */
  const unexpected = new Map<string, number>();
  /**
   * Texts parked on {@link MAX_CONSECUTIVE_SERVER_ERRORS}, so the accusing line is written once per
   * page life and a retry knows to reset the durable count. NOT the decision: that is the durable
   * `serverErrors`, so a retry taken in another tab un-parks the entry here too.
   */
  const serverFailed = new Set<string>();
  const lanes = new Map<string, Promise<void>>();
  /** Conversations whose running lane must look at the queue once more (an enqueue or wake-up arrived). */
  const laneRerun = new Set<string>();
  let activeSends = 0;
  const sendWaiters: Array<() => void> = [];
  /**
   * THE UPLOAD OF AN ATTACHMENT RUNS OUTSIDE ITS LANE (WP-OFF-9). The lane used to await the whole
   * transfer inside `flushOne`, holding the conversation AND a send slot: a text written behind a
   * 13 MB file on a weak link waited minutes for it. Now the lane STARTS the transfer and moves on;
   * only the small MLS send of the media message, once the upload has ended, takes the lane. One task
   * per entry id (checked and set with no await between them), so a file is never on the wire twice.
   */
  const uploadTasks = new Map<string, UploadTask>();
  /**
   * Attachments known to still owe their upload. Read at the backoff skip, where the light queue read
   * cannot say it: an attachment backing off on its UPLOAD does not hold its successors, one backing
   * off on its MLS send does. In memory: after a reload an unknown entry holds them until it is due
   * (60 s at most), once.
   */
  const uploadOwed = new Set<string>();
  let activeUploads = 0;
  const uploadWaiters: Array<() => void> = [];
  /** Attachments queued for an upload slot, not yet on the wire: a retry has nothing to restart. */
  const slotWaiting = new Set<string>();
  /** The wake-up of a lane that waits for its conversation's uploads to end (deferred, no clock). */
  const laneWake = new Map<string, () => void>();
  let disposed = false;
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
   *
   * Keyed to WHY it was withdrawn, because a send that then fails means a different thing for each:
   * see {@link WithdrawReason} and the failure branch at the top of `settleFailure`.
   */
  const cancelled = new Map<string, WithdrawReason>();

  /**
   * Conversations whose exit is draining them right now ({@link OutboxController.drainForExit}). A
   * lane of one of these does not wait for an upload to end: the exit is waiting on the lane, and an
   * attachment still uploading is what the drain then reports as lost.
   */
  const exiting = new Set<string>();

  /**
   * The ids inside `mlsService.sendMessage` right now.
   *
   * A cancellation is only a cancellation if it arrives before the frame does; past this point the
   * peers are getting the message whatever the queue says, and saying so is what lets the caller
   * fall back to a `delete_message` event instead of silently losing the delete.
   *
   * A SET, BECAUSE UP TO {@link MAX_CONCURRENT_SENDS} LANES SEND AT ONCE. It was one id, which the
   * last lane to start overwrote: a message deleted while it was on the wire in ANOTHER lane was
   * answered "never sent", and no `delete_message` went out - the peers kept it (review of #1887).
   */
  const inFlight = new Set<string>();

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
   * Forgets the `cancelled` ids whose row is gone, once NO lane is running. A lane walks a snapshot
   * of the queue, so an id may only be dropped when no snapshot can still hold it - and with no lane
   * running there is none. Without this the set kept one id per withdrawal for the session (every
   * superseded read watermark), copied into every tab by `outbox_entry_cancelled`.
   */
  function pruneCancelled(queued: OutboxEntry[]): void {
    if (lanes.size > 0 || cancelled.size === 0) return;
    const present = new Set(queued.map((e) => e.id));
    let forgotten = 0;
    for (const id of cancelled.keys()) {
      if (!present.has(id) && !inFlight.has(id)) {
        cancelled.delete(id);
        forgotten++;
      }
    }
    if (forgotten > 0) {
      log(`[OUTBOX] forgot ${forgotten} withdrawn id(s) whose row is gone and no lane holds`);
    }
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
      // A FOLLOWER NEVER FLUSHES, so it holds no snapshot to keep the id out of, and an id kept
      // here would only grow the set for the session. An undecided tab keeps it: it may be the
      // leader, and it reads its first snapshot only once the election is over.
      if (getTabLeadership() === 'follower') return;
      cancelled.set(event.messageId, 'other-tab');
      log(
        `[OUTBOX] ${event.messageId.slice(0, 8)}… cancelled by another tab - it will not be sent.`
      );
      return;
    }
    if (getIsTabLeader()) return;
    if (event.type === 'outbox_entry_failed') {
      log(
        `[OUTBOX] ${event.messageId.slice(0, 8)}… failed on 5xx in the leader tab - shown failed here`
      );
      showServerFailure(event.messageId, event.serverErrors);
      return;
    }
    patchStatus(event.messageId, 'sent');
    // A text this tab showed failed (and then retried elsewhere) keeps no `failed` view once sent.
    clearUpload(event.messageId);
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

  /** Record the server's receive time on a sent message in the reactive map; `persistSent` writes it. */
  function patchServerTimestamp(messageId: string, serverTimestamp: number): void {
    const found = findMessage(messageId);
    if (!found) return;
    const messages = [...found.convo.messages];
    messages[found.idx] = { ...messages[found.idx], serverTimestamp };
    conversations.set(found.key, { ...found.convo, messages });
  }

  /**
   * The author proofs the stored row already holds, so the full-row write below keeps them. A read
   * failure is logged and answers none: the row it would have kept is unreadable anyway.
   */
  async function storedProofs(messageId: string): Promise<StoredProofs> {
    if (!storage) return {};
    const row = await storage.getMessage(messageId, deviceKey()).catch((e: unknown) => {
      log(
        `[OUTBOX] ${messageId.slice(0, 8)}… stored row unreadable - its author proofs are not carried: ${String(e)}`
      );
      return null;
    });
    if (!row) return {};
    return {
      authorship: row.authorship ?? undefined,
      editProof: row.editProof ?? undefined,
      deleteProof: row.deleteProof ?? undefined,
      restoredUnverified: row.restoredUnverified,
    };
  }

  /**
   * Persist the sent message to the encrypted messages store under the live conversation key, with
   * THIS DEVICE'S OWN SIGNATURE on what it just sent (`own`): the message's proof for a message, the
   * edit's or the deletion's for a control frame, the reaction's on the reaction it set - so a
   * history bundle this device writes later proves its own words too.
   */
  async function persistSent(
    liveConvId: string,
    messageId: string,
    own?: { body: Uint8Array; proof: Uint8Array; control: boolean }
  ): Promise<void> {
    if (!storage) return;
    const found = findMessage(messageId);
    if (!found) return;
    const m = found.convo.messages[found.idx];
    const proofs = await storedProofs(messageId);
    let reactions = m.reactions;
    if (own) {
      const mine = recordOwnAuthorship(own.body, own.proof, liveConvId);
      if (!own.control) {
        proofs.authorship = mine;
      } else {
        const frame = decodeAppMessage(own.body);
        const event = frame?.system?.event;
        if (event === 'edit_message') proofs.editProof = mine;
        else if (event === 'delete_message') {
          // The original bytes go with the message; only the author's signed tombstone stays.
          proofs.deleteProof = mine;
          proofs.authorship = undefined;
          proofs.editProof = undefined;
        } else if (frame?.reaction) {
          const r = frame.reaction;
          reactions = reactions?.map((x) =>
            canonicalUserId(x.userId) === canonicalUserId(deps.userId) &&
            x.emoji === r.emoji &&
            (x.at ?? 0) === Number(r.at ?? 0)
              ? { ...x, proof: mine }
              : x
          );
        }
      }
    }
    // A full-row write, not a patch: `liveConvId` may differ from the key the optimistic row was
    // written under (the group was re-keyed mid-send), and a patch cannot move a row. So every
    // field the in-memory message still carries is written back rather than dropped - the proofs
    // included, which live only in the stored row.
    await storage
      .saveMessage(
        {
          id: m.id,
          conversationId: liveConvId,
          senderId: m.senderId,
          content: m.content,
          timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
          reactions,
          serverTimestamp: m.serverTimestamp,
          isDeleted: m.isDeleted,
          isEdited: m.isEdited,
          ...(m.editedAt ? { editedAt: m.editedAt.getTime() } : {}),
          ...(proofs.authorship ? { authorship: proofs.authorship } : {}),
          ...(proofs.editProof ? { editProof: proofs.editProof } : {}),
          ...(proofs.deleteProof ? { deleteProof: proofs.deleteProof } : {}),
          ...(proofs.restoredUnverified ? { restoredUnverified: true } : {}),
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

  /** This device's copy of the quoted message - in memory, else the store - or `null` if it holds none. */
  async function quotedCopy(messageId: string): Promise<PlaceableMessage | null> {
    const found = findMessage(messageId);
    if (found) return found.convo.messages[found.idx];
    if (!storage) return null;
    return storage.getMessage(messageId, deviceKey()).catch((e: unknown) => {
      // Unreadable is not absent: rethrown so the reply waits rather than losing its quote.
      log(`[OUTBOX] quoted ${messageId.slice(0, 8)}… unreadable from the store: ${String(e)}`);
      throw e;
    });
  }

  /**
   * The reply as it may leave: its quote text kept, or blanked when the quoted message falls inside
   * a current member's exclusion window (a Remove holds against a later re-add, user 2026-10-14) - a
   * reply reaches every current member live and its stored copy rides every later history bundle.
   *
   * Decided HERE, at the send, against the windows in force now - never when the reply is composed,
   * which would cost a round trip per reply and blank the quote for good when composed offline.
   * **A failed read THROWS** into the send's own catch, an ordinary transient failure: the reply
   * waits for the next attempt and is never blanked on a failure.
   *
   * **THE SERVER REFUSING THE READ (`ExclusionsRefusedError`, off the roster) IS NOT A VERDICT ON
   * THIS DEVICE.** The route refuses on the roster alone, the send on this device's row - a device
   * `active` but roster-less sends freely. So the read's refusal repairs nothing (the roster repair
   * forgets the tree, and a destructive repair waits for proof the state is broken): the frame
   * quotes by id only - what a reader of no window may safely carry - and the SEND decides. Accepted,
   * the reply went out id-only; refused `sender-not-active`, the send's own arm repairs on its own
   * proof (fourth review of #1878).
   *
   * A blank is permanent, so it is written to the entry and the echo - the stored copy is what a
   * later bundle carries - but only by `commit`, once the frame carrying it has been ACCEPTED: a
   * send that fails keeps the quote, and the next attempt decides again.
   */
  async function decideQuote(
    entry: OutboxEntry
  ): Promise<{ entry: OutboxEntry; commit: () => Promise<void> }> {
    const kept = { entry, commit: async () => {} };
    if (entry.kind !== 'reply' || !entry.replyTo?.preview) return kept;
    const quoted = await quotedCopy(entry.replyTo.id);
    let entitled: boolean;
    try {
      entitled = await quotePreviewEntitled(entry.conversationId, quoted, { mlsService, log });
    } catch (e) {
      if (!(e instanceof ExclusionsRefusedError)) throw e;
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… the server refused the exclusion windows of ${entry.conversationId.slice(0, 8)}… (not on its roster) - the reply quotes by id only, and the send decides whether this device is a member`
      );
      entitled = false;
    }
    if (entitled) return kept;
    const blanked: OutboxEntry = { ...entry, replyTo: { ...entry.replyTo, preview: '' } };
    return { entry: blanked, commit: () => persistBlankedQuote(blanked) };
  }

  /** Writes an accepted reply's blanked quote to its queue entry and its echo - see `decideQuote`. */
  async function persistBlankedQuote(blanked: OutboxEntry): Promise<void> {
    const entry = blanked;
    // A row withdrawn while its frame was on the wire is gone for good: saving it would put a
    // deleted message back in the queue (#1887's withdrawal).
    if (!cancelled.has(entry.id)) {
      await storage
        ?.saveOutboxEntry(blanked, deviceKey())
        .catch((e: unknown) =>
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… blanked quote not saved to the queue: ${String(e)}`
          )
        );
    }
    const found = findMessage(entry.id);
    if (found) {
      const echo = found.convo.messages[found.idx];
      const env = parseEnvelope(echo.content);
      const content =
        env.kind === 'text' && env.replyTo
          ? serializeEnvelope(mkTextEnvelope(env.text, { ...env.replyTo, content: '' }))
          : echo.content;
      const messages = [...found.convo.messages];
      messages[found.idx] = {
        ...echo,
        content,
        ...(echo.replyTo ? { replyTo: { ...echo.replyTo, content: '' } } : {}),
      };
      conversations.set(found.key, { ...found.convo, messages });
    }
  }

  /** Runs `fn` while holding one of {@link MAX_CONCURRENT_UPLOADS} slots, handed on like a send slot. */
  async function withUploadSlot<T>(
    id: string,
    signal: AbortSignal,
    fn: () => Promise<T>
  ): Promise<T> {
    if (activeUploads < MAX_CONCURRENT_UPLOADS) activeUploads++;
    else {
      // A CANCEL REACHES A TRANSFER STILL WAITING FOR ITS SLOT AT ONCE: the waiter leaves the queue
      // and the task settles now, not when an unrelated upload frees a slot (review of #2061).
      slotWaiting.add(id);
      log(`[OUTBOX] ${id.slice(0, 8)}… waits for an upload slot (${MAX_CONCURRENT_UPLOADS} busy)`);
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = (): void => {
            const at = uploadWaiters.indexOf(waiter);
            if (at !== -1) uploadWaiters.splice(at, 1);
            reject(new UploadAbortedError(signal.reason));
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          uploadWaiters.push(waiter);
        });
      } finally {
        slotWaiting.delete(id);
      }
    }
    try {
      return await fn();
    } finally {
      const next = uploadWaiters.shift();
      if (next) next();
      else activeUploads--;
    }
  }

  /** True while an attachment of `conversationId` is on the wire (or waiting for an upload slot). */
  function hasRunningUpload(conversationId: string): boolean {
    for (const task of uploadTasks.values()) {
      if (task.conversationId === conversationId && task.settled === null) return true;
    }
    return false;
  }

  /** Makes the lane of `conversationId` look at its queue again - started by a flush if none runs. */
  function wakeLane(conversationId: string): void {
    if (disposed) return;
    laneRerun.add(conversationId);
    const wake = laneWake.get(conversationId);
    if (wake) wake();
    else if (!lanes.has(conversationId)) void runFlush();
  }

  /**
   * Starts the transfer of a queued attachment OUTSIDE its lane and returns at once. When it ends -
   * whatever the outcome - the lane is woken, and THE LANE classifies the result, so a failure takes
   * exactly the dispositions it took when the lane awaited the upload itself. A withdrawal is the one
   * outcome settled here: the row is already gone, so no lane pass will ever meet the entry again.
   */
  function startUpload(queued: OutboxEntry, media: NonNullable<OutboxEntry['media']>): void {
    // THE BYTES TRAVEL IN A HOLDER THE TASK EMPTIES, never in a closure that keeps them for the
    // whole transfer: a raw take replaced by its prepared file must not stay alive beside it (two
    // copies of a 90 s video through a weak-link upload, on a phone). Every closure below lives in
    // `launchUpload`'s scope, which sees the entry WITHOUT its payload.
    launchUpload({ ...queued, media: undefined }, { media });
  }

  /** {@link startUpload}'s body, over an entry stripped of its payload (see there). */
  function launchUpload(
    entry: OutboxEntry,
    payload: { media?: NonNullable<OutboxEntry['media']> }
  ): void {
    const task: UploadTask = {
      conversationId: entry.conversationId,
      settled: null,
      sendDue: false,
    };
    uploadTasks.set(entry.id, task);
    const control = new AbortController();
    uploads.set(entry.id, control);
    uploadOwed.add(entry.id);
    log(
      `[OUTBOX] ${entry.id.slice(0, 8)}… upload started outside the lane of ${entry.conversationId.slice(0, 8)}…`
    );
    void withUploadSlot(entry.id, control.signal, () => uploadAttachment(entry, payload, control))
      .then(
        // The payload WITHOUT its bytes: nothing keeps a 13 MB file alive once it has left. It is
        // the payload as UPLOADED - a prepared reel's type, size and dimensions, not the raw take's.
        ({ ref, media: sent }): SettledUpload => ({
          ok: true,
          media: { ...sent, uploadedRef: ref, fileBytes: undefined, upload: undefined },
        }),
        (error: unknown): SettledUpload => ({ ok: false, error })
      )
      .then((settled) => {
        task.settled = settled;
        task.sendDue = settled.ok;
        // Uploaded: from now on its MLS send keeps lane order like any message's.
        if (settled.ok) uploadOwed.delete(entry.id);
        if (disposed) return;
        const abortedByCancel =
          !settled.ok &&
          settled.error instanceof UploadAbortedError &&
          settled.error.reason === 'cancel';
        // WITHDRAWN, whether the abort reached the transfer or the withdrawal landed after the body
        // left (during the ref write, with nothing left to abort): the row is gone, no lane pass will
        // meet it again, so the task forgets itself here or never (review of #2061).
        if (abortedByCancel || cancelled.has(entry.id)) {
          uploadTasks.delete(entry.id);
          uploadOwed.delete(entry.id);
          clearUpload(entry.id);
          // A session this transfer opened AFTER the withdrawal released what it knew (its init was
          // in flight then): released here, the one place that learns of it.
          if (!settled.ok) releaseSessionOf(entry.id, undefined, 'opened during its withdrawal');
          log(
            abortedByCancel
              ? `[OUTBOX] ${entry.id.slice(0, 8)}… upload cancelled - the transfer was aborted`
              : `[OUTBOX] ${entry.id.slice(0, 8)}… upload ended after its message was withdrawn - nothing will be sent`
          );
        } else {
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… upload ${settled.ok ? 'ended' : 'failed'} - its lane is woken to ${settled.ok ? 'send the message' : 'classify the failure'}`
          );
        }
        wakeLane(entry.conversationId);
      });
  }

  /**
   * Uploads a queued attachment and persists its server ref to the row BEFORE returning: a kill
   * after the upload must never upload the same file again. Runs inside an upload slot.
   */
  async function uploadAttachment(
    entry: OutboxEntry,
    payload: { media?: NonNullable<OutboxEntry['media']> },
    control: AbortController
  ): Promise<{
    ref: NonNullable<NonNullable<OutboxEntry['media']>['uploadedRef']>;
    media: NonNullable<OutboxEntry['media']>;
  }> {
    // Taken out of the holder: from here the local is the ONLY reference this task keeps, and it is
    // replaced by the prepared payload once a raw take is prepared.
    let media = payload.media!;
    payload.media = undefined;
    const uploadMedia = deps.uploadMedia;
    let uploaded: MediaRef;
    let attemptLoaded = 0;
    let hint: ReturnType<typeof setInterval> | null = null;
    try {
      if (!uploadMedia) {
        throw new LocalAttachmentError('the queued attachment has no uploader');
      }
      // Withdrawn (or retried) while it waited for a slot: nothing left the device.
      if (control.signal.aborted) throw new UploadAbortedError(control.signal.reason);
      logMlsMetric({ kind: 'outbox_upload_attempt', conversationId: entry.conversationId });
      patchUpload(entry.id, {
        phase: 'preparing',
        loaded: 0,
        total: 0,
        attempt: entry.attempts + 1,
        prepared: media.prepare ? 0 : undefined,
      });
      // A RAW TAKE IS PREPARED HERE, in the upload task (RC-5): its slot is held, a cancel reaches
      // the encoder, and the prepared file REPLACES the take on disk before a byte leaves.
      if (media.prepare) media = await prepareQueued(entry, media, control.signal);
      // The hint only: the transport abandons a dead transfer on its own, this says so earlier.
      // Started after the preparation, which moves no byte and is not a stall.
      let lastMoved = Date.now();
      hint = setInterval(() => {
        if (Date.now() - lastMoved > UPLOAD_STALL_HINT_MS)
          patchUpload(entry.id, { phase: 'stalled' });
      }, 2_000);
      const described = media;
      uploaded = await uploadMedia(
        media,
        {
          signal: control.signal,
          onProgress: ({ loaded, total }) => {
            lastMoved = Date.now();
            attemptLoaded = Math.max(attemptLoaded, loaded);
            patchUpload(entry.id, { phase: 'uploading', loaded, total });
          },
        },
        {
          // BEFORE THE FIRST PART LEAVES: a kill from here on resumes the same session.
          persist: async (state) => {
            log(
              `[OUTBOX] ${entry.id.slice(0, 8)}… resumable session ${state.uploadId?.slice(0, 8) ?? '(none)'}… recorded`
            );
            // Known in memory even when the row write below fails, so a withdrawal in this page life
            // still releases it.
            if (state.uploadId) openSessions.set(entry.id, state.uploadId);
            if (!storage) return;
            await storage
              .updateOutboxEntry(
                entry.id,
                mediaDescriptionPatch(described, { upload: state }),
                deviceKey()
              )
              // Not fatal: losing it costs a re-upload after a kill, never a wrong byte (the digest
              // in the state refuses to resume other bytes).
              .catch((e) =>
                log(
                  `[OUTBOX] ${entry.id.slice(0, 8)}… resumable session NOT recorded (a kill re-uploads): ${String(e)}`
                )
              );
          },
        }
      );
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
      if (hint) clearInterval(hint);
      uploads.delete(entry.id);
    }
    noAnswer.delete(entry.id);
    bestLoaded.delete(entry.id);
    unexpected.delete(entry.id);
    // Completed: nothing left on the server to release.
    openSessions.delete(entry.id);
    clearUpload(entry.id);
    const ref = {
      mediaId: uploaded.mediaId,
      key: uploaded.key,
      iv: uploaded.iv,
      ...(uploaded.encoding ? { encoding: uploaded.encoding } : {}),
    };
    // Persist the ref + drop the raw bytes BEFORE sending: a crash after upload must not re-upload.
    // (A resumable reel's session would answer a re-ask from its memo anyway; the ref is what saves
    // even that round trip.)
    await storage
      ?.updateOutboxEntry(
        entry.id,
        // `fileBytes: undefined` explicitly: a row of the pre-blob format holds its bytes inline,
        // and the merge would otherwise carry them over.
        mediaDescriptionPatch(media, { uploadedRef: ref, upload: undefined, fileBytes: undefined }),
        deviceKey()
      )
      // Losing this write means a crash before the send re-uploads the same file; the ref is kept
      // in memory by the task, so THIS page life still sends it without a second upload.
      .catch((e) => log(`[OUTBOX] ${entry.id.slice(0, 8)}… media ref not persisted: ${String(e)}`));
    return { ref, media };
  }

  /**
   * Prepares a queued RAW take (RC-5) and stores the prepared file in its place, returning the
   * payload to upload. THE TAKE IS NEVER LOST: the prepared bytes go to the blob slot the committed
   * row does not name, and only the row's rewrite makes them the entry's - a kill before that
   * prepares the take again, a kill after it uploads what was prepared.
   *
   * Throws `UploadAbortedError` on a cancel or a retry; passes the preparer's
   * {@link OutboxPrepareRefusedError} through unchanged (a refusal for good, which `settleFailure`
   * retires with its sentence); and throws {@link OutboxPrepareError} when this attempt could not
   * prepare the take or store the result - the take stays, parked with a retry.
   */
  async function prepareQueued(
    entry: OutboxEntry,
    raw: NonNullable<OutboxEntry['media']>,
    signal: AbortSignal
  ): Promise<NonNullable<OutboxEntry['media']>> {
    const id = entry.id.slice(0, 8);
    if (!deps.prepareMedia) throw new OutboxPrepareError('no preparer for a raw take');
    if (!raw.fileBytes?.length) {
      throw new LocalAttachmentError('the queued take holds no bytes to prepare');
    }
    log(`[OUTBOX] ${id}… preparing its ${raw.prepare} take (${raw.fileBytes.length} raw bytes)`);
    let prepared: PreparedOutboxMedia;
    try {
      prepared = await deps.prepareMedia(raw, {
        signal,
        onProgress: (fraction) => patchUpload(entry.id, { phase: 'preparing', prepared: fraction }),
      });
    } catch (e) {
      if (e instanceof UploadAbortedError) throw e;
      if (signal.aborted) throw new UploadAbortedError(signal.reason);
      // Refused for good: the preparer's own type, passed through for `settleFailure` to retire.
      if (e instanceof OutboxPrepareRefusedError) {
        log(
          `[OUTBOX] ${id}… its take was REFUSED by the preparer: ${String(e.cause).slice(0, 160)}`
        );
        throw e;
      }
      log(`[OUTBOX] ${id}… its take could NOT be prepared: ${String(e).slice(0, 160)}`);
      throw new OutboxPrepareError('the take could not be prepared', e);
    }
    if (signal.aborted) throw new UploadAbortedError(signal.reason);
    const next: NonNullable<OutboxEntry['media']> = {
      ...raw,
      prepare: undefined,
      upload: undefined,
      fileBytes: prepared.bytes,
      mimeType: prepared.mimeType,
      size: prepared.bytes.length,
      ...(prepared.fileName ? { fileName: prepared.fileName } : {}),
      ...(prepared.width ? { width: prepared.width } : {}),
      ...(prepared.height ? { height: prepared.height } : {}),
      ...(prepared.durationMs ? { durationMs: prepared.durationMs } : {}),
    };
    if (storage) {
      const { blob: _blob, ...withBytes } = next;
      try {
        // The bytes ARE in this patch: the store writes them to the other blob slot, then the row.
        await storage.updateOutboxEntry(entry.id, { media: withBytes }, deviceKey());
      } catch (e) {
        // NEVER UPLOAD BYTES THE ROW DOES NOT NAME: a kill after such an upload would prepare the
        // take again and send a second file under the same message.
        log(`[OUTBOX] ${id}… the prepared file could NOT be stored: ${String(e).slice(0, 160)}`);
        throw new OutboxPrepareError('the prepared file could not be stored', e);
      }
    }
    log(
      `[OUTBOX] ${id}… take prepared: ${raw.fileBytes.length} -> ${prepared.bytes.length} bytes (${prepared.mimeType}), stored in its place`
    );
    return next;
  }

  /**
   * Builds, from an uploaded attachment's ref, the proto to send and the real media envelope to
   * swap into the optimistic placeholder message.
   */
  function buildMediaMessage(
    entry: OutboxEntry,
    media: NonNullable<OutboxEntry['media']>,
    ref: NonNullable<NonNullable<OutboxEntry['media']>['uploadedRef']>
  ): { proto: Uint8Array; content: string } {
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
    cause: 'group-deleted' | 'evicted' | 'evicted-late' | 'too-large' | 'refused' | 'unpreparable',
    /** The thread line for `unpreparable`: the preparer's own Paraglide sentence. */
    notice?: string
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
    uploadTasks.delete(entry.id);
    uploadOwed.delete(entry.id);
    repairHeld.delete(entry.id);
    // THE ROW GOES, SO ITS SESSION GOES: nothing will resume it. A refusal for good (`too-large`,
    // `refused`) was already released by the uploader that met it.
    if (cause === 'too-large' || cause === 'refused') openSessions.delete(entry.id);
    else releaseSessionOf(entry.id, entry.media?.upload?.uploadId, cause);
    if (entry.kind !== 'control') {
      if (cause === 'too-large' || cause === 'refused' || cause === 'unpreparable') {
        // THE PERMANENT FAILURES THAT ARE ABOUT THE OBJECT, NOT THE GROUP: nothing about the
        // conversation changed, so no banner and no eviction - only a line in the thread that tells
        // the author which message will never go and what to do about it. Best-effort, and logged.
        const line =
          cause === 'too-large'
            ? m.outbox_upload_too_large()
            : cause === 'unpreparable' && notice
              ? notice
              : m.outbox_upload_refused();
        await deps
          .addMessageToChat?.('system', line, entry.conversationId, { isSystem: true })
          .catch((e: unknown) =>
            log(`[OUTBOX] ${entry.id.slice(0, 8)}… ${cause} notice not posted: ${String(e)}`)
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
    await storage
      ?.deleteOutboxEntry(entry.id)
      .catch((e: unknown) =>
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… permanently failed row NOT deleted: ${String(e).slice(0, 120)}`
        )
      );
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
   * `resumeOutboxGroup` the moment a Welcome or an external join completes, and every entry held
   * for that group (`repairHeld`, written here) skips the backoff written below ONCE. It used to call
   * `flushOutbox()`, which this docblock claimed was enough and was not: a flush respects
   * `nextAttemptAt`, so the held entry waited for its own timer, up to a minute (review,
   * 2026-10-31). The backoff below is what happens when the repair does NOT land, which is the only
   * case that was unbounded.
   */
  async function holdForRetry(
    entry: OutboxEntry,
    describe: (attempts: number) => string,
    opts: {
      transport?: boolean;
      repair?: boolean;
      local?: boolean;
      quiet?: boolean;
      /** The run of consecutive 5xx to record with the backoff (the 5xx arm only). */
      serverErrors?: number;
      /** The hold, when it is not the plain ladder's (`serverErrorHoldMs`, the 5xx arm only). */
      delayMs?: number;
    } = {}
  ): Promise<FlushOutcome> {
    if (opts.transport) transportHeld.add(entry.id);
    else transportHeld.delete(entry.id);
    if (opts.repair) repairHeld.set(entry.id, entry.conversationId);
    else repairHeld.delete(entry.id);
    // The count is of CONSECUTIVE local failures: any other kind of hold breaks the run.
    if (!opts.local) unexpected.delete(entry.id);
    patchStatus(entry.id, 'pending');
    // An attachment still to upload shows that its next attempt is queued (and starts from zero -
    // except a chat reel's resumable session, which resumes at the parts the server lacks).
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
          nextAttemptAt: Date.now() + (opts.delayMs ?? backoffFor(attempts)),
          ...(opts.serverErrors !== undefined ? { serverErrors: opts.serverErrors } : {}),
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
   * Holds an entry for its GROUP - not sendable yet, or awaiting the Welcome of a re-admission - so
   * that the group becoming ready resumes it ({@link OutboxController.resumeGroup}).
   *
   * `readySeen` is the group's ready count read at the gate. When it moved before the hold was
   * written, the announcement already ran and found this entry in no set: the hold is resumed here,
   * and the lane re-runs, so the entry goes in the same drain rather than at the end of its backoff.
   */
  async function holdForGroup(
    entry: OutboxEntry,
    readySeen: number,
    describe: (attempts: number) => string
  ): Promise<FlushOutcome> {
    const outcome = await holdForRetry(entry, describe, { repair: true });
    if ((readyAnnouncements.get(entry.conversationId) ?? 0) !== readySeen) {
      repairHeld.delete(entry.id);
      resuming.add(entry.id);
      laneRerun.add(entry.conversationId);
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… group ${entry.conversationId.slice(0, 8)}… became ready during this attempt - resumed at once`
      );
    }
    return outcome;
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
    repairHeld.delete(entry.id);
    unexpected.delete(entry.id);
    patchStatus(entry.id, 'pending');
    patchUpload(entry.id, { phase: 'error' });
    return 'parked';
  }

  /**
   * Shows a text the server failed {@link MAX_CONSECUTIVE_SERVER_ERRORS} times in a row as FAILED
   * (`error`, the bubble's Retry), and keeps it - nothing the user wrote is lost. Terminal until the
   * member retries: the decision is the durable count, so this runs again after a reload, and the
   * accusing line is written once per page life.
   */
  function parkServerFailure(entry: OutboxEntry, cause: string): FlushOutcome {
    if (!serverFailed.has(entry.id)) {
      const line = `[OUTBOX] ${entry.id.slice(0, 8)}… ${entry.kind} entry FAILED: ${cause} - parked as failed, Retry offered, entry kept`;
      console.error(line);
      log(line);
    }
    const first = !serverFailed.has(entry.id);
    serverFailed.add(entry.id);
    transportHeld.delete(entry.id);
    repairHeld.delete(entry.id);
    showServerFailure(entry.id, entry.serverErrors ?? 0);
    // A follower tab draws the same bubble: it never flushes, so it would not know until a reload.
    if (first) publishOutboxEntryFailed(entry.id, entry.serverErrors ?? 0);
    return 'parked';
  }

  /**
   * Draws a text failed on 5xx: status `error`, and the `failed` view that is how the bubble knows a
   * Retry exists for it (`retryUpload` is the one handler). ONE place for the three tabs' paths.
   */
  function showServerFailure(messageId: string, serverErrors: number): void {
    patchStatus(messageId, 'error');
    patchUpload(messageId, { phase: 'failed', attempt: serverErrors });
  }

  /**
   * The member's Retry of a text failed on 5xx, decided on the STORED row - not on this tab's
   * memory, which in a follower never saw the failure. The count AND the clock go back to zero
   * BEFORE the flush is raised, so whichever tab drains reads a text that is due and not failed.
   */
  async function resetServerFailure(messageId: string): Promise<void> {
    if (!storage) return;
    const stored = (await readQueue('retry')).find((e) => e.id === messageId);
    if (!stored || !isServerFailureTerminal(stored)) return;
    log(
      `[OUTBOX] ${messageId.slice(0, 8)}… failed text: retry asked, the 5xx count (${stored.serverErrors}) is reset`
    );
    clearUpload(messageId);
    patchStatus(messageId, 'pending');
    await storage
      .updateOutboxEntry(messageId, { serverErrors: 0, nextAttemptAt: 0 }, deviceKey())
      .catch((err: unknown) =>
        log(`[OUTBOX] ${messageId.slice(0, 8)}… 5xx count reset not persisted: ${String(err)}`)
      );
  }

  /** Writes a new consecutive-5xx count without touching the backoff. Logged when lost. */
  async function writeServerErrors(id: string, count: number): Promise<void> {
    await storage
      ?.updateOutboxEntry(id, { serverErrors: count }, deviceKey())
      .catch((err: unknown) =>
        log(`[OUTBOX] ${id.slice(0, 8)}… 5xx count ${count} not persisted: ${String(err)}`)
      );
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
    // THE MARK IS NOT CONSUMED HERE. The withdrawal's delete may still be pending, and a second
    // pass of this lane would re-read the row, find no mark and send it (review of #1887). The
    // mark is dropped by `pruneCancelled`, once the row is gone and no lane runs.
    if (cancelled.has(entry.id)) {
      clearUpload(entry.id);
      // An ended upload of a withdrawn message has nothing left to do; a running one forgets itself.
      if (uploadTasks.get(entry.id)?.settled) uploadTasks.delete(entry.id);
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… cancelled before it was sent - dropped, not delivered`
      );
      return 'gone';
    }

    // Consumed here, whether or not the backoff was still running, so a stale arming cannot outlive
    // the reconnect it came from.
    if (forbiddenParked.has(entry.id)) return 'skip';
    // ITS UPLOAD IS ON THE WIRE, OUTSIDE THE LANE (WP-OFF-9): nothing to do until it ends, and
    // nothing read - not the payload, not the group - on each pass a text enqueued meanwhile causes.
    const task = uploadTasks.get(entry.id);
    if (task && task.settled === null) return 'uploading';
    // ITS UPLOAD FAILED: classified HERE, in the lane, through the very path that classified it when
    // the lane awaited the transfer - a refusal, a give-up, a transport hold, a retry on request.
    if (task?.settled && !task.settled.ok) {
      uploadTasks.delete(entry.id);
      return uploadPhaseOutcome(
        await settleFailure(entry, entry.conversationId, task.settled.error)
      );
    }
    const resumed = resuming.delete(entry.id);
    // A manual retry (or a reconnect's resume) is a fresh start for the no-answer count.
    if (resumed) {
      noAnswer.delete(entry.id);
      bestLoaded.delete(entry.id);
      unexpected.delete(entry.id);
      // THE MEMBER'S RETRY of a text failed on 5xx: the retry wrote the count back to 0, and this
      // snapshot may predate that write. A reconnect's resume never reaches here (not `serverFailed`).
      if (serverFailed.delete(entry.id)) entry = { ...entry, serverErrors: 0 };
    }
    // PARKED IS NOT BLOCKING: the entry waits for the member, and what was written after it goes.
    if (!resumed && parked.has(entry.id)) return 'parked';
    parked.delete(entry.id);
    // FAILED ON 5xx, read from the DURABLE count: after a reload as well as in this page life.
    if (!resumed && isServerFailureTerminal(entry)) {
      return parkServerFailure(
        entry,
        `the server answered 5xx on ${entry.serverErrors} attempts in a row`
      );
    }
    // Reset elsewhere (a retry in another tab wrote the count back): it goes again, said once.
    if (serverFailed.delete(entry.id)) {
      clearUpload(entry.id);
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… failed text retried (count reset) - sending again`);
    }
    // AN UPLOAD THAT JUST ENDED makes its message due at once: the backoff on the row belonged to the
    // upload attempts before it, never to a send that has not been tried.
    // ONCE: the first attempt consumes it, so a send that fails after the upload keeps its backoff.
    const uploadEnded = task?.settled?.ok === true && task.sendDue;
    if (!resumed && !uploadEnded && entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… skipped, backing off for ${entry.nextAttemptAt - Date.now()}ms (attempt ${entry.attempts})`
      );
      // Backing off on its UPLOAD, an attachment holds only what depends on it (WP-OFF-9).
      return entry.kind === 'media' && uploadOwed.has(entry.id) ? 'uploading' : 'skip';
    }
    if (task) task.sendDue = false;

    // The MLS outbox is for DMs/groups only. A channel entry (server-authoritative, no MLS group)
    // can only have leaked in through a bug: it would loop forever on requestReAdd 500s. Drop it so
    // a stale entry cannot storm the delivery service.
    if (isChannelConversationId(entry.conversationId)) {
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… channel entry - dropped (channels do not use MLS)`);
      await storage?.deleteOutboxEntry(entry.id).catch(() => {});
      return 'error';
    }

    // ITS UPLOAD ENDED IN THIS PAGE LIFE: the task holds the payload, bytes dropped, with the ref to
    // send - so the row is not read a second time, and a ref whose row write failed is still sent
    // (that loss costs a second upload only after a kill).
    if (entry.kind === 'media' && task?.settled?.ok)
      entry = { ...entry, media: task.settled.media };

    // THE PAYLOAD OF AN ATTACHMENT IS READ HERE AND NOWHERE EARLIER: the queue read returns a media
    // entry as its scheduling columns only, because decoding the file is what froze a Pixel 6a once
    // per backoff (2026-10-10). Every skip above returns before this line, so an entry that is not
    // due costs a row of numbers - and a due one is decoded exactly once.
    if (entry.kind === 'media' && !entry.media) {
      try {
        // TIMED, because this read is where a 13 MB attachment's 'waiting' bubble was spent and no
        // line said how long it took (Mi 9T, alpha.4: ~60 s before the first progress).
        const readFrom = Date.now();
        const full = await storage?.getOutboxEntry(entry.id, deviceKey());
        if (full) {
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… payload read in ${Date.now() - readFrom} ms (${full.media?.fileBytes?.length ?? 0} file bytes)`
          );
        }
        if (!full) {
          // Withdrawn between the `cancelled` check above and this read - or between the row read
          // and the blob read inside it, which the storage layer re-asks before calling a missing
          // blob a lost attachment: consume it, like that check.
          cancelled.delete(entry.id);
          clearUpload(entry.id);
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… no longer queued - nothing to send`);
          return 'gone';
        }
        entry = full;
      } catch (e) {
        if (e instanceof OutboxPayloadUnreadableError) {
          // A blob the platform evicted (iOS WKWebView under storage pressure) or that no longer
          // opens is the attachment LOST on this device: said so, because "cannot be decrypted"
          // would send the reader after the PIN.
          const gone =
            e.cause instanceof OutboxBlobMissingError || e.cause instanceof OutboxBlobCorruptError;
          return parkAsError(
            entry,
            gone
              ? `its attachment is no longer readable on this device (${(e.cause as Error).name})`
              : `its payload cannot be decrypted (${String(e.cause).slice(0, 80)})`
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
    if (entry.kind === 'media' && entry.media && !entry.media.uploadedRef) uploadOwed.add(entry.id);

    const terminalId = entry.conversationId;
    // Read BEFORE the gate: a ready announcement landing after it finds this entry in no set yet.
    const readySeen = readyAnnouncements.get(terminalId) ?? 0;
    const sendable = deps.isGroupHealthy(terminalId);

    // GROUP DELETED SERVER-SIDE - ASKED ONLY WHERE THE ANSWER CHANGES WHAT HAPPENS NEXT.
    //
    // `GET /api/mls/groups/:id` was asked before EVERY send, and on a text reply it was the largest
    // single step of the flush: 148-245 ms of a ~450 ms flush on the Mi 9T (2026-10-12, dev), one
    // full round trip before the encrypt. For a sendable group the POST asks the same question
    // atomically - the delivery service refuses a deleted group with a typed 410
    // (`GroupDeletedError`, the `group-deleted` arm in the catch below), which reaches the same
    // `failPermanently` with the same cause - and the pre-flight could never be the whole answer
    // anyway, since a deletion can land inside its round trip. So it is asked where the POST is NOT
    // the next step:
    //  - an unsendable group goes to the re-add below, which never reaches the server's refusal: a
    //    deleted group there would be re-added for ever instead of retired;
    //  - a media entry uploads its file before the POST, and a deleted group must not cost that.
    //    Once uploaded, its POST is the next step and answers the question itself.
    if (!sendable || (entry.kind === 'media' && !entry.media?.uploadedRef)) {
      const groupMeta = await mlsService.getGroupMeta(terminalId).catch((e: unknown) => {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… group ${terminalId.slice(0, 8)}… unreadable before the send (${String(e).slice(0, 80)}) - the send path decides`
        );
        return null;
      });
      if (groupMeta?.deletedAt) {
        return failPermanently(entry, terminalId, 'group-deleted');
      }
    }

    // Group not sendable yet: trigger recovery (external join / welcome_request) and retry later.
    // Logged because this branch holds a message back indefinitely while reporting nothing: a
    // conversation stuck here looks, from the outside, exactly like a message that was delivered.
    if (!sendable) {
      await deps
        .requestReAdd(terminalId)
        .catch((e) =>
          log(`[OUTBOX] Re-add request for ${terminalId.slice(0, 8)}… failed: ${String(e)}`)
        );
      // Through `holdForRetry`, which is what this branch did not do: it returned `'retry'` having
      // written nothing, so the entry had neither a clock of its own nor a count of how long it had
      // been held. See that function for what each of the two fields actually decides.
      return holdForGroup(
        entry,
        readySeen,
        (attempts) =>
          `[OUTBOX] ${entry.id.slice(0, 8)}… held: group ${terminalId.slice(0, 8)}… not sendable, re-add requested (attempt ${attempts})`
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
      // OUT OF THE GROUP, AND WAITING TO BE LET BACK IN - NOT EVICTED. A re-admission is a Remove and
      // then an Add, three seconds apart, and the Remove half leaves exactly this state: the group
      // held, the epoch gap cleared, `isGroupActive` false. `retireIfEvicted` already read
      // `reAddInFlight` when that Remove merged and wrote the row `pending` instead of `removed`
      // (`markAwaitingReAdmission`), so the fact is in the durable row before anything is sent - and
      // failing the entry here retired the conversation and lost the message three seconds before
      // the Welcome re-admitted the device (review, 2026-10-31). Held like a group not sendable yet,
      // with no re-add asked: one is in flight, and `requestReAdd` stands down on a held group anyway.
      // The Welcome resumes it (`resumeGroup`).
      const key = findConversationKeyByGroupId(conversations, terminalId);
      if (awaitsReAdmission(key ? conversations.get(key) : undefined)) {
        return holdForGroup(
          entry,
          readySeen,
          (attempts) =>
            `[OUTBOX] ${entry.id.slice(0, 8)}… held: group ${terminalId.slice(0, 8)}… awaits the Welcome of this device's re-admission (attempt ${attempts})`
        );
      }
      return failPermanently(entry, terminalId, 'evicted');
    }

    patchStatus(entry.id, 'sending');
    logMlsMetric({ kind: 'outbox_flush_attempt', conversationId: terminalId });

    // An attachment that still owes its upload: what fails before the transfer starts is an upload
    // failure too, and holds back only what depends on it.
    let uploadPhase = false;
    try {
      // Media: start the upload OUTSIDE the lane, or - once it ended - build proto + envelope.
      let proto: Uint8Array;
      let mediaContent: string | undefined;
      // What an accepted frame makes permanent (a blanked quote); nothing for any other entry.
      let commitQuote: () => Promise<void> = async () => {};
      if (entry.kind === 'media') {
        const media = entry.media;
        if (!media) throw new LocalAttachmentError('the queued attachment has no payload');
        if (!media.uploadedRef) {
          uploadPhase = true;
          if (!deps.uploadMedia) throw new Error('uploadMedia callback not provided');
          if (!media.fileBytes || media.fileBytes.length === 0) {
            throw new LocalAttachmentError('the queued attachment holds no bytes to upload');
          }
          // CHECK AND CLAIM WITH NO AWAIT BETWEEN THEM (the running-task check at the top is many
          // awaits back): two passes of one lane must never start two transfers of one file.
          if (uploadTasks.get(entry.id)?.settled === null) return 'uploading';
          startUpload(entry, media);
          return 'uploading';
        }
        const prepared = buildMediaMessage(entry, media, media.uploadedRef);
        proto = prepared.proto;
        mediaContent = prepared.content;
        // The upload has completed, so the blob is readable before MLS acknowledges the message.
        // Replace the optimistic empty ref now; waiting for sendMessage leaves media at `''` during
        // the whole network race and a renderer that observed that state stays on its skeleton.
        updateMessageContent(entry.id, mediaContent);
      } else {
        const decided = await decideQuote(entry);
        commitQuote = decided.commit;
        proto = buildOutboxProto(decided.entry) ?? new Uint8Array(0);
      }

      // LAST LOOK, WITH NO AWAIT BEFORE THE CLAIM. The check at the top of this function is many
      // awaits back (the health gate, `isGroupActive`, an upload): a withdrawal landing in between
      // was answered "never sent" and the frame went out anyway (review of #1887). From here on the
      // id is in `inFlight`, which every withdrawal reads, so the two can no longer both miss.
      if (cancelled.has(entry.id)) {
        clearUpload(entry.id);
        log(`[OUTBOX] ${entry.id.slice(0, 8)}… withdrawn just before the send - not delivered`);
        return 'gone';
      }
      // HELD UNTIL THE SENT ROW IS DELETED, NOT ONLY WHILE THE POST RUNS. A sent row stays queued
      // through `persistSent` and its own delete, and a withdrawal reading it there was answered
      // "never sent" for a frame the peers already had - so no `delete_message` went out.
      inFlight.add(entry.id);
      try {
        const sent: SentFrame = await mlsService.sendMessage(
          terminalId,
          proto,
          entry.id,
          deliveryForOutboxEntry(entry)
        );
        // A KNOWN CRASH WINDOW, AND WHY IT IS ACCEPTED: a kill between the accepted send and this
        // write leaves the local entry and echo with the quote text the frame did not carry. The
        // text is this device's own (it was decrypted here), so nothing reaches anyone who was out;
        // only this device keeps showing it. The window is one storage write wide
        // (history-reconciliation).
        await commitQuote();
        // THE SENDER'S OWN COPY GETS THE SERVER TIME every recipient's copy carries. A sender never
        // receives its frame back, so this answer is the only place it can come from - and an
        // undated copy cannot be placed against an exclusion window (a Remove holds against a later
        // re-add, user 2026-10-14). A control frame is not a message: its entry id names the
        // message it mutates, whose own time must not move.
        if (entry.kind !== 'control') {
          if (sent.receivedAt !== null) patchServerTimestamp(entry.id, sent.receivedAt);
          else log(`[OUTBOX] ${entry.id.slice(0, 8)}… sent, the server answered no receive time`);
        }
        // The media envelope was installed immediately after upload, before the MLS send.
        await persistSent(terminalId, entry.id, {
          body: proto,
          proof: sent.authorProof,
          control: entry.kind === 'control',
        });
        patchStatus(entry.id, 'sent');
        clearUpload(entry.id);
        transportHeld.delete(entry.id);
        repairHeld.delete(entry.id);
        unexpected.delete(entry.id);
        uploadTasks.delete(entry.id);
        uploadOwed.delete(entry.id);
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
      } finally {
        inFlight.delete(entry.id);
      }
      logMlsMetric({
        kind: 'outbox_flush_success',
        conversationId: terminalId,
        latencyMs: Date.now() - entry.sentAt,
      });
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… sent in ${terminalId.slice(0, 8)}…`);
      return 'sent';
    } catch (e) {
      const outcome = await settleFailure(entry, terminalId, e);
      return uploadPhase ? uploadPhaseOutcome(outcome) : outcome;
    }
  }

  /**
   * An UPLOAD failure that is held for a retry holds back only what depends on the attachment
   * (WP-OFF-9): nothing of the message has left, so the text written after it may go. Every other
   * outcome - parked, refused, gone - already says what it is.
   */
  function uploadPhaseOutcome(outcome: FlushOutcome): FlushOutcome {
    return outcome === 'retry' ? 'uploading' : outcome;
  }

  /**
   * Classifies a failed attempt of `entry` - its MLS send, or its upload, which the lane receives
   * from the task that ran it outside the lane - and applies its disposition. ONE PATH FOR BOTH, so
   * an upload failure ends exactly as it did when the lane awaited the transfer itself.
   */
  async function settleFailure(
    entry: OutboxEntry,
    terminalId: string,
    e: unknown
  ): Promise<FlushOutcome> {
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
    // WITHDRAWN WHILE IT WAS ON THE WIRE: its row is already deleted, so no disposition below can
    // apply - there is nothing left to park, count or retry. Whatever the server answered, the entry
    // is over; the line says what that means for the reason it was withdrawn.
    const withdrawnAs = cancelled.get(entry.id);
    if (withdrawnAs) {
      clearUpload(entry.id);
      const answer = refusalStatus(e) ?? (e instanceof Error ? e.name : 'unknown');
      const meaning: Record<WithdrawReason, string> = {
        // The author's delete already went as an event (the withdrawal answered "maybe sent"), and
        // it is harmless now: the members never got the frame it deletes.
        user: 'deleted by its author while on the wire, and the send failed - the members never got it',
        superseded:
          'superseded while on the wire, and the send failed - the newer entry carries it',
        exit: 'withdrawn by the group exit while on the wire, and the send failed - the group is being left',
        'other-tab': 'withdrawn by another tab while on the wire, and the send failed',
      };
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… ${meaning[withdrawnAs]} (${answer}) - dropped`);
      return 'gone';
    }
    // ANY OTHER ANSWER BREAKS A RUN OF 5xx, so the count is truly consecutive. A transport failure is
    // not an answer and leaves it as it is.
    if (!(e instanceof SendServerError) && isSendAnswer(e) && (entry.serverErrors ?? 0) > 0) {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… answered ${refusalStatus(e) ?? (e as Error).name} after ${entry.serverErrors} 5xx in a row - the run is reset`
      );
      await writeServerErrors(entry.id, 0);
      entry = { ...entry, serverErrors: 0 };
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
    // THE SERVER SAYS THE GROUP IS GONE. For a sendable text or control entry this is where a
    // deletion is learnt at all (no pre-flight is asked, see above); for a media entry it is a
    // deletion that landed after the pre-flight read the group as alive. The same permanent
    // disposition either way - one `cause`, so a reader cannot tell the seams apart and does not
    // have to.
    if (kind === 'group-deleted') {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… send REFUSED: ${terminalId.slice(0, 8)}… is deleted on the server (410 on this frame)`
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
      repairHeld.delete(entry.id);
      patchStatus(entry.id, 'pending');
      patchUpload(entry.id, { phase: 'failed' });
      return 'parked';
    }
    // THE TAKE COULD NOT BE PREPARED (RC-5): the encoder refused it, or its result could not be
    // stored. About this device and this file, never the link - so no ladder; the take is KEPT and
    // the member retries (a new preparation) or deletes.
    if (e instanceof OutboxPrepareError) {
      return parkAsError(entry, `${e.message} (${String(e.cause).slice(0, 120)})`);
    }
    // REFUSED BY THE PREPARER, a fact of the file or the engine (too long, unreadable, a codec it
    // cannot encode): another preparation answers the same, so a retry button would be a lie. Failed
    // for good, with the preparer's own sentence in the thread.
    if (e instanceof OutboxPrepareRefusedError) {
      return failPermanently(entry, terminalId, 'unpreparable', e.notice);
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
    // A 5xx ON A TEXT IS COUNTED, read from the TYPE (`SendServerError`, typed at the throw): the
    // Nth in a row parks it as failed (user, 2026-10-18). The count is written BEFORE the park, so a
    // reload finds the same terminal state. Media and controls keep the uncounted ladder below.
    if (e instanceof SendServerError && boundedOnServerErrors(entry)) {
      const count = (entry.serverErrors ?? 0) + 1;
      if (count >= MAX_CONSECUTIVE_SERVER_ERRORS) {
        await writeServerErrors(entry.id, count);
        return parkServerFailure(
          { ...entry, serverErrors: count },
          `the server answered ${e.status} (${e.origin}) in ${terminalId.slice(0, 8)}…, the ${count}th 5xx in a row`
        );
      }
      const held = entry;
      const delayMs = serverErrorHoldMs(held.attempts + 1, e.retryAfterMs);
      return holdForRetry(
        held,
        (attempts) =>
          `[OUTBOX] ${held.id.slice(0, 8)}… server error ${e.status} (${e.origin}), ${count}/${MAX_CONSECUTIVE_SERVER_ERRORS} in a row (attempt ${attempts}), next in ${delayMs} ms${e.retryAfterMs !== null ? ` (Retry-After ${e.retryAfterMs} ms)` : ''}`,
        { serverErrors: count, delayMs }
      );
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
      // no answer (a deadline expiry included) - a `TransportFailureError`, which the one predicate
      // reads - never a sentence to match.
      {
        transport: kind === 'unknown' && isTransportFailure(e),
        repair: kind === 'sender-not-active',
      }
    );
  }

  /** Schedule a single backoff re-flush at the earliest pending `nextAttemptAt`. */
  function scheduleBackoff(entries: OutboxEntry[]): void {
    // A controller disposed (sign-out, a new session) during the queue read that fed this must arm
    // nothing: the timer would raise a flush on a dead controller.
    if (disposed) {
      log('[OUTBOX] backoff not armed - the controller was disposed during the queue read');
      return;
    }
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
    pruneCancelled(queued);
    if (queued.length === 0) return;
    // CHECK AND CLAIM WITH NO AWAIT BETWEEN THEM: two wake-ups landing together must not both start
    // a lane for one conversation, because two lanes would send one entry twice.
    const started: Promise<void>[] = [];
    for (const conversationId of new Set(queued.map((e) => e.conversationId))) {
      if (lanes.has(conversationId)) {
        laneRerun.add(conversationId);
        // A lane waiting for its uploads must look at what was just queued behind them.
        laneWake.get(conversationId)?.();
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
      if (disposed) return;
      laneRerun.delete(conversationId);
      const queue = await readQueue('flush');
      const entries = queue.filter((e) => e.conversationId === conversationId);
      if (entries.length === 0) return;
      // A GROUP WHOSE EXIT IS OWED SENDS NOTHING FROM AN ORDINARY FLUSH: its rows are withdrawn, under
      // this lane's claim, before any of them reaches the wire. The exit's own drain is the one lane
      // that may still send them (`exiting`), while the membership exists. This is what covers a kill
      // between `recordPendingGroupExit` and that drain: on relaunch the replay of the owed exit may
      // end the membership before or after this flush, and either way no row of the group is posted
      // into the 403 (review of #2259). Read from DURABLE state, once per pass: a lane is claimed
      // before it runs, and an exit recorded during the pass awaits the lane before it withdraws.
      if (!exiting.has(conversationId) && (await withdrawForOwedExit(conversationId, queue))) {
        return;
      }
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
        // An attachment whose upload runs or is owed is unsent like a parked one: a reply quoting it
        // waits, an independent text goes (WP-OFF-9).
        if (outcome === 'parked' || outcome === 'uploading') heldBack.add(entry.id);
        if (outcome === 'sent') anySent = true;
        // Withdrawn or permanently failed: the entry is out of the queue, so what follows it may go.
        else if (outcome === 'gone' || outcome === 'error') continue;
        // Parked for the member (blocked, failed): waiting on a human, not on the network, so what
        // was written after it must not wait too. Only an entry that RETRIES holds its successors.
        else if (outcome === 'parked') continue;
        // Uploading: the transfer runs outside the lane; only the media message's own send, once
        // it ended, takes its turn here. What was written after it goes now (WP-OFF-9).
        else if (outcome === 'uploading') continue;
        // Retry or backing off: the successors wait, which is what keeps the conversation in order.
        else break;
      }
      // Chain another pass if a send unblocked dependents, or a concurrent enqueue arrived.
      if (anySent) continue;
      // AN EXIT IS WAITING ON THIS LANE: one pass that sent nothing is its answer, and what is left
      // (an upload still running, a held entry) is what the exit withdraws and reports as lost.
      if (exiting.has(conversationId)) return;
      if (laneRerun.has(conversationId)) continue;
      if (disposed || !hasRunningUpload(conversationId)) return;
      // THE BACKOFF IS ARMED BEFORE THE WAIT: `runFlush` arms it only once every lane it started has
      // returned, and this one may wait minutes for a file - a text held behind it on a 5xx would wait
      // for the whole upload (review of #2061). The ladder's own timer is the event: it raises a flush,
      // which finds this lane claimed and wakes it.
      scheduleBackoff(await readQueue('backoff before an upload wait'));
      if (disposed) return;
      if (laneRerun.has(conversationId)) continue;
      if (!hasRunningUpload(conversationId)) return;
      // AN UPLOAD OF THIS CONVERSATION IS STILL ON THE WIRE: the lane stays claimed and waits for an
      // EVENT - the upload ending, or a flush raised meanwhile (an enqueue) - never a clock. The wait
      // holds no send slot, so other conversations and this one's next text are not held by it.
      // Checked and armed with no await between them: a task that settles first set `laneRerun`.
      log(`[OUTBOX] lane ${conversationId.slice(0, 8)}… waits for its upload(s) to end`);
      await new Promise<void>((resolve) => laneWake.set(conversationId, resolve));
      laneWake.delete(conversationId);
    }
  }

  /**
   * Whether this device owes the exit of `entry`'s conversation - a DURABLE fact (`pendingGroupExits`),
   * written before the exit acts and read on every enqueue - and, when it does, the line saying so.
   * An unreadable store answers `false`: it proves nothing, the entry is queued, and that is logged.
   */
  async function owedExitRefuses(entry: OutboxEntry, what: string): Promise<boolean> {
    const exit = await owedExitOf(entry.conversationId, `${entry.id.slice(0, 8)}…`, 'queued');
    if (!exit) return false;
    const line = `[OUTBOX] ${entry.id.slice(0, 8)}… (${entry.kind}) ${what}: this device owes the ${exit.kind} of ${entry.conversationId.slice(0, 8)}… (owed for ${owedFor(exit.requestedAt)}), so nothing of it can be delivered`;
    // SOMETHING THE MEMBER WROTE, DROPPED, ACCUSES. A control refused here is the late read-mark
    // writer this gate exists for; a text or a file is not, and the one way to reach this with one is
    // an exit the server keeps refusing (kept for ever, by design) on a group the member is in again
    // - and the enqueue resolves, so this line is all that says it (backlog, P3).
    if (entry.kind !== 'control') console.warn(line);
    log(line);
    return true;
  }

  /**
   * The exit this device owes for `conversationId`, read from DURABLE state, or `null`. An unreadable
   * store answers `null`: it proves nothing, and the line says what goes ahead without the check.
   */
  async function owedExitOf(
    conversationId: string,
    subject: string,
    without: string
  ): Promise<PendingGroupExit | null> {
    if (!storage) return null;
    try {
      return (
        (await storage.getPendingGroupExits()).find((x) => x.groupId === conversationId) ?? null
      );
    } catch (e) {
      log(
        `[OUTBOX] ${subject} owed group exits unreadable (${String(e).slice(0, 80)}) - ${without} without that check`
      );
      return null;
    }
  }

  /**
   * Withdraws every queued row of `conversationId` when its exit is owed, and says so by kind.
   * `queue` is the snapshot the lane just read. Returns whether the exit was owed (the lane stops).
   */
  async function withdrawForOwedExit(
    conversationId: string,
    queue: OutboxEntry[]
  ): Promise<boolean> {
    const short = conversationId.slice(0, 8);
    const exit = await owedExitOf(conversationId, `lane ${short}…`, 'flushed');
    if (!exit) return false;
    const { left, kinds } = await withdrawGroupForExit(conversationId, queue);
    // A WARNING: rows reaching a flush with their group's exit owed means the exit's own drain never
    // ran - a kill inside the leave - and what the member queued there is lost.
    const line = `[OUTBOX] lane ${short}…: this device owes the ${exit.kind} of the group (owed for ${owedFor(exit.requestedAt)}) - ${left.length} queued entr${left.length === 1 ? 'y' : 'ies'} withdrawn, never sent into the refusal (${kinds})`;
    console.warn(line);
    log(line);
    return true;
  }

  /**
   * Withdraws every row of `conversationId` in `snapshot` for a group exit, rewrites the mirror once,
   * and returns how many there were and what they were, by kind - the two exit paths word it alike.
   */
  async function withdrawGroupForExit(
    conversationId: string,
    snapshot: OutboxEntry[]
  ): Promise<{ left: OutboxEntry[]; kinds: string }> {
    const left = snapshot.filter((e) => e.conversationId === conversationId);
    const gone = new Set<string>();
    const lostByKind = new Map<OutboxEntry['kind'], number>();
    for (const entry of left) {
      const { rowDeleted } = await withdraw(entry.id, 'exit', snapshot);
      if (rowDeleted) gone.add(entry.id);
      lostByKind.set(entry.kind, (lostByKind.get(entry.kind) ?? 0) + 1);
    }
    if (gone.size > 0) await syncOutboxMirror(snapshot.filter((e) => !gone.has(e.id)));
    return { left, kinds: [...lostByKind].map(([k, n]) => `${n} ${k}`).join(', ') };
  }

  /**
   * Releases the resumable upload session (RC-5) of an entry whose row is going away, so the server
   * does not hold its staged parts, its slot among the owner's open sessions and its budget for 24 h.
   * The id is this page life's (`openSessions`, which a failed row write cannot lose) or the row's.
   * Fire and forget: `deps.releaseUpload` resolves either way and logs its own outcome.
   */
  function releaseSessionOf(entryId: string, rowUploadId: string | undefined, why: string): void {
    const uploadId = openSessions.get(entryId) ?? rowUploadId;
    openSessions.delete(entryId);
    if (!uploadId) return;
    if (!deps.releaseUpload) {
      log(
        `[OUTBOX] ${entryId.slice(0, 8)}… session ${uploadId.slice(0, 8)}… left to the server's sweep - no releaser`
      );
      return;
    }
    log(`[OUTBOX] ${entryId.slice(0, 8)}… releasing its upload session (${why})`);
    void deps
      .releaseUpload(uploadId, why)
      // The contract says it never rejects; a releaser that does is said, never swallowed.
      .catch((e: unknown) =>
        log(`[OUTBOX] ${entryId.slice(0, 8)}… session release threw: ${String(e).slice(0, 120)}`)
      );
  }

  /**
   * The upload session id a queued row records, read WITHOUT its file (a withdrawal must not decrypt
   * a 90 s video to learn an id). `undefined` for a row with none, or one that cannot be read - said.
   */
  async function rowUploadId(entry: OutboxEntry): Promise<string | undefined> {
    if (entry.kind !== 'media' || !storage) return undefined;
    if (entry.media) return entry.media.upload?.uploadId;
    try {
      const described = await storage.getOutboxEntry(entry.id, deviceKey(), { withFile: false });
      return described?.media?.upload?.uploadId;
    } catch (e) {
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… its upload session could not be read before the withdrawal (left to the server's sweep): ${String(e).slice(0, 120)}`
      );
      return undefined;
    }
  }

  /**
   * Withdraw a queued entry that has not left this device. The body of `cancelPending`, shared with
   * the latest-wins supersede so both settle the same three copies (the durable row, a running
   * flush's snapshot, the other tabs) and the native mirror. See {@link OutboxController.cancelPending}.
   *
   * A row ON THE WIRE in this tab is still deleted and marked cancelled - it is not retried if that
   * send fails - but `withdrawn` is `false`, because the peers may already have it.
   *
   * KNOWN LIMIT OF THE `snapshot` FORM (the latest-wins supersede): a row the leader sent AND deleted
   * between the caller's read and this call is answered `withdrawn: true`. Only the supersede passes
   * a snapshot, its answer feeds a log line, and the receiver's `max` makes the extra frame
   * harmless; re-reading the queue per row to close it is the cost the single read removed.
   *
   * @param reason who withdrew it - it decides what each line says, since "the delete has to travel as
   *               an event" is true of an author's delete and false of a group exit.
   * @param snapshot the queue as the caller already read it, so a supersede reads it once per enqueue;
   *                 and then the mirror is left to the caller, which rewrites it once for the batch.
   * @returns `withdrawn`: guaranteed never sent by this tab; `rowDeleted`: the durable row is gone.
   */
  async function withdraw(
    messageId: string,
    reason: Exclude<WithdrawReason, 'other-tab'>,
    snapshot?: OutboxEntry[]
  ): Promise<{ withdrawn: boolean; rowDeleted: boolean }> {
    if (!storage) return { withdrawn: false, rowDeleted: false };
    const queued = (snapshot ?? (await readQueue('cancel'))).find((e) => e.id === messageId);
    if (!queued) return { withdrawn: false, rowDeleted: false };
    const onWireAtStart = inFlight.has(messageId);
    // A 5xx IS NOT PROOF THAT NOTHING WAS STORED: a gateway may answer 502 after the delivery service
    // queued the frame. So a text that was ever answered 5xx in this run is withdrawn here AND
    // answered "maybe sent", and the delete also goes out as an event (peers that have it drop it).
    const maybeStored = (queued.serverErrors ?? 0) > 0;
    // READ BEFORE THE ROW GOES: the reel's open upload session, which nothing could name afterwards.
    // An entry waiting in backoff, parked as failed, or not restarted since a relaunch has no
    // transfer running to abort - the row is the only thing that knows its session.
    const sessionInRow = openSessions.has(messageId) ? undefined : await rowUploadId(queued);

    // Three things, and the order between them does not matter because none can undo another:
    // the durable row (every future flush), this tab's snapshot (a flush already walking), and
    // the other tabs' snapshots (a leader draining on our behalf).
    cancelled.set(messageId, reason);
    parked.delete(messageId);
    serverFailed.delete(messageId);
    noAnswer.delete(messageId);
    bestLoaded.delete(messageId);
    unexpected.delete(messageId);
    uploadOwed.delete(messageId);
    // An upload that already ENDED leaves nothing to abort; one still running is aborted below and
    // forgets itself when it settles.
    if (uploadTasks.get(messageId)?.settled) uploadTasks.delete(messageId);
    publishOutboxEntryCancelled(messageId);
    let rowDeleted = true;
    await storage
      .deleteOutboxEntry(messageId)
      // A row that survives is a message that will be sent after the user deleted it, which is
      // the whole defect - so this is reported rather than swallowed, and the caller is told the
      // cancellation did not hold so the `delete_message` event goes out instead.
      .catch((e) => {
        log(`[OUTBOX] ${messageId.slice(0, 8)}… cancel could not delete the row: ${String(e)}`);
        cancelled.delete(messageId);
        rowDeleted = false;
      });
    // A FOLLOWER RUNS NO LANE, so nothing here will ever read its mark, and `pruneCancelled` only
    // runs in the leader: kept, it would stay for the session. The leader has its own copy from
    // `outbox_entry_cancelled`.
    if (getTabLeadership() === 'follower') cancelled.delete(messageId);
    // The mirror is the native background sender's own copy of the queue: leaving the entry in it
    // sends the message from Android after it was withdrawn here.
    if (rowDeleted && !snapshot) await refreshMirror();
    // The row is gone, so nothing will resume its session: give it back now. A transfer still
    // running is aborted below and keeps it no longer (an abort never releases by itself).
    if (rowDeleted) releaseSessionOf(messageId, sessionInRow, 'withdrawn');
    // ON THE WIRE, NOW OR AT THE START. A send cannot START after the mark was set (the flush
    // re-checks it with no await before claiming `inFlight`), and `inFlight` holds a sent id until
    // its row is deleted, so these two reads see every frame this tab let out.
    if (!rowDeleted || onWireAtStart || inFlight.has(messageId)) {
      if (rowDeleted) {
        log(
          reason === 'exit'
            ? // NOT REACHED BY THIS TAB'S OWN LANE: the exit withdraws under its claim, after the lane
              // drained. Only a send another path holds can be here, and it is said for what it is.
              `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn by the group exit while it was being sent - the members may have it; it is not retried`
            : `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn while it was already being sent - the peers` +
                ' will have it, so the delete has to travel as an event'
        );
      }
      return { withdrawn: false, rowDeleted };
    }
    if (maybeStored) {
      log(
        reason === 'exit'
          ? `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn by the group exit after ${queued.serverErrors} 5xx answer(s) - a gateway may have stored it, so the members may have it`
          : `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn after ${queued.serverErrors} 5xx answer(s) - a gateway may have stored it, so the delete travels as an event too`
      );
      return { withdrawn: false, rowDeleted };
    }
    // A body already on the wire is stopped too, not only forgotten. AFTER the check above: the
    // abort wakes the flush that owns the transfer, which consumes `cancelled`.
    uploads.get(messageId)?.abort('cancel');
    // "By this tab": only this tab's sends are known here. A leader tab draining on a follower's
    // behalf learns of the withdrawal from `outbox_entry_cancelled`, and may already be sending it.
    log(
      reason === 'exit'
        ? `[OUTBOX] ${messageId.slice(0, 8)}… (${queued.kind}) withdrawn by the group exit - it could not be sent before the membership ended, and is lost`
        : `[OUTBOX] ${messageId.slice(0, 8)}… withdrawn from the queue before this tab sent it`
    );
    return { withdrawn: true, rowDeleted };
  }

  /**
   * The unsent entries a latest-wins `entry` supersedes, or `'covered'` when one already queued
   * carries as much - the new one then says nothing and is not queued, which is also what keeps a
   * mark from moving backwards on the wire. A queue that cannot be read reads as "nothing queued":
   * the entry is queued normally, which costs a frame and never loses one.
   */
  function supersededBy(
    entry: OutboxEntry,
    latestWins: LatestWins,
    snapshot: OutboxEntry[]
  ): OutboxEntry[] | 'covered' {
    const siblings: OutboxEntry[] = [];
    for (const queued of snapshot) {
      if (queued.conversationId !== entry.conversationId || queued.id === entry.id) continue;
      if (cancelled.has(queued.id)) continue;
      const value = latestWins.valueOf(queued);
      if (value === null) continue;
      if (value >= latestWins.value) return 'covered';
      siblings.push(queued);
    }
    return siblings;
  }

  return {
    async enqueue(entry: OutboxEntry, opts: EnqueueOptions = {}): Promise<void> {
      // REJECTS RATHER THAN RETURNS: a no-op here told the caller its message was queued when
      // nothing would ever send it.
      if (!storage) {
        log(`[OUTBOX] Enqueue refused for ${entry.id.slice(0, 8)}…: no storage layer`);
        throw new OutboxEnqueueError('no storage layer');
      }
      // A GROUP THIS DEVICE IS LEAVING OR DELETING TAKES NOTHING NEW, read from the DURABLE owed
      // exit (`pendingGroupExits`), which is written before the exit acts and outlives a reload. A
      // frame queued from here on could only be refused once the membership ends - this is what
      // closes the late read-mark writers (the debounce cleanup, the owed-mark drain) without a
      // clock. RESOLVES, not rejects: the owed-mark ledger then drops the mark, which is the point,
      // and there is no member-visible send to fail - the conversation is already retired.
      // A read that fails proves nothing, so the entry is queued as before and the line says so.
      if (await owedExitRefuses(entry, 'not queued')) {
        // A send path that wrote the row beside its echo has ALREADY queued it: the row goes too,
        // or the next flush would post it into the refusal this gate exists to prevent.
        if (opts.alreadyDurable) await withdraw(entry.id, 'exit');
        return;
      }
      let superseded: OutboxEntry[] = [];
      // ONE READ OF THE QUEUE PER LATEST-WINS ENQUEUE: it decides the supersede, settles each
      // withdrawal and rewrites the mirror. Reading it per step decrypted the whole queue 2 + 2n
      // times for one read receipt (review of #1887).
      let snapshot: OutboxEntry[] | null = null;
      if (opts.latestWins) {
        snapshot = await readQueue('supersede');
        const found = supersededBy(entry, opts.latestWins, snapshot);
        if (found === 'covered') {
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… (${entry.kind}) not queued: an unsent entry for ${entry.conversationId.slice(0, 8)}… already carries ${opts.latestWins.value} or more`
          );
          return;
        }
        superseded = found;
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
          const writeFrom = Date.now();
          await storage.saveOutboxEntry(entry, deviceKey());
          log(
            `[OUTBOX] ${entry.id.slice(0, 8)}… durable write took ${Date.now() - writeFrom} ms (${entry.media?.fileBytes?.length ?? 0} file bytes)`
          );
        } catch (e) {
          log(`[OUTBOX] Enqueue failed for ${entry.id.slice(0, 8)}…: ${String(e)}`);
          throw new OutboxEnqueueError('the durable write failed', e);
        }
      }
      // AND ASKED AGAIN ONCE THE ROW IS ON DISK. An exit recorded while this write ran may already
      // have taken its last look at the queue, and would never see this row; so the writer looks
      // instead. Whichever comes second sees the other, so no row of an exited group outlives both.
      if (await owedExitRefuses(entry, 'withdrawn right after its write')) {
        await withdraw(entry.id, 'exit');
        return;
      }
      // WITHDRAWN ONLY NOW, AFTER THE NEW ROW IS ON DISK: a crash between the two leaves both rows,
      // which send in order and merge as `max` - one spare frame. The other order loses both.
      if (snapshot) {
        const gone = new Set<string>();
        for (const old of superseded) {
          const { withdrawn, rowDeleted } = await withdraw(old.id, 'superseded', snapshot);
          if (rowDeleted) gone.add(old.id);
          log(
            !rowDeleted
              ? `[OUTBOX] ${old.id.slice(0, 8)}… NOT superseded: its row could not be deleted, so both go - the newer one after it`
              : withdrawn
                ? `[OUTBOX] ${old.id.slice(0, 8)}… superseded by ${entry.id.slice(0, 8)}… before this tab sent it (a leader tab may already be sending it; the newer one follows)`
                : `[OUTBOX] ${old.id.slice(0, 8)}… superseded by ${entry.id.slice(0, 8)}… while on the wire here - not retried, the newer one follows it`
          );
        }
        await syncOutboxMirror(
          [...snapshot.filter((e) => !gone.has(e.id)), entry].sort(
            (a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id)
          )
        );
      } else {
        await refreshMirror();
      }
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
      return (await withdraw(messageId, 'user')).withdrawn;
    },

    async drainForExit(conversationId: string, exitKind: 'leave' | 'delete'): Promise<number> {
      if (!storage) return 0;
      const tag = `[OUTBOX] ${exitKind} of ${conversationId.slice(0, 8)}…`;
      exiting.add(conversationId);
      try {
        // 1. A LANE ALREADY RUNNING IS AWAITED, NOT RACED: its send in flight settles before the
        // membership ends. Woken first, so one waiting for an upload sees `exiting` and returns.
        for (
          let running = lanes.get(conversationId);
          running;
          running = lanes.get(conversationId)
        ) {
          laneWake.get(conversationId)?.();
          await running;
        }
        // 2. THE LANE IS CLAIMED BY THE EXIT, with no await since the check above. Until it is
        // released no other flush can start a send for this group, so what is withdrawn below is
        // known not to be on the wire - the withdrawal ends the race instead of healing it.
        let release!: () => void;
        lanes.set(
          conversationId,
          new Promise<void>((resolve) => {
            release = resolve;
          })
        );
        try {
          const before = (await readQueue('exit drain')).filter(
            (e) => e.conversationId === conversationId
          );
          if (before.length === 0) return 0;
          // 3. WHAT CAN STILL GO, GOES - the membership and the MLS state both exist until the server
          // step. In queue order, so a text written before a reaction to it still precedes it, and
          // each skips its backoff once: an exit is the last chance it has.
          const canSend =
            getIsTabLeader() && !connectivity.isOffline && (canFlush ? canFlush() : true);
          if (canSend) {
            for (const e of before) resuming.add(e.id);
            await drainLane(conversationId);
          } else {
            log(
              `${tag}: ${before.length} queued entr${before.length === 1 ? 'y' : 'ies'} cannot be sent from here (${!getIsTabLeader() ? 'not the leader tab' : connectivity.isOffline ? 'offline' : 'session not ready to send'})`
            );
          }
          // 4. WHAT COULD NOT GO IS WITHDRAWN, under the same claim, and said by kind: a text lost
          // here is something the member wrote, a control is a receipt or a reaction.
          const { left, kinds } = await withdrawGroupForExit(
            conversationId,
            await readQueue('exit withdraw')
          );
          const line = `${tag}: ${before.length - left.length} of ${before.length} queued entr${before.length === 1 ? 'y' : 'ies'} sent before the server step, ${left.length} lost${left.length > 0 ? ` (${kinds})` : ''}`;
          if (left.length > 0) console.warn(line);
          log(line);
          return left.length;
        } finally {
          lanes.delete(conversationId);
          release();
        }
      } finally {
        exiting.delete(conversationId);
      }
    },

    flush(): Promise<void> {
      return runFlush();
    },

    resumeGroup(conversationId: string): Promise<void> {
      readyAnnouncements.set(conversationId, (readyAnnouncements.get(conversationId) ?? 0) + 1);
      let resumed = 0;
      for (const [id, heldIn] of repairHeld) {
        if (heldIn !== conversationId) continue;
        repairHeld.delete(id);
        resuming.add(id);
        resumed++;
      }
      // Said only when something was waiting: a redelivered Welcome announces a group already ready on
      // every cold start, and a line per group there would be one its reader learns to skip.
      if (resumed > 0) {
        log(
          `[OUTBOX] group ${conversationId.slice(0, 8)}… ready - ${resumed} held entr${resumed === 1 ? 'y' : 'ies'} resumed`
        );
      }
      return runFlush();
    },

    retryUpload(messageId: string): void {
      // Still waiting for an upload slot: nothing has left, so there is nothing to restart, and
      // aborting would only send it to the back of the queue (review of #2061). Answered BEFORE any
      // arming: a `resuming` mark left here would outlive this attempt and let a later failure of
      // it skip its fresh backoff and reset its no-answer count.
      if (slotWaiting.has(messageId)) {
        log(
          `[OUTBOX] ${messageId.slice(0, 8)}… retry: not started yet, it keeps its place in line`
        );
        return;
      }
      // Skip the backoff for this entry (the one `resuming` already exists for) and, when its
      // transfer is on the wire and stalled, abandon it: the flush then restarts it at once.
      resuming.add(messageId);
      parked.delete(messageId);
      // A 403-parked entry used to ignore this button for the controller's whole life.
      forbiddenParked.delete(messageId);
      const running = uploads.get(messageId);
      if (running) {
        running.abort('retry');
        return;
      }
      // A TEXT FAILED ON 5xx starts a new run, DURABLY and read from the ROW (a follower tab holds
      // none of the leader's memory): written before the flush, so no tab parks it again.
      void resetServerFailure(messageId).then(() => runFlush());
    },

    async applyPendingStatuses(): Promise<void> {
      if (!storage) return;
      const entries = await readQueue('pending statuses');
      for (const entry of entries) {
        const found = findMessage(entry.id);
        // A text failed on 5xx stays FAILED across a reload: its durable count says so.
        if (found && isServerFailureTerminal(entry)) {
          showServerFailure(entry.id, entry.serverErrors ?? 0);
          continue;
        }
        // Only (re)apply 'pending'; do not clobber a live 'sending' transition.
        if (found && found.convo.messages[found.idx].status !== 'sending') {
          patchStatus(entry.id, 'pending');
        }
      }
    },

    dispose(): void {
      disposed = true;
      for (const running of uploads.values()) running.abort('cancel');
      uploads.clear();
      uploadTasks.clear();
      // A lane waiting for its uploads ends now instead of waiting on a controller that is gone.
      for (const wake of laneWake.values()) wake();
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
  sweepOrphanBlobs(deps);
  setUploadRetry((messageId) => controller.retryUpload(messageId));
  for (const listener of registrationListeners) {
    try {
      listener(deps.userId);
    } catch (e) {
      console.error('[OUTBOX] a registration listener threw:', e);
    }
  }
  return active;
}

const registrationListeners = new Set<(userId: string) => void>();

/**
 * Calls `listener` each time a controller is registered, with its user: the event that makes a
 * write owed to the outbox before it existed (a boot, a sign-in) deliverable. The listener runs after
 * the controller is active, so an enqueue inside it is taken.
 *
 * @returns the unsubscribe.
 */
export function onOutboxRegistered(listener: (userId: string) => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

/**
 * Once per session, delete the attachment blobs no queued row owns - what a kill between a blob
 * write and its row write leaves. Best-effort and logged: garbage is a cost, never a failure.
 */
function sweepOrphanBlobs(deps: OutboxDeps): void {
  const storage = deps.storage;
  if (!storage) return;
  // Called INSIDE the chain: a synchronous throw (a storage handle not open yet) must land in the
  // `.catch` below, never in `registerOutbox`, which would then return no controller at all.
  Promise.resolve()
    .then(() => storage.sweepOutboxBlobs())
    .then((n) => {
      if (n > 0) deps.log(`[OUTBOX] swept ${n} orphan attachment blob(s) (no row owns them)`);
    })
    .catch((e) => deps.log(`[OUTBOX] orphan blob sweep failed: ${String(e)}`));
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
 * | `sessionAuth`'s `onGroupReady`, through {@link resumeOutboxGroup} | one GROUP became sendable; the network never changed |
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

/**
 * One group became sendable - a Welcome installed, an external join landed: resume the entries held
 * for it and drain, on the active controller (no-op when none). See
 * {@link OutboxController.resumeGroup}.
 *
 * NOT A PLAIN {@link flushOutbox}, and that was the defect: a held entry carries the backoff its hold
 * wrote, and a flush skips an entry whose `nextAttemptAt` is in the future unless it is resumed - so
 * a message held before a Welcome waited up to the ladder's top step, a minute, after the group was
 * ready (review, 2026-10-31). The event that ends the hold is the one that resumes it.
 */
export function resumeOutboxGroup(conversationId: string): void {
  void active?.resumeGroup(conversationId);
}

/** Enqueue a message on the active controller. Rejects with {@link OutboxEnqueueError} when it cannot. */
export function enqueueOutboxMessage(entry: OutboxEntry, opts?: EnqueueOptions): Promise<void> {
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
  if (!active) return Promise.resolve(false);
  return active.cancelPending(messageId).finally(bumpOutboxQueueVersion);
}

/**
 * Settle the queue of a conversation this device is leaving or deleting, on the active controller -
 * see {@link OutboxController.drainForExit}. Rejects with {@link OutboxEnqueueError} when no
 * controller is registered: a group exit is only reachable from a signed-in session, so reaching
 * here without one is a defect to report, never "nothing queued".
 */
export function drainOutboxForExit(
  conversationId: string,
  exitKind: 'leave' | 'delete'
): Promise<number> {
  if (!active) {
    return Promise.reject(new OutboxEnqueueError('no active outbox controller'));
  }
  return active.drainForExit(conversationId, exitKind).finally(bumpOutboxQueueVersion);
}

/** Mark loaded messages still queued as `pending` (no-op when none). */
export function applyOutboxPendingStatuses(): Promise<void> {
  return active ? active.applyPendingStatuses() : Promise.resolve();
}
