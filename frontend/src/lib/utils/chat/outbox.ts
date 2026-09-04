import type { SvelteMap } from 'svelte/reactivity';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, OutboxEntry } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import type { MediaRef } from '$lib/media';
import { encodeAppMessage, mkText, mkReply, mkMedia, mediaKindToType } from '$lib/proto/codec';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { fromHex } from '$lib/utils/hex';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { logMlsMetric } from '$lib/mls-client/mlsRecoveryMetrics';
import { classifyOutgoingSendError } from '$lib/mls-client/mlsSendError';
import { syncOutboxMirror } from '$lib/utils/chat/outboxMirror';
import { connectivity } from '$lib/stores/connectivity.svelte';
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
  deviceKeyB64: string;
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
  /** Encrypt + upload a queued media file, returning the server media ref (queued-media flush). */
  uploadMedia?: (media: NonNullable<OutboxEntry['media']>) => Promise<MediaRef>;
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
  /** Persist a queued message and schedule a flush. */
  enqueue: (entry: OutboxEntry) => Promise<void>;
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
  /** Drain the outbox. Gated on tab leadership here, not by the caller. Coalesces concurrent calls. */
  flush: () => Promise<void>;
  /** Mark already-loaded messages whose id is still queued as `pending` (reload / history load). */
  applyPendingStatuses: () => Promise<void>;
  /** Stop the internal backoff timer. */
  dispose: () => void;
}

/** Result of attempting to flush a single entry. */
type FlushOutcome = 'sent' | 'retry' | 'error' | 'skip';

/**
 * Creates the outbox controller. The flusher re-encodes the proto against the current epoch at
 * send time (so epoch changes are transparent), is idempotent on the stable messageId (a re-send
 * after a crash is deduplicated by the receiver), and never sends into an unhealthy group.
 */
export function createOutbox(deps: OutboxDeps): OutboxController {
  const { conversations, storage, mlsService, deviceKeyB64, log, canFlush } = deps;

  let flushing = false;
  let rerun = false;
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
   * coalesces through `flushing`/`rerun`, but only AFTER this gate, so the coalescing could not
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
   * Read the queue. A failure here is indistinguishable from an empty queue to every caller, so
   * it is the one place a queued message can vanish without a trace - hence the log.
   */
  async function readQueue(where: string): Promise<OutboxEntry[]> {
    if (!storage) return [];
    return storage.getOutboxEntries(deviceKeyB64).catch((e) => {
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
   * and `runFlush` already collapses re-entry through `flushing`/`rerun`.
   */
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') runFlush();
  };
  const unsubscribeReconnect = connectivity.onReconnect(() => {
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
        deviceKeyB64
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
      logMlsMetric({ kind: 'outbox_upload_attempt', conversationId: entry.conversationId });
      const uploaded = await deps.uploadMedia(media);
      ref = { mediaId: uploaded.mediaId, key: uploaded.key, iv: uploaded.iv };
      // Persist the ref + drop the raw bytes BEFORE sending: a crash after upload must not re-upload.
      await storage
        ?.updateOutboxEntry(
          entry.id,
          { media: { ...media, uploadedRef: ref, fileBytes: undefined } },
          deviceKeyB64
        )
        // Losing this write means a crash before the send re-uploads the same file.
        .catch((e) =>
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… media ref not persisted: ${String(e)}`)
        );
    }
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
        caption: media.caption,
        ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
      }),
      messageId: entry.id,
      sentAt: entry.sentAt,
    });
    return { proto, content: serializeEnvelope(mkMediaEnvelope(fullRef, media.caption)) };
  }

  /**
   * Retires an entry that can never be sent, whatever is retried and however long is waited.
   *
   * There are exactly two such causes and they are indistinguishable from here on: the group was
   * deleted server-side, or this device was removed from it. Both leave the message undeliverable
   * for good, so both take the same three steps - error status, the banner (never raised by a
   * reaction or a read receipt, only by a user-visible send), and the row gone from the queue.
   * `reason` is what separates them in the log, which is the only place the difference can still
   * be read.
   */
  async function failPermanently(
    entry: OutboxEntry,
    terminalId: string,
    cause: 'group-deleted' | 'evicted' | 'evicted-late'
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
    if (entry.kind !== 'control') deps.markDeletedRemotely?.(terminalId);
    await storage?.deleteOutboxEntry(entry.id).catch(() => {});
    logMlsMetric({
      kind: 'outbox_permanent_error',
      conversationId: terminalId,
      entryKind: entry.kind,
      cause,
    });
    return 'error';
  }

  /** Flush a single entry. Returns the outcome so the loop can schedule backoff/chaining. */
  async function flushOne(entry: OutboxEntry): Promise<FlushOutcome> {
    // Withdrawn after this flush read its snapshot of the queue. The row is already gone, so this
    // is the only thing standing between a message the user deleted and the wire.
    if (cancelled.has(entry.id)) {
      cancelled.delete(entry.id);
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… cancelled before it was sent - dropped, not delivered`
      );
      return 'skip';
    }

    if (entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) {
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
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… held: group ${terminalId.slice(0, 8)}… not sendable, requesting re-add`
      );
      await deps
        .requestReAdd(terminalId)
        .catch((e) =>
          log(`[OUTBOX] Re-add request for ${terminalId.slice(0, 8)}… failed: ${String(e)}`)
        );
      return 'retry';
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
      } else {
        proto = buildOutboxProto(entry) ?? new Uint8Array(0);
      }

      inFlight = entry.id;
      try {
        await mlsService.sendMessage(terminalId, proto, entry.id, deliveryForOutboxEntry(entry));
      } finally {
        inFlight = null;
      }
      // Swap the placeholder for the uploaded media before persisting the sent copy.
      if (mediaContent) updateMessageContent(entry.id, mediaContent);
      await persistSent(terminalId, entry.id);
      patchStatus(entry.id, 'sent');
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
      if (kind === 'evicted') {
        log(
          `[OUTBOX] ${entry.id.slice(0, 8)}… send REFUSED as evicted, after isGroupActive answered that this device is still a member of ${terminalId.slice(0, 8)}… - the two disagree, and OpenMLS is the one that is right`
        );
        return failPermanently(entry, terminalId, 'evicted-late');
      }
      // Keep pending, back off. The message is never lost - that is true of both arms that reach
      // here, and it is the only thing they share.
      patchStatus(entry.id, 'pending');
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
          deviceKeyB64
        )
        // Losing this write loses the backoff with it, so the entry is retried at full speed.
        .catch((err) =>
          log(`[OUTBOX] ${entry.id.slice(0, 8)}… backoff not persisted: ${String(err)}`)
        );
      // A LINE ITS READER LEARNS TO SKIP HIDES THE NEXT DEFECT, so the two arms that reach here do
      // not share a sentence. `sender-not-active` is not transient by any reading - the server has
      // refused this device's leaf and will refuse it identically until the repair above lands - and
      // reporting it as "transient failure (attempt 23)" is what let eight stuck messages read as
      // ordinary network noise for two and a half hours. What is retried here is the MESSAGE; what
      // is being waited on is the REPAIR, and the line now says which.
      log(
        kind === 'sender-not-active'
          ? `[OUTBOX] ${entry.id.slice(0, 8)}… held for the roster repair of ${terminalId.slice(0, 8)}… (attempt ${attempts}) - not a transient failure: the server refuses this device's leaf until it is re-admitted`
          : `[OUTBOX] ${entry.id.slice(0, 8)}… transient failure (attempt ${attempts}): ${String(e).slice(0, 80)}`
      );
      return 'retry';
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
    if (flushing) {
      rerun = true;
      return;
    }
    flushing = true;
    try {
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
        log(
          `[OUTBOX] Incoming-queue barrier failed, sending at a possibly stale epoch: ${String(e)}`
        )
      );
      do {
        rerun = false;
        const entries = await readQueue('flush');
        if (entries.length === 0) break;
        logMlsMetric({ kind: 'outbox_pending_count', count: entries.length });
        log(`[OUTBOX] Flushing ${entries.length} queued entr${entries.length === 1 ? 'y' : 'ies'}`);
        let anySent = false;
        for (const entry of entries) {
          const outcome = await flushOne(entry);
          if (outcome === 'sent') anySent = true;
        }
        // Re-read for backoff scheduling (statuses/attempts changed during the loop).
        const remaining = await readQueue('backoff scheduling');
        if (remaining.length > 0) {
          log(
            `[OUTBOX] ${remaining.length} entr${remaining.length === 1 ? 'y' : 'ies'} still queued`
          );
          scheduleBackoff(remaining);
        }
        // Chain another pass if a send unblocked dependents, or a concurrent enqueue arrived.
        if (!anySent) break;
      } while (rerun);
    } finally {
      flushing = false;
      void refreshMirror();
    }
  }

  return {
    async enqueue(entry: OutboxEntry): Promise<void> {
      if (!storage) return;
      // The first trace of a message on this device: without it there is no way to tell a send that
      // never reached the queue from one the queue accepted and lost.
      log(
        `[OUTBOX] Queued ${entry.id.slice(0, 8)}… (${entry.kind}) for ${entry.conversationId.slice(0, 8)}…`
      );
      await storage
        .saveOutboxEntry(entry, deviceKeyB64)
        .catch((e) => log(`[OUTBOX] Enqueue failed: ${String(e)}`));
      await refreshMirror();
      runFlush();
    },

    async cancelPending(messageId: string): Promise<boolean> {
      if (!storage) return false;
      const queued = (await readQueue('cancel')).find((e) => e.id === messageId);
      if (!queued) return false;

      // Three things, and the order between them does not matter because none can undo another:
      // the durable row (every future flush), this tab's snapshot (a flush already walking), and
      // the other tabs' snapshots (a leader draining on our behalf).
      cancelled.add(messageId);
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
  active = createOutbox(deps);
  return active;
}

/** Tear down the active controller (logout). */
export function unregisterOutbox(): void {
  active?.dispose();
  active = null;
}

/** The active controller, or null when logged out. */
export function getOutbox(): OutboxController | null {
  return active;
}

/** Trigger a flush on the active controller (no-op when none). */
export function flushOutbox(): void {
  void active?.flush();
}

/** Enqueue a message on the active controller (no-op when none). */
export function enqueueOutboxMessage(entry: OutboxEntry): Promise<void> {
  return active ? active.enqueue(entry) : Promise.resolve();
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
