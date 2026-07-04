import type {
  IMlsService,
  GroupMeta,
  UserGroupRow,
  MlsInitOptions,
  BulkIngestPhase,
  BulkIngestObserver,
} from '$lib/mls-client';
import {
  MlsDeliveryApi,
  resolveMlsPublicUrls,
  MLS_ADD_LOCK_TTL_MS,
  MLS_REBOOT_LOCK_TTL_MS,
} from '$lib/mls-client';
import {
  type MlsDecryptSession,
  createSequentialDecryptSession,
} from '$lib/mls-client/mlsDecryptSession';
import type { MlsDeliveryFetch } from '$lib/mls-client/mlsDeliveryApi';
import type { IncomingDeliveryMeta } from '$lib/mls-client/IMlsService';
import { MlsPerGroupScheduler, type MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  logMlsMetric,
} from '$lib/mls-client';
import {
  beginQueueDrainBench,
  recordQueueDrainMessage,
  finishQueueDrainBench,
  recordPendingMessagesFetched,
} from '$lib/mls-client/catchupBenchmark';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { getToken } from '$lib/stores/auth';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * Abstract base class shared by WebMlsService (WASM) and TauriMlsService (Rust native).
 *
 * Contains every field and method that is identical between the two platforms:
 * - All `/api/mls/*` delivery REST wrappers (delegated to {@link MlsDeliveryApi})
 * - WebSocket callback registrations (onMessage, onDisconnect, etc.)
 * - Queue plumbing (enqueueMessage, waitForMessageQueueIdle, processQueue, fetchPendingMessages)
 * - Pending-retry scheduling (pendingRetryTimer / scheduleRetry)
 * - Lifecycle boilerplate (init promise dedup, destroy base listeners)
 *
 * Platform-specific code lives exclusively in the subclasses:
 * - WebMlsService: WASM client, key-package worker, browser WebSocket
 * - TauriMlsService: invoke() calls, native WebSocket, epoch/group caches
 */
export abstract class BaseMlsService implements IMlsService {
  // ── Platform identity ─────────────────────────────────────────────────────
  protected readonly platform: 'web' | 'tauri';

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onChannelEvent?: (event: { type: string; data: unknown }) => void;

  protected messageCallback:
    | ((
        senderId: string,
        content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean,
        ratchetTreeBytes?: Uint8Array,
        isCommit?: boolean,
        deliveryMeta?: IncomingDeliveryMeta
      ) => Promise<boolean>)
    | null = null;

  protected disconnectCallback: (() => void) | null = null;

  protected welcomeRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  protected welcomeProcessedCallback: ((groupId?: string) => void) | null = null;

  // ── URLs & identity ───────────────────────────────────────────────────────
  protected baseUrl: string;
  protected historyUrl: string;
  protected userId = 'unknown';
  protected deviceId = 'pending';

  // ── Delivery REST client ──────────────────────────────────────────────────
  protected readonly delivery: MlsDeliveryApi;

  // ── Init dedup ────────────────────────────────────────────────────────────
  protected initPromise: Promise<void> | null = null;
  /** True when MLS is initialized without an existing state blob (fresh device). */
  protected freshStart = false;
  /** Epoch ms of the last {@link republishKeyMaterial} run, used to debounce it. */
  private lastKeyMaterialRepublish = 0;

  // ── Timers & event handlers ───────────────────────────────────────────────
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected _visibilityHandler: (() => void) | null = null;
  protected _onlineHandler: (() => void) | null = null;

  // ── In-session retry timer ────────────────────────────────────────────────
  /**
   * Reschedules `fetchPendingMessages` after PENDING_RETRY_DELAY_MS when a queued
   * message returned `false` from the callback (rather than waiting for a reconnect).
   */
  private pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PENDING_RETRY_DELAY_MS = 15_000;

  // ── Message queue ─────────────────────────────────────────────────────────
  /** Per-conversation queues with round-robin scheduling and a global MLS mutex. */
  protected readonly messageScheduler: MlsPerGroupScheduler;

  /** Persistence-only window: no UI buffering, no overlay (default for {@link withMlsBulkIngest}). */
  private static readonly PERSIST_ONLY_PHASE: BulkIngestPhase = {
    bufferUi: false,
    showOverlay: false,
  };

  /** Lifecycle observers of bulk-ingest windows (MLS state persister, UI render buffer). */
  private readonly bulkIngestObservers: BulkIngestObserver[] = [];

  /** Stack of open phases, so {@link endBulkIngest} replays the exact phase its open used. */
  private readonly bulkIngestPhases: BulkIngestPhase[] = [];

  constructor(platform: 'web' | 'tauri', fetchImpl?: MlsDeliveryFetch) {
    this.platform = platform;
    // Device ID is resolved per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.messageScheduler = new MlsPerGroupScheduler(platform);
    this.delivery = new MlsDeliveryApi({
      historyUrl: this.historyUrl,
      getToken,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the MLS identity, deduplicating concurrent calls via a shared promise.
   * Delegates actual init to the platform-specific {@link _initImpl}.
   */
  async init(
    userId: string,
    pin: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const p = this._initImpl(userId, pin, state, opts);
    this.initPromise = p;
    try {
      await p;
    } catch (e) {
      // Clear the cached promise so a failed init (e.g. undecryptable state pending
      // recovery) can be retried instead of returning the same rejection forever.
      this.initPromise = null;
      throw e;
    }
  }

  /** Platform-specific init body (WASM load vs Tauri invoke). */
  protected abstract _initImpl(
    userId: string,
    pin: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;

  /**
   * Platform-specific decrypt + client init for a given PIN and (optional) saved state.
   * Throws on a wrong PIN / unusable state - and unlike {@link _initImpl} performs NO
   * fresh-start fallback, so callers can probe a candidate PIN non-destructively.
   * `this.userId` and `this.deviceId` must already be resolved.
   */
  protected abstract loadStateWithPin(pin: string, state?: Uint8Array): Promise<void>;

  /**
   * Forgot-PIN-elsewhere recovery: the account PIN was changed on another device, so this
   * device's local state is still sealed under the OLD pin. Decrypts it with `oldPin`
   * (non-destructively - no fresh-start, device id untouched) then re-encrypts it under
   * `newPin` via {@link changePIN}, preserving all local messages. Marks the client as
   * initialised so a following {@link init}/login reuses it instead of re-decrypting.
   *
   * Returns `false` when `oldPin` does not decrypt the local state (so the caller can show
   * an "ancien PIN incorrect" error); `true` on success.
   */
  async recoverAndRekey(
    userId: string,
    oldPin: string,
    newPin: string,
    state: Uint8Array
  ): Promise<boolean> {
    this.userId = userId;
    this.delivery.userId = userId;
    await this.resolveDeviceId(userId);
    try {
      await this.loadStateWithPin(oldPin, state);
    } catch (e) {
      console.warn(
        '[MLS] recoverAndRekey: old PIN did not decrypt local state:',
        String(e).slice(0, 160)
      );
      return false;
    }
    await this.changePIN(newPin);
    // The client is already decrypted in memory and the persisted blob is now re-encrypted
    // under newPin; short-circuit init() so the subsequent login reuses this exact client.
    this.initPromise = Promise.resolve();
    return true;
  }

  /**
   * Removes shared event listeners and clears the heartbeat timer.
   * Calls {@link destroyPlatformResources} for subclass-specific teardown.
   */
  destroy(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pendingRetryTimer !== null) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    this.destroyPlatformResources();
  }

  /** Override to release platform-specific resources (e.g. Worker, native WebSocket). */
  protected destroyPlatformResources(): void {}

  // ── WebSocket (platform-specific) ─────────────────────────────────────────

  abstract connect(token?: string): Promise<void>;
  abstract isWsOpen(): boolean;
  abstract sendDisconnect(): void;

  abstract sendTyping(groupId: string, isTyping: boolean): void;

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array,
      isCommit?: boolean,
      deliveryMeta?: IncomingDeliveryMeta
    ) => Promise<boolean>
  ): void {
    this.messageCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  onWelcomeRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.welcomeRequestCallback = callback;
  }

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  addBulkIngestObserver(observer: BulkIngestObserver): void {
    this.bulkIngestObservers.push(observer);
  }

  beginBulkIngest(phase: BulkIngestPhase = BaseMlsService.PERSIST_ONLY_PHASE): void {
    this.bulkIngestPhases.push(phase);
    for (const observer of this.bulkIngestObservers) observer.onBulkIngestStart(phase);
  }

  async endBulkIngest(): Promise<void> {
    const phase = this.bulkIngestPhases.pop();
    if (!phase) {
      console.warn('[QUEUE] endBulkIngest sans beginBulkIngest correspondant - ignoré');
      return;
    }
    // Replay the exact phase the matching open used: start and end can never disagree.
    for (const observer of this.bulkIngestObservers) await observer.onBulkIngestEnd(phase);
  }

  // ── Message queue ─────────────────────────────────────────────────────────

  /** Resolves when all per-group MLS queues are drained. */
  async waitForMessageQueueIdle(): Promise<void> {
    return this.messageScheduler.waitUntilIdle();
  }

  /** Runs `fn` under the global MLS client mutex (shared with the drain and catch-up sessions). */
  runUnderMlsLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.messageScheduler.runUnderMlsLock(fn);
  }

  /** Enqueues a message and starts the per-group fair drain loop if idle. */
  protected enqueueMessage(msg: MlsQueuedMessage): void {
    this.messageScheduler.enqueue(msg);
    if (!this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Schedules an in-session retry of `fetchPendingMessages` after PENDING_RETRY_DELAY_MS.
   * Only fires if the WebSocket is still open at the time of execution.
   * Cancels any previously scheduled retry before registering a new one.
   */
  protected scheduleRetry(): void {
    if (this.pendingRetryTimer !== null) clearTimeout(this.pendingRetryTimer);
    this.pendingRetryTimer = setTimeout(() => {
      this.pendingRetryTimer = null;
      if (this.isWsOpen()) {
        console.log('[QUEUE] In-session retry: fetchPendingMessages (unacknowledged message)');
        void this.fetchPendingMessages();
      }
    }, BaseMlsService.PENDING_RETRY_DELAY_MS);
  }

  /** Drains per-group queues with round-robin scheduling and a global MLS mutex. */
  protected async processQueue(): Promise<void> {
    if (!this.messageCallback) {
      console.warn('[QUEUE] messageCallback not set - queued messages will not be processed');
      return;
    }

    const ackIds: string[] = [];
    let hadFailedQueuedMessage = false;

    await this.messageScheduler.drain(
      async (msg) => {
        const groupId = msg.groupId;
        recordQueueDrainMessage(groupId);

        // group_reset control messages: ACK and ignore on both platforms.
        // The WebSocket reconnect is sufficient to re-sync state.
        if (msg.type === 'group_reset') {
          console.log(`[QUEUE] group_reset (control) ignored - group=${groupId ?? 'unknown'}`);
          if (shouldAckGroupResetControl({ hasQueuedId: Boolean(msg.queuedMessageId) })) {
            ackIds.push(msg.queuedMessageId!);
          }
          return;
        }

        try {
          console.log(
            `[QUEUE] Processing ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} group=${groupId ?? 'unknown'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const deliveryMeta: IncomingDeliveryMeta | undefined =
            msg.queuedCreatedAt !== undefined || msg.queuedMessageId
              ? {
                  ...(msg.queuedCreatedAt !== undefined
                    ? { queuedCreatedAt: msg.queuedCreatedAt }
                    : {}),
                  ...(msg.queuedMessageId ? { queuedMessageId: msg.queuedMessageId } : {}),
                }
              : undefined;

          const cbResult = await this.messageCallback!(
            msg.senderId,
            msg.ciphertext,
            msg.groupId,
            msg.isWelcome,
            msg.ratchetTreeBytes,
            msg.isCommit,
            deliveryMeta
          );

          console.log(
            `[QUEUE] messageCallback → ${cbResult} (group=${groupId ?? 'unknown'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const flags = {
            isWelcome: msg.isWelcome,
            isCommit: msg.isCommit,
            hasQueuedId: Boolean(msg.queuedMessageId),
          };
          if (shouldAckAfterSuccess(cbResult, flags) && msg.queuedMessageId) {
            ackIds.push(msg.queuedMessageId);
          } else if (flags.hasQueuedId && cbResult === false) {
            hadFailedQueuedMessage = true;
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          if (msg.isWelcome && groupId) {
            this.messageScheduler.reinjectAfterWelcome(groupId);
            this.welcomeProcessedCallback?.(groupId);
          }

          // Platform hook: called after each successful message (e.g. Tauri epoch cache refresh).
          await this.onMessageProcessed(groupId);
        } catch (e) {
          console.error(`[QUEUE] Error processing message:`, e);

          if (msg.isWelcome) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'welcome_error',
            });
            console.error(
              `[QUEUE] Welcome failed for group=${groupId} - NOT ACKed, retry on reconnect`
            );
            if (groupId) this.messageScheduler.clearWelcomePending(groupId);
          } else {
            const exFlags = {
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
              hasQueuedId: Boolean(msg.queuedMessageId),
            };
            if (shouldAckAfterException(exFlags) && msg.queuedMessageId) {
              ackIds.push(msg.queuedMessageId);
            } else if (exFlags.hasQueuedId) {
              logMlsMetric({
                kind: 'queue_skip_ack',
                platform: this.platform,
                reason: 'exception_non_commit',
                isWelcome: msg.isWelcome,
                isCommit: msg.isCommit,
              });
            }
            if (groupId && this.messageScheduler.hasWelcomePending(groupId)) {
              this.messageScheduler.reinjectAfterWelcome(groupId);
            }
          }
        }
      },
      {
        onDrainStart: (pendingCount) => {
          beginQueueDrainBench(pendingCount);
          // Live drain: buffer decrypted messages for one grouped UI flush; show the overlay
          // only for a multi-message catch-up. endBulkIngest replays this exact phase.
          this.beginBulkIngest({ bufferUi: true, showOverlay: pendingCount > 1 });
        },
        onDrainEnd: async () => {
          if (ackIds.length > 0) {
            logMlsMetric({ kind: 'queue_ack', platform: this.platform, count: ackIds.length });
            void this.delivery
              .ackMessages(ackIds)
              .catch((e) => console.warn('[ACK] drain ack failed:', e));
          }

          // In-session retry: if a message was not ACKed, reschedule fetchPendingMessages
          // rather than waiting for the next reconnect.
          if (hadFailedQueuedMessage) {
            this.scheduleRetry();
          }

          finishQueueDrainBench(ackIds.length);
          await this.endBulkIngest();
        },
      }
    );

    // Messages that arrived via WebSocket while onDrainEnd was awaiting (draining=true)
    // were enqueued but could not start a new drain. Restart here so they are not stuck.
    if (this.messageScheduler.getPendingCount() > 0 && !this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Platform hook called after each successfully processed message.
   * Override in subclasses to perform platform-specific post-processing
   * (e.g. refreshing epoch cache on Tauri).
   */
  protected async onMessageProcessed(_groupId: string | undefined): Promise<void> {}

  /** Fetches offline-queued messages from the delivery service and routes each through the priority queue. */
  async fetchPendingMessages(): Promise<void> {
    if (this.userId === 'unknown') return;

    void this.delivery.ackMessages([]).catch(() => {});

    const FETCH_TIMEOUT = 10_000;

    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      const messages = await this.delivery.pullPendingMessagesJson(ctrl.signal);
      clearTimeout(tid);

      if (Array.isArray(messages)) {
        if (messages.length > 0) {
          recordPendingMessagesFetched(messages.length);
          console.log(`[PENDING] Fetched ${messages.length} pending messages`);

          // Route all pending messages through the serialized queue so they
          // never race with live WebSocket messages calling messageCallback.
          for (const msg of messages as Record<string, unknown>[]) {
            const msgId = (msg.id || msg._id) as string | undefined;
            const queuedCreatedAt = parseServerTimestampMs(msg.createdAt);
            const proto: string | undefined = typeof msg.proto === 'string' ? msg.proto : undefined;

            // ── Control messages (group_reset persisted for offline devices) ──
            // These have no MLS payload (empty proto). Both platforms ACK and ignore:
            // WebSocket reconnect is sufficient to re-sync state.
            if (msg.type === 'group_reset') {
              this.enqueueMessage({
                senderId: (msg.senderId as string) || 'unknown',
                ciphertext: new Uint8Array(0),
                groupId: (msg.groupId as string) || undefined,
                isWelcome: false,
                isCommit: false,
                queuedMessageId: msgId,
                type: 'group_reset',
                queuedCreatedAt,
              });
              continue;
            }

            if (proto) {
              try {
                const ciphertext = fromBase64(proto);
                if (ciphertext.length > 0) {
                  this.enqueueMessage({
                    senderId: (msg.senderId as string) || 'unknown',
                    ciphertext,
                    groupId: (msg.groupId as string) || undefined,
                    isWelcome: msg.isWelcome === true,
                    isCommit: msg.isCommit === true,
                    ratchetTreeBytes:
                      typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                        ? fromBase64(msg.ratchetTree as string)
                        : undefined,
                    queuedMessageId: msgId,
                    queuedCreatedAt,
                  });
                }
              } catch (e) {
                console.error('[PENDING] Failed to enqueue proto message:', e);
              }
            }
          }
        } else {
          console.log(`[PENDING] No pending MLS messages for ${this.userId}:${this.deviceId}`);
        }
      } else {
        console.warn(
          `[PENDING] Pending message fetch failed or non-array (${this.userId}:${this.deviceId})`
        );
      }
    } catch (e) {
      console.error('[PENDING] Failed to fetch pending messages:', e);
    }
    await this.waitForMessageQueueIdle();
  }

  // ── Delivery wrappers ─────────────────────────────────────────────────────
  // All methods below are pure pass-throughs to this.delivery. Both Web and Tauri
  // implementations were 100% identical, so they live here once.

  /** Announces to group members that this device needs a Welcome. */
  async sendWelcomeRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('welcome-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  async clearPendingWelcomeRequests(groupId: string): Promise<void> {
    await this.delivery.clearPendingWelcomeRequests(groupId);
  }

  /** Delivers a Welcome message to the target user/device. */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    return this.delivery.sendWelcome(
      welcomeBytes,
      targetUserId,
      groupId,
      targetDeviceId,
      ratchetTreeBytes
    );
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Resolves (or generates and persists) this device's stable per-user id WITHOUT
   * touching the encrypted MLS state. Safe to call before {@link init}, so the PIN
   * can be verified against the real deviceId before any state decryption /
   * fresh-start can run - a wrong PIN must never delete/revoke the device.
   *
   * Resolution order: in-memory (already resolved) → localStorage → native restore
   * (Tauri push context) → freshly generated. The result is cached on the instance
   * and mirrored to the delivery client, so the subsequent {@link init} reuses it.
   */
  async resolveDeviceId(userId: string): Promise<string> {
    if (this.deviceId && this.deviceId !== 'pending') return this.deviceId;
    const deviceKey = `mls_device_id_${userId}`;
    const stored = localStorage.getItem(deviceKey);
    let resolved = stored;
    if (!resolved) {
      resolved = (await this.restoreDeviceIdFromNative(userId)) ?? this.generateDeviceId(userId);
      localStorage.setItem(deviceKey, resolved);
    }
    this.deviceId = resolved;
    this.delivery.deviceId = resolved;
    return resolved;
  }

  /**
   * Platform hook: restore a previously-used device id from native storage when
   * localStorage was cleared (Tauri reads push_context.json to avoid a credential
   * mismatch after a WebView eviction / reinstall). Web has no native store → null.
   */
  protected async restoreDeviceIdFromNative(_userId: string): Promise<string | null> {
    return null;
  }

  /** Generates a fresh, unique per-user device id prefixed with the platform tag. */
  protected generateDeviceId(userId: string): string {
    return `${this.platform}-${userId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  }

  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    return this.delivery.fetchUserDevices(userId);
  }

  /**
   * Supprime tous les one-time prekeys publiés puis régénère le matériel de clé
   * (fallback statique + pool) depuis le keystore local courant via
   * {@link generateKeyPackage}. Garantit qu'aucun KeyPackage publié ne référence
   * une clé privée absente localement - la racine de la boucle `NoMatchingKeyPackage`.
   *
   * Débounce les appels rapprochés (≤ 30 s) : plusieurs groupes peuvent échouer en
   * même temps, mais une seule purge/régénération (coûteuse, jusqu'à 50 KeyPackages)
   * suffit à réconcilier tout le matériel publié.
   */
  async republishKeyMaterial(pin: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastKeyMaterialRepublish < 30_000) return;
    this.lastKeyMaterialRepublish = now;
    await this.delivery.deleteAllOneTimePrekeys();
    await this.generateKeyPackage(pin);
  }

  /**
   * Valide chaque one-time prekey publié et purge du serveur ceux dont on n'a plus la
   * clé privée locale (état réinitialisé/restauré). Conservateur : ne purge que les
   * orphelins *prouvés* (KeyPackage validé mais absent du keystore) ; un KeyPackage
   * non validable est laissé en place (un pair pourrait le valider). Best-effort.
   */
  async reconcilePublishedKeyPackages(): Promise<void> {
    const published = await this.delivery.listOwnPrekeys();
    if (published.length === 0) return;

    const orphanIds: string[] = [];
    for (const { id, keyPackage } of published) {
      try {
        if (!(await this.keyPackageHasPrivate(keyPackage))) orphanIds.push(id);
      } catch {
        // KeyPackage non désérialisable/validable localement : on ne le purge pas.
      }
    }

    if (orphanIds.length > 0) {
      await this.delivery.pruneOwnPrekeys(orphanIds);
      console.log(
        `[MLS] reconcilePublishedKeyPackages: purged ${orphanIds.length}/${published.length} orphaned prekey(s)`
      );
    }
  }

  /** True si le keystore local possède encore la clé privée du KeyPackage public fourni. */
  protected abstract keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean>;

  async fetchDeviceKeyPackage(
    userId: string,
    deviceId: string
  ): Promise<{
    keyPackage: Uint8Array;
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  } | null> {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    return this.delivery.publishKeyPackages(packages);
  }

  async updateDeviceMetadata(
    userId: string,
    deviceId: string,
    metadata: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string }
  ): Promise<{
    status: string;
    deviceName: string | null;
    deviceOs: string | null;
    deviceAppVersion: string | null;
  }> {
    return this.delivery.updateDeviceMetadata(userId, deviceId, metadata);
  }

  async acquireAddLock(groupId: string, ttlMs = MLS_ADD_LOCK_TTL_MS): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  async acquireRebootLock(groupId: string, ttlMs = MLS_REBOOT_LOCK_TTL_MS): Promise<boolean> {
    return this.delivery.acquireRebootLock(groupId, ttlMs);
  }

  async releaseRebootLock(groupId: string): Promise<void> {
    return this.delivery.releaseRebootLock(groupId);
  }

  async createRemoteGroup(name: string, isGroup = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number
  ): Promise<import('$lib/mls-client/historyTypes').HistoryStreamRow[]> {
    return this.delivery.fetchHistory(groupId, afterStreamId, limit);
  }

  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>> {
    return this.delivery.fetchHistoryBatch(groups);
  }

  async fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
  }> {
    return this.delivery.fetchCommitsSince(groupId, sinceEpoch);
  }

  async forceLeaveGroup(groupId: string): Promise<void> {
    try {
      await this.delivery.deliveryPost(`groups/${groupId}/force_leave`, {
        deviceId: this.deviceId,
      });
    } catch (e) {
      console.warn('[MLS] forceLeaveGroup error (non-fatal):', e);
    }
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  async setGroupImage(groupId: string, mediaId: string | null): Promise<void> {
    return this.delivery.setGroupImage(groupId, mediaId);
  }

  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  async getGroupUserMembers(groupId: string): Promise<{ userId: string }[]> {
    return this.delivery.getGroupUserMembers(groupId);
  }

  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  async getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta> {
    return this.delivery.getGroupServerStatus(groupId);
  }

  async getDismissedGroups(): Promise<string[]> {
    return this.delivery.getDismissedGroups();
  }

  async dismissGroup(groupId: string): Promise<void> {
    return this.delivery.dismissGroup(groupId);
  }

  async undismissGroup(groupId: string): Promise<void> {
    return this.delivery.undismissGroup(groupId);
  }

  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string,
    claimedByDeviceId?: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    return this.delivery.claimGroupSuccessor(deadGroupId, successorId, claimedByDeviceId);
  }

  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  async getDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      deviceId: string;
      groupId: string;
      status: string;
    }>
  > {
    return this.delivery.getDeviceMemberships(userId, deviceId);
  }

  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status);
  }

  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  async deleteDevice(
    userId: string,
    deviceId: string
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    return this.delivery.deleteDevice(userId, deviceId);
  }

  // ── Shared MLS decrypt session (overridden on Web for the worker path) ─────

  /** Sequential, in-place session used by Tauri and when the crypto worker is disabled. */
  async createDecryptSession(groupId: string): Promise<MlsDecryptSession> {
    return createSequentialDecryptSession(this, groupId);
  }

  /**
   * Default no-op: only Tauri/Android has a background JNI engine that can advance `mls.bin`
   * while the app is backgrounded, so only TauriMlsService overrides this to reload (C2). On
   * web/desktop the in-memory engine is the sole writer; there is nothing to reload.
   */
  async reloadStateFromDisk(): Promise<void> {}

  // ── Platform-specific (abstract) ──────────────────────────────────────────

  abstract saveState(pin: string): Promise<Uint8Array>;
  abstract changePIN(newPin: string): Promise<void>;
  abstract generateKeyPackage(pin: string): Promise<Uint8Array>;
  abstract publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  abstract createGroup(groupId: string): Promise<void>;
  abstract forceCreateGroup(groupId: string): Promise<void>;

  // ── One commit regime (C7-A unified: stage -> validate -> merge/clear) ──────
  //
  // Every structural commit (ADD and REMOVE) runs through runCommitTransaction: the stage step
  // produces the commit WITHOUT merging, the server validates the epoch, then we merge (accept) or
  // clear (reject). A rejected commit therefore never leaves the local epoch ahead, so the whole
  // class of "sender fork" desyncs disappears. The platform primitives below (stage / merge / clear
  // / export tree / fresh epoch) are the only pieces that differ between WASM and native.

  /** Stages an Add commit WITHOUT merging. Returns the commit, shared Welcome, and the input
   *  positions actually added / dropped-as-invalid (already-member dedup is silent). */
  protected abstract stageAddMembers(
    groupId: string,
    keyPackages: Uint8Array[]
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedIndices: number[];
    skippedIndices: number[];
  }>;
  /** Stages a Remove commit (all devices of the given users) WITHOUT merging. Returns the commit. */
  protected abstract stageRemoveMembers(groupId: string, userIds: string[]): Promise<Uint8Array>;
  /** Stages a Remove commit for specific devices ("userId:deviceId") WITHOUT merging. */
  protected abstract stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[]
  ): Promise<Uint8Array>;
  /** Merges the pending staged commit (server accepted): advances the local epoch. */
  protected abstract mergePendingCommit(groupId: string): Promise<void>;
  /** Clears the pending staged commit (server rejected): local epoch unchanged, no fork. */
  protected abstract clearPendingCommit(groupId: string): Promise<void>;
  /** Exports the group's ratchet tree from the CURRENT (post-merge) state for the Welcome. */
  protected abstract exportRatchetTree(groupId: string): Promise<Uint8Array>;
  /** Reads the authoritative current (pre-merge) epoch for server validation. */
  protected abstract freshEpoch(groupId: string): Promise<number>;
  /** Exports a self-contained GroupInfo (ratchet tree included) for the external-join base. */
  protected abstract exportGroupInfo(groupId: string): Promise<Uint8Array>;
  /** Builds an external commit from a served GroupInfo and stages it locally (group at epoch+1).
   *  Returns the resolved group id and the commit to submit for server epoch validation. */
  protected abstract joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }>;

  /**
   * Runs one staged commit transaction under the MLS lock: stage (no merge) -> validate the epoch
   * server-side -> merge (accept) or clear (reject, throws). On accept it broadcasts the commit
   * (skipping `excludeDeviceIds`) and, when `exportTree` is set, exports the post-merge ratchet
   * tree for the caller to deliver in the Welcome. The network preamble that builds the stage
   * inputs stays OUTSIDE this method; only the stage->merge unit is locked.
   */
  protected async runCommitTransaction(
    groupId: string,
    stageFn: () => Promise<{
      commit: Uint8Array;
      welcome?: Uint8Array;
      addedDeviceIds?: string[];
      skippedDeviceIds?: string[];
    }>,
    opts: { excludeDeviceIds?: string[]; exportTree?: boolean } = {}
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skippedDeviceIds: string[];
  }> {
    const out = await this.runUnderMlsLock(async () => {
      const staged = await stageFn();
      // baseEpoch = current (pre-merge) epoch: the staged commit will transition N -> N+1.
      const baseEpoch = await this.freshEpoch(groupId);
      // One atomic server round-trip: validate the epoch, and on accept the server records the
      // commit in the epoch-indexed log (rung-1 replay) AND fans it out to members. If we crash
      // between this accept and the local merge below, our epoch lags the server by one - a gap the
      // rung-1 replay heals on the next sync, no longer a destructive fork. [[C7]]
      const validation = await this.delivery.submitCommit(
        groupId,
        baseEpoch,
        toBase64(staged.commit),
        opts.excludeDeviceIds
      );
      if (!validation.accepted) {
        // Rejected: roll back the staged commit. The local epoch never moved, so there is NO fork.
        // Throw without the `server epoch:.., sent:..` marker so the caller treats it as a
        // retryable failure rather than a fork to heal. [[C7]]
        await this.clearPendingCommit(groupId).catch(() => {});
        throw new Error(`Staged commit rejected: ${validation.reason || 'epoch_mismatch'}`);
      }
      await this.mergePendingCommit(groupId);
      const ratchetTree = opts.exportTree ? await this.exportRatchetTree(groupId) : undefined;
      return {
        welcome: staged.welcome,
        ratchetTree,
        addedDeviceIds: staged.addedDeviceIds ?? [],
        skippedDeviceIds: staged.skippedDeviceIds ?? [],
      };
    });
    // The commit advanced the epoch: refresh the external-join base so a member lacking state can
    // self-join at the new epoch. Best-effort, off the critical path; skipped on reject (the closure
    // above throws before we get here, so the epoch never moved). [[Phase 4]]
    void this.refreshGroupInfo(groupId);
    return out;
  }

  /**
   * Exports the current GroupInfo and pushes it to the delivery service (external-join base, Phase 4).
   * Refreshed after every commit (a new group's first member-add is itself a commit) so an authorized
   * member lacking MLS state can self-join at the current epoch. Best-effort: never throws (a failed
   * refresh only means a joiner
   * may momentarily get a one-epoch-stale base and retry).
   */
  async refreshGroupInfo(groupId: string): Promise<void> {
    try {
      const groupInfo = await this.exportGroupInfo(groupId);
      const baseEpoch = this.getEpoch(groupId);
      await this.delivery.storeGroupInfo(groupId, toBase64(groupInfo), baseEpoch);
    } catch (e) {
      console.warn(
        `[MLS] refreshGroupInfo failed for ${groupId.slice(0, 8)}…:`,
        String(e).slice(0, 120)
      );
    }
  }

  /**
   * Attempts to (re)join `groupId` via an external commit built from the server-stored GroupInfo,
   * WITHOUT a peer Welcome. This is the self-service recovery seam (Phase 4): a member with no local
   * MLS state fetches the current GroupInfo, builds an external commit, and submits it under the
   * standard epoch gate. On an epoch-race reject it discards the group and retries with a fresher
   * GroupInfo (this replaces the CAS/successor dance - no peer liveness required).
   *
   * Returns true on success. Returns false when no GroupInfo is available (never stored, or the
   * caller is not an authorized member), or the build fails, or the epoch race is lost repeatedly -
   * the caller then falls back to the legacy welcome_request path.
   */
  async externalJoin(groupId: string): Promise<boolean> {
    const excludeSelf = [`${this.userId}:${this.deviceId}`];
    for (let attempt = 0; attempt < 3; attempt++) {
      const gi = await this.delivery.fetchGroupInfo(groupId).catch(() => null);
      if (!gi) return false; // nothing stored / not a member -> fall back to welcome_request

      let joined: { groupId: string; commit: Uint8Array };
      try {
        joined = await this.runUnderMlsLock(() =>
          this.joinByExternalCommit(fromBase64(gi.groupInfo))
        );
      } catch (e) {
        // Build failed (e.g. the group is already held locally) -> fall back.
        console.warn(
          `[MLS] externalJoin build failed for ${groupId.slice(0, 8)}…:`,
          String(e).slice(0, 120)
        );
        return false;
      }

      // Submit under the epoch gate against the GroupInfo's base epoch. The server fans the external
      // commit out to existing members (excluding this device, which already applied it).
      const validation = await this.delivery
        .submitCommit(joined.groupId, gi.baseEpoch, toBase64(joined.commit), excludeSelf)
        .catch(() => ({ accepted: false, reason: 'network' as const }));

      if (validation.accepted) {
        await this.runUnderMlsLock(() => this.mergePendingCommit(joined.groupId));
        void this.refreshGroupInfo(joined.groupId);
        console.log(
          `[MLS] externalJoin succeeded for ${joined.groupId.slice(0, 8)}… (base epoch ${gi.baseEpoch})`
        );
        return true;
      }

      // Rejected: a newer commit landed since we fetched the GroupInfo. An external commit cannot be
      // cleared, so discard the group and retry with a fresher GroupInfo.
      this.forgetGroup(joined.groupId);
      console.log(
        `[MLS] externalJoin epoch race for ${joined.groupId.slice(0, 8)}… (base ${gi.baseEpoch}) - retrying`
      );
    }
    return false;
  }

  async addMember(
    groupId: string,
    keyPackageBytes: Uint8Array,
    excludeDeviceIds?: string[]
  ): Promise<{ welcome?: Uint8Array; ratchetTree?: Uint8Array }> {
    const result = await this.runCommitTransaction(
      groupId,
      async () => {
        const staged = await this.stageAddMembers(groupId, [keyPackageBytes]);
        return { commit: staged.commit, welcome: staged.welcome };
      },
      { excludeDeviceIds, exportTree: true }
    );
    return { welcome: result.welcome, ratchetTree: result.ratchetTree };
  }

  async addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>,
    excludeDeviceIds?: string[]
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skippedDeviceIds: string[];
  }> {
    return this.runCommitTransaction(
      groupId,
      async () => {
        const staged = await this.stageAddMembers(
          groupId,
          devices.map((d) => d.keyPackage)
        );
        return {
          commit: staged.commit,
          welcome: staged.welcome,
          addedDeviceIds: staged.addedIndices.map((i) => devices[i].deviceId),
          skippedDeviceIds: staged.skippedIndices.map((i) => devices[i].deviceId),
        };
      },
      { excludeDeviceIds, exportTree: true }
    );
  }

  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    await this.runCommitTransaction(groupId, async () => ({
      commit: await this.stageRemoveMembers(groupId, userIds),
    }));
  }

  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    await this.runCommitTransaction(groupId, async () => ({
      commit: await this.stageRemoveMembersByDevice(groupId, deviceIdentities),
    }));
  }

  abstract processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  abstract sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    silent?: boolean
  ): Promise<Uint8Array>;
  abstract processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null>;
  abstract exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;
  abstract getLocalGroups(): string[];
  abstract getEpoch(groupId: string): number;
  abstract forgetGroup(groupId: string, minEpoch?: number): void;
  abstract dropGroup(groupId: string): void;
}
