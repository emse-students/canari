import type {
  IMlsService,
  GroupMeta,
  UserGroupRow,
  MlsInitOptions,
  BulkIngestPhase,
  BulkIngestObserver,
} from '$lib/mls-client';
import { MlsDeliveryApi, resolveMlsPublicUrls, MLS_ADD_LOCK_TTL_MS } from '$lib/mls-client';
import {
  type MlsDecryptSession,
  createSequentialDecryptSession,
} from '$lib/mls-client/mlsDecryptSession';
import { DeviceRevokedError, type MlsDeliveryFetch } from '$lib/mls-client/mlsDeliveryApi';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import {
  MAX_BURN_GENERATIONS,
  commitPersisted,
  noteFrameEmitted,
  pendingSendGenerations,
  resetSendRatchetLedger,
  snapshotEmitted,
} from '$lib/mls-client/sendRatchetLedger';
import type { HistoryRequestOutcome, IncomingDeliveryMeta } from '$lib/mls-client/IMlsService';
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
import {
  reportUnackedFrames,
  takeGroupsAwaiting,
  type UnackedReason,
} from '$lib/mls-client/messagePipeline/unackedFrames';
import { getToken } from '$lib/stores/auth';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * Abstract base class shared by WebMlsService (WASM) and TauriMlsService (Rust native).
 *
 * Contains every field and method that is identical between the two platforms:
 * - All `/api/mls/*` delivery REST wrappers (delegated to {@link MlsDeliveryApi})
 * - WebSocket callback registrations (onMessage, onDisconnect, etc.)
 * - Queue plumbing (enqueueMessage, waitForMessageQueueIdle, processQueue, fetchPendingMessages)
 * - Event-driven re-fetch of frames the handler left unacknowledged (refetchFramesLeftBehind)
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

  protected historyRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  protected welcomeProcessedCallback: ((groupId?: string) => void) | null = null;

  /**
   * Raised when the server says THIS device has been revoked, while it is still connected.
   *
   * Distinct from the revocation the key-package path already handles: that one is discovered by
   * asking, on the next enrolment, and answered by rotating to a fresh identity. This one arrives
   * unprompted at the moment its owner deletes the device, and the answer is the opposite - there
   * is no identity to continue under, so the session ends and the device is returned to a fresh
   * install.
   */
  protected deviceRevokedCallback: (() => void) | null = null;

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
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const p = this._initImpl(userId, deviceKeyB64, state, opts).then(() =>
      // BEFORE ANYTHING CAN SEND, and inside the promise every caller already awaits: a send racing
      // the repair would be encrypted at the very generation the repair exists to move past.
      this.reconcileSendRatchets(deviceKeyB64)
    );
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

  /**
   * Classifies why {@link loadStateWithKey} rejected, so `_initImpl` can pick a recovery that
   * actually addresses the cause.
   *
   * The distinction is not cosmetic. `sealed` means the blob would not decrypt: the account key
   * changed on another device, and re-entering the OLD PIN recovers it - so the caller must stop
   * and offer that path rather than destroy anything. `mismatch` means the blob DID decrypt and
   * only carries another device's identity; no PIN can fix that, so pausing for a recovery the
   * user cannot complete just strands them. Treating the two alike is what surfaced a false
   * "your PIN was changed on another device" to users who had never changed their PIN.
   */
  protected classifyStateLoadFailure(error: unknown): 'mismatch' | 'sealed' {
    const errStr = String(error);
    return errStr.includes('identity mismatch') || errStr.includes('Credential identity')
      ? 'mismatch'
      : 'sealed';
  }

  /** Platform-specific init body (WASM load vs Tauri invoke). */
  protected abstract _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;

  /**
   * Platform-specific decrypt + client init for a given device key and (optional) saved state.
   * Throws on a wrong key / unusable state - and unlike {@link _initImpl} performs NO
   * fresh-start fallback, so callers can probe a candidate key non-destructively.
   * `this.userId` and `this.deviceId` must already be resolved.
   */
  protected abstract loadStateWithKey(deviceKeyB64: string, state?: Uint8Array): Promise<void>;

  /**
   * Forgot-PIN-elsewhere recovery: the account PIN was changed on another device, so this
   * device's local state is still sealed under the OLD key. Decrypts it with `oldDeviceKeyB64`
   * (non-destructively - no fresh-start, device id untouched) then re-encrypts it under
   * `newDeviceKeyB64` via {@link changeDeviceKey}, preserving all local messages. Marks the
   * client as initialised so a following {@link init}/login reuses it instead of re-decrypting.
   *
   * Returns `false` when `oldDeviceKeyB64` does not decrypt the local state (so the caller can
   * show an "ancien PIN incorrect" error); `true` on success.
   */
  async recoverAndRekey(
    userId: string,
    oldDeviceKeyB64: string,
    newDeviceKeyB64: string,
    state: Uint8Array
  ): Promise<boolean> {
    this.userId = userId;
    this.delivery.userId = userId;
    await this.resolveDeviceId(userId);
    try {
      await this.loadStateWithKey(oldDeviceKeyB64, state);
    } catch (e) {
      console.warn(
        '[MLS] recoverAndRekey: old device key did not decrypt local state:',
        String(e).slice(0, 160)
      );
      return false;
    }
    await this.changeDeviceKey(newDeviceKeyB64);
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
    // The work list of unacknowledged frames belongs to the session, not to this client: it is
    // dropped by `resetUnackedFrames` at logout, and a destroy that kept the socket's successor
    // running must not lose what still needs re-fetching.
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

  onHistoryRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.historyRequestCallback = callback;
  }

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  /** @see deviceRevokedCallback */
  onDeviceRevoked(callback: () => void): void {
    this.deviceRevokedCallback = callback;
  }

  /** Asks the server whether this device is denylisted. `false` when the question cannot be reached. */
  isDeviceRevoked(): Promise<boolean> {
    return this.delivery.isDeviceRevoked();
  }

  addBulkIngestObserver(observer: BulkIngestObserver): void {
    this.bulkIngestObservers.push(observer);
  }

  beginBulkIngest(phase: BulkIngestPhase = BaseMlsService.PERSIST_ONLY_PHASE): void {
    this.bulkIngestPhases.push(phase);
    for (const observer of this.bulkIngestObservers) {
      // Isolated for the same reason as the close below: one observer refusing to OPEN its window
      // must not stop the next from opening one it will be asked to close.
      try {
        observer.onBulkIngestStart(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to start:', e);
      }
    }
  }

  async endBulkIngest(): Promise<void> {
    const phase = this.bulkIngestPhases.pop();
    if (!phase) {
      console.warn('[QUEUE] endBulkIngest without a matching beginBulkIngest - ignored');
      return;
    }
    // Replay the exact phase the matching open used: start and end can never disagree.
    //
    // PER OBSERVER, and that is the whole point. These are independent subscribers - the encrypted
    // state persister and the UI render buffer - and they were being awaited in one bare loop, so
    // the FIRST to reject cancelled every one after it. The persister is registered first and
    // rethrows when a checkpoint fails, which would have left the UI observer's window open
    // forever: `messageCatchupDepth` never comes back down (the sync banner stays up for the rest
    // of the session) and `bulkIngestActive` stays raised, so every later inbound message is
    // buffered instead of rendered and is then discarded by the next drain. A failed disk write
    // must cost a checkpoint, never the message pipeline.
    for (const observer of this.bulkIngestObservers) {
      try {
        await observer.onBulkIngestEnd(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to end (window closed anyway):', e);
      }
    }
  }

  // ── Message queue ─────────────────────────────────────────────────────────

  /**
   * Settles when the offline backlog is being pulled from the server, or immediately when it is not.
   *
   * Covers the FETCH only, never the drain that follows it: {@link fetchPendingMessages} ends by
   * awaiting the barrier below, so a flag held across that tail would make the pull wait on itself.
   */
  private pendingPullInFlight: Promise<void> | null = null;

  /**
   * True while the LAST pull ran to completion - every page fetched, no transport failure.
   *
   * It is what lets {@link waitForMessageQueueIdle} state emptiness instead of idleness. Read
   * together with `isWsOpen()`, never alone: a socket that has since dropped means frames may have
   * been queued while this device was unreachable, and the pull that covers them is the reconnect's
   * (`initializeConnection` runs one immediately after every `connect`). Cleared at the start of
   * each pull, so a pull that failed half-way leaves it false and the next barrier pulls again.
   */
  private mailboxEmptiedByAPull = false;

  /** Open catch-up sessions. A depth rather than a flag: nothing guarantees only one at a time. */
  private catchUpDepth = 0;

  /** Pending while a catch-up is open; `null` when none is. */
  private catchUpGate: Promise<void> | null = null;

  /** Opens {@link catchUpGate}. Held only while `catchUpDepth > 0`. */
  private releaseCatchUpGate: (() => void) | null = null;

  /**
   * How many times the LIVE MLS client has been mutated by something other than a catch-up.
   *
   * Read at the snapshot and again at the swap: if it moved, the state about to be installed
   * predates a mutation the live client already made, and installing it would undo that mutation.
   * A COUNT rather than a flag because the swap has to compare two instants, not ask "recently?".
   */
  protected liveMutations = 0;

  /**
   * Records a mutation of the live MLS client made outside a catch-up.
   *
   * Called by the send path today, which is the only mutation that runs unserialised against a
   * catch-up: everything else goes through the drain, and the drain and the catch-up take the same
   * mutex, so they cannot overlap by construction.
   */
  protected noteLiveMutation(): void {
    this.liveMutations++;
  }

  /**
   * Marks a catch-up session as open, closing the gate every send waits on.
   *
   * THE THIRD ACTOR. Sequencing "drain, then history exchange" orders the two paths that READ this
   * device's store, and leaves the one that WRITES to it - a send - free to land anywhere. On web a
   * send during the window is then overwritten by the swap: measured 2026-08-14 across three runs of
   * MSG-1b, `sendsDuringWindow=1` produced a `LOST frame` twice and `sendsDuringWindow=0` produced
   * none, with the frame named on the LOST line being, byte for byte, the send that followed the
   * rewind. The victim is always the next send after the swap - usually the focused tab's read
   * watermark, which is why the loss looked for days like a property of silent frames.
   */
  protected beginCatchUp(): void {
    this.catchUpDepth++;
    if (this.catchUpDepth === 1) {
      this.catchUpGate = new Promise<void>((resolve) => {
        this.releaseCatchUpGate = resolve;
      });
    }
  }

  /** Marks a catch-up session as closed, releasing every send waiting behind it. */
  protected endCatchUp(): void {
    this.catchUpDepth = Math.max(0, this.catchUpDepth - 1);
    if (this.catchUpDepth === 0) {
      this.releaseCatchUpGate?.();
      this.releaseCatchUpGate = null;
      this.catchUpGate = null;
    }
  }

  /**
   * Resolves when no catch-up session is open.
   *
   * Awaited by the send path, and safe to await from anywhere a send happens today. The drain holds
   * the MLS mutex for each message and a catch-up holds it for its whole life, so no catch-up can be
   * open while a handler runs - a send raised from inside the pipeline therefore never waits here.
   * The one send raised from inside a replay (`reconcileGroup`, on an unreadable frame) is
   * fire-and-forget, so it settles after `finish` rather than blocking it.
   */
  async waitForCatchUpIdle(): Promise<void> {
    await this.catchUpGate;
  }

  /**
   * Resolves when this device's mailbox is EMPTY - nothing left to fetch, and nothing left to apply.
   *
   * BOTH HALVES, because either one alone answers a different question. `waitUntilIdle` says "I have
   * applied everything I received"; it says nothing about what is still sitting on the server, and
   * the backlog is pulled ONE PAGE AT A TIME (`fetchPendingMessages`). Between a drained page and the
   * next one landing, the scheduler is genuinely idle while the mailbox is genuinely full - measured
   * on A1 at 976 rows / 36 MB, which is many pages with real network gaps between them.
   *
   * Every caller of this barrier - the ask, the answer, the archive replay, the outbox flusher -
   * wants the second, stronger fact: a device that has not emptied its mailbox is not a reliable
   * source about its own history, and must neither ask for one nor describe what it holds.
   *
   * Sequential rather than a loop, and that is what makes it terminate: the pull is edge-driven (a
   * connection), so nothing starts a new one while the queue it filled is draining. A pull that DOES
   * begin later is a new edge, which re-triggers the reconciliation by itself.
   *
   * AND IT PULLS IF NOBODY ELSE HAS, which is the half this was missing and the docblock was already
   * claiming (WP-DUPDELIVERY-1). Waiting on `pendingPullInFlight` answers "has the pull that is
   * RUNNING finished" - so with no pull running and a full mailbox on the server, both halves
   * resolved instantly and the caller went on to read the archive with its own frames still queued.
   * Measured on prod 2026-08-15: an archive replay finished at 11:43:10, a pull started at
   * 11:43:12.889 on a connection edge, and the single row it returned was a frame the replay had
   * already read - `Duplicate delivery ... already read by the archive replay`. Every such line in
   * every capture says the archive won, and not one says live delivery, so this arm had never once
   * been the one that fired. The heal was the witness; the overlap is what had to go.
   *
   * The evidence for "empty" is a COMPLETED pull plus a socket still open (see
   * {@link mailboxEmptiedByAPull}), never a duration.
   */
  async waitForMessageQueueIdle(): Promise<void> {
    /**
     * FROM INSIDE A CATCH-UP THIS BARRIER CANNOT RESOLVE, SO IT ACCUSES INSTEAD OF HANGING.
     *
     * A catch-up session holds the global MLS mutex for its whole life (`createDecryptSession` ->
     * {@link beginCatchUp}) and the drain needs that same non-reentrant mutex for every message. A
     * caller that opens one and then waits for its mailbox waits for a drain that cannot start:
     * both sides stop for good, and nothing in the client recovers without a reload.
     *
     * It is a deadlock in theory before it is one in practice, and it shipped once - 2026-08-15, the
     * archive replay took this barrier after opening its session. W2 opened a bulk ingest at
     * 14:58:44.612, the frame arrived 389 ms later, its drain nested to depth 2, and neither ever
     * finished; the server saw the other side of the same event as two frames unACKed and a
     * `PUSH_DEFERRED -> FCM fallback` on a browser with no push token.
     *
     * There is no legitimate caller here - the barrier's whole purpose is to be taken BEFORE the
     * session - so this is a defect report, not a degradation to absorb quietly. The responder legs
     * solve the same problem the other way, by DEFERRING past the drain rather than awaiting it
     * (`answerAfterMailboxDrained`), which is the shape to copy when a call site cannot know whether
     * it runs inside one.
     */
    if (this.catchUpDepth > 0) {
      console.error(
        '[QUEUE] mailbox barrier awaited from inside a catch-up session - it can never resolve there' +
          ' (the drain needs the MLS mutex this session holds), so it was SKIPPED and the caller is' +
          ' proceeding against a mailbox that may not be empty. Take the barrier before opening the' +
          ' session, or defer past the drain instead of awaiting it.'
      );
      return;
    }
    if (
      !this.pendingPullInFlight &&
      !(this.mailboxEmptiedByAPull && this.isWsOpen()) &&
      this.userId !== 'unknown'
    ) {
      // Ends by awaiting `settleMailbox` itself, so this is the whole barrier and not a step of it.
      return this.fetchPendingMessages().catch(() => {});
    }
    return this.settleMailbox();
  }

  /**
   * The wait alone: whatever pull is in flight has landed, and the scheduler has applied it.
   *
   * Split out of {@link waitForMessageQueueIdle} because {@link fetchPendingMessages} ends on it -
   * calling the full barrier there would have the pull wait on itself.
   */
  private async settleMailbox(): Promise<void> {
    await this.pendingPullInFlight?.catch(() => {});
    return this.messageScheduler.waitUntilIdle();
  }

  /** @inheritdoc */
  notifyConversationsRestored(): void {
    this.refetchFramesLeftBehind('absent-conversation', 'conversations restored');
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
   * Re-fetches the delivery queue because the thing that was blocking `reason` has just happened.
   *
   * THIS REPLACED A 15-SECOND TIMER, and the difference is the whole point. The handler leaves a
   * frame unacknowledged for exactly two reasons, and neither of them is discharged by waiting: an
   * unknown group needs its Welcome, an absent conversation needs the local store restore. A clock
   * asking again every fifteen seconds re-fetched the same rows, failed them the same way, and
   * re-opened the catch-up overlay on every cycle - for the whole session, on a device whose group
   * never came back. So the ask is now driven by the EVENT that changes the answer, and there is no
   * cycle to bound: no event, no ask.
   *
   * Silent and free when nothing is waiting, so callers may fire it on any occurrence of the event.
   */
  protected refetchFramesLeftBehind(reason: UnackedReason, trigger: string): void {
    const groups = takeGroupsAwaiting(reason);
    if (groups.length === 0) return;
    if (!this.isWsOpen()) {
      // Nothing to re-fetch over: the reconnect runs a pull of its own, and the handler will note
      // whatever still fails. Dropping the note here is safe for the same reason `take` is.
      console.log(`[QUEUE] ${trigger}: socket closed, the reconnect pull covers it`);
      return;
    }
    console.log(
      `[QUEUE] ${trigger}: re-fetching for ${groups.length} group(s) left behind as ${reason} [${groups
        .map((g) => g.slice(0, 8))
        .join(', ')}]`
    );
    void this.fetchPendingMessages();
  }

  /** Drains per-group queues with round-robin scheduling and a global MLS mutex. */
  protected async processQueue(): Promise<void> {
    if (!this.messageCallback) {
      console.warn('[QUEUE] messageCallback not set - queued messages will not be processed');
      return;
    }

    const ackIds: string[] = [];
    /** Groups whose Welcome landed in this drain: the one event that unblocks an unknown group. */
    const welcomedGroups: string[] = [];

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

          // The stuck-callback watchdog that used to sit here is gone, and it is not lost: it
          // covered ONE of the four awaits that can freeze the drain, and `MlsPerGroupScheduler`
          // now guards every one of them - including this callback, which it invokes as
          // `processMessage`. Two watchdogs for one await would have reported the same freeze
          // twice and still said nothing about the other three.
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
            // The handler already recorded WHY, against the group, in `unackedFrames`. Nothing to
            // note here: what discharges it is an event, not this drain ending.
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
            welcomedGroups.push(groupId);
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

          // A Welcome landing is the proof that frames buffered for an unknown group can now be
          // read. `reinjectAfterWelcome` replays the ones this session buffered in memory; this
          // asks the server for the ones it left unacknowledged in earlier drains.
          if (welcomedGroups.length > 0) {
            this.refetchFramesLeftBehind('unknown-group', 'welcome processed');
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

  /**
   * Fetches offline-queued messages from the delivery service and routes each through the priority
   * queue, ONE PAGE AT A TIME: a page is enqueued (and so, later, ACKed) as soon as it lands, so a
   * pull that dies half-way still shrinks the backlog. Draining the whole queue behind a single
   * deadline was WP-PENDING-1 - a device far enough behind aborted on every reconnect, ACKed
   * nothing, and its backlog grew forever.
   */
  async fetchPendingMessages(): Promise<void> {
    if (this.userId === 'unknown') return;

    // Cleared here rather than on failure: what the barrier may trust is a pull that finished, and
    // this one has not started. A pull that dies half-way therefore leaves it false.
    this.mailboxEmptiedByAPull = false;

    void this.delivery.ackMessages([]).catch(() => {});

    /** Per-page deadline: one request's worth of transfer, not the whole backlog's. */
    const PAGE_TIMEOUT = 10_000;
    let fetched = 0;

    /**
     * ANNOUNCED WHILE IT RUNS, so the barrier can state a fact about the whole mailbox rather than
     * about whichever pages happen to have landed. Never rejects - every failure is handled below -
     * so nothing waiting on it can be left hanging by a transport error.
     */
    const pull = (async () => {
      try {
        await this.delivery.pullPendingMessagesJson({
          pageTimeoutMs: PAGE_TIMEOUT,
          onPage: (rows) => {
            fetched += rows.length;
            recordPendingMessagesFetched(rows.length);
            console.log(`[PENDING] Fetched ${rows.length} pending messages (${fetched} so far)`);
            this.enqueuePendingRows(rows as Record<string, unknown>[]);
          },
        });
        // Every page fetched and enqueued: the server holds nothing more for this device, which is
        // the fact the barrier is allowed to stand on.
        this.mailboxEmptiedByAPull = true;
        if (fetched === 0) {
          console.log(`[PENDING] No pending MLS messages for ${this.userId}:${this.deviceId}`);
        }
      } catch (e) {
        // Partial progress is still progress, and saying so is the difference between "the pull
        // failed" and "the pull failed after draining 4 pages" - the second is what proves the
        // backlog is shrinking across attempts.
        //
        // NAME THE CONSEQUENCE, not just the failure. A transport failure is not an answer: reaching
        // here means this device's offline backlog is still on the server and nothing here will go
        // back for it - the next reconnect's pull is what covers it. Read as "fetch failed", the line
        // sat in production logs beside a queue that had not shrunk in weeks and nobody connected the
        // two. `pullPendingMessagesJson` has already halved its page size down to a single row before
        // giving up, so this is a genuine transport failure rather than an answer too big to arrive.
        console.error(
          `[PENDING] Pending fetch failed after ${fetched} message(s) - the backlog for ${this.userId}:${this.deviceId} is UNDRAINED and stays queued until the next reconnect:`,
          e
        );
      }
    })();
    this.pendingPullInFlight = pull;
    try {
      await pull;
    } finally {
      // CLEARED BEFORE THE BARRIER, deliberately: the line below is that barrier, and a pull still
      // announcing itself here would be waiting on its own completion.
      this.pendingPullInFlight = null;
    }
    await this.settleMailbox();
    // Only now is the answer complete: the rows were enqueued, not handled, so what the handler
    // refused to acknowledge is known only once the queue has drained. Without this, a device that
    // re-fetches the same backlog on every reconnect reports a perfectly healthy pull each time.
    reportUnackedFrames((msg) => console.warn(msg));
  }

  /**
   * Routes one page of raw pending rows through the serialized queue, so they never race with live
   * WebSocket messages calling messageCallback.
   *
   * **A ROW THIS DROPS IS NEVER ACKED, SO IT IS DRAINED AGAIN FOR EVER.** Only what reaches
   * `enqueueMessage` can ever be acknowledged: anything the loop passes over stays in
   * `queued_message` until the 90-day retention, is re-fetched on every reconnect, and makes the
   * backlog a number that only ever grows. That is invisible from the outside - a pull that returns
   * 500 rows and acknowledges none looks exactly like a pull that had nothing to do - so the rows
   * are COUNTED and NAMED here, with their two causes kept apart because they call for opposite
   * fixes: a payload that is absent or empty is a producer writing a row it never filled, while one
   * that fails to decode is a corrupt or truncated write.
   */
  private enqueuePendingRows(rows: Record<string, unknown>[]): void {
    /** Rows this page will not acknowledge, by cause. Bounded by the page size, so keeping ids is cheap. */
    const undeliverable: { empty: string[]; malformed: string[] } = { empty: [], malformed: [] };

    for (const msg of rows) {
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
            continue;
          }
        } catch (e) {
          console.error('[PENDING] Failed to enqueue proto message:', e);
          undeliverable.malformed.push(msgId ?? '(no id)');
          continue;
        }
      }
      // Reached only by a row carrying no usable payload: no `proto` at all, or one that decoded to
      // zero bytes. Nothing was enqueued, so nothing will ACK it.
      undeliverable.empty.push(msgId ?? '(no id)');
    }

    const stuck = undeliverable.empty.length + undeliverable.malformed.length;
    if (stuck > 0) {
      const sample = (ids: string[]) => ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', …' : '');
      console.warn(
        `[PENDING] ${stuck}/${rows.length} row(s) of this page cannot be delivered and will NOT be acknowledged - they will be re-fetched on every reconnect until the retention window expires. ` +
          `empty payload: ${undeliverable.empty.length}${undeliverable.empty.length ? ` [${sample(undeliverable.empty)}]` : ''}; ` +
          `undecodable payload: ${undeliverable.malformed.length}${undeliverable.malformed.length ? ` [${sample(undeliverable.malformed)}]` : ''}`
      );
    }
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

  /**
   * Asks the server to elect ONE online member to reconcile `groupId` with us. What we want is
   * stated separately, inside MLS, so this frame carries nothing about the conversation's contents.
   *
   * The server elects the responder, so it alone knows whether there was one, and it says so:
   * `noPeerOnline` reports that answer. It is true ONLY on an explicit `no_peer_online` - a request
   * that failed to reach the server, or answered something unparseable, proves nothing about who is
   * reachable, and concluding "nobody" from it would abandon a reconciliation on a dropped packet.
   */
  async sendHistoryRequest(groupId: string): Promise<HistoryRequestOutcome> {
    const answer = await this.delivery.deliveryPost('history-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
    return { noPeerOnline: answer?.status === 'no_peer_online' };
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
   * Generates and publishes this device's key packages, re-enrolling under a fresh id when the
   * server answers that this one is revoked.
   *
   * A revoked id is denylisted for good and `resolveDeviceId` deliberately hands the same id back
   * after a reinstall, so retrying it is futile: the only way forward is to become a new device.
   * Retried exactly once - a second refusal is a server bug, not a state to keep rotating through.
   */
  async generateKeyPackage(deviceKeyB64: string): Promise<Uint8Array> {
    try {
      return await this.generateKeyPackageImpl(deviceKeyB64);
    } catch (e) {
      if (!(e instanceof DeviceRevokedError)) throw e;
      const abandoned = await this.rotateDeviceIdentity(deviceKeyB64, 'revoked server-side');
      console.warn(`[MLS] Device ${abandoned} was revoked - re-enrolled as ${this.deviceId}`);
      return this.generateKeyPackageImpl(deviceKeyB64);
    }
  }

  /**
   * Abandons this device's identity and starts over under a freshly generated id: the MLS
   * credential is `userId:deviceId`, so a new id IS a new device and the old state can only be
   * discarded. Used for a credential mismatch (the state names someone else) and for a server-side
   * revocation (the id is denylisted and no retry can lift it).
   *
   * Order matters: the fresh state is persisted under the new id BEFORE anything else may fail.
   * Leaving a new id in localStorage next to the old blob is what made the churn self-sustaining -
   * every launch mismatched again and minted yet another device.
   *
   * @returns the id that was abandoned, for the caller to log.
   */
  protected async rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string> {
    const oldDeviceId = this.deviceId;
    console.warn(`[MLS] Rotating device identity (${reason}), abandoning ${oldDeviceId}`);
    this.deviceId = this.generateDeviceId(this.userId);
    localStorage.setItem(`mls_device_id_${this.userId}`, this.deviceId);
    this.delivery.deviceId = this.deviceId;
    // The counters describe the ratchets of the device being abandoned, whose state is about to be
    // discarded for a fresh one starting at generation zero. Carried over, they would burn against
    // sends that, from the peers' side, this device has never made.
    resetSendRatchetLedger(this.userId);
    await this.loadStateWithKey(deviceKeyB64, undefined);
    await this.persistCheckpoint(deviceKeyB64);
    // Deregister the abandoned device so other members stop generating Welcomes for a key package
    // our fresh state no longer holds (NoMatchingKeyPackage). Best-effort: a revoked id is already
    // gone server-side, and a mismatch must not block on the network.
    this.deleteDevice(this.userId, oldDeviceId).catch((err) =>
      console.warn(`[MLS] Cleanup old device ${oldDeviceId} failed:`, err)
    );
    return oldDeviceId;
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
   * Deletes every published one-time prekey, then regenerates the key material (static
   * fallback + pool) from the current local keystore via {@link generateKeyPackage}. Guarantees
   * that no published KeyPackage references a private key missing locally - the root of the
   * `NoMatchingKeyPackage` loop.
   *
   * Debounces close-together calls (<= 30 s): several groups can fail at the same time, but a
   * single purge/regeneration (expensive, up to 50 KeyPackages) is enough to reconcile all
   * published material.
   */
  async republishKeyMaterial(deviceKeyB64: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastKeyMaterialRepublish < 30_000) return;
    this.lastKeyMaterialRepublish = now;
    await this.delivery.deleteAllOneTimePrekeys();
    await this.generateKeyPackage(deviceKeyB64);
  }

  /**
   * Validates every published one-time prekey and purges from the server those whose local
   * private key is gone (state reset/restored). Conservative: only purges *proven* orphans
   * (KeyPackage validated but absent from the keystore); a KeyPackage that cannot be validated
   * is left in place (a peer might be able to validate it). Best-effort.
   */
  async reconcilePublishedKeyPackages(): Promise<void> {
    const published = await this.delivery.listOwnPrekeys();
    if (published.length === 0) return;

    const orphanIds: string[] = [];
    for (const { id, keyPackage } of published) {
      try {
        if (!(await this.keyPackageHasPrivate(keyPackage))) orphanIds.push(id);
      } catch {
        // KeyPackage not locally deserializable/validatable: don't purge it.
      }
    }

    if (orphanIds.length > 0) {
      await this.delivery.pruneOwnPrekeys(orphanIds);
      console.log(
        `[MLS] reconcilePublishedKeyPackages: purged ${orphanIds.length}/${published.length} orphaned prekey(s)`
      );
    }
  }

  /** True if the local keystore still holds the private key for the given public KeyPackage. */
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

  async createRemoteGroup(name: string, isGroup = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number,
    until?: string
  ): Promise<import('$lib/mls-client/historyTypes').HistoryPage> {
    return this.delivery.fetchHistory(groupId, afterStreamId, limit, until);
  }

  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryPage>> {
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
    // The sequential path decrypts in place, so it cannot be UNDONE by a swap the way the worker
    // path can - but a send during it is still a send racing a catch-up, and the ordering rule is
    // about the sequence, not about which platform happens to survive breaking it.
    this.beginCatchUp();
    let session: MlsDecryptSession;
    try {
      session = await createSequentialDecryptSession(this, groupId);
    } catch (e) {
      this.endCatchUp();
      throw e;
    }
    return {
      decryptPage: (msgs) => session.decryptPage(msgs),
      finish: async () => {
        try {
          await session.finish();
        } finally {
          this.endCatchUp();
        }
      },
    };
  }

  /**
   * Default no-op: only Tauri/Android has a background JNI engine that can advance `mls.bin`
   * while the app is backgrounded, so only TauriMlsService overrides this to reload (C2). On
   * web/desktop the in-memory engine is the sole writer; there is nothing to reload.
   */
  async reloadStateFromDisk(): Promise<void> {}

  /**
   * Default null: every path but the Tauri biometric one derives the device key in the frontend
   * and hands it to {@link init}, so there is nothing to ask back for.
   */
  async resolveSessionDeviceKey(): Promise<string | null> {
    return null;
  }

  // ── Platform-specific (abstract) ──────────────────────────────────────────

  /**
   * Writes the current state to this platform's durable store. Split from {@link saveState} because
   * Tauri's already lands on disk while Web still has to hand the bytes to IndexedDB, and no caller
   * - {@link rotateDeviceIdentity}, the checkpoint persister, the structural checkpoint - may have
   * to know which. See `IMlsService.persistCheckpoint` for what the duplicate cost.
   */
  protected abstract writeCheckpoint(deviceKeyB64: string): Promise<void>;

  /**
   * Advances this device's send ratchet by `count` generations without emitting anything.
   *
   * Platform-specific and nothing else: WHEN to burn, and by how much, is decided once in
   * {@link reconcileSendRatchets}. See `MlsManager::skip_send_generations` for why it encrypts and
   * why burning too many is free while burning too few is the defect.
   */
  protected abstract skipSendGenerations(groupId: string, count: number): Promise<number>;

  /**
   * Checkpoints the live state AND records how much of this device's send ratchet it makes durable.
   *
   * CONCRETE, FOR THE REASON {@link sendMessage} IS. The count is read BEFORE the write is started
   * and committed only AFTER it resolves, and that order is the entire guarantee: a send landing
   * during the write is then counted as unpersisted and costs one burnt generation too many on the
   * next load, where the opposite order costs one too few and reproduces exactly the fault this
   * exists to close. Leaving the pairing to each call site would be the eighteen-call-sites lesson
   * of `sendMessage`, re-learnt on the seam that guards the ratchet instead of the one that moves it.
   */
  async persistCheckpoint(deviceKeyB64: string): Promise<void> {
    const emitted = snapshotEmitted(this.userId);
    await this.writeCheckpoint(deviceKeyB64);
    commitPersisted(this.userId, emitted);
  }

  /**
   * Burns whatever this device sent but never checkpointed, so the restored ratchet is back where
   * the peers already believe it is. Runs once per {@link init}, before anything can send.
   *
   * A fresh start has no history to repair and any surviving count describes a device that no longer
   * exists, so the ledger is dropped rather than replayed.
   *
   * Per group, and isolated per group: the ledger can name a conversation this device has since left
   * or forgotten, and `skipSendGenerations` answers `GroupNotFound` for it. One unrepairable group
   * must not cost the repair of the others.
   */
  protected async reconcileSendRatchets(deviceKeyB64: string): Promise<void> {
    if (this.freshStart) {
      resetSendRatchetLedger(this.userId);
      return;
    }
    const pending = pendingSendGenerations(this.userId);
    if (pending.length === 0) return;

    let repaired = 0;
    for (const { groupId, deficit, clamped } of pending) {
      if (clamped) {
        // NAMED, NEVER SILENT: a deficit past the receivers' forward window is a corrupt counter,
        // not a backlog, and burning the cap will not repair it. Saying so is what separates
        // "repaired" from "gave up at the bound" in the log a later reader will have.
        console.warn(
          `[MLS] Send ledger for ${groupId.slice(0, 8)}… claims more than ${MAX_BURN_GENERATIONS} unpersisted frames - burning the cap only; the ratchet cannot be repaired past the receivers' forward window`
        );
      }
      try {
        await this.skipSendGenerations(groupId, deficit);
        repaired++;
        console.log(
          `[MLS] Restored state for ${groupId.slice(0, 8)}… was ${deficit} generation(s) behind this device's own sends - burnt, no frame will re-use a spent generation`
        );
      } catch (e) {
        console.warn(
          `[MLS] Could not burn ${deficit} generation(s) for ${groupId.slice(0, 8)}…:`,
          String(e).slice(0, 160)
        );
      }
    }

    // The burn moved the live ratchet and nothing durable knows it yet, so a second reload would
    // burn the same generations again. Harmless (over-shooting is free) but pointless, and the
    // checkpoint is what closes the ledger: it commits `persisted = emitted` through the pairing
    // above. A failure leaves the deficit standing, which repairs itself on the next load.
    if (repaired > 0) {
      await this.persistCheckpoint(deviceKeyB64).catch((e) =>
        console.warn('[MLS] Checkpoint after the ratchet burn failed:', String(e).slice(0, 160))
      );
    }
  }

  abstract saveState(deviceKeyB64: string): Promise<Uint8Array>;
  abstract changeDeviceKey(newDeviceKeyB64: string): Promise<void>;
  protected abstract generateKeyPackageImpl(deviceKeyB64: string): Promise<Uint8Array>;
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
  /**
   * Encrypts one application message against the LIVE client, advancing this device's send ratchet.
   * Platform-specific and nothing else: every rule that has to hold around a send lives in
   * {@link sendMessage}, which is the only caller.
   */
  protected abstract encryptForSend(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Encrypts an application message and puts it on the wire.
   *
   * CONCRETE, AND SHARED BY BOTH PLATFORMS ON PURPOSE. Three things must happen around every send,
   * and each of them was previously the responsibility of the caller:
   *
   * - nothing leaves this device while a catch-up is open ({@link waitForCatchUpIdle}), because a
   *   send advances the ratchet of a client the catch-up is about to replace with a copy taken
   *   before it;
   * - the advance is COUNTED ({@link noteLiveMutation}), which is what lets every state-replacement
   *   seam refuse a candidate that predates it;
   * - the advance is CHECKPOINTED, because the moment the frame is on the wire the peer has consumed
   *   that generation, and a ratchet that only moved in RAM is a ratchet the next load puts back.
   *
   * It was a template method the day the third rule was found at TWO of the EIGHTEEN call sites
   * that reach a send - the sixteen others (read receipts, reactions, edits, deletes, pins, group
   * control, calls) advanced the ratchet and checkpointed nothing. A rule that each caller has to
   * remember is a rule the next caller will not, so it is enforced here or not at all.
   */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    frameDelivery: FrameDelivery = DELIVERY.visible
  ): Promise<Uint8Array> {
    await this.waitForCatchUpIdle();
    const encryptedBytes = await this.encryptForSend(groupId, messageBytes);
    this.noteLiveMutation();
    // DURABLE, AND BEFORE THE POST. The ratchet has moved by now and stays moved whether or not the
    // POST below succeeds, so this is the only correct moment: counting a successful send instead
    // would leave every failed POST as an under-count, which is the direction that re-issues a spent
    // generation. It is what a reload recovers the advance from when the checkpoint below does not
    // land in time - the whole reason that checkpoint is allowed not to be awaited.
    noteFrameEmitted(this.userId, groupId);
    await this.checkpointAfterSend();
    const proto = toBase64(encryptedBytes);
    await this.delivery.postApplicationMessage(groupId, proto, frameDelivery);
    return encryptedBytes;
  }
  /**
   * Checkpoints the ratchet advance the send just made, and decides whether the send WAITS for it.
   *
   * THE COUNTER THAT GUARDS THIS WINDOW DOES NOT SURVIVE A PAGE LOAD. `liveMutations` and every
   * watermark compared against it are per-page-session state, initialised to 0 when the app starts;
   * the OUTBOX is durable and outlives it. So a client that sends, is reloaded before the checkpoint
   * lands, and then drains its queue encrypts those entries against a state read back from disk that
   * is behind the sends the previous session already made - and the peers refuse the frames with
   * `SecretReuseError`, reporting, correctly, that the sender's ratchet rewound. Measured on the
   * phone on 2026-08-14, twice, on a fleet with nothing else happening to it.
   *
   * The invariant is therefore: `mls.bin` is never behind a frame that has already left the device.
   * Only awaiting the checkpoint before the frame goes on the wire can hold it, because no in-memory
   * guard is present after the load that has to be defended against.
   *
   * The DEFAULT does not await, and that is web's answer on purpose: its checkpoint is an Argon2
   * round trip, and putting one on the latency of every message is not a trade worth making for a
   * fault that reconciles itself. Native overrides this - see `TauriMlsService`.
   */
  protected async checkpointAfterSend(): Promise<void> {
    scheduleOutboundMlsPersist();
  }

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
