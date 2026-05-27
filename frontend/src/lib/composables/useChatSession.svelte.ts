/**
 * Reactive composable owning the full chat session lifecycle:
 * MLS initialisation, WebSocket connection, reconnection, biometric enroll,
 * device sync, backup export/import, dev-tool helpers, and logout.
 *
 * Kept separate from conversation state (useConversations) so each concern
 * has a single place to change.
 */
import { goto } from '$app/navigation';
import { MlsService } from '$lib/mlsService';
import type { IMlsService } from '$lib/mlsService';
import { getStorage } from '$lib/db';
import type { IStorage } from '$lib/db';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { computePinVerifier } from '$lib/utils/chat/auth';
import { getToken, clearAuth } from '$lib/stores/auth';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import {
  addDevMember,
  discoverMissingGroups,
  exportUserBackup,
  generateDevKeyPackage,
  handleWelcomeRequest,
  importUserBackup,
  processDevWelcome,
  processPendingInvitations,
} from '$lib/utils/chat/actions';
import { checkGroupSuccessors } from '$lib/utils/chat/recovery';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  setupMessageHandler,
  initializeConnection,
  openGatewayConnection,
  syncConnectionAfterWsOpen,
  initTabLeadershipAsync,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import { BiometricService } from '$lib/services/biometric';
import { savePin, clearPin, clearPinAndKey } from '$lib/utils/pinVault';
import { CallService } from '$lib/services/CallService';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';

/** Callbacks that useChatSession needs from the parent composable (useConversations + UI glue). Passed to login(), logout(), reconnect helpers, etc. */
export interface ChatSessionCallbacks {
  /** Reactive map of all open conversations, keyed by conversation ID. */
  conversations: SvelteMap<string, Conversation>;
  /** Restores conversations from IndexedDB and re-checks MLS state consistency. */
  loadAndRestoreConversations: () => Promise<void>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  beginBulkMessageIngest?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void;
  endBulkMessageIngest?: (
    enableBulkBuffer?: boolean,
    showOverlay?: boolean
  ) => void | Promise<void>;
  batchAddMessages?: (
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string
  ) => Promise<void>;
  saveConversation: (contactName: string) => Promise<void>;
  selectConversation: (name: string) => void;
  onChannelMemberJoined?: (event: any) => void;
  onChannelMemberKicked?: (event: any) => void;
  onChannelUpdated?: (event: {
    channelId: string;
    name?: string;
    workspaceId?: string;
    imageMediaId?: string;
  }) => void;
  onChannelDeleted?: (event: { channelId: string; workspaceId?: string }) => void;
  onWorkspaceUpdated?: (event: { workspaceId: string; imageMediaId?: string }) => void;
  onReadReceiptReceived?: (event: {
    conversationKey: string;
    senderId: string;
    messageIds: string[];
  }) => void;
  onSendError: (msg: string) => void;
  onShowSyncGuidePrompt: () => void;
  /** Appelé dès que le PIN est validé et MLS initialisé (isLoggedIn vient de passer à true),
   * avant loadAndRestoreConversations(). Permet de fermer le modal PIN immédiatement
   * sans attendre la fin complète du login (conversations, WebSocket, etc.). */
  onMlsReady?: () => void;
  /** Appelé quand le login échoue (PIN incorrect, serveur inaccessible, etc.).
   * Si fourni, la redirection vers /login n'a PAS lieu — le caller gère l'erreur.
   * Si absent, on redirige vers /login comme avant. */
  onLoginFailed?: (error: string) => void;
  log: (msg: string) => void;
  messageReactions: SvelteMap<string, any[]>;
  getSelectedContact: () => string | null;
  setSelectedContact: (v: string | null) => void;
  onLoadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
  /** Fired when a group transitions to isReady=true (Welcome processed). Used to drain pending auto-retry messages. */
  onGroupReady?: (groupId: string) => void;
}

/** Creates and returns the reactive chat session store covering login, MLS init, WebSocket, biometrics, device sync, backup, and dev tools. */
export function useChatSession() {
  // ── Identity ──────────────────────────────────────────────────────────────
  let userId = $state('');
  let pin = $state('');
  let authToken = $state('');
  let myDeviceId = $state('');
  let loginError = $state('');

  // ── Session status ────────────────────────────────────────────────────────
  let isLoggedIn = $state(false);
  let isWsConnected = $state(false);
  let showBiometricEnrollPrompt = $state(false);

  // ── Services ──────────────────────────────────────────────────────────────
  let mls: IMlsService | null = $state(null);
  let storage: IStorage | null = $state(null);
  let callService = $state<any>(null);
  let callState = $state<any>('idle');

  // ── Reconnection bookkeeping ──────────────────────────────────────────────
  const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Leader-tab periodic successor migration check (cleared on logout). */
  let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Detects a dead WebSocket while the UI still shows online (cleared on logout). */
  let connectionWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  const CONNECTION_WATCHDOG_MS = 30_000;
  let isReconnecting = false;
  let isSyncing = false;

  // ── Backup ────────────────────────────────────────────────────────────────
  let isExporting = $state(false);
  let isImporting = $state(false);
  let isLoginInProgress = false; // plain boolean — guards against concurrent login() calls

  // ── Dev tools ─────────────────────────────────────────────────────────────
  let lastKeyPackage = $state('');
  let incomingBytesHex = $state('');
  let lastCommit = $state('');
  let lastWelcome = $state('');

  const historyBaseUrl = (() => {
    const env = import.meta.env.VITE_DELIVERY_URL;
    if (env?.trim()) return env;
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3010';
  })();

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Returns the current MLS service instance, creating it lazily if needed. Throws outside the browser context. */
  function ensureMls(): IMlsService {
    if (!mls) {
      if (typeof window === 'undefined') throw new Error('MLS unavailable outside browser context');
      mls = new MlsService();
    }
    return mls;
  }

  /** Wipes all local MLS state, device ID, and stored DB for the given user — called when the server signals that this device has been revoked. */
  async function resetDeviceAsFresh(userIdToReset: string, cb: ChatSessionCallbacks) {
    // Purge all local state tied to this logical device so next init creates
    // a brand new MLS device identity.
    const { removeMlsState } = await import('$lib/utils/hex');
    await removeMlsState(userIdToReset);
    localStorage.removeItem(`mls_device_id_${userIdToReset}`);
    localStorage.removeItem(`canari_sync_guide_seen_${userIdToReset}`);

    const deviceNamePrefix = `device-name:${userIdToReset}:`;
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(deviceNamePrefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      localStorage.removeItem(key);
    }

    try {
      const storageToClear = await getStorage(userIdToReset);
      await storageToClear.clear();
    } catch {
      // Best-effort cleanup: continue even if local DB is not accessible.
    }

    mls?.destroy?.();
    mls = null;
    storage = null;
    myDeviceId = '';
    isLoggedIn = false;
    isWsConnected = false;
    clearPinAndKey();
    clearUserLocally();
    cb.log('[SECURITY] Appareil revoque detecte: etat local purgé, reconnexion requise.');
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  /** Full login flow: verifies the PIN against the server, initialises MLS, opens IndexedDB, restores conversations, connects the WebSocket, and schedules device-sync. On failure redirects to /login (or calls cb.onLoginFailed if provided). */
  async function login(cb: ChatSessionCallbacks) {
    if (!userId.trim() || !pin.trim()) {
      loginError = 'Veuillez remplir tous les champs.';
      return;
    }

    // Guard against concurrent calls (e.g. onMount + afterNavigate firing together).
    if (isLoggedIn || isReconnecting || isLoginInProgress) return;
    isLoginInProgress = true;

    loginError = '';
    userId = userId.trim().toLowerCase();

    // Clear any stale reconnect timer from a previous session
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;

    try {
      const mlsService = ensureMls();
      cb.log('Verification du PIN...');

      // Start MLS state load immediately — pure I/O, doesn't need the token.
      const { loadMlsState } = await import('$lib/utils/hex');
      const _isTauri = !!(window as any).__TAURI_INTERNALS__;
      const mlsStatePromise = (async (): Promise<
        { bytes: Uint8Array; source: string } | undefined
      > => {
        const loaded = await loadMlsState(userId);
        if (loaded) return { bytes: loaded, source: 'indexeddb' };
        if (_isTauri) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const fallback = await invoke<number[] | null>('load_mls_state');
            if (fallback && fallback.length > 0)
              return { bytes: new Uint8Array(fallback), source: 'native' };
          } catch {
            // Non-bloquant
          }
        }
        return undefined;
      })();

      let accessToken: string;
      try {
        accessToken = await getToken();
      } catch {
        loginError = 'Session expiree. Merci de vous reconnecter.';
        isLoginInProgress = false;
        return;
      }

      const verifier = await computePinVerifier(userId, pin);
      const deviceId = mlsService.getDeviceId();
      const verifierPayload = JSON.stringify({ userId, verifier, deviceId });
      const verifierHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      };

      // Collect the MLS state that was loading in the background.
      const mlsStateResult = await mlsStatePromise;
      const hadLocalState = Boolean(mlsStateResult);
      if (mlsStateResult) {
        cb.log(
          mlsStateResult.source === 'native'
            ? 'Etat MLS restaure depuis la sauvegarde native (mls.bin).'
            : 'Etat MLS charge depuis IndexedDB.'
        );
      }

      cb.log('Initialisation MLS...');
      // Run pin-check, MLS init, and DB open concurrently.
      // mlsService.init() validates the PIN independently via Argon2 decryption —
      // the pin-check network call adds cross-device mismatch signaling and revocation.
      // Both run in parallel to hide the network RTT inside the Argon2/deserialization time.
      const pinCheckFetch = async () => {
        const res = await fetch(`${historyBaseUrl}/api/mls/security/pin-check`, {
          method: 'POST',
          headers: verifierHeaders,
          body: verifierPayload,
        });
        if (!res.ok) throw new Error('Impossible de verifier le PIN (serveur inaccessible).');
        return res.json() as Promise<{ status: string; resetRequired?: boolean }>;
      };

      const [pinCheckSettled, mlsInitSettled, storageSettled] = await Promise.allSettled([
        pinCheckFetch(),
        mlsService.init(userId, pin, mlsStateResult?.bytes),
        getStorage(userId),
      ]);

      // Report errors in priority order: pin-check gives the friendliest message.
      if (pinCheckSettled.status === 'fulfilled' && pinCheckSettled.value.status === 'mismatch') {
        throw new Error(
          'PIN incorrect : ce PIN ne correspond pas a celui enregistre pour cet utilisateur. Tous vos appareils doivent utiliser le meme PIN.'
        );
      }
      if (mlsInitSettled.status === 'rejected') throw mlsInitSettled.reason;
      if (pinCheckSettled.status === 'rejected') throw pinCheckSettled.reason;
      if (storageSettled.status === 'rejected') throw storageSettled.reason;

      const pinCheckData = pinCheckSettled.value;
      if (pinCheckData.resetRequired === true) {
        mls?.destroy?.();
        mls = null; // Force fresh MlsService on next login after wipe
        await resetDeviceAsFresh(userId, cb);
        pin = '';
        throw new Error(
          'Cet appareil a ete revoque. L etat local a ete reinitialise: reconnectez-vous avec votre PIN pour l enregistrer comme nouvel appareil.'
        );
      }
      if (pinCheckData.status === 'registered') cb.log('Premier appareil : PIN enregistre.');

      storage = storageSettled.value;
      myDeviceId = mlsService.getDeviceId();
      cb.log(`Identite MLS initialisee (device: ${myDeviceId})`);
      console.log(`[INIT] MLS initialized for userId=${userId} device=${myDeviceId}`);
      cb.log('Base de donnees locale initialisee.');

      authToken = await getToken();

      isLoggedIn = true;
      saveUserLocally({ id: userId, admin: isGlobalAdmin() });
      cb.onMlsReady?.();
      // On Tauri (mobile): rely exclusively on the hardware-backed keystore —
      // never cache the PIN in any browser storage. The biometric enrolment
      // prompt that follows will call BiometricService.enableBiometric(pin).
      // On web/desktop: store an AES-GCM encrypted blob in sessionStorage so
      // the PIN is never at rest in plaintext and is wiped on tab/session close.
      const tauriEnv = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (!tauriEnv) {
        await savePin(pin);
      } else if (!(await BiometricService.isConfigured().catch(() => false))) {
        // Tauri but biometrics not yet enrolled: cache encrypted for this session
        // only (will be cleared once the user completes biometric enrolment below).
        await savePin(pin);
      }
      // Android push: register (or refresh) this device token in delivery-service.
      // Non-blocking: messaging must continue even if push registration fails.
      void startPushService(historyBaseUrl, authToken, myDeviceId)
        .then(() => cb.log('[PUSH] Enregistrement token push termine.'))
        .catch((e) =>
          cb.log(`[WARN] Echec enregistrement push: ${e instanceof Error ? e.message : String(e)}`)
        );

      // Pré-injecter les messages FCM mis en cache avant la sync MLS complète (~10s)
      await consumeFcmCache(pin, storage).catch(() => {});

      await cb.loadAndRestoreConversations();

      try {
        const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
        const missingKeys: string[] = [];
        for (const [key, c] of cb.conversations.entries()) {
          // Channels use AES-GCM, not MLS — never mark them as not-ready
          if (isChannelConversationId(c.id)) continue;
          if (c.isReady && !localMlsGroups.has(c.id)) {
            cb.conversations.set(key, { ...c, isReady: false });
            missingKeys.push(key);
          }
        }
        if (missingKeys.length > 0) {
          cb.log(
            `[WARN] Groupes sans etat MLS local detectes — ${missingKeys.length} conversation(s) marquees non-pretes, reinvite declenchee au prochain connect.`
          );
          console.warn(
            `[INIT] ${missingKeys.length} conversation(s) missing local MLS state — marked not-ready`
          );
          await Promise.all(missingKeys.map((key) => cb.saveConversation(key).catch(() => {})));
        }
      } catch (e) {
        console.warn('[INIT] Erreur détection groupes MLS manquants:', e);
      }

      processDeviceInvitationsLocally(cb).catch((e) =>
        cb.log(`[WARN] Echec sync appareils (login): ${e instanceof Error ? e.message : String(e)}`)
      );

      const syncGuideKey = `canari_sync_guide_seen_${userId}`;
      let hasOtherDevices = false;
      try {
        const otherDevices = await mlsService.fetchUserDevices(userId);
        hasOtherDevices = otherDevices.filter((d) => d.deviceId !== myDeviceId).length > 0;
      } catch {
        /* non-blocking */
      }

      if (!hadLocalState && hasOtherDevices && localStorage.getItem(syncGuideKey) !== '1') {
        cb.onShowSyncGuidePrompt();
        localStorage.setItem(syncGuideKey, '1');
      }

      setupMessageHandler({
        mlsService,
        storage,
        userId,
        pin,
        historyBaseUrl,
        conversations: cb.conversations,
        messageReactions: cb.messageReactions,
        getSelectedContact: cb.getSelectedContact,
        setSelectedContact: cb.setSelectedContact,
        saveConversation: cb.saveConversation,
        deleteConversation: storage ? (id) => storage!.deleteConversation(id) : undefined,
        addMessageToChat: cb.addMessageToChat,
        batchAddMessages: cb.batchAddMessages,
        loadHistoryForConversation: cb.onLoadHistoryForConversation,
        onChannelMemberJoined: cb.onChannelMemberJoined,
        onChannelMemberKicked: cb.onChannelMemberKicked,
        onChannelUpdated: cb.onChannelUpdated,
        onChannelDeleted: cb.onChannelDeleted,
        onWorkspaceUpdated: cb.onWorkspaceUpdated,
        onReadReceiptReceived: cb.onReadReceiptReceived,
        onCallSignal: (senderId: string, groupId: string, callMsg) => {
          callService?.handleCallSignal(senderId, groupId, callMsg);
        },
        onGroupPoisoned: (groupId: string) => {
          const convoName =
            cb.conversations.get(groupId)?.name ?? cb.conversations.get(groupId)?.contactName;
          const label = convoName ? `"${convoName}"` : `(${groupId.slice(0, 8)}…)`;
          cb.log(
            `[ALERTE] Conversation ${label} corrompue et irrécupérable. Demandez à un autre membre de vous réinviter.`
          );
          appendLog(
            `⚠️ Conversation ${label} corrompue — demandez à un autre membre de vous réinviter.`
          );
        },
        log: cb.log,
      });

      if (mlsService.setBulkIngestHooks && cb.beginBulkMessageIngest && cb.endBulkMessageIngest) {
        mlsService.setBulkIngestHooks(cb.beginBulkMessageIngest, cb.endBulkMessageIngest);
      }

      // Rafraîchir Svelte quand on rejoint un groupe
      if ('onWelcomeProcessed' in mlsService) {
        (mlsService as any).onWelcomeProcessed(async (groupId?: string) => {
          if (groupId) {
            cb.log(`[SYNC] Welcome traité pour ${groupId}, rafraîchissement...`);
            if (!cb.conversations.has(groupId)) {
              // Persist a minimal placeholder so the group survives across sessions.
              // We use the groupId as name temporarily; loadAndRestoreConversations will
              // replace it with the correct peer UUID and conversationType via the
              // Phase-2 member-count check (2 members → 'direct' + normalized name).
              cb.conversations.set(groupId, {
                id: groupId,
                contactName: groupId,
                name: groupId,
                messages: [],
                isReady: true,
                mlsStateHex: null,
                unreadCount: 0,
                conversationType: 'group',
              });
              await cb.saveConversation(groupId);
              // Resync from server: Phase-2 member check will reclassify 1v1 groups
              // as 'direct' and write the correct "userId::peerId" name to the DB.
              await cb
                .loadAndRestoreConversations()
                .catch((e) => cb.log(`[WARN] Erreur resync convs (Welcome): ${e}`));
            }
            cb.onLoadHistoryForConversation(groupId, groupId).catch((e) =>
              cb.log(`[WARN] Erreur refresh conv ${groupId}: ${e}`)
            );
            cb.onGroupReady?.(groupId);
          } else {
            cb.log('[SYNC] Welcome traité, rafraîchissement des conversations...');
            cb.loadAndRestoreConversations().catch((e) =>
              cb.log(`[WARN] Erreur refresh convs: ${e}`)
            );
          }
        });
      }

      // When a device in MLS recovery sends a reinvite_request, re-run
      // processPendingInvitations so we re-invite it and send a fresh Welcome.
      // The add-lock inside processPendingInvitations handles concurrent calls.
      mlsService.onReinviteRequest((senderDeviceId: string, groupId: string) => {
        cb.log(`[SYNC] reinvite_request reçu de ${senderDeviceId} pour groupe ${groupId}`);
        processDeviceInvitationsLocally(cb).catch((e) =>
          cb.log(
            `[WARN] Echec sync appareils (reinvite_request): ${e instanceof Error ? e.message : String(e)}`
          )
        );
      });

      // When a device (from any user) sends a welcome_request for a group we belong to,
      // race to acquire the add-lock and, if we win, invite the device and send a commit.
      mlsService.onWelcomeRequest(
        async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
          cb.log(
            `[SYNC] welcome_request reçu de ${requesterUserId}:${requesterDeviceId} pour ${groupId}`
          );
          try {
            await handleWelcomeRequest({
              mlsService: ensureMls(),
              userId,
              pin,
              conversations: cb.conversations,
              log: cb.log,
              requesterUserId,
              requesterDeviceId,
              groupId,
            });
          } catch (e) {
            cb.log(
              `[WARN] Echec handleWelcomeRequest: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      );

      // Multi-tab leadership: only the leader tab opens the WebSocket.
      await initTabLeadershipAsync(cb.log);

      await initializeConnection({
        mlsService,
        userId,
        pin,
        scheduleReconnect: () => scheduleReconnect(cb),
        setIsWsConnected: (v) => (isWsConnected = v),
        setReconnectAttempts: (v) => (reconnectAttempts = v),
        processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(cb),
        log: cb.log,
      });

      // Only the leader tab syncs history and devices
      if (!getIsTabLeader()) return;

      // Discover groups the user belongs to on the server but doesn't have locally.
      // This catches cases where Welcomes were lost (device offline, state cleared, etc.)
      const st0 = storage;
      discoverMissingGroups({
        mlsService,
        userId,
        pin,
        conversations: cb.conversations,
        saveConversation: cb.saveConversation,
        deleteConversation: st0 ? (id) => st0.deleteConversation(id) : undefined,
        log: cb.log,
      }).catch((e) =>
        cb.log(`[WARN] Echec decouverte groupes: ${e instanceof Error ? e.message : String(e)}`)
      );

      // discoverMissingGroups attend 30s (BOOTSTRAP_TIMEOUT_MS) avant de
      // tenter un re-bootstrap. On programme un retry à 35s pour que le
      // bootstrap se déclenche effectivement quand le timeout expire.
      // Un second retry à 70s couvre le cas où le premier a échoué
      // (ex: lock pris par un autre device qui n'a pas réussi).
      for (const delay of [35_000, 70_000]) {
        setTimeout(() => {
          const hasPending = [...cb.conversations.values()].some((c) => !c.isReady);
          if (!hasPending) return;
          const svc = mlsService;
          if (!svc) return;
          const st1 = storage;
          discoverMissingGroups({
            mlsService: svc,
            userId,
            pin,
            conversations: cb.conversations,
            saveConversation: cb.saveConversation,
            deleteConversation: st1 ? (id) => st1.deleteConversation(id) : undefined,
            log: cb.log,
          }).catch((e) =>
            cb.log(
              `[WARN] Echec decouverte groupes (retry): ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }, delay);
      }

      // Health check: migrate any group whose successor was claimed by another device.
      // Run once on connect, then every 5 minutes (leader tab only).
      const st2 = storage;
      const recoveryDeps = {
        mlsService,
        storage: st2,
        userId,
        pin,
        conversations: cb.conversations,
        getSelectedContact: cb.getSelectedContact,
        setSelectedContact: cb.setSelectedContact,
        saveConversation: cb.saveConversation,
        deleteConversation: st2 ? (id: string) => st2.deleteConversation(id) : undefined,
        log: cb.log,
      };
      checkGroupSuccessors(recoveryDeps).catch((e) =>
        cb.log(
          `[HEALTH] Erreur health check initial: ${e instanceof Error ? e.message : String(e)}`
        )
      );
      if (healthCheckInterval !== null) clearInterval(healthCheckInterval);
      healthCheckInterval = setInterval(
        () => {
          if (!getIsTabLeader()) return;
          checkGroupSuccessors(recoveryDeps).catch((e) =>
            cb.log(`[HEALTH] Erreur health check: ${e instanceof Error ? e.message : String(e)}`)
          );
        },
        5 * 60 * 1_000
      );

      startConnectionWatchdog(cb);

      const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (isTauri && !(await BiometricService.isConfigured()) && !isBiometricPromptDismissed()) {
        showBiometricEnrollPrompt = true;
      }
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      loginError = msg;
      cb.log(`Erreur: ${msg}`);
      console.error('[INIT] Login failed:', msg);
      clearUserLocally();
      clearPin();
      if (cb.onLoginFailed) {
        cb.onLoginFailed(msg);
      } else {
        const cur = window.location.pathname + window.location.search;
        void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
      }
    } finally {
      isLoginInProgress = false;
    }
  }

  /** On Tauri/Android (no biometrics), reads the PIN from push_context.json and delegates to login(). Returns true if login succeeded, false if manual PIN is still needed. */
  async function nativeStorageLogin(cb: ChatSessionCallbacks): Promise<boolean> {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ctx = await invoke<{ pin?: string; userId?: string } | null>('load_push_context');
      if (!ctx?.pin || !ctx.userId || ctx.userId !== userId) return false;
      appendLog('[PIN] PIN restauré depuis stockage natif — login auto...');
      pin = ctx.pin;
      await login(cb);
      return isLoggedIn;
    } catch {
      return false;
    }
  }

  /** Reads the PIN from the hardware biometric keystore and delegates to login(). Displays a user-friendly error if biometric authentication fails. */
  async function biometricLogin(cb: ChatSessionCallbacks) {
    loginError = '';
    cb.log('[BIOMETRIE] Tentative de connexion biométrique...');
    try {
      const savedUser = currentUserId();
      if (!savedUser) {
        loginError = 'Aucun utilisateur enregistre pour la biometrie.';
        cb.log('[BIOMETRIE] Echec — aucun utilisateur local');
        return;
      }
      cb.log(`[BIOMETRIE] Authentification pour userId=${savedUser.slice(0, 8)}...`);
      const retrieved = await BiometricService.authenticateAndGetSecret();
      if (!retrieved) {
        loginError = "L'authentification biometrique a echoue. Entrez votre PIN manuellement.";
        cb.log('[BIOMETRIE] Echec — secret non récupéré, PIN manuel requis');
        return;
      }
      cb.log('[BIOMETRIE] PIN récupéré via biométrie — appel login()');
      userId = savedUser;
      pin = retrieved;
      await login(cb);
    } catch (e) {
      loginError = 'Echec de la biometrie. Entrez votre PIN manuellement.';
      cb.log(`[BIOMETRIE] Exception: ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
    }
  }

  const BIOMETRIC_DISMISSED_KEY = 'canari_biometric_prompt_dismissed';

  /** Returns true if the user has permanently dismissed the biometric enrolment prompt (localStorage flag). */
  function isBiometricPromptDismissed(): boolean {
    if (localStorage.getItem(BIOMETRIC_DISMISSED_KEY) === 'true') return true;
    return false;
  }

  /** Hides the biometric enrolment banner and persists a "dismissed" flag both in localStorage and in the Tauri native store (if running on Tauri). */
  async function dismissBiometricPrompt(): Promise<void> {
    showBiometricEnrollPrompt = false;
    localStorage.setItem(BIOMETRIC_DISMISSED_KEY, 'true');
    const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_native_flag', { key: 'biometricPromptDismissed', value: true }).catch(
        () => {}
      );
    }
  }

  /** Stores the current PIN in the hardware biometric keystore, then clears the in-memory PIN so future logins require biometric authentication. */
  async function enrollBiometric() {
    appendLog('[BIOMETRIE] Inscription biométrique en cours...');
    try {
      await BiometricService.enableBiometric(pin);
      // PIN is now protected by the hardware keystore — wipe the session cache
      // so the app cannot reopen without biometric authentication.
      clearPinAndKey();
      showBiometricEnrollPrompt = false;
      localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
      appendLog('[BIOMETRIE] Inscription OK — PIN effacé de la session (keystore matériel)');
    } catch (e) {
      appendLog(`[BIOMETRIE] Echec inscription: ${e instanceof Error ? e.message : String(e)}`);
      console.error('Biometric enrollment failed:', e);
    }
  }

  /** Clears all session state (conversations, tokens, push registration), deregisters the device push token, and redirects to /login. */
  function logout(cb: ChatSessionCallbacks) {
    cb.log(`[LOGOUT] Déconnexion de userId=${userId?.slice(0, 8) ?? 'inconnu'}...`);
    const tokenForPushCleanup = authToken;
    const deviceForPushCleanup = myDeviceId;

    // Non-blocking cleanup of server-side push token binding for this device.
    if (tokenForPushCleanup && deviceForPushCleanup) {
      void stopPushService(historyBaseUrl, tokenForPushCleanup, deviceForPushCleanup);
    }

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (healthCheckInterval !== null) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    stopConnectionWatchdog();
    reconnectAttempts = 0;
    isLoggedIn = false;
    isWsConnected = false;
    cb.conversations.clear();
    cb.setSelectedContact(null);
    storage = null;
    authToken = '';
    showBiometricEnrollPrompt = false;
    clearUserLocally();
    clearPinAndKey();
    clearAuth();
    cb.log('[LOGOUT] État local effacé — redirection vers /login');
    void goto('/login', { replaceState: true });
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  function startConnectionWatchdog(cb: ChatSessionCallbacks) {
    if (connectionWatchdogInterval !== null) return;
    connectionWatchdogInterval = setInterval(() => {
      if (!isLoggedIn || !getIsTabLeader()) return;
      const svc = mls;
      if (svc?.isWsOpen()) return;
      if (isWsConnected) isWsConnected = false;
      if (reconnectTimer !== null || isReconnecting) return;
      cb.log('[WS] Surveillance: socket inactif, reconnexion...');
      scheduleReconnect(cb);
    }, CONNECTION_WATCHDOG_MS);
  }

  function stopConnectionWatchdog() {
    if (connectionWatchdogInterval !== null) {
      clearInterval(connectionWatchdogInterval);
      connectionWatchdogInterval = null;
    }
  }

  /** Pauses the WebSocket connection and stops all background timers. Called when the app is backgrounded. */
  function pauseConnection() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (healthCheckInterval !== null) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    stopConnectionWatchdog();
    mls?.sendDisconnect();
    isWsConnected = false;
    appendLog('[LIFECYCLE] App en arrière-plan — connexion pausée.');
  }

  /** Schedules an exponential-backoff WebSocket reconnect attempt (delays: 1s, 2s, 4s … 30s max). No-op when already logged out or a timer is already pending. */
  function scheduleReconnect(cb: ChatSessionCallbacks) {
    if (!isLoggedIn) return;
    isWsConnected = false;
    if (reconnectTimer !== null || isReconnecting) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    cb.log(
      `Connexion perdue. Nouvelle tentative dans ${delay / 1000}s... (tentative ${reconnectAttempts})`
    );
    reconnectTimer = setTimeout(() => attemptReconnect(cb), delay);
  }

  /** Performs one WebSocket reconnect with full post-connect sync (same as login). Falls back to scheduleReconnect on failure. */
  async function attemptReconnect(cb: ChatSessionCallbacks) {
    reconnectTimer = null;
    if (!isLoggedIn || isReconnecting) return;
    if (!getIsTabLeader()) {
      cb.log('[TAB] Onglet follower — reconnexion ignorée.');
      return;
    }
    isReconnecting = true;
    try {
      cb.log('Reconnexion en cours...');
      const mlsService = ensureMls();
      const connectionDeps = {
        mlsService,
        userId,
        pin,
        scheduleReconnect: () => scheduleReconnect(cb),
        setIsWsConnected: (v: boolean) => (isWsConnected = v),
        setReconnectAttempts: (v: number) => (reconnectAttempts = v),
        processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(cb),
        log: cb.log,
      };
      const connected = await openGatewayConnection(connectionDeps);
      if (!connected) {
        scheduleReconnect(cb);
        return;
      }
      await syncConnectionAfterWsOpen(connectionDeps);
      const st2 = storage;
      discoverMissingGroups({
        mlsService: ensureMls(),
        userId,
        pin,
        conversations: cb.conversations,
        saveConversation: cb.saveConversation,
        deleteConversation: st2 ? (id) => st2.deleteConversation(id) : undefined,
        log: cb.log,
      }).catch((e) =>
        cb.log(
          `[WARN] Echec decouverte groupes (reconnect): ${e instanceof Error ? e.message : String(e)}`
        )
      );
    } catch (err) {
      cb.log(`Reconnexion echouee: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[WS] Reconnection failed:', err instanceof Error ? err.message : err);
      scheduleReconnect(cb);
    } finally {
      isReconnecting = false;
    }
  }

  // ── Device sync ───────────────────────────────────────────────────────────

  /** Processes any pending MLS invitations from our own other devices (multi-device sync). Re-entrant safe: concurrent calls are dropped if a sync is already running. */
  async function processDeviceInvitationsLocally(cb: ChatSessionCallbacks) {
    if (isSyncing) return;
    isSyncing = true;
    try {
      await processPendingInvitations({
        mlsService: ensureMls(),
        userId,
        pin,
        conversations: cb.conversations,
        log: cb.log,
      });
    } finally {
      isSyncing = false;
    }
  }

  // ── Backup ────────────────────────────────────────────────────────────────

  /** Exports an encrypted backup of all conversations and MLS state for the current user (triggers browser download). */
  async function handleExport(log: (msg: string) => void) {
    if (!storage) return;
    isExporting = true;
    try {
      await exportUserBackup({ storage, userId, pin, myDeviceId, log });
    } catch (e) {
      log(`Erreur export : ${e}`);
    } finally {
      isExporting = false;
    }
  }

  /** Imports a previously exported backup file, decrypts it with the current PIN, replaces IndexedDB, and reloads conversations. */
  async function handleImport(
    file: File,
    log: (msg: string) => void,
    clearConversations: () => void,
    reloadConversations: () => Promise<void>
  ) {
    if (!storage) return;
    isImporting = true;
    try {
      await importUserBackup({
        file,
        pin,
        storage,
        myDeviceId,
        userId,
        log,
        clearConversations,
        reloadConversations,
      });
    } catch (e) {
      log(`Erreur import : ${e}`);
    } finally {
      isImporting = false;
    }
  }

  // ── Dev tools ─────────────────────────────────────────────────────────────

  /** Dev-tool: generates a new MLS KeyPackage for this device and stores it in lastKeyPackage (hex). */
  async function devGenerateKeyPackage(log: (msg: string) => void) {
    try {
      lastKeyPackage = await generateDevKeyPackage({ mlsService: ensureMls(), pin });
    } catch (_e: unknown) {
      log(`Err GenKeyPackage: ${_e instanceof Error ? _e.message : String(_e)}`);
    }
  }

  /** Dev-tool: adds a member (KeyPackage from incomingBytesHex) to an MLS group and stores the resulting Commit/Welcome hex for inspection. */
  async function devAddMember(groupId: string, log: (msg: string) => void) {
    if (!incomingBytesHex) return;
    try {
      const result = await addDevMember({
        mlsService: ensureMls(),
        groupId,
        incomingBytesHex,
      });
      lastCommit = result.commitHex;
      if (result.welcomeHex) lastWelcome = result.welcomeHex;
      incomingBytesHex = '';
    } catch (_e: unknown) {
      log(`Err AddMember: ${_e instanceof Error ? _e.message : String(_e)}`);
    }
  }

  /** Dev-tool: processes a Welcome message (hex in incomingBytesHex) so this device joins the corresponding MLS group. */
  async function devProcessWelcome(log: (msg: string) => void) {
    if (!incomingBytesHex) return;
    try {
      await processDevWelcome({ mlsService: ensureMls(), incomingBytesHex });
      incomingBytesHex = '';
    } catch (_e: unknown) {
      log(`Err ProcessWelcome: ${_e instanceof Error ? _e.message : String(_e)}`);
    }
  }

  /**
   * Initialise MLS and CallService. Must be called from onMount in the parent component.
   * Kept here so the parent does not need to import TauriMlsService / WebMlsService directly.
   */
  function initServices(log: (msg: string) => void) {
    if (mls) return; // already initialised
    mls = new MlsService();
    log(
      (window as any).__TAURI_INTERNALS__
        ? 'Initialisé en mode TAURI'
        : 'Initialisé en mode WEB (WASM)'
    );
    callService = new CallService(mls);
    callService.callState.subscribe((s: any) => (callState = s));
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    // identity (read/write so parent can bind)
    /** Authenticated user ID (lowercase). */
    get userId() {
      return userId;
    },
    set userId(v: string) {
      userId = v;
    },
    /** Encryption PIN used to protect local MLS state. */
    get pin() {
      return pin;
    },
    set pin(v: string) {
      pin = v;
    },
    /** Current JWT access token (in-memory only). */
    get authToken() {
      return authToken;
    },
    set authToken(v: string) {
      authToken = v;
    },
    /** MLS device ID assigned to this browser/app instance. */
    get myDeviceId() {
      return myDeviceId;
    },
    /** Last login error message to display to the user. */
    get loginError() {
      return loginError;
    },
    /** Base URL of the chat-delivery service used for history and pin-check calls. */
    get historyBaseUrl() {
      return historyBaseUrl;
    },

    // status
    /** True once the full login flow has completed successfully. */
    get isLoggedIn() {
      return isLoggedIn;
    },
    /** True while a login attempt is in progress (biometric or PIN). */
    get isLoginInProgress() {
      return isLoginInProgress;
    },
    /** True while the WebSocket connection to the gateway is open. */
    get isWsConnected() {
      return isWsConnected;
    },
    /** True when the biometric enrolment banner should be shown (Tauri only). */
    get showBiometricEnrollPrompt() {
      return showBiometricEnrollPrompt;
    },
    set showBiometricEnrollPrompt(v: boolean) {
      showBiometricEnrollPrompt = v;
    },
    /** Active IndexedDB storage instance (null before login). */
    get storage() {
      return storage;
    },

    // services
    /** WebRTC call service instance (null before initServices). */
    get callService() {
      return callService;
    },
    /** Current call state (e.g. 'idle', 'ringing', 'connected'). */
    get callState() {
      return callState;
    },
    set callService(v: any) {
      callService = v;
    },
    set callState(v: any) {
      callState = v;
    },

    // backup status
    /** True while a backup export is in progress. */
    get isExporting() {
      return isExporting;
    },
    /** True while a backup import is in progress. */
    get isImporting() {
      return isImporting;
    },

    // dev tools state
    /** Last generated MLS KeyPackage as a hex string (dev panel). */
    get lastKeyPackage() {
      return lastKeyPackage;
    },
    /** Hex string pasted into the dev panel for incoming MLS bytes. */
    get incomingBytesHex() {
      return incomingBytesHex;
    },
    set incomingBytesHex(v: string) {
      incomingBytesHex = v;
    },
    /** Last produced MLS Commit bytes as hex (dev panel). */
    get lastCommit() {
      return lastCommit;
    },
    /** Last produced MLS Welcome bytes as hex (dev panel). */
    get lastWelcome() {
      return lastWelcome;
    },

    // actions
    /** Initialises the MLS service and CallService; must be called from onMount. */
    initServices,
    /** Returns the current MLS service instance, creating it lazily if needed. */
    ensureMls,
    /** Runs the full login flow (PIN verify, MLS init, DB open, WS connect). */
    login,
    /** On Tauri/Android without biometrics, reads PIN from push_context.json and logs in silently. */
    nativeStorageLogin,
    /** Retrieves the PIN from the biometric keystore and delegates to login(). */
    biometricLogin,
    /** Saves the PIN to the hardware keystore and clears it from memory. */
    enrollBiometric,
    /** Persists the "dismissed" flag and hides the biometric enrolment banner. */
    dismissBiometricPrompt,
    /** Clears session state and redirects to /login. */
    logout,
    /** Pauses WebSocket and clears background timers when the app is backgrounded. */
    pauseConnection,
    /** Schedules an exponential-backoff WebSocket reconnect attempt. */
    scheduleReconnect,
    /** Performs one WebSocket reconnect attempt and re-runs device sync. */
    attemptReconnect,
    /** Processes pending MLS invitations from other devices of the current user. */
    processDeviceInvitationsLocally,
    /** Exports an encrypted backup of all conversations (triggers browser download). */
    handleExport,
    /** Imports a previously exported backup file and reloads conversations. */
    handleImport,
    /** Dev-tool: generates a new MLS KeyPackage for this device. */
    devGenerateKeyPackage,
    /** Dev-tool: adds a member (KeyPackage hex) to an MLS group. */
    devAddMember,
    /** Dev-tool: processes a Welcome message (hex) so this device joins the group. */
    devProcessWelcome,
  };
}
