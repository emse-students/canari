import type { GraineSignatureEngine } from '$lib/crypto/graineV2';
import { tauriGraineSignatureEngine } from '$lib/mls-client/tauriGraineSignatureEngine';
import { getClientAppVersion } from '$lib/utils/appVersion';
import { isChannelEventFrame, isHeartbeatFrame } from '$lib/mls-client/channelEventTypes';
import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import NativeWebSocket, { type Message as WsMessage } from '@tauri-apps/plugin-websocket';
import {
  logMlsMetric,
  detectRuntimeDeviceOs,
  SavedStateUnopenedError,
  SavedStateOfAnotherAccountError,
  noPinOpensState,
  VaultOwnerUnprovenError,
  LocalStateNotReadyError,
  type MlsInitOptions,
} from '$lib/mls-client';
import {
  mapNativeBatchDecryptResults,
  type BatchDecryptRow,
} from '$lib/mls-client/mlsBatchDecrypt';
import { assertVerifiedSender, type EnvelopeSender } from '$lib/mls-client/verifiedSender';
import type { AuthoredFrame } from '$lib/mls-client/mlsDeliveryApi';
import type { ForkFinding } from '$lib/mls-client/integrityFindings';
import type {
  DecryptedApplication,
  GraineRunReading,
  MlsBatchProcessResult,
} from '$lib/mls-client/IMlsService';
import type { AuthorVerdict } from '$lib/crypto/messageAuthorship';
import type { SkippedKeyPackage } from '$lib/mls-client/skippedKeyPackage';
import {
  StagedCommitPendingError,
  type OwedWelcome,
  type PendingSubmissionRead,
} from '$lib/mls-client/commitSubmission';
import type { DeviceEvent, DevicePin, KeyPackageVerdict } from '$lib/mls-client/deviceTrust';
import type { DatedKeyPackage } from '$lib/mls-client/keyPackages';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { gatewaySocketUrl } from '$lib/mls-client/frameDelivery';
import {
  GatewayOpenAbandonedError,
  type GatewaySocketOpen,
} from '$lib/mls-client/gatewaySocketOpen';
import { getToken } from '$lib/stores/auth';
import { sanitizeForLog } from '$lib/utils/logSanitize';
import { fromBase64, toBase64, toHex, type MlsStateWriteLatch } from '$lib/utils/hex';
import type { StateLedgerChanges } from '$lib/mls-client/stateLedgers';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { getLocale } from '$lib/i18n';
import { BaseMlsService } from './BaseMlsService';
import { beginBootSpan, endBootSpan, timeBootSpan } from '$lib/mls-client/bootBenchmark';
import { keystoreUnlockPrompt } from './biometric';
import { DELETE_DEVICE_KEY_COMMAND } from './keystoreCommands';
import { onAppForegroundChange } from '$lib/utils/appForeground';
import { conformPluginFetch } from '$lib/utils/transportFailure';
import { ACCOUNT_KEY, keystoreAlias } from '$lib/utils/accountLocalKeys';
import { connectNativeSocket, NATIVE_CONNECT_TIMEOUT_MS } from './nativeSocketConnect';

/** Native batch result for key package generation plus immediate `mls.bin` persistence. */
/**
 * What the native batch hands back: the two things this side publishes.
 *
 * IT DECLARED A THIRD, `state`, AND NOTHING EVER READ IT. The command persists the blob itself, so
 * the field only ever crossed the IPC boundary to be dropped - and Tauri sends a `Vec<u8>` as a
 * JSON array of integers, which is several bytes of wire per byte of state, on every connection.
 */
interface NativeKeyPackageBatchResult {
  fallback: NativeDatedKeyPackage;
  pool_packages: NativeDatedKeyPackage[];
}

/**
 * One key package from the native mint, with the instant it stops being usable.
 *
 * The expiry crosses the boundary because nothing on this side can recover it: only the Rust crate
 * parses an MLS KeyPackage, and the delivery service stores an opaque string. `notAfterSecs` is
 * seconds since the epoch - see `DatedKeyPackage`, which carries the reasoning.
 */
interface NativeDatedKeyPackage {
  public: number[];
  notAfterSecs: number;
}

/** What `envoyer_message_bytes` did - mirrors `Scellement` in `src-tauri/src/commands/mls.rs`. */
type SealOutcome =
  | { status: 'sealed'; ciphertext: number[]; authorProof: number[] }
  | { status: 'commitPending' };

/** What `recharger_mls_au_resume` did - mirrors `ReloadOutcome` in `src-tauri/src/commands/storage.rs`. */
type ReloadOutcome = 'reloaded' | 'nothing-on-disk' | 'epoch-regression' | 'live-ahead';

/**
 * MLS service implementation for Tauri (mobile/desktop).
 * Delegates all cryptographic operations to the native Rust side via `invoke()`.
 */
export class TauriMlsService extends BaseMlsService {
  private ws: Awaited<ReturnType<typeof NativeWebSocket.connect>> | null = null;
  /** The `pagehide` listener releasing the native socket with its page (see `connect`). */
  private _pageHideHandler: (() => void) | null = null;
  /** The `pageshow` listener asking for a new socket when the page SURVIVED its `pagehide`. */
  private _pageShowHandler: (() => void) | null = null;
  private wsUnlisten: (() => void) | null = null;
  /** Consecutive pings sent without any incoming data frame from the server. */
  private missedHeartbeats = 0;
  /** Maximum consecutive pings without any server activity before we force-close (parity WebMlsService). */
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /**
   * Whether {@link _knownGroups} was filled from the native manager since the state was loaded.
   * Reset by every load: a cache from the previous state, or none, says nothing about this one.
   */
  private _groupsListed = false;
  /** Last known MLS epoch per group (native); keeps sync `getEpoch()` meaningful on Tauri. */
  private _epochByGroupId: Map<string, number> = new Map();
  /**
   * The stamp of the last reading (or forget) written into the two caches, per group.
   *
   * READINGS ARE LINEARISED BY WHEN THEY STARTED, NOT BY WHEN THEY RESOLVED. Native calls run in the
   * order they were issued, so a reading started later saw a later state - but two awaits can
   * resolve in either order, and the start-up/resume sync reads many groups while commits, merges,
   * joins and forgets keep landing. A stamp taken BEFORE each native read, and a write applied only
   * when no later-started one has been written, is what keeps an older reading from overwriting a
   * newer one, and a sync from resurrecting a group forgotten while it ran.
   */
  private _cacheStamp: Map<string, number> = new Map();
  /**
   * The latest stamp ISSUED per group - set when a reading or a forget STARTS, where
   * {@link _cacheStamp} is set when one is written. The sync reads it to leave alone a group some
   * call is already working on (a create or join whose epoch read has not resolved yet).
   */
  private _touchStamp: Map<string, number> = new Map();
  /** Source of {@link _cacheStamp} values; strictly increasing for the life of the service. */
  private _stampSeq = 0;
  /** In-flight Rust MLS mutations; drained before `saveState` so mls.bin matches `_knownGroups`. */
  private pendingRustMutations: Promise<unknown>[] = [];
  // Device key kept in memory after init() to re-encrypt the MLS state after each
  // message without asking the user for the PIN again.
  private _deviceKeyB64 = '';

  constructor() {
    // CONFORMED, never raw: the plugin rejects with a bare string where `fetch` throws a TypeError,
    // and the delivery client classifies its failures by type (`transportFailure.ts`).
    super('tauri', conformPluginFetch(fetch));
  }

  /** Tracks a native invoke so `saveState` can wait for Rust before persisting mls.bin. */
  private trackRustMutation(promise: Promise<unknown>): void {
    this.pendingRustMutations.push(promise);
    void promise.finally(() => {
      const idx = this.pendingRustMutations.indexOf(promise);
      if (idx >= 0) this.pendingRustMutations.splice(idx, 1);
    });
  }

  /** Waits for pending forget/drop invokes before serializing MLS state. */
  private async awaitRustMutations(): Promise<void> {
    const pending = [...this.pendingRustMutations];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  /**
   * Re-reads one group's epoch from the native manager into the cache `getEpoch` answers from.
   *
   * Called after EVERY native operation that can move an epoch - a commit applied, a merge, a join,
   * a Welcome - and awaited there, because the synchronous `getEpoch` is read right after them: the
   * commit replay compares it with its target after each commit, and the key-group frame route
   * decides from it whether a gap is closed.
   */
  private async refreshEpochCache(groupId: string): Promise<void> {
    await this.readEpochIntoCache(groupId, this.nextCacheStamp(groupId));
  }

  /**
   * A new stamp for {@link _cacheStamp}, taken BEFORE the native call it will guard. Given a group,
   * it also records that group as touched from now on ({@link _touchStamp}).
   */
  private nextCacheStamp(groupId?: string): number {
    const stamp = ++this._stampSeq;
    if (groupId !== undefined) this._touchStamp.set(groupId, stamp);
    return stamp;
  }

  /** Whether a write under `stamp` may land for `groupId`: nothing started later has been written. */
  private cacheWriteAllowed(groupId: string, stamp: number): boolean {
    return (this._cacheStamp.get(groupId) ?? 0) <= stamp;
  }

  /** Whether no call has started on `groupId` since `stamp` was issued. */
  private untouchedSince(groupId: string, stamp: number): boolean {
    return (this._touchStamp.get(groupId) ?? 0) <= stamp;
  }

  /**
   * Reads `groupId`'s epoch under `stamp` and writes it, unless a later-started reading or a forget
   * was written meanwhile (see {@link _cacheStamp}).
   */
  private async readEpochIntoCache(groupId: string, stamp: number): Promise<void> {
    let epoch: number | null;
    let failure: unknown = null;
    try {
      epoch = await invoke<number>('obtenir_epoch', { groupId });
    } catch (err) {
      epoch = null;
      failure = err;
    }
    if (!this.cacheWriteAllowed(groupId, stamp)) return;
    this._cacheStamp.set(groupId, stamp);
    if (epoch !== null) {
      this._epochByGroupId.set(groupId, epoch);
      logMlsMetric({ kind: 'epoch_cache', platform: 'tauri', groupId, epoch });
      return;
    }
    this._epochByGroupId.delete(groupId);
    // Ordinary for a group just forgotten; for a held one it means `getEpoch` now answers 0.
    if (this._knownGroups.has(groupId)) {
      console.error(
        `[MLS][Tauri] held group ${groupId.slice(0, 8)}... has no readable epoch - getEpoch answers 0 for it:`,
        String(failure)
      );
    }
  }

  /** Resets the heartbeat miss counter whenever a data frame is received from the server. */
  private resetHeartbeatCounter(): void {
    this.missedHeartbeats = 0;
  }

  /** Clears the heartbeat interval. */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Starts the 8-second heartbeat interval (zombie detection + ping). */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) {
        this.clearHeartbeat();
        return;
      }
      // Check if the server has sent anything since the last ping (parity WebMlsService).
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > TauriMlsService.MAX_MISSED_HEARTBEATS) {
        console.warn(
          `[WS] ${this.missedHeartbeats} pings without server response - closing zombie connection`
        );
        this.clearHeartbeat();
        // Unlisten before disconnecting to prevent the Close event from firing
        // disconnectCallback a second time (same pattern as connect() cleanup).
        const deadWs = this.ws;
        this.wsUnlisten?.();
        this.wsUnlisten = null;
        this.ws = null;
        void deadWs.disconnect().catch(() => {});
        this.disconnectCallback?.();
        return;
      }
      this.ws.send(JSON.stringify({ type: 'ping' })).catch(() => {
        /* socket closed between check and send */
      });
    }, 8_000); // data frame bypasses nginx proxy_read_timeout; keeps presence TTL fresh
  }

  /**
   * Returns true while the native WebSocket instance exists.
   * Unlike WebMlsService (which checks `readyState === OPEN`), the Tauri native WS
   * plugin exposes no `readyState`. `this.ws` is set to null synchronously on every
   * disconnect path (Close event, heartbeat zombie kill, connect() reconnect), so
   * `!== null` is the best available equivalent.
   */
  isWsOpen(): boolean {
    return this.ws !== null;
  }

  /**
   * Opens a NativeWebSocket to the chat gateway under `open.deviceId`, passing the Bearer token in
   * the URL query string for mobile compatibility. Reached through `connect` only.
   *
   * FENCED AFTER EACH AWAIT: the release of the previous socket and the native connect both yield,
   * and a pause landing in either must leave no socket - so `open.isCurrent()` is read after each,
   * and a native socket that arrives for an abandoned open is released rather than assigned.
   */
  protected override async openGatewaySocket(open: GatewaySocketOpen): Promise<void> {
    const { deviceId, token } = open;
    // Unlisten + disconnect before reconnecting so the Close event doesn't trigger disconnectCallback.
    // EVERY SHARED FIELD IS LET GO BEFORE THE AWAIT, never after it: once this open yields, a pause
    // and a resume may have handed `ws` and `wsUnlisten` to a LATER open, and a write here would
    // clobber that one's live socket. After each await this open touches only its own locals until
    // the fence says it is still current.
    this.clearHeartbeat();
    const previous = this.ws;
    if (previous) {
      this.wsUnlisten?.();
      this.wsUnlisten = null;
      this.ws = null;
      try {
        await previous.disconnect();
      } catch (e) {
        console.log(
          `[WS] the previous native socket was already gone: ${sanitizeForLog(String(e))}`
        );
      }
    }
    if (!open.isCurrent()) {
      throw new GatewayOpenAbandonedError('paused while the previous socket was released');
    }

    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible' && !this.ws) {
          this.disconnectCallback?.();
        }
      };
      this._onlineHandler = () => {
        if (!this.ws) {
          this.disconnectCallback?.();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      window.addEventListener('online', this._onlineHandler);
      // THE PAGE LEAVING RELEASES ITS NATIVE SOCKET. The plugin's connection and its `addListener`
      // channel live in RUST and outlive the document: after a WebView reload (a system text-size
      // change) the old page's channel id kept being answered into the new page,
      // `[TAURI] Couldn't find callback id N` every ~15 s (Mi 9T, 2026-10-17). The only recurring
      // Rust-to-JS channel is this socket's, so it is released with the page - the same release
      // the backgrounding path performs, and the next page opens its own. The cause is REASONED,
      // not observed: the reading that closes it is the id no longer repeating after a reload.
      this._pageHideHandler = () => {
        if (!this.ws) return;
        console.log('[WS] page leaving - releasing the native socket and its listener channel');
        this.pauseSocket();
      };
      window.addEventListener('pagehide', this._pageHideHandler);
      // A `pagehide` the page SURVIVES (a bfcache entry restored, a navigation that did not
      // destroy the document) leaves it with no socket and no visibility edge to notice: the
      // restore itself is the trigger, so it asks for the reconnect.
      this._pageShowHandler = () => {
        if (!this.ws) {
          console.log('[WS] page shown again with no socket - reconnecting');
          this.disconnectCallback?.();
        }
      };
      window.addEventListener('pageshow', this._pageShowHandler);
      // THE EDGE THE VISIBILITY API NEVER FIRES ON A PHONE. A backgrounded Android WebView stays
      // `visible` (measured, see `appForeground.ts`), so the handler above cannot see the user
      // coming back; the activity's own foreground event can. Same decision, honest trigger.
      this._foregroundUnsubscribe = onAppForegroundChange((foreground) => {
        if (foreground && !this.ws) {
          console.log('[WS] app back in the foreground with no socket - reconnecting');
          this.disconnectCallback?.();
        }
      });
    }

    // On Tauri mobile the cookie is not sent cross-origin, so we pass the
    // Bearer token explicitly in the URL query string.
    // Use the same regex as WebMlsService to avoid http:// → wss:// mismatch.
    const wsBase = this.baseUrl.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
    const { url: wsUrl, redacted } = gatewaySocketUrl(wsBase, deviceId, token);
    console.log(`[WS] Opening connection → ${redacted}`);

    const socket = await connectNativeSocket(
      NativeWebSocket.connect(wsUrl),
      NATIVE_CONNECT_TIMEOUT_MS
    );
    if (!open.isCurrent()) {
      // The pause already settled this open; the socket the plugin handed back is nobody's.
      console.log('[WS] a native socket arrived for an open a pause abandoned - released');
      socket.disconnect().catch((e: unknown) => {
        console.warn(`[WS] releasing the abandoned native socket failed: ${String(e)}`);
      });
      throw new GatewayOpenAbandonedError('paused during the native connect');
    }
    this.ws = socket;
    console.log(`[WS] Connected to Chat Gateway - device=${sanitizeForLog(deviceId)}`);

    this.wsUnlisten = this.ws.addListener((msg: WsMessage) => {
      // Any incoming frame proves the server is alive - reset heartbeat miss counter (parity WebMlsService).
      if (msg.type !== 'Close') {
        this.resetHeartbeatCounter();
      }

      if (msg.type === 'Close') {
        // Only THIS socket's close releases the shared fields: a later open may own them now.
        if (this.ws !== socket) {
          console.log('[WS] a close arrived for a native socket already replaced - ignored');
          return;
        }
        this.ws = null;
        this.clearHeartbeat();
        const closeData = msg.data as { code: number; reason: string } | null;
        const code = closeData?.code ?? 0;
        const codeDesc =
          code === 1000
            ? 'normal closure'
            : code === 1001
              ? 'server shutting down'
              : code === 1006
                ? 'abnormal closure (no close frame)'
                : code === 1008
                  ? 'policy violation (auth?)'
                  : code === 1011
                    ? 'internal server error'
                    : `code=${code}`;
        console.warn(`[WS] Disconnected - ${codeDesc}, reason="${closeData?.reason ?? ''}"`);
        this.disconnectCallback?.();
        return;
      }

      if (msg.type !== 'Text') return;

      void (async () => {
        try {
          const parsed = JSON.parse(msg.data as string) as Record<string, unknown>;
          const msgType = typeof parsed.type === 'string' ? parsed.type : '';
          // The transport's keepalive, not a message. Parity with `WebMlsService`, through the one
          // predicate both clients ask - see `isHeartbeatFrame`.
          if (isHeartbeatFrame(msgType)) return;
          await this.deliverFrame(parsed, msgType);
        } catch (e) {
          console.error('[WS RCV] Failed to process WebSocket message:', e);
        }
      })();
    });

    this.startHeartbeat();

    // Pending queue fetch is handled by initializeConnection() to keep
    // behavior aligned between WebMlsService and TauriMlsService.
  }

  /**
   * Hands ONE parsed gateway frame to the handler its type names - the native half of the routing
   * `WebMlsService` implements for the browser socket. Everything in front of it, the inbound gate
   * included, is shared on {@link BaseMlsService}.
   */
  protected override async routeFrame(
    parsed: Record<string, unknown>,
    msgType: string
  ): Promise<void> {
    if (isChannelEventFrame(msgType)) {
      if (this.onChannelEvent) {
        this.onChannelEvent({ type: msgType, data: parsed.data });
      } else {
        console.warn(`[WS RCV] Received channel event but no onChannelEvent registered.`);
      }
      return;
    }
    if (msgType === 'typing') {
      // Group/DM typing: normalise the flat gateway frame into the channel-event
      // shape so the shared handler updates the typing store uniformly.
      this.onChannelEvent?.({
        type: 'typing',
        data: { groupId: parsed.groupId, userId: parsed.userId, state: parsed.state },
      });
      return;
    }
    if (msgType === 'device_revoked') {
      // Its owner deleted this device. The denylist row is the durable half and would be
      // found at the next login anyway; this is what makes it immediate, so a device
      // declared lost stops holding a live session the moment it is disowned. Never
      // trusted blindly: the frame is addressed to this device by the gateway, and the
      // handler re-checks with the server before wiping anything.
      console.warn('[WS RCV] device_revoked - this device was deleted by its owner');
      this.deviceRevokedCallback?.();
      return;
    }
    if (msgType === 'welcome_request') {
      const requesterUserId = (parsed.requesterUserId as string) || '';
      const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
      const groupId = (parsed.groupId as string) || '';
      console.log(
        `[WS RCV] welcome_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
      );
      this.welcomeRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
      return;
    }
    if (msgType === 'base_refresh_request') {
      const requesterUserId = (parsed.requesterUserId as string) || '';
      const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
      const groupId = (parsed.groupId as string) || '';
      console.log(
        `[WS RCV] base_refresh_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
      );
      this.baseRefreshRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
      return;
    }
    if (msgType === 'history_request') {
      const requesterUserId = (parsed.requesterUserId as string) || '';
      const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
      const groupId = (parsed.groupId as string) || '';
      console.log(
        `[WS RCV] history_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
      );
      this.historyRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
      return;
    }
    if (msgType === 'epoch_rejected') {
      console.warn(
        `[WS RCV] Epoch rejected for group ${parsed.groupId} (server epoch: ${parsed.currentEpoch})`
      );
      if (this.onChannelEvent) {
        this.onChannelEvent({
          type: 'epoch_rejected',
          data: { groupId: parsed.groupId, currentEpoch: parsed.currentEpoch },
        });
      }
      return;
    }
    if (parsed.proto && this.messageCallback) {
      const ciphertext = fromBase64(parsed.proto as string);
      const ratchetTreeBytes =
        typeof parsed.ratchetTree === 'string' && (parsed.ratchetTree as string).length > 0
          ? fromBase64(parsed.ratchetTree as string)
          : undefined;
      if (ciphertext.length > 0) {
        this.enqueueMessage(
          {
            senderId: (parsed.senderId as string) || 'unknown',
            senderDeviceId: (parsed.senderDeviceId as string) || undefined,
            ciphertext,
            groupId: (parsed.groupId as string) || undefined,
            isWelcome: !!parsed.isWelcome,
            isCommit: !!parsed.isCommit,
            ratchetTreeBytes,
            queuedMessageId: (parsed.queuedMessageId as string) || undefined,
            queuedCreatedAt: parseServerTimestampMs(parsed.createdAt),
            // Forwarded by the gateway since step A (history-answer-addressing, rule 4).
            addressed: parsed.addressed === true,
          },
          'live'
        );
      }
    } else if (parsed.proto && !this.messageCallback) {
      console.warn(
        `[WS RCV] a frame carried a proto but no messageCallback is registered - the frame is DROPPED`
      );
    } else if (msgType) {
      // See the same branch in `WebMlsService`: a typed frame that reached no handler is the
      // one failure this layer cannot otherwise show, and it stayed invisible for months.
      console.warn(
        `[WS RCV] frame type "${msgType}" reached no handler - the server is sending ` +
          `something this client does not route (see channelEventTypes)`
      );
    }
  }

  /** Sends a disconnect control frame over the native WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'disconnect' })).catch(() => {
        // Best-effort - ignore if the socket is already closing
      });
    }
  }

  /** Removes the page-lifecycle listeners this class registered, then the base teardown. */
  override destroy(): void {
    if (this._pageHideHandler) {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    if (this._pageShowHandler) {
      window.removeEventListener('pageshow', this._pageShowHandler);
      this._pageShowHandler = null;
    }
    super.destroy();
  }

  /**
   * Sends `disconnect`, then drops the native socket and its heartbeat with no disconnect callback -
   * see {@link IMlsService.pauseSocket}. The listener goes first, so the `Close` the plugin may
   * still deliver cannot report a disconnection either.
   */
  protected override pausePlatformSocket(): void {
    this.clearHeartbeat();
    const ws = this.ws;
    if (!ws) return;
    this.wsUnlisten?.();
    this.wsUnlisten = null;
    this.ws = null;
    // THE SEND IS THE PROBE. A socket the OS closed under a backgrounding app delivers no `Close`
    // (the listener of a live one would have nulled `this.ws`), but its `send` REJECTS - and the
    // plugin has already dropped such a connection, so `disconnect()` on it can only answer
    // "Trying to work with closed connection" (Mi 9T, 2026-10-06, on every background). The
    // rejection is the fact, known here: release only a socket whose send was accepted.
    void ws.send(JSON.stringify({ type: 'disconnect' })).then(
      () => {
        ws.disconnect().catch((e: unknown) => {
          console.warn(`[WS] pauseSocket: native disconnect failed: ${String(e)}`);
        });
      },
      (e: unknown) => {
        console.log(
          `[WS] pauseSocket: socket already closed natively (${String(e)}) - nothing to release.`
        );
      }
    );
    console.log('[WS] Paused - disconnect sent, socket released until the next foreground.');
  }

  /** Sends an ephemeral typing signal over the native WebSocket for a DM/group. */
  sendTyping(groupId: string, isTyping: boolean): void {
    if (this.ws) {
      this.ws
        .send(JSON.stringify({ type: 'typing', groupId, state: isTyping ? 'start' : 'stop' }))
        .catch(() => {
          // Best-effort - typing is non-critical
        });
    }
  }

  /**
   * Tauri override: when localStorage was cleared (Android WebView eviction / reinstall),
   * restore the original device id from native push_context.json so we don't generate a
   * new id and trigger a credential mismatch against the persisted MLS state.
   */
  protected override async restoreDeviceIdFromNative(userId: string): Promise<string | null> {
    try {
      const ctx = await invoke<{ deviceId?: string; userId?: string } | null>('load_push_context');
      if (ctx?.deviceId && ctx.userId === userId) return ctx.deviceId;
    } catch {
      /* desktop / file absent */
    }
    return null;
  }

  /**
   * Tauri override: writes the id into `push_context.json`, which is the file
   * {@link restoreDeviceIdFromNative} reads back and the one place the WebView cannot evict.
   *
   * Deliberately NOT `store_push_context`: that command needs a device key and a keystore write
   * that succeeds, and its two call sites only reach it after an auth-token refresh returns from
   * the network. This one patches the two identity keys and nothing else, so the backup exists
   * from the moment the id does - offline, in biometric mode, and with the keystore refusing.
   */
  protected override async persistDeviceIdNatively(
    userId: string,
    deviceId: string
  ): Promise<void> {
    await invoke('store_device_identity', { userId, deviceId });
  }

  /**
   * Logs what the `KeyPackage` label in the load-time composition line is made of.
   *
   * THE NATIVE TWIN OF `WebMlsService.logKeyPackageCensus`, and the reason it exists is that it used
   * to have no twin at all: native printed the census from inside `load_or_create`, which is on the
   * awaited path of `initialiser_mls` - in front of the first screen. Measured on OXYGEN
   * 2026-09-17, 5 groups, 1000-package pool: a cold load costs 24.5 ms with the diagnostic and
   * 12.9 ms without it. The web call site's own docblock already said a thousand deserialised
   * bundles do not belong in front of the connected badge; native was doing exactly that.
   *
   * Best-effort by design, like the web one: a diagnostic that can break a session is worse than no
   * diagnostic, and the caller has nothing to decide on the result.
   */
  logKeyPackageCensus(): void {
    invoke<string>('recenser_key_packages')
      .then((census) => console.log(`[MLS] key package census - ${census}`))
      .catch((e: unknown) => console.warn(`[MLS] key package census unavailable: ${String(e)}`));
  }

  /** Implementation body for init(); resolves device ID from native push context or localStorage, calls `initialiser_mls`, and seeds the known-groups cache. */
  protected async _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    this.userId = userId;
    this.delivery.userId = userId;
    this._deviceKeyB64 = deviceKeyB64;
    // ONE PREDICATE FOR "THIS DEVICE HAS A SAVED STATE", read three times below - and it is no
    // longer `!!state`, because since 2026-09-15 the login path deliberately leaves the 7,8 MB
    // blob on disk rather than hauling it through the IPC bridge twice ({@link MlsInitOptions}).
    // Every branch here that reacts to a missing state is destructive - a fresh start rotates the
    // device identity - so all three had to learn the difference between "there is none" and
    // "it was not passed".
    const savedStateExists = !!state || opts?.stateOnDisk === true;
    this.freshStart = !savedStateExists;

    // A KEY OF UNPROVEN OWNER WITH NO STATE TO OPEN PROVES NOTHING, and a fresh start would seal a
    // new state under it - another account's key, as far as anything here knows. The login refuses
    // this before calling init; it is restated here so the contract of `vaultOwnerUnproven` does not
    // depend on that caller.
    if (opts?.vaultOwnerUnproven && !savedStateExists) {
      console.warn(
        '[VAULT] unlabelled vault key refused - no saved state to prove the account with'
      );
      throw new VaultOwnerUnprovenError('no_state');
    }

    // Per-user device ID (same rationale as WebMlsService). resolveDeviceId restores
    // from localStorage or the native push_context before generating a fresh id, and
    // is idempotent: a no-op when login already resolved it before the pin-check.
    await this.resolveDeviceId(userId);

    // A KEPT ID WITH A LOST STATE RE-ENROLS AS A NEW DEVICE (`reenrolLostState`). The rotation loads
    // and persists the fresh client itself; the post-init steps below (push context, groups cache)
    // still run, under the new id.
    const reenrolled = !savedStateExists && (await this.reenrolLostState(deviceKeyB64, opts));

    // THE NAME IS THE SAME ON BOTH PLATFORMS ON PURPOSE. `WebMlsService` brackets its own decrypt
    // with `mls-load-state` too, so an Android report and a browser report answer the same question
    // with the same word - which is the only way the two can be compared at all, and the phone is
    // where this block was measured at 1621.9 ms with nothing inside it named.
    beginBootSpan('mls-load-state');
    try {
      if (!reenrolled) {
        await this.loadStateWithKey(
          deviceKeyB64,
          state,
          opts?.stateOnDisk,
          opts?.unattendedKeyRead
        );
      }
      endBootSpan('mls-load-state', { recovered: false });
    } catch (e) {
      // CLOSED HERE RATHER THAN IN A `finally`, because the two exits are not the same measurement:
      // this one is a decrypt that failed and handed the rest of its time to a recovery, and a
      // report that merged them would show a fresh-start boot as a slow load.
      endBootSpan('mls-load-state', { recovered: true });
      // If init fails AND a saved state existed, the state is to blame
      // (credential mismatch, partial corruption, invalid key…).
      // → systematic fresh-start to avoid blocking the user indefinitely.
      // If state == null and error → real crash (no state to blame) → rethrow.
      let cause = this.classifyStateLoadFailure(e);

      // `mls.bin` IS ONE FILE PER INSTALL, AND A RECORD BESIDE IT SAYS WHOSE IT IS. When that record
      // names another account, this account's key was never going to open it - and every branch
      // below either writes (the re-seal, the rotation) or hands the gate a reset that deletes it. So
      // it is refused first, whatever the cause, and NOTHING is written. Only a record naming someone
      // else proves it: no record is absence of proof (`mls_state_owner`).
      if (savedStateExists) {
        const owner = await this.savedStateOwner();
        if (owner !== null && owner !== userId) {
          console.warn(
            `[MLS] The saved state is recorded as another account's (${cause}) - nothing rotated, nothing written; the gate withholds the reset`
          );
          throw new SavedStateOfAnotherAccountError(e);
        }
      }

      // A KEY OF UNPROVEN OWNER IS REFUSED BEFORE ANY RECOVERY CAN RUN, because every recovery below
      // writes: the legacy re-seal persists `mls.bin`, and a rotation replaces it. `mls.bin` is one
      // file per install, so with the unlabelled vault of the account that signed in before, a
      // `mismatch` here is THAT account's state - and rotating it away was the data loss this
      // refusal exists for (see `MlsInitOptions.vaultOwnerUnproven`).
      if (opts?.vaultOwnerUnproven) {
        const refusal = cause === 'mismatch' ? 'mismatch' : 'unopenable';
        console.warn(
          `[VAULT] unlabelled vault key refused on the saved state (${cause}) - nothing rotated, nothing written; PIN gate next`
        );
        throw new VaultOwnerUnprovenError(refusal);
      }

      // No key in the keystore (a cancelled or refused sheet, a wiped entry) says nothing about
      // the saved state and is recoverable - the user just needs to enter their PIN. Do NOT
      // destroy the device identity: let the error propagate to the PIN modal.
      const isKeystoreEmpty = cause === 'keystore_unavailable';

      // A snapshot written before v0.11.0 sits in the Argon2id envelope and cannot decrypt with
      // the device key, which is indistinguishable here from a key rotated on another device.
      // Retry once letting Rust try that envelope: on success it re-seals and persists mls.bin.
      // Must not `return` on success - the push-context write below this block still has to run.
      let migrated = false;
      if (cause === 'undecryptable' && savedStateExists && opts?.legacyPin && !isKeystoreEmpty) {
        try {
          await this.invokeInit(deviceKeyB64, state, opts.legacyPin, opts.stateOnDisk);
          migrated = true;
          console.log('[MLS] Pre-v0.11.0 mls.bin re-sealed under the device key.');
        } catch (migrationError) {
          // Two very different failures land here: the blob was not a legacy envelope at all
          // (still `undecryptable` -> recovery), or it opened and names another device
          // (`mismatch` -> fresh start). Keeping the original verdict would offer an old-PIN
          // recovery for an identity no PIN can repair.
          cause = this.classifyStateLoadFailure(migrationError);
          console.warn(
            `[MLS] Legacy migration did not yield a usable state (${cause}):`,
            String(migrationError).slice(0, 200)
          );
        }
      }

      if (migrated) {
        // State recovered in place: keep the device identity and fall through to the normal
        // post-init steps.
      } else if ((noPinOpensState(cause) || savedStateExists) && !isKeystoreEmpty) {
        // ANYTHING NO PIN CAN OPEN IS ROTATED, EVERYTHING ELSE IS WORTH PAUSING FOR, and the test
        // is written that way round deliberately. A `mismatch` decrypted fine and names another
        // device; an `altered` state's header names THIS key and its tag fails (DE7, CORRUPT-2) -
        // honouring noFreshStart for either strands the user on a gate asking for a PIN that cannot
        // exist. Everything else - a PIN rotated elsewhere, a legacy blob that says nothing, a
        // failure this classifier has never been taught about - is a reason to STOP rather than to
        // rotate an identity and lose what the blob still holds. Never widened past the fingerprint:
        // a rotation on every failed decrypt destroys the history of every real PIN rotation.
        if (opts?.noFreshStart && !noPinOpensState(cause)) {
          throw new SavedStateUnopenedError(
            cause === 'rotated' || cause === 'undecryptable' ? cause : 'unknown',
            e
          );
        }
        if (cause === 'altered') {
          console.error(
            `[MLS] The saved state was ALTERED under the key its header names - no PIN opens it; rotating the device identity: ${String(e).slice(0, 200)}`
          );
        }
        await this.rotateDeviceIdentity(
          deviceKeyB64,
          cause === 'mismatch'
            ? 'credential mismatch - stale state'
            : `loaded state unusable (${cause}): ${String(e).slice(0, 200)}`
        );
      } else {
        throw e;
      }
    }

    // Write mls.bin immediately after init so the FCM service can decrypt
    // even if no message has been processed yet (saveState not yet called).
    //
    // IT IS TIMED THOUGH NOTHING AWAITS IT, AND THAT IS THE POINT. This writes the whole snapshot -
    // `saveState`'s own docblock records 2.0 s of a 3.7 s phone measurement for writing it twice -
    // and it is started here while `lister_groupes` below IS awaited. If the native side serialises
    // these calls, the awaited one queues behind this write and the boot pays for it without any
    // line saying so. A span that is still open at `MLS ready` reports exactly that.
    const savePromise = timeBootSpan('mls-save-state', this.persistState(deviceKeyB64)).catch(
      () => {}
    );

    // Save session context for Android push notifications (no-op on desktop).
    // Must run AFTER saveState writes mls.bin (C3: race condition fix).
    // Only applicable when a device key is available (C5: skip in biometric mode
    // where deviceKeyB64="" would store an empty key, overwriting the
    // biometric key already stored by biometricLoginImpl → getKeyBytes).
    if (deviceKeyB64.length > 0) {
      void savePromise.then(() =>
        getToken()
          .then((pushToken: string) =>
            invoke('store_push_context', {
              deviceKeyB64,
              userId,
              deviceId: this.deviceId,
              baseUrl: this.historyUrl,
              pushToken,
              // Restated because this call REPLACES push_context.json - see set_push_context_locale.
              locale: getLocale(),
            })
          )
          // EVERY SWALLOWED BRANCH LOGS. This chain is gated on a network round-trip and a
          // keystore write, and it silently carried the device-identity backup until that backup
          // became `store_device_identity`'s own job - months of drift with nothing in any log.
          // `String(e)`: the class names the cause (`TransportFailureError` on an offline start,
          // when no token exists), and the stack of a known throw is a dozen lines that say nothing.
          // NOT re-attempted at the reconnect - an open item, see offline-and-weak-network section 15.
          .catch((e) =>
            console.warn(`[MLS][Tauri] push_context write after init failed: ${String(e)}`)
          )
      );
    }

    // Populate the local groups cache from Rust after init. AWAITED, so it is on the boot's
    // critical path in a way the write above is not - which is the whole reason both carry a clock.
    beginBootSpan('mls-list-groups');
    try {
      const groups = await this.syncGroupCachesFromNative();
      endBootSpan('mls-list-groups', { groups });
    } catch (e) {
      endBootSpan('mls-list-groups', { failed: true });
      // Non-blocking: cache stays empty, GroupAlreadyExists fallback will handle it.
      console.error('[MLS][Tauri] listing the held groups at start-up failed:', String(e));
    }
  }

  /**
   * Rebuilds BOTH caches of the native manager - the groups it holds and the epoch of each - from
   * the manager itself, as one fact.
   *
   * THE EPOCH CACHE WAS NEVER FILLED HERE, and `getEpoch` answers 0 for a group it has no entry for.
   * So after every cold start, every group held whose drain carried no frame read as epoch 0 - and
   * a key group the server had at 56 then looked 56 epochs BEHIND. `verifyDistributionEpoch` asked
   * the commit log from epoch 0, the replay broke on the first commit (epoch 0, against a tree at
   * 56), the gap stayed armed - so `distributionEpochFor` refused every seal - and 45 s later the
   * sync watchdog forgot the tree and external-joined again, one burst per device across all its
   * key groups. Production 2026-10-09: 449 re-joins in six days, 378 from native apps, each at the
   * head of a log whose previous commit was the same device's own join.
   *
   * IT WRITES INTO THE LIVE CACHES, NEVER SWAPS THEM. Commits, merges, joins, Welcomes and forgets
   * keep landing while it awaits, so every write is guarded by {@link _cacheStamp}: a group created,
   * joined or forgotten after the listing started keeps what that call wrote, and an epoch read by a
   * later-started refresh is never lowered by this function's older reading.
   *
   * @returns how many groups the manager holds
   */
  private async syncGroupCachesFromNative(): Promise<number> {
    const listStamp = this.nextCacheStamp();
    const groups = await invoke<string[]>('lister_groupes');
    const listed = new Set(groups);
    // A group some call started on after the listing did (created, joined, refreshed or forgotten)
    // carries a newer fact than this listing - it is left to that call, listed or not.
    const settled = groups.filter((groupId) => this.untouchedSince(groupId, listStamp));
    for (const groupId of settled) this._knownGroups.add(groupId);
    this._groupsListed = true;
    for (const groupId of new Set([...this._knownGroups, ...this._epochByGroupId.keys()])) {
      if (listed.has(groupId) || !this.untouchedSince(groupId, listStamp)) continue;
      this._knownGroups.delete(groupId);
      this._epochByGroupId.delete(groupId);
      this._cacheStamp.set(groupId, listStamp);
    }
    // Each reading takes its own stamp NOW, before its read, and lands as it resolves.
    await Promise.all(
      settled.map((groupId) => this.readEpochIntoCache(groupId, this.nextCacheStamp(groupId)))
    );
    console.log(
      `[MLS][Tauri] group caches rebuilt from the native manager - ${groups.length} group(s)`
    );
    return groups.length;
  }

  /**
   * THE GROUP CACHES FOLLOW A STATE OPENED BY THE RECOVERY. `openLocalStateWithKey` marks the client
   * initialised, so the login after a PIN recovery skips `_initImpl` - and with it the listing that
   * fills {@link _knownGroups}. iPhone 12, `1.2.9-alpha.2`, 2026-10-15: the native manager held the
   * group while `getLocalGroups()` answered nothing, so the restore reported "0/1 ... missing" (a
   * banner for nothing lost), demoted the conversation to pending, and the re-add's external join
   * failed with "already present locally" - until the next cold start listed it.
   */
  protected override async afterStateOpened(): Promise<void> {
    let groups: number;
    try {
      groups = await this.syncGroupCachesFromNative();
    } catch (e) {
      // REFUSED, NOT LOGGED AND RUN ON: a login over an unlisted cache is the whole cascade above.
      throw new LocalStateNotReadyError(e);
    }
    console.log(`[MLS][Tauri] state opened by the recovery - ${groups} group(s) listed`);
  }

  /** See {@link BaseMlsService.heldGroupsKnown}: true once the native manager's groups were listed. */
  override heldGroupsKnown(): boolean {
    return this._groupsListed;
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` in Rust and updates the local known-groups cache. */
  protected async createGroupImpl(groupId: string): Promise<void> {
    await invoke('creer_groupe', { groupId });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
  }

  /**
   * Native {@link persistState} writes `mls.bin` before it returns, so the checkpoint is that one
   * call. Handing its bytes back to `save_mls_state` would write the same file twice - 2.0 s of the
   * 3.7 s measured on the phone, nearly all of it marshalling the snapshot as a JS `number[]`. That
   * second write went in 2026-08-14; the marshalling it blamed only went when the command stopped
   * returning the blob at all.
   */
  protected async writeCheckpoint(
    deviceKeyB64: string,
    _latch: MlsStateWriteLatch,
    ledgers?: StateLedgerChanges
  ): Promise<void> {
    await this.persistState(deviceKeyB64, ledgers);
  }

  /** The ledgers the opened native state carries (`mls-core/src/app_ledgers.rs`). */
  protected async readStateLedgers(): Promise<Record<string, string>> {
    return invoke<Record<string, string>>('lire_ledgers_mls');
  }

  /**
   * Native `invoke` wrapper - burns `count` send generations in one crossing.
   *
   * ONE invoke for the whole burn rather than one per generation: each crossing marshals a
   * ciphertext that is thrown away, and the burn exists precisely because this platform's checkpoint
   * is too expensive to await.
   */
  protected async skipSendGenerations(groupId: string, count: number): Promise<number> {
    return invoke<number>('skip_send_generations', { groupId, count });
  }

  /**
   * Encrypts and writes `mls.bin`, and returns the number of bytes written.
   *
   * IT IS NOT CALLED `saveState`, AND THE RENAME IS THE FIX. `saveState` is web's word: there the
   * bytes ARE the persistence, because the caller still has to hand them to IndexedDB. Native had
   * inherited the same signature through {@link IMlsService}, so `sauvegarder_mls_et_persister`
   * returned the whole snapshot and Tauri marshalled it as a JSON array of one number per byte -
   * ~7.8 million integers across the bridge, then a `Uint8Array.from` over all of them, on every
   * checkpoint and once more on the awaited boot path. **All four native call sites discarded the
   * result**, and the docblock on {@link writeCheckpoint} had named that exact cost since
   * 2026-08-14 while still paying it: the fix that day removed the duplicate WRITE and left the
   * marshalling, because it never changed what the command returns.
   *
   * A length, by contrast, is eight bytes and answers the one question a caller can have about a
   * write it did not perform itself.
   */
  async persistState(deviceKeyB64: string, ledgers?: StateLedgerChanges): Promise<number> {
    await this.awaitRustMutations();
    // ONE invoke for encrypt + write: the JS side never sees the blob, which is the point. The
    // ledgers ride the same invoke and are applied to the manager before its export
    // (`stateLedgers.ts`), so they reach `mls.bin` in the write that holds their ratchets.
    return invoke<number>('sauvegarder_mls_et_persister', {
      deviceKeyB64,
      ledgers: ledgers ?? null,
    });
  }

  /**
   * C2: reloads `mls.bin` from disk into the warm in-memory engine. Called on resume (mobile)
   * BEFORE the WS resumes processing: while backgrounded, a native engine (Welcome/send) may
   * have advanced `mls.bin`; without this the warm state is stale and its next save would clobber
   * that advance (lost-update -> SecretReuse). The native command also marks the foreground
   * active first, so background engines stop writing before it reads, and refuses any reload
   * that would regress a live group's epoch.
   *
   * A missing device key means there is nothing to decrypt with -- skip rather than throw, since
   * this runs on every resume and a failure here must not break the resume sequence.
   *
   * THE REFUSAL IS DECIDED IN RUST, UNDER THE MANAGER LOCK, AND THIS METHOD ONLY ACTS ON IT.
   * `reload_is_monotonic` grades group EPOCHS, and what a send or a decrypted frame moves is a
   * GENERATION inside one epoch: a snapshot a few messages old is accepted, the live ratchet goes
   * back, a frame already read decrypts a second time (measured on the Mi 9T 2026-09-08, gen 45/46
   * re-derived 112 ms after a reload) and the next send re-issues a spent generation. The guard
   * that stood here counted SENDS in the WebView, so a RECEIVE moved nothing it could see, and
   * even a send landing between its check and the native swap was overwritten. The live manager
   * itself knows whether it is ahead of the file (`MlsManager::has_unsaved_ratchet_advance`), and
   * asking it inside the lock the swap holds leaves no interleaving to reconcile afterwards.
   *
   * `live-ahead` OBLIGES US to persist the live state: that is what makes the NEXT resume safe and
   * the only ordering under which a background engine starting later reads a state that is not
   * already behind. Web keeps its own counter (`installUnlessOvertaken`) because its swap runs
   * off-thread; the two stay separate for that reason, not for lack of a shared one.
   */
  override async reloadStateFromDisk(): Promise<void> {
    if (!this._deviceKeyB64) {
      console.warn('[MLS][Tauri] reloadStateFromDisk skipped - no device key in session.');
      return;
    }
    // THE INDEX GOES BEFORE THE SWAP: a send racing the reload re-reads the state (or is refused by
    // it natively) instead of trusting an index of the state being replaced.
    this.forgetUnresolvedIndex();
    try {
      const outcome = await invoke<ReloadOutcome>('recharger_mls_au_resume', {
        userId: this.userId,
        deviceId: this.deviceId,
        deviceKeyB64: this._deviceKeyB64,
      });
      if (outcome === 'reloaded') {
        // The installed manager may be AHEAD of the live one (a background engine advanced the
        // file), so the epochs are re-read with the groups - a stale-low epoch reads as "behind".
        await this.syncGroupCachesFromNative();
        console.log('[MLS][Tauri] mls.bin reloaded on resume (C2) - group cache refreshed.');
        // The installed state may hold a commit a background engine staged and could not settle (a
        // background Welcome whose answer it never read): settled like this session's own.
        this.settleAfterStateReplaced();
      } else if (outcome === 'live-ahead') {
        console.warn(
          '[MLS][Tauri] Resume reload SKIPPED: the live manager holds a send or a decrypted frame that mls.bin does not - reloading would put the ratchet back. Persisting the live state instead.'
        );
        await this.persistState(this._deviceKeyB64).catch((e) => {
          console.error('[MLS][Tauri] Persist of the live state after a skipped reload failed:', e);
        });
      } else {
        console.log(`[MLS][Tauri] Resume reload not applied (${outcome}) - live state kept.`);
      }
    } catch (e) {
      // Non-fatal: the warm state stays in place. Losing the reload risks clobbering a background
      // advance, so this must be loud even though it does not abort the resume.
      console.error('[MLS][Tauri] reloadStateFromDisk failed:', e);
    }
  }

  /**
   * Reads back the at-rest key `initialiser_mls` cached natively for this session.
   *
   * Biometric mode calls {@link invokeInit} with an empty string, so `_deviceKeyB64` stays empty
   * and the frontend holds no key - yet the frontend is the only layer that encrypts locally
   * stored messages. Rust resolved it from the keystore behind the one BiometricPrompt of the
   * login and cached it, so this costs no second prompt.
   *
   * Also fills `_deviceKeyB64` when it is empty: {@link reloadStateFromDisk} skips on a missing
   * key, and skipping it on every resume is how a background engine's advance to `mls.bin` gets
   * clobbered by the next save (lost-update -> SecretReuse).
   */
  override async resolveSessionDeviceKey(): Promise<string | null> {
    const keyB64 = await invoke<string | null>('recuperer_cle_session_mls');
    if (!keyB64) return null;
    if (!this._deviceKeyB64) this._deviceKeyB64 = keyB64;
    return keyB64;
  }

  /**
   * The account `mls.bin` was last opened for, `null` when none is recorded (`mls_state_owner`).
   *
   * Asked only once a load has FAILED, so a sign-in that opens its state pays nothing for it. The
   * command never rejects for a missing or unreadable record (it answers `null` and logs natively);
   * a rejection here is the bridge itself failing, and it propagates - read as "no owner", it would
   * hand the gate a reset that may delete another account's state.
   */
  private async savedStateOwner(): Promise<string | null> {
    return (await invoke<string | null>('mls_state_owner')) ?? null;
  }

  /** Native decrypt + client init for a given device key/state; throws on wrong key (no fresh-start). */
  protected async loadStateWithKey(
    deviceKeyB64: string,
    state?: Uint8Array,
    stateOnDisk?: boolean,
    unattendedKeyRead?: boolean
  ): Promise<void> {
    this._groupsListed = false;
    await this.invokeInit(deviceKeyB64, state, undefined, stateOnDisk, unattendedKeyRead);
  }

  /**
   * Single `initialiser_mls` call site.
   *
   * `legacyPin` is only ever set on the migration retry from {@link _initImpl}: with it, the Rust
   * side may fall back to the pre-v0.11.0 Argon2id envelope, re-seal `mls.bin` under
   * `deviceKeyB64` and persist it. {@link loadStateWithKey} must stay free of it so probing a
   * candidate key (openLocalStateWithKey) cannot rewrite the stored snapshot as a side effect.
   *
   * `biometricPrompt` is sent unconditionally, even though only biometric mode (empty
   * `deviceKeyB64`) raises a sheet: this is the one command that can carry it, because the native
   * keystore plugin cannot resolve a locale of its own.
   *
   * `unattendedKeyRead` is the biometric cadence's "skip the sheet" - see {@link MlsInitOptions}.
   */
  private async invokeInit(
    deviceKeyB64: string,
    state?: Uint8Array,
    legacyPin?: string,
    stateOnDisk?: boolean,
    unattendedKeyRead?: boolean
  ): Promise<void> {
    this._deviceKeyB64 = deviceKeyB64;
    // `Array.from` ON A MULTI-MEGABYTE BLOB IS THE THING TO AVOID HERE, and `stateOnDisk` is how
    // the login path avoids it: Rust reads `mls.bin` itself and nothing is serialised. What is left
    // is the two callers that genuinely hold bytes the native side could not have read - the
    // pre-v0.11.0 migration retry and a probe of a candidate key - and they are one-off flows.
    const encryptedState = state ? Array.from(state) : null;
    await invoke('initialiser_mls', {
      userId: this.userId,
      deviceId: this.deviceId,
      deviceKeyB64,
      encryptedState,
      opts: {
        legacyPin: legacyPin ?? null,
        biometricPrompt: keystoreUnlockPrompt(),
        stateOnDisk: stateOnDisk === true,
        unattendedKeyRead: unattendedKeyRead === true,
      },
    });
  }

  /**
   * See {@link BaseMlsService.pointUnattendedUnlockAt}: the keystore entry biometric unlock and the
   * background push read, rewritten with the new key and AWAITED - unlike the refresh inside
   * {@link changeDeviceKeyImpl}, because here the order is the point. A refusal propagates: the
   * caller must not move any data while an unattended unlock still opens the old state.
   *
   * A REFUSED WRITE DELETES THE ENTRY BEFORE IT PROPAGATES. A refusal that came before the native
   * side's own deletes (a malformed key, a platform that throws first) would leave the OLD key in
   * the keystore, and with biometric unlock on that is a silent login on the old PIN, skipping the
   * server check. With no entry, the next launch asks for the PIN; the biometric flag is left as the
   * user set it, and the next PIN login writes the entry back (`store_push_context`).
   */
  override async pointUnattendedUnlockAt(newDeviceKeyB64: string): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    try {
      await invoke('actualiser_cle_keystore_avec_devicekey', {
        deviceKeyB64: newDeviceKeyB64,
        userId: this.userId,
        deviceId: this.deviceId,
      });
    } catch (e) {
      // Through the at-rest guard: an entry holding a phone's hardware-held key is never deleted
      // here (its account's marker refuses it) - the change moved no data, and that key still opens it.
      console.error('[MLS][Tauri] Keystore refused the new device key - deleting its entry:', e);
      await invoke(DELETE_DEVICE_KEY_COMMAND, {
        alias: keystoreAlias(this.userId, this.deviceId),
      }).catch((d) =>
        console.error('[MLS][Tauri] Deleting the keystore entry after a refusal failed too:', d)
      );
      throw e;
    }
    console.log('[MLS][Tauri] Keystore now holds the new device key (unattended unlock moved).');
    return true;
  }

  protected async changeDeviceKeyImpl(newDeviceKeyB64: string): Promise<void> {
    this._deviceKeyB64 = newDeviceKeyB64;
    await this.persistState(newDeviceKeyB64);

    // Always regenerate the keystore key for background push, regardless of the biometric flag.
    // The keystore key is required for FCM decryption even without biometrics.
    if (isTauriRuntime()) {
      invoke('actualiser_cle_keystore_avec_devicekey', {
        deviceKeyB64: newDeviceKeyB64,
        userId: this.userId,
        deviceId: this.deviceId,
      }).catch((e) =>
        console.warn('[MLS][Tauri] Keystore key refresh after device key change failed:', e)
      );
    }

    // Refresh the native push context so background FCM decryption uses the
    // updated keystore key.
    void getToken()
      .then((pushToken: string) =>
        invoke('store_push_context', {
          deviceKeyB64: newDeviceKeyB64,
          userId: this.userId,
          deviceId: this.deviceId,
          baseUrl: this.historyUrl,
          pushToken,
          // Restated because this call REPLACES push_context.json - see set_push_context_locale.
          locale: getLocale(),
        })
      )
      .catch((e) =>
        console.warn('[MLS][Tauri] push_context refresh after device key change failed:', e)
      );

    console.log('[MLS][Tauri] Device key changed - state re-encrypted and persisted.');
  }

  /** Tauri-native `invoke` wrapper - calls `generer_key_packages_et_persister`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  protected async generateKeyPackageImpl(deviceKeyB64: string): Promise<DatedKeyPackage> {
    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      // THE RETURN IS DELIBERATELY UNUSED HERE, and only here. `freshStart` means the manager was
      // built with no state at all, so the keystore holds no private bundle for anything the
      // server is about to delete - there is nothing to reclaim, and calling `forgetPurgedPrekeys`
      // would log a "reclaimed 0/50" line whose only content is that this branch cannot apply.
      // The purge itself still matters: those published prekeys have no private half anywhere, and
      // a peer consuming one is the `NoMatchingKeyPackage` loop.
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    //
    // A BUNDLE IS 1 936 BYTES, NOT THE ~400 THIS COMMENT CLAIMED UNTIL 2026-09-06 - measured by
    // `mls-core/tests/state_weight.rs`, where 200 of them are 60% of a state that also holds 41
    // groups. The figure mattered: it is the arithmetic the pool size of 50 was chosen against, and
    // being wrong by five times is what made "hundreds of unused bundles" sound affordable. A
    // device through the 2026-09 healing campaign reached a 19 548 753-byte `mls.bin` that took
    // 17 s to checkpoint and 22 s to unlock behind the PIN.
    //
    // The pool size is NOT the leak and lowering it is not the fix - `republishKeyMaterial` purges
    // the server and mints a fresh 50 once per 30 s during a `NoMatchingKeyPackage` storm, and each
    // of those rounds orphans the previous 50 locally for ever. What bounds it is
    // `MlsManager::prune_expired_key_packages`, which runs once per load in `load_or_create` and so
    // covers this path, the web one and the background FCM one alike.
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);
    console.log(`[MLS][Tauri] generateKeyPackage native batch path needed=${needed}`);

    // Single native command: generate fallback + OTKPs + persist encrypted state.
    const nativeBatch = await invoke<NativeKeyPackageBatchResult>(
      'generer_key_packages_et_persister',
      {
        deviceKeyB64,
        count: needed,
      }
    );
    const dated = (kp: NativeDatedKeyPackage): DatedKeyPackage => ({
      bytes: Uint8Array.from(kp.public),
      notAfterSecs: kp.notAfterSecs,
    });
    const fallback = dated(nativeBatch.fallback);
    const poolPackages = nativeBatch.pool_packages.map(dated);

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** Tauri-native `invoke` wrapper - checks via `key_package_a_clef_privee` that we hold the KeyPackage's private key. */
  protected async keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean> {
    return invoke<boolean>('key_package_a_clef_privee', {
      keyPackageBytes: Array.from(keyPackageBytes),
    });
  }

  /**
   * Tauri-native `invoke` wrapper - drops the private bundles the server reported purging.
   *
   * The device key goes with it because the native side PERSISTS: a reclaim that is not written
   * back to `mls.bin` is reclaimed again next session and never shrinks the file the whole
   * measurement was taken on.
   */
  protected async forgetKeyPackages(publicKeyPackages: Uint8Array[]): Promise<number> {
    return invoke<number>('oublier_key_packages', {
      deviceKeyB64: this._deviceKeyB64,
      keyPackages: publicKeyPackages.map((kp) => Array.from(kp)),
    });
  }

  /**
   * Tauri-native `invoke` wrapper - stages an Add commit WITHOUT merging via `ajouter_membres_bulk`
   * (all key packages in one OpenMLS commit, one shared Welcome). Returns
   * (commit, welcome?, addedIndices, skipped, groupInfo) - the last being the base for the epoch
   * the commit creates. `addedIndices` are positions in `keyPackages`
   * actually included - entries skipped (invalid, or already a member) are omitted rather than
   * collapsing to a bare count. `skipped` is `{ index, reason }` per INVALID/undeserializable
   * KeyPackage, the reason typed in Rust (not the already-member dedup), surfaced so the loss is not silent. [[C5]]
   */
  protected async stageAddMembers(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; identity: string }>,
    intent: Uint8Array
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    groupInfo: Uint8Array;
    addedIndices: number[];
    skipped: SkippedKeyPackage[];
  }> {
    const keyPackagesBytes = devices.map((d) => Array.from(d.keyPackage));
    const expectedIdentities = devices.map((d) => d.identity);
    const result = await invoke<
      [number[], number[] | null, number[], SkippedKeyPackage[], number[]]
    >('ajouter_membres_bulk', {
      groupId,
      keyPackagesBytes,
      expectedIdentities,
      intent: Array.from(intent),
    });
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
      addedIndices: result[2],
      skipped: result[3] ?? [],
      groupInfo: Uint8Array.from(result[4]),
    };
  }

  /** Tauri-native `invoke` wrapper - `remplacer_appareil`, staged not merged and recorded with
   *  `intent` in the same call. */
  protected async stageReplaceDevice(
    groupId: string,
    identity: string,
    keyPackage: Uint8Array,
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; welcome: Uint8Array; groupInfo: Uint8Array }> {
    const [commit, welcome, groupInfo] = await invoke<[number[], number[], number[]]>(
      'remplacer_appareil',
      { groupId, identity, keyPackage: Array.from(keyPackage), intent: Array.from(intent) }
    );
    return {
      commit: Uint8Array.from(commit),
      welcome: Uint8Array.from(welcome),
      groupInfo: Uint8Array.from(groupInfo),
    };
  }

  /**
   * `mls_state_absent`: `true` only when `mls.bin` does not exist or is empty. An unreadable data
   * directory is an `Err`, which `reenrolLostState` reads as "not proven" - unlike `mls_state_size`,
   * which answers 0 for it.
   */
  protected async savedStateProvenAbsent(): Promise<boolean> {
    return invoke<boolean>('mls_state_absent');
  }

  /** Tauri-native `invoke` wrapper - `verifier_key_package`, the Rust verdict on binding and pin. */
  protected async vetKeyPackageNative(
    keyPackage: Uint8Array,
    identity: string
  ): Promise<KeyPackageVerdict> {
    return invoke<KeyPackageVerdict>('verifier_key_package', {
      keyPackage: Array.from(keyPackage),
      expectedIdentity: identity,
    });
  }

  /** Tauri-native `invoke` wrapper - `cles_signature_epinglees`, the keys as byte arrays. */
  protected async pinnedSignatureKeysNative(
    userId: string,
    deviceId: string
  ): Promise<DevicePin | null> {
    const pin = await invoke<{
      keys: number[][];
      anchored: boolean;
      reaffirmations: number;
    } | null>('cles_signature_epinglees', { userId, deviceId });
    return pin === null ? null : { ...pin, keys: pin.keys.map((k) => Uint8Array.from(k)) };
  }

  /** Tauri-native `invoke` wrapper - `epoques_departs`, the epochs as JSON numbers. */
  protected async removalEpochsNative(groupId: string, userId: string): Promise<number[]> {
    return invoke<number[]>('epoques_departs', { groupId, userId });
  }

  /** Tauri-native `invoke` wrapper - `prendre_evenements_appareils` (`DeviceEvent`, camelCase). */
  protected async takeDeviceEventsNative(): Promise<DeviceEvent[]> {
    return invoke<DeviceEvent[]>('prendre_evenements_appareils');
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for all devices of the given users (no merge). */
  protected async stageRemoveMembers(
    groupId: string,
    userIds: string[],
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }> {
    const [commit, groupInfo] = await invoke<[number[], number[]]>('retirer_membres', {
      groupId,
      userIds,
      intent: Array.from(intent),
    });
    return { commit: Uint8Array.from(commit), groupInfo: Uint8Array.from(groupInfo) };
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for specific device identities (no merge). */
  protected async stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[],
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }> {
    const [commit, groupInfo] = await invoke<[number[], number[]]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
      intent: Array.from(intent),
    });
    return { commit: Uint8Array.from(commit), groupInfo: Uint8Array.from(groupInfo) };
  }

  /** Tauri-native `invoke` wrapper - stages a refresh of this device's own leaf (no merge). */
  protected async stageSelfUpdate(
    groupId: string,
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }> {
    const [commit, groupInfo] = await invoke<[number[], number[]]>('rafraichir_feuille', {
      groupId,
      intent: Array.from(intent),
    });
    return { commit: Uint8Array.from(commit), groupInfo: Uint8Array.from(groupInfo) };
  }

  /** Tauri-native `invoke` wrapper - when this device's leaf was minted, `null` once a commit replaced it. */
  protected async ownLeafMintedAt(groupId: string): Promise<number | null> {
    return (await invoke<number | null>('date_feuille', { groupId })) ?? null;
  }

  /** Tauri-native `invoke` wrapper - this device's leaf key as hex, `null` with no own leaf. */
  protected async ownLeafKey(groupId: string): Promise<string | null> {
    const key = await invoke<number[] | null>('cle_feuille', { groupId });
    return key ? toHex(new Uint8Array(key)) : null;
  }

  /** Tauri-native `invoke` wrapper - whether this device's context is the one the served base describes. */
  protected async ownContextMatchesBase(groupId: string, groupInfo: Uint8Array): Promise<boolean> {
    return invoke<boolean>('contexte_correspond_base', {
      groupId,
      groupInfo: Array.from(groupInfo),
    });
  }

  /** Tauri-native `invoke` wrapper - see {@link BaseMlsService.pendingSubmission}. */
  protected async pendingSubmission(groupId: string): Promise<PendingSubmissionRead> {
    const res = await invoke<
      | { status: 'none' | 'unreadable' }
      | {
          status: 'recorded';
          intent: number[];
          baseEpoch: number;
          commit: number[];
          groupInfo: number[];
          welcome: number[] | null;
          addedIndices: number[];
        }
    >('soumission_en_attente', { groupId });
    if (res.status !== 'recorded') return { status: res.status };
    return {
      status: 'recorded',
      record: {
        intent: Uint8Array.from(res.intent),
        baseEpoch: res.baseEpoch,
        commit: Uint8Array.from(res.commit),
        groupInfo: Uint8Array.from(res.groupInfo),
        welcome: res.welcome ? Uint8Array.from(res.welcome) : undefined,
        addedIndices: res.addedIndices,
      },
    };
  }

  /** Tauri-native `invoke` wrapper - see {@link BaseMlsService.mergePendingCommitOwingWelcome}. */
  protected async mergePendingCommitOwingWelcome(
    groupId: string,
    recipients: string[]
  ): Promise<void> {
    await invoke('confirmer_commit_welcome_du', { groupId, recipients });
    await this.refreshEpochCache(groupId);
  }

  /** Tauri-native `invoke` wrapper - see {@link BaseMlsService.owedWelcomes}. */
  protected async owedWelcomes(): Promise<OwedWelcome[]> {
    const owed =
      await invoke<
        Array<{ groupId: string; welcome: number[]; ratchetTree: number[]; recipients: string[] }>
      >('welcomes_dus');
    return owed.map((w) => ({
      groupId: w.groupId,
      welcome: Uint8Array.from(w.welcome),
      ratchetTree: Uint8Array.from(w.ratchetTree),
      recipients: w.recipients,
    }));
  }

  /** Tauri-native `invoke` wrapper - see {@link BaseMlsService.welcomeDelivered}. */
  protected async welcomeDelivered(
    groupId: string,
    recipient: string,
    welcome: Uint8Array
  ): Promise<void> {
    await invoke('welcome_remis', { groupId, recipient, welcome: Array.from(welcome) });
  }

  /** Tauri-native `invoke` wrapper - see {@link BaseMlsService.groupsWithPendingCommit}. */
  protected async groupsWithPendingCommit(): Promise<string[]> {
    return invoke<string[]>('groupes_commit_en_attente');
  }

  /** Tauri-native `invoke` wrapper - merges the pending staged commit (server accepted) and refreshes the epoch cache. */
  protected async mergePendingCommit(groupId: string): Promise<void> {
    await invoke('confirmer_commit', { groupId });
    await this.refreshEpochCache(groupId);
  }

  /** Tauri-native `invoke` wrapper - clears the pending staged commit (server rejected, no fork). */
  protected async clearPendingCommit(groupId: string): Promise<void> {
    await invoke('annuler_commit', { groupId });
  }

  /** Tauri-native `invoke` wrapper - exports the post-merge ratchet tree for the Welcome. */
  protected async exportRatchetTree(groupId: string): Promise<Uint8Array> {
    const rt = await invoke<number[]>('exporter_ratchet_tree', { groupId });
    return new Uint8Array(rt);
  }

  /** Tauri-native `invoke` wrapper - reads the authoritative pre-merge epoch via `obtenir_epoch`. */
  protected async freshEpoch(groupId: string): Promise<number> {
    const stamp = this.nextCacheStamp(groupId);
    try {
      const epoch = await invoke<number>('obtenir_epoch', { groupId });
      if (this.cacheWriteAllowed(groupId, stamp)) {
        this._cacheStamp.set(groupId, stamp);
        this._epochByGroupId.set(groupId, epoch);
      }
      return epoch;
    } catch (e) {
      // The caller asked for the AUTHORITATIVE epoch and gets the cached one instead - a fallback,
      // so it accuses.
      console.error(
        `[MLS][Tauri] freshEpoch: native epoch of ${groupId.slice(0, 8)}... unreadable - answering the cached ${this.getEpoch(groupId)}:`,
        String(e)
      );
      return this.getEpoch(groupId);
    }
  }

  /** Tauri-native `invoke` wrapper - exports the self-contained GroupInfo (external-join base). */
  protected async exportGroupInfo(groupId: string): Promise<Uint8Array> {
    const gi = await invoke<number[]>('exporter_group_info', { groupId });
    return new Uint8Array(gi);
  }

  /** Tauri-native `invoke` wrapper - builds an external commit from a served GroupInfo and stages it.
   *  The native command returns the (group_id, commit) tuple; the group joins the known-groups cache. */
  protected async joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }> {
    const [groupId, commit] = await invoke<[string, number[]]>('rejoindre_par_commit_externe', {
      groupInfoBytes: Array.from(groupInfoBytes),
    });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
    return { groupId, commit: new Uint8Array(commit) };
  }

  /** Tauri-native `invoke` wrapper - calls `trailer_welcome`, updates the known-groups cache, refreshes the epoch, and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string> {
    const groupId = await invoke<string>('trailer_welcome', {
      welcomeBytes: Array.from(welcomeBytes),
      ratchetTreeBytes: ratchetTreeBytes ? Array.from(ratchetTreeBytes) : null,
    });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
    return groupId;
  }

  /**
   * Native `invoke` wrapper - encrypts via `envoyer_message_bytes`, which appends this device's
   * author signature (`mls-core/src/authorship.rs`) and advances the live send ratchet. Ordering
   * and persistence: `sendMessage`. The native side refuses, typed, a group whose state holds a
   * staged commit ({@link StagedCommitPendingError}): the state decides, not the session's index of
   * it.
   */
  protected async encryptForSend(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<AuthoredFrame> {
    const res = await invoke<SealOutcome>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    if (res.status === 'commitPending') {
      console.warn(
        `[MLS][Tauri] ${groupId.slice(0, 8)}... send refused natively: a staged commit is unsettled`
      );
      throw new StagedCommitPendingError(groupId);
    }
    return {
      sealed: Uint8Array.from(res.ciphertext),
      authorProof: Uint8Array.from(res.authorProof),
    };
  }

  /** Native `invoke` wrapper - see {@link IMlsService.takeForkFindings}. */
  async takeForkFindings(): Promise<ForkFinding[]> {
    return invoke<ForkFinding[]>('prendre_constats_fork');
  }

  /** Tauri-native `invoke` wrapper - decrypts a raw MLS ciphertext via `recevoir_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array,
    envelope?: EnvelopeSender
  ): Promise<DecryptedApplication | null> {
    const res = await invoke<{
      data: number[];
      sender: string | null;
      author: AuthorVerdict;
    } | null>('recevoir_message_bytes', { groupId, messageBytes: Array.from(messageBytes) });
    // Null is a commit or a proposal - the one result that may have moved the epoch, and the
    // commit replay reads `getEpoch` on the very next line (see `refreshEpochCache`).
    if (!res) {
      await this.refreshEpochCache(groupId);
      return null;
    }
    assertVerifiedSender(groupId, envelope, res.sender);
    return { plaintext: Uint8Array.from(res.data), author: res.author };
  }

  /** Single IPC crossing for an ordered page of ciphertexts (history catch-up on native MLS). */
  async processIncomingMessagesBatch(
    groupId: string,
    messages: Uint8Array[]
  ): Promise<MlsBatchProcessResult[]> {
    if (messages.length === 0) return [];
    const raw = await invoke<BatchDecryptRow[]>('recevoir_messages_batch', {
      groupId,
      messages: messages.map((m) => Array.from(m)),
    });
    // A page may carry commits; one read covers the whole batch.
    await this.refreshEpochCache(groupId);
    return mapNativeBatchDecryptResults(raw);
  }

  /** Tauri-native `invoke` wrapper - calls `exporter_secret` in Rust to derive a keying-material export for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('exporter_secret', {
      groupId,
      label,
      context: Array.from(context),
      keyLen,
    });
    return new Uint8Array(res);
  }

  /** Tauri-native `invoke` wrapper - publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
  async publishKeyPackage(keyPackage: DatedKeyPackage): Promise<void> {
    const base64 = toBase64(keyPackage.bytes);
    const storedName =
      localStorage.getItem(ACCOUNT_KEY.deviceName(this.userId, this.deviceId)) || undefined;
    const deviceAppVersion = getClientAppVersion();
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      notAfterSecs: keyPackage.notAfterSecs,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs('desktop'),
      deviceAppVersion,
    });
  }

  /** Returns the list of MLS group IDs known locally, populated from Rust via `lister_groupes` at init time. */
  getLocalGroups(): string[] {
    return [...this._knownGroups];
  }

  /**
   * Tauri-native `invoke` wrapper - `groupe_actif`. See {@link IMlsService.isGroupActive}.
   *
   * Read live from Rust rather than mirrored into `_knownGroups`: a cached membership flag is a
   * second copy of a fact OpenMLS already stores durably, and the only way the two can differ is
   * the way that matters - the cache saying we are still in a group we were removed from. It
   * propagates the Rust error, which is what an unheld group answers.
   */
  async isGroupActive(groupId: string): Promise<boolean> {
    return invoke<boolean>('groupe_actif', { groupId });
  }

  /**
   * Tauri-native `invoke` wrapper - every leaf identity (`userId:deviceId`) in the group's tree.
   *
   * Read live from Rust rather than cached: unlike the epoch, nothing here mirrors the tree, and a
   * stale roster is exactly the input a removal decision must never be given. It propagates the
   * Rust error, which is what an unheld group answers - never an empty tree.
   */
  async getGroupMemberIdentities(groupId: string): Promise<string[]> {
    return invoke<string[]>('lister_identites_membres', { groupId });
  }

  /** The tree's signature key for one leaf, or null when it has none (`graine_member_signature_key`). */
  async memberSignatureKey(groupId: string, identity: string): Promise<Uint8Array | null> {
    const key = await invoke<number[] | null>('graine_member_signature_key', { groupId, identity });
    return key ? new Uint8Array(key) : null;
  }

  /** The leaf carrying a package's signature key, or null (`feuille_portant_cle`). */
  async leafHoldingKeyOf(groupId: string, keyPackage: Uint8Array): Promise<string | null> {
    return invoke<string | null>('feuille_portant_cle', {
      groupId,
      keyPackage: Array.from(keyPackage),
    });
  }

  /** The key group's clean run at its current epoch (`graine_run`), read live under the manager lock. */
  async graineRun(groupId: string): Promise<GraineRunReading> {
    return invoke<GraineRunReading>('graine_run', { groupId });
  }

  /** This device's credential key signs `message` (`graine_sign_with_device_credential`). */
  async signWithDeviceCredential(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await invoke<number[]>('graine_sign_with_device_credential', { message: Array.from(message) })
    );
  }

  /** The Rust engine's Ed25519 commands: the one standalone implementation, `tauriGraineSignatureEngine`. */
  graineSignatureEngine(): GraineSignatureEngine {
    return tauriGraineSignatureEngine();
  }

  /**
   * The MLS epoch of a group, from the cache every epoch-moving native call refreshes (see
   * `refreshEpochCache` and `syncGroupCachesFromNative`). 0 for a group this device does not hold.
   */
  getEpoch(groupId: string): number {
    return this._epochByGroupId.get(groupId) ?? 0;
  }

  /** Tauri-native `invoke` wrapper - calls `oublier_groupe` in Rust to drop local MLS state and removes the group from the epoch cache. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    // A forget is a cache write like any reading: stamped, so a sync or refresh that started
    // before it cannot bring the group back (see `_cacheStamp`).
    this._cacheStamp.set(groupId, this.nextCacheStamp(groupId));
    this._epochByGroupId.delete(groupId);
    // Keep `_knownGroups` in sync synchronously (Web reads WASM live via get_groups()).
    this._knownGroups.delete(groupId);
    this.trackRustMutation(
      invoke('oublier_groupe', { groupId, minEpoch }).catch((e) => {
        console.warn('[MLS] forgetGroup error:', e);
        // The native manager may still hold it: re-read both caches from the manager.
        return this.syncGroupCachesFromNative()
          .then(() => undefined)
          .catch((err) =>
            console.error(
              '[MLS][Tauri] re-listing groups after a failed forget failed:',
              String(err)
            )
          );
      })
    );
  }
}
