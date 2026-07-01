import type { SvelteMap } from 'svelte/reactivity';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, OutboxEntry } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import type { MediaRef } from '$lib/media';
import { encodeAppMessage, mkText, mkReply, mkMedia, mediaKindToType } from '$lib/proto/codec';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { fromHex } from '$lib/utils/hex';
import { resolveTerminalGroup } from '$lib/utils/chat/groupSyncEligibility';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import { logMlsMetric } from '$lib/mls-client/mlsRecoveryMetrics';
import { syncOutboxMirror } from '$lib/utils/chat/outboxMirror';

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
  pin: string;
  conversations: SvelteMap<string, Conversation>;
  log: (msg: string) => void;
  /** Emit a non-destructive welcome_request for a group missing from the WASM. */
  requestReAdd: (groupId: string) => Promise<void>;
  /** True when the group can be sent into (in the WASM, not in an unresolved epoch gap). */
  isGroupHealthy: (groupId: string) => boolean;
  /** Mark a conversation deletedRemotely (banner) when its whole lineage is gone. */
  markDeletedRemotely?: (groupId: string) => void;
  /** Encrypt + upload a queued media file, returning the server media ref (queued-media flush). */
  uploadMedia?: (media: NonNullable<OutboxEntry['media']>) => Promise<MediaRef>;
}

/** Public surface of the per-session outbox controller. */
export interface OutboxController {
  /** Persist a queued message and schedule a flush. */
  enqueue: (entry: OutboxEntry) => Promise<void>;
  /** Drain the outbox (tab-leader gated by the caller). Coalesces concurrent calls. */
  flush: () => Promise<void>;
  /** Mark already-loaded messages whose id is still queued as `pending` (reload / history load). */
  applyPendingStatuses: () => Promise<void>;
  /** Re-key queued entries from a dead group to its successor (MLS reboot G -> S). */
  reassign: (fromId: string, toId: string) => Promise<void>;
  /** Stop the internal backoff timer. */
  dispose: () => void;
}

/** Result of attempting to flush a single entry. */
type FlushOutcome = 'sent' | 'retry' | 'error' | 'skip';

/**
 * Creates the outbox controller. The flusher re-encodes the proto against the current epoch at
 * send time (so epoch changes are transparent), resolves the terminal group (so a rebooted group
 * G is sent into its successor S), is idempotent on the stable messageId (a re-send after a crash
 * is deduplicated by the receiver), and never sends into an unhealthy group.
 */
export function createOutbox(deps: OutboxDeps): OutboxController {
  const { conversations, storage, mlsService, pin, log } = deps;

  let flushing = false;
  let rerun = false;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;

  /** Rewrite the native background-send mirror from the current queue (Tauri only; best-effort). */
  async function refreshMirror(): Promise<void> {
    if (!storage) return;
    const entries = await storage.getOutboxEntries(pin).catch(() => [] as OutboxEntry[]);
    await syncOutboxMirror(entries);
  }

  // Flush opportunistically when connectivity or foreground is regained.
  const onOnline = (): void => {
    runFlush();
  };
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') runFlush();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
  }

  /** Locate a message by id across all conversations (it may have migrated to a successor key). */
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
    await storage
      .saveMessage(
        {
          id: m.id,
          conversationId: liveConvId,
          senderId: m.senderId,
          content: m.content,
          timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
          readBy: m.readBy,
          reactions: m.reactions,
        },
        pin
      )
      .catch((e) => log(`[OUTBOX] Persist sent ${messageId.slice(0, 8)}… échoué: ${String(e)}`));
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
          pin
        )
        .catch(() => {});
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

  /** Flush a single entry. Returns the outcome so the loop can schedule backoff/chaining. */
  async function flushOne(entry: OutboxEntry): Promise<FlushOutcome> {
    if (entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) return 'skip';

    // The MLS outbox is for DMs/groups only. A channel entry (server-authoritative, no MLS group)
    // can only have leaked in through a bug: it would loop forever on resolveTerminalGroup and
    // requestReAdd 500s. Drop it so a stale entry cannot storm the delivery service.
    if (isChannelConversationId(entry.conversationId)) {
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… channel entry - dropped (channels do not use MLS)`);
      await storage?.deleteOutboxEntry(entry.id).catch(() => {});
      return 'error';
    }

    const { terminalId, groupMeta, hasChain } = await resolveTerminalGroup(
      mlsService,
      entry.conversationId
    );

    // Whole lineage deleted without a usable successor: the only permanent failure.
    if (groupMeta?.deletedAt && !hasChain) {
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… groupe supprimé sans successeur - échec définitif`);
      patchStatus(entry.id, 'error');
      // A control event (reaction/read-receipt) must not be what raises the "conversation
      // deleted" banner; only a user-visible text/media send does.
      if (entry.kind !== 'control') deps.markDeletedRemotely?.(terminalId);
      await storage?.deleteOutboxEntry(entry.id).catch(() => {});
      logMlsMetric({ kind: 'outbox_permanent_error', conversationId: terminalId });
      return 'error';
    }

    // Group not sendable yet: emit a soft welcome_request and retry later. NEVER reboot here -
    // the persistent reboot deadline (sessionWatchdogs) owns escalation.
    if (!deps.isGroupHealthy(terminalId)) {
      await deps.requestReAdd(terminalId).catch(() => {});
      return 'retry';
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

      // Control events are MLS state-sync only: send them silent (no push notification).
      await mlsService.sendMessage(terminalId, proto, entry.id, entry.kind === 'control');
      scheduleOutboundMlsPersist();
      // Swap the placeholder for the uploaded media before persisting the sent copy.
      if (mediaContent) updateMessageContent(entry.id, mediaContent);
      await persistSent(terminalId, entry.id);
      patchStatus(entry.id, 'sent');
      await storage?.deleteOutboxEntry(entry.id).catch(() => {});
      logMlsMetric({
        kind: 'outbox_flush_success',
        conversationId: terminalId,
        latencyMs: Date.now() - entry.sentAt,
      });
      log(`[OUTBOX] ${entry.id.slice(0, 8)}… envoyé dans ${terminalId.slice(0, 8)}…`);
      return 'sent';
    } catch (e) {
      // Transient (WrongEpoch / network): keep pending, back off. The message is never lost.
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
          pin
        )
        .catch(() => {});
      log(
        `[OUTBOX] ${entry.id.slice(0, 8)}… échec transitoire (tentative ${attempts}): ${String(e).slice(0, 80)}`
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
    if (flushing) {
      rerun = true;
      return;
    }
    flushing = true;
    try {
      // Avant tout envoi : laisser la file de messages ENTRANTS se drainer. fetchPendingMessages
      // (au reconnect/resume) ne fait qu'enfiler les frames en attente - leur traitement (commits
      // qui avancent l'epoch) est asynchrone. Sans cette barriere, un flush declenche par
      // online/visibilitychange peut partir AVANT que les commits manques soient appliques :
      // le message serait chiffre a une epoch perimee, donc indechiffrable par les pairs a jour
      // (perte silencieuse - la course "envoi a froid au resume"). Attendre l'idle garantit que
      // l'epoch locale est a jour. En regime permanent la file est deja idle -> resolution
      // immediate, aucune latence ajoutee. [[DF1c]]
      await mlsService.waitForMessageQueueIdle().catch(() => {});
      do {
        rerun = false;
        const entries = await storage.getOutboxEntries(pin).catch(() => [] as OutboxEntry[]);
        if (entries.length === 0) break;
        logMlsMetric({ kind: 'outbox_pending_count', count: entries.length });
        let anySent = false;
        for (const entry of entries) {
          const outcome = await flushOne(entry);
          if (outcome === 'sent') anySent = true;
        }
        // Re-read for backoff scheduling (statuses/attempts changed during the loop).
        const remaining = await storage.getOutboxEntries(pin).catch(() => [] as OutboxEntry[]);
        if (remaining.length > 0) scheduleBackoff(remaining);
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
      await storage
        .saveOutboxEntry(entry, pin)
        .catch((e) => log(`[OUTBOX] Enqueue échoué: ${String(e)}`));
      await refreshMirror();
      runFlush();
    },

    flush(): Promise<void> {
      return runFlush();
    },

    async applyPendingStatuses(): Promise<void> {
      if (!storage) return;
      const entries = await storage.getOutboxEntries(pin).catch(() => [] as OutboxEntry[]);
      for (const entry of entries) {
        const found = findMessage(entry.id);
        // Only (re)apply 'pending'; do not clobber a live 'sending' transition.
        if (found && found.convo.messages[found.idx].status !== 'sending') {
          patchStatus(entry.id, 'pending');
        }
      }
    },

    async reassign(fromId: string, toId: string): Promise<void> {
      if (!storage) return;
      await storage.reassignOutboxConversation(fromId, toId).catch(() => {});
      await refreshMirror();
      runFlush();
    },

    dispose(): void {
      if (backoffTimer) clearTimeout(backoffTimer);
      backoffTimer = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
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

/** Mark loaded messages still queued as `pending` (no-op when none). */
export function applyOutboxPendingStatuses(): Promise<void> {
  return active ? active.applyPendingStatuses() : Promise.resolve();
}

/** Re-key queued entries from a dead group to its successor (no-op when none). */
export function reassignOutboxConversation(fromId: string, toId: string): Promise<void> {
  return active ? active.reassign(fromId, toId) : Promise.resolve();
}
