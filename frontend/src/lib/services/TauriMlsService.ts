import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import NativeWebSocket, { type Message as WsMessage } from '@tauri-apps/plugin-websocket';
import {
  logMlsMetric,
  detectRuntimeDeviceOs,
  MLS_LOCAL_STATE_UNDECRYPTABLE,
  type MlsInitOptions,
} from '$lib/mls-client';
import { mapNativeBatchDecryptResults } from '$lib/mls-client/mlsBatchDecrypt';
import type { MlsBatchProcessResult } from '$lib/mls-client/IMlsService';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { getToken } from '$lib/stores/auth';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { BaseMlsService } from './BaseMlsService';

/** Native batch result for key package generation plus immediate `mls.bin` persistence. */
interface NativeKeyPackageBatchResult {
  fallback: number[];
  pool_packages: number[][];
  state: number[];
}

/**
 * MLS service implementation for Tauri (mobile/desktop).
 * Delegates all cryptographic operations to the native Rust side via `invoke()`.
 */
export class TauriMlsService extends BaseMlsService {
  private ws: Awaited<ReturnType<typeof NativeWebSocket.connect>> | null = null;
  private wsUnlisten: (() => void) | null = null;
  /** Consecutive pings sent without any incoming data frame from the server. */
  private missedHeartbeats = 0;
  /** Maximum consecutive pings without any server activity before we force-close (parity WebMlsService). */
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /** Last known MLS epoch per group (native); keeps sync `getEpoch()` meaningful on Tauri. */
  private _epochByGroupId: Map<string, number> = new Map();
  /** In-flight Rust MLS mutations; drained before `saveState` so mls.bin matches `_knownGroups`. */
  private pendingRustMutations: Promise<unknown>[] = [];
  private appVersionCache: string | null | undefined = undefined;
  // PIN kept in memory after init() to re-encrypt the MLS state after each message
  // without asking the user for the PIN again.
  private _pin = '';

  constructor() {
    super('tauri', fetch);
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

  /** Refresh cached epoch from native MLS (best-effort). */
  private async refreshEpochCache(groupId: string): Promise<void> {
    try {
      const e = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, e);
      logMlsMetric({ kind: 'epoch_cache', platform: 'tauri', groupId, epoch: e });
    } catch {
      this._epochByGroupId.delete(groupId);
    }
  }

  /**
   * Platform hook: refresh the epoch cache after each successfully processed message.
   * Called by BaseMlsService.processQueue after a successful messageCallback invocation.
   */
  protected override async onMessageProcessed(groupId: string | undefined): Promise<void> {
    if (groupId) {
      await this.refreshEpochCache(groupId);
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

  /** Tauri-native `invoke` wrapper - opens a NativeWebSocket to the chat gateway, passing the Bearer token in the URL query string for mobile compatibility. */
  async connect(token?: string): Promise<void> {
    // Unlisten + disconnect before reconnecting so the Close event doesn't trigger disconnectCallback.
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.wsUnlisten?.();
        this.wsUnlisten = null;
        await this.ws.disconnect();
      } catch {
        /* ignore */
      }
      this.ws = null;
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
    }

    // On Tauri mobile the cookie is not sent cross-origin, so we pass the
    // Bearer token explicitly in the URL query string.
    let resolvedToken = token;
    if (!resolvedToken) {
      try {
        resolvedToken = await getToken();
      } catch {
        // Proceed without token; gateway will reject with 401 if required.
      }
    }

    // Use the same regex as WebMlsService to avoid http:// → wss:// mismatch.
    const wsBase = this.baseUrl.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
    const tokenParam = resolvedToken ? `&token=${encodeURIComponent(resolvedToken)}` : '';
    const wsUrl = `${wsBase}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
    console.log(
      `[WS] Opening connection → ${wsBase}/api/ws?device_id=${this.deviceId}${resolvedToken ? '&token=***' : ' (no token)'}`
    );

    // NativeWebSocket.connect() resolves when the handshake completes, rejects on failure.
    // Impose the same 15-second timeout as WebMlsService to prevent silent hangs on Android.
    let resolved = false;
    const connectPromise = NativeWebSocket.connect(wsUrl);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        if (!resolved) reject(new Error('WebSocket connection timeout after 15s'));
      }, 15_000)
    );
    this.ws = await Promise.race([connectPromise, timeoutPromise]);
    resolved = true;
    console.log(`[WS] Connected to Chat Gateway - device=${this.deviceId}`);

    this.wsUnlisten = this.ws.addListener((msg: WsMessage) => {
      // Any incoming frame proves the server is alive - reset heartbeat miss counter (parity WebMlsService).
      if (msg.type !== 'Close') {
        this.resetHeartbeatCounter();
      }

      if (msg.type === 'Close') {
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
          const msgType = parsed.type as string | undefined;

          if (msgType && (msgType.startsWith('channel.') || msgType === 'post_created')) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msgType}`);
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
              this.enqueueMessage({
                senderId: (parsed.senderId as string) || 'unknown',
                ciphertext,
                groupId: (parsed.groupId as string) || undefined,
                isWelcome: !!parsed.isWelcome,
                isCommit: !!parsed.isCommit,
                ratchetTreeBytes,
                queuedMessageId: (parsed.queuedMessageId as string) || undefined,
                queuedCreatedAt: parseServerTimestampMs(parsed.createdAt),
              });
            }
          } else if (parsed.proto && !this.messageCallback) {
            console.warn(
              `[WS RCV] proto reçu mais messageCallback non initialisé. Message ignoré.`
            );
          }
          // Pas de proto → event non-MLS (post, channel), ignoré silencieusement.
        } catch (e) {
          console.error('[WS RCV] Failed to process WebSocket message:', e);
        }
      })();
    });

    this.startHeartbeat();

    // Pending queue fetch is handled by initializeConnection() to keep
    // behavior aligned between WebMlsService and TauriMlsService.
  }

  /** Sends a disconnect control frame over the native WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'disconnect' })).catch(() => {
        // Best-effort - ignore if the socket is already closing
      });
    }
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

  /** Releases Tauri-specific resources: closes the native WebSocket and its listener. */
  protected override destroyPlatformResources(): void {
    this.clearHeartbeat();
    if (this.wsUnlisten) {
      this.wsUnlisten();
      this.wsUnlisten = null;
    }
    if (this.ws) {
      this.ws.disconnect().catch(() => {});
      this.ws = null;
    }
  }

  /** Tauri-native `invoke` wrapper - initializes the Rust MLS state via `initialiser_mls`, deduplicating concurrent calls via a shared promise. */
  async init(userId: string, pin: string, state?: Uint8Array): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initImpl(userId, pin, state);
    await this.initPromise;
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

  /** Implementation body for init(); resolves device ID from native push context or localStorage, calls `initialiser_mls`, and seeds the known-groups cache. */
  protected async _initImpl(
    userId: string,
    pin: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    this.userId = userId;
    this.delivery.userId = userId;
    this._pin = pin;
    this.freshStart = !state;

    // Per-user device ID (same rationale as WebMlsService). resolveDeviceId restores
    // from localStorage or the native push_context before generating a fresh id, and
    // is idempotent: a no-op when login already resolved it before the pin-check.
    const deviceKey = `mls_device_id_${userId}`;
    await this.resolveDeviceId(userId);

    try {
      await this.loadStateWithPin(pin, state);
    } catch (e) {
      // If init fails AND a saved state existed, the state is to blame
      // (credential mismatch, partial corruption, invalid Argon2 key…).
      // → systematic fresh-start to avoid blocking the user indefinitely.
      // If state == null and error → real crash (no state to blame) → rethrow.
      const errStr = String(e);
      const isCredentialMismatch =
        errStr.includes('identity mismatch') || errStr.includes('Credential identity');
      if (isCredentialMismatch || state != null) {
        // Caller wants a chance to recover (decrypt with the old PIN) before any
        // destructive fresh-start: signal instead of discarding local history.
        if (opts?.noFreshStart) throw new Error(MLS_LOCAL_STATE_UNDECRYPTABLE, { cause: e });
        const oldDeviceId = this.deviceId; // capture before overwriting
        if (isCredentialMismatch) {
          console.warn('[MLS] Credential mismatch - discarding stale state, starting fresh');
        } else {
          console.warn(
            '[MLS] Loaded state unusable (corruption?) → fresh-start:',
            errStr.slice(0, 200)
          );
        }
        this.deviceId = this.generateDeviceId(userId);
        localStorage.setItem(deviceKey, this.deviceId);
        this.delivery.deviceId = this.deviceId;
        await this.loadStateWithPin(pin, undefined);
        // Deregister the stale device from the server so other devices no longer
        // try to use its key packages when generating Welcome messages.
        // Without this, re-bootstrap sends a Welcome for the OLD key package
        // (which is now gone from our fresh state), causing NoMatchingKeyPackage.
        this.deleteDevice(userId, oldDeviceId).catch((err) =>
          console.warn(`[MLS] Cleanup old device ${oldDeviceId} failed:`, err)
        );
      } else {
        throw e;
      }
    }

    // Save session context for Android push notifications (no-op on desktop).
    // The pushToken is included so the Kotlin service can fetch the MLS proto
    // when it is not included inline in the FCM payload (large messages).
    void getToken()
      .then((pushToken: string) =>
        invoke('store_push_context', {
          pin,
          userId,
          deviceId: this.deviceId,
          baseUrl: this.historyUrl,
          pushToken,
        })
      )
      .catch(() => {});

    // Write mls.bin immediately after init so the FCM service can decrypt
    // even if no message has been processed yet (saveState not yet called).
    void this.saveState(pin).catch(() => {});

    // Populate the local groups cache from Rust after init.
    try {
      const groups = await invoke<string[]>('lister_groupes');
      this._knownGroups = new Set(groups);
    } catch {
      // Non-blocking: cache stays empty, GroupAlreadyExists fallback will handle it.
    }
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` in Rust and updates the local known-groups cache. */
  async createGroup(groupId: string): Promise<void> {
    await invoke('creer_groupe', { groupId });
    this._knownGroups.add(groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` ignoring GroupAlreadyExists, letting Rust handle orphan state cleanup. */
  async forceCreateGroup(groupId: string): Promise<void> {
    // Tauri: use the same creer_groupe - orphan recovery in Rust handles the wipe.
    // A dedicated force_creer_groupe IPC command could be added later if needed.
    await invoke('creer_groupe', { groupId }).catch(() => {});
    this._knownGroups.add(groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `sauvegarder_mls` to encrypt and persist the MLS state to the native mls.bin file. */
  async saveState(pin: string): Promise<Uint8Array> {
    await this.awaitRustMutations();
    // Native command handles save_encrypted + mls.bin write in one invoke to
    // avoid JS Array.from(…) conversion on large state blobs (notably Android).
    const raw = await invoke<number[]>('sauvegarder_mls_et_persister', { pin });
    const bytes = Uint8Array.from(raw);
    return bytes;
  }

  /**
   * C2: reloads `mls.bin` from disk into the warm in-memory engine. Called on resume (Android)
   * BEFORE the WS resumes processing: while backgrounded, a native JNI engine (Welcome/send) may
   * have advanced `mls.bin`; without this the warm state is stale and its next save would clobber
   * that advance (lost-update -> SecretReuse). Also marks the foreground active server-side so the
   * background engines stop writing. Refreshes the known-groups cache (a background Welcome may
   * have joined a new group) and clears the epoch cache (epochs may have advanced under us).
   */
  override async reloadStateFromDisk(): Promise<void> {
    // Only Android runs a background JNI engine that advances mls.bin; on desktop Tauri the
    // in-memory engine is the sole writer, so a reload would re-derive Argon2 for nothing.
    if (!isAndroidTauriRuntime() || !this._pin) return;
    await this.awaitRustMutations();
    try {
      const reloaded = await invoke<boolean>('recharger_mls_au_resume', {
        userId: this.userId,
        deviceId: this.deviceId,
        pin: this._pin,
      });
      if (reloaded) {
        this._epochByGroupId.clear();
        try {
          const groups = await invoke<string[]>('lister_groupes');
          this._knownGroups = new Set(groups);
        } catch {
          /* cache stays as-is; GroupAlreadyExists fallback handles drift */
        }
        console.log('[MLS][Tauri] etat recharge depuis mls.bin au resume (C2)');
      }
    } catch (e) {
      console.warn('[MLS][Tauri] reloadStateFromDisk failed:', e);
    }
  }

  /**
   * Re-encrypts the MLS state with the new PIN via the native Tauri command and updates
   * the cached PIN used for background saves. Must be called after a successful PIN change.
   */
  /** Native decrypt + client init for a given PIN/state; throws on wrong PIN (no fresh-start). */
  protected async loadStateWithPin(pin: string, state?: Uint8Array): Promise<void> {
    this._pin = pin;
    const encryptedState = state ? Array.from(state) : null;
    await invoke('initialiser_mls', {
      userId: this.userId,
      deviceId: this.deviceId,
      pin,
      encryptedState,
    });
  }

  async changePIN(newPin: string): Promise<void> {
    this._pin = newPin;
    await this.saveState(newPin);

    // Refresh the native push context so background FCM decryption and native
    // auto-login use the new PIN. mls.bin is now re-encrypted under newPin; without
    // this update push_context.json would keep the old PIN and background decrypts
    // (and silent re-login) would fail until the next manual login. Mirrors init().
    void getToken()
      .then((pushToken: string) =>
        invoke('store_push_context', {
          pin: newPin,
          userId: this.userId,
          deviceId: this.deviceId,
          baseUrl: this.historyUrl,
          pushToken,
        })
      )
      .catch((e) => console.warn('[MLS][Tauri] push_context refresh after PIN change failed:', e));

    console.log('[MLS][Tauri] PIN changed - state re-encrypted and persisted.');
  }

  /** Tauri-native `invoke` wrapper - calls `generer_key_package`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  async generateKeyPackage(pin: string): Promise<Uint8Array> {
    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 matches WebMlsService and avoids bloating the Rust state with hundreds
    // of unused private key bundles (each ~400 bytes encrypted in mls.bin).
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);
    console.log(`[MLS][Tauri] generateKeyPackage native batch path needed=${needed}`);

    // Single native command: generate fallback + OTKPs + persist encrypted state.
    const nativeBatch = await invoke<NativeKeyPackageBatchResult>(
      'generer_key_packages_et_persister',
      {
        pin,
        count: needed,
      }
    );
    const fallback = Uint8Array.from(nativeBatch.fallback);
    const poolPackages = nativeBatch.pool_packages.map((kp) => Uint8Array.from(kp));

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** Tauri-native `invoke` wrapper - vérifie via `key_package_a_clef_privee` qu'on possède la clé privée du KeyPackage. */
  protected async keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean> {
    return invoke<boolean>('key_package_a_clef_privee', {
      keyPackageBytes: Array.from(keyPackageBytes),
    });
  }

  /**
   * Tauri-native `invoke` wrapper - stages an Add commit WITHOUT merging via `ajouter_membres_bulk`
   * (all key packages in one OpenMLS commit, one shared Welcome). Returns
   * (commit, welcome?, addedIndices, skippedIndices). `addedIndices` are positions in `keyPackages`
   * actually included - entries skipped (invalid, or already a member) are omitted rather than
   * collapsing to a bare count. `skippedIndices` are positions dropped for an INVALID/undeserializable
   * KeyPackage (not the already-member dedup), surfaced so the loss is not silent. [[C5]]
   */
  protected async stageAddMembers(
    groupId: string,
    keyPackages: Uint8Array[]
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedIndices: number[];
    skippedIndices: number[];
  }> {
    const keyPackagesBytes = keyPackages.map((kp) => Array.from(kp));
    const result = await invoke<[number[], number[] | null, number[], number[]]>(
      'ajouter_membres_bulk',
      { groupId, keyPackagesBytes }
    );
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
      addedIndices: result[2],
      skippedIndices: result[3] ?? [],
    };
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for all devices of the given users (no merge). */
  protected async stageRemoveMembers(groupId: string, userIds: string[]): Promise<Uint8Array> {
    const commitBytes = await invoke<number[]>('retirer_membres', { groupId, userIds });
    return new Uint8Array(commitBytes);
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for specific device identities (no merge). */
  protected async stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[]
  ): Promise<Uint8Array> {
    const commitBytes = await invoke<number[]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
    });
    return new Uint8Array(commitBytes);
  }

  /** Tauri-native `invoke` wrapper - merges the pending staged commit (server accepted) and refreshes the epoch cache. */
  protected async mergePendingCommit(groupId: string): Promise<void> {
    await invoke('confirmer_commit', { groupId });
    void this.refreshEpochCache(groupId);
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
    try {
      const epoch = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, epoch);
      return epoch;
    } catch {
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

  /** Tauri-native `invoke` wrapper - encrypts plaintext via `envoyer_message_bytes`, then POSTs the ciphertext to the delivery service. */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    silent = false
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    const encryptedBytes = Uint8Array.from(res);
    const proto = toBase64(encryptedBytes);
    await this.delivery.postApplicationMessage(groupId, proto, silent);
    return encryptedBytes;
  }

  /** Tauri-native `invoke` wrapper - decrypts a raw MLS ciphertext via `recevoir_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const res = await invoke<number[] | null>('recevoir_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    return res ? Uint8Array.from(res) : null;
  }

  /** Single IPC crossing for an ordered page of ciphertexts (history catch-up on native MLS). */
  async processIncomingMessagesBatch(
    groupId: string,
    messages: Uint8Array[]
  ): Promise<MlsBatchProcessResult[]> {
    if (messages.length === 0) return [];
    const raw = await invoke<Array<{ ok: boolean; data?: number[] | null; error?: string }>>(
      'recevoir_messages_batch',
      {
        groupId,
        messages: messages.map((m) => Array.from(m)),
      }
    );
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
  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = toBase64(keyPackageBytes);
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    const deviceAppVersion = await this.getRuntimeAppVersion();
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs('desktop'),
      ...(deviceAppVersion ? { deviceAppVersion } : {}),
    });
  }

  /** Returns the list of MLS group IDs known locally, populated from Rust via `lister_groupes` at init time. */
  getLocalGroups(): string[] {
    return [...this._knownGroups];
  }

  /** Returns the last cached MLS epoch for a group, or 0 if unknown; cache is refreshed by `refreshEpochCache`. */
  getEpoch(groupId: string): number {
    return this._epochByGroupId.get(groupId) ?? 0;
  }

  /** Tauri-native `invoke` wrapper - calls `oublier_groupe` in Rust to drop local MLS state and removes the group from the epoch cache. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    this._epochByGroupId.delete(groupId);
    // Keep `_knownGroups` in sync synchronously (Web reads WASM live via get_groups()).
    this._knownGroups.delete(groupId);
    this.trackRustMutation(
      invoke('oublier_groupe', { groupId, minEpoch }).catch((e) => {
        console.warn('[MLS] forgetGroup error:', e);
        return invoke<string[]>('lister_groupes')
          .then((groups) => {
            this._knownGroups = new Set(groups);
          })
          .catch(() => {});
      })
    );
  }

  /** Poison Pill - definitive purge via Tauri `supprimer_groupe`: Rust memory, storage and epoch lock at MAX. */
  dropGroup(groupId: string): void {
    this._epochByGroupId.delete(groupId);
    this._knownGroups.delete(groupId);
    this.trackRustMutation(
      invoke('supprimer_groupe', { groupId }).catch((e) => {
        console.warn('[MLS] dropGroup error:', e);
        return invoke<string[]>('lister_groupes')
          .then((groups) => {
            this._knownGroups = new Set(groups);
          })
          .catch(() => {});
      })
    );
  }

  private async getRuntimeAppVersion(): Promise<string | undefined> {
    if (this.appVersionCache !== undefined) {
      return this.appVersionCache ?? undefined;
    }
    try {
      const v = await getVersion();
      this.appVersionCache = v?.trim() ? v.trim() : null;
      return this.appVersionCache ?? undefined;
    } catch {
      this.appVersionCache = null;
      return undefined;
    }
  }
}
