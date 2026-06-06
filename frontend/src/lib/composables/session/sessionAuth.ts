/**
 * Fonctions d'authentification extraites de useChatSession :
 * login, logout, nativeStorageLogin, biometricLogin, resetDeviceAsFresh.
 *
 * Chaque fonction reçoit `ctx: SessionContext` à la place de la closure
 * et `cb: ChatSessionCallbacks` pour interagir avec les conversations / l'UI.
 */
import { goto } from '$app/navigation';
import { SvelteSet } from 'svelte/reactivity';
import { getStorage } from '$lib/db';
import { computePinVerifier } from '$lib/utils/chat/auth';
import { getToken, clearAuth } from '$lib/stores/auth';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import { checkGroupSuccessors, requestReAdd, RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  setupMessageHandler,
  initializeConnection,
  initTabLeadershipAsync,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import { BiometricService } from '$lib/services/biometric';
import { savePin, clearPin, clearPinAndKey } from '$lib/utils/pinVault';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isLikelyPrivateBrowsing } from '$lib/utils/isLikelyPrivateBrowsing';
import { handleWelcomeRequest, processPendingInvitations } from '$lib/utils/chat/actions';
import { cancelReAdd, reboot } from '$lib/utils/chat/recovery';
import { CallService } from '$lib/services/CallService';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import {
  scheduleReconnectImpl,
  attemptReconnectImpl,
  runGroupDiscoveryImpl,
  startConnectionWatchdogImpl,
  stopConnectionWatchdogImpl,
} from './sessionConnection';
import { startHealthCheckImpl, startSyncWatchdogImpl } from './sessionWatchdogs';
import { isBiometricPromptDismissed } from './sessionBiometrics';

// ── Helpers internes ───────────────────────────────────────────────────────────

/**
 * Marque une conversation comme supprimée côté serveur (deletedRemotely=true).
 * L'UI affiche une bannière pour que l'utilisateur puisse supprimer localement.
 */
function markGroupDeletedRemotely(groupId: string, ctx: SessionContext, cb: ChatSessionCallbacks) {
  const convo = cb.conversations.get(groupId);
  if (!convo || convo.deletedRemotely) return;
  cb.conversations.set(groupId, { ...convo, deletedRemotely: true });
  cb.saveConversation(groupId).catch(() => {});
}

/**
 * Construit les RecoveryDeps nécessaires à requestReAdd / reboot.
 * Centralisé ici pour éviter la duplication dans login et attemptReconnect.
 */
export function makeRecoveryDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  const st = ctx.getStorage();
  return {
    mlsService: ctx.ensureMls(),
    storage: st,
    userId: ctx.getUserId(),
    pin: ctx.getPin(),
    conversations: cb.conversations,
    getSelectedContact: cb.getSelectedContact,
    setSelectedContact: cb.setSelectedContact,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id: string) => st.deleteConversation(id) : undefined,
    log: cb.log,
  };
}

/** Processes any pending MLS invitations from our own other devices (multi-device sync). Re-entrant safe. */
export async function processDeviceInvitationsLocally(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
) {
  if (ctx.isSyncing()) return;
  ctx.setIsSyncing(true);
  try {
    await processPendingInvitations({
      mlsService: ctx.ensureMls(),
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      conversations: cb.conversations,
      log: cb.log,
    });
  } finally {
    ctx.setIsSyncing(false);
  }
}

// ── Fonctions exportées ────────────────────────────────────────────────────────

/**
 * Wipes all local MLS state, device ID, and stored DB for the given user.
 * Called when the server signals that this device has been revoked.
 */
export async function resetDeviceAsFreshImpl(
  ctx: SessionContext,
  userIdToReset: string,
  cb: ChatSessionCallbacks
): Promise<void> {
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

  ctx.resetMls();
  ctx.setStorage(null);
  ctx.setMyDeviceId('');
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  clearPinAndKey();
  clearUserLocally();
  cb.log('[SECURITY] Appareil revoque detecte: etat local purgé, reconnexion requise.');
}

/**
 * Full login flow: verifies the PIN against the server, initialises MLS, opens IndexedDB,
 * restores conversations, connects the WebSocket, and schedules device-sync.
 * On failure redirects to /login (or calls cb.onLoginFailed if provided).
 */
export async function loginImpl(ctx: SessionContext, cb: ChatSessionCallbacks): Promise<void> {
  const userId = ctx.getUserId();
  const pin = ctx.getPin();

  if (!userId.trim() || !pin.trim()) {
    ctx.setLoginError('Veuillez remplir tous les champs.');
    return;
  }

  // Guard against concurrent calls (e.g. onMount + afterNavigate firing together).
  if (ctx.isLoggedIn() || ctx.isReconnecting() || ctx.getIsLoginInProgress()) return;
  ctx.setIsLoginInProgress(true);

  ctx.setLoginError('');
  ctx.setUserId(userId.trim().toLowerCase());

  // Clear any stale reconnect timer from a previous session
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  ctx.setReconnectAttempts(0);
  ctx.setReconnectCircuitOpen(false);

  ctx.setTabLeaderSessionCb(cb);

  try {
    const mlsService = ctx.ensureMls();
    cb.log('Verification du PIN...');

    // Start MLS state load immediately - pure I/O, doesn't need the token.
    const { loadMlsState } = await import('$lib/utils/hex');
    const mlsStatePromise = (async (): Promise<
      { bytes: Uint8Array; source: string } | undefined
    > => {
      const loaded = await loadMlsState(ctx.getUserId());
      if (loaded) return { bytes: loaded, source: 'indexeddb' };
      if (isTauriRuntime()) {
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
      ctx.setLoginError('Session expiree. Merci de vous reconnecter.');
      ctx.setIsLoginInProgress(false);
      return;
    }

    const verifier = await computePinVerifier(ctx.getUserId(), ctx.getPin());
    const deviceId = mlsService.getDeviceId();
    const verifierPayload = JSON.stringify({ userId: ctx.getUserId(), verifier, deviceId });
    const verifierHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };

    // Collect the MLS state that was loading in the background.
    const mlsStateResult = await mlsStatePromise;
    if (mlsStateResult) {
      cb.log(
        mlsStateResult.source === 'native'
          ? 'Etat MLS restaure depuis la sauvegarde native (mls.bin).'
          : 'Etat MLS charge depuis IndexedDB.'
      );
    }

    cb.log('Initialisation MLS...');
    // Run pin-check, MLS init, and DB open concurrently.
    const pinCheckFetch = async () => {
      const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
        method: 'POST',
        headers: verifierHeaders,
        body: verifierPayload,
      });
      if (!res.ok) throw new Error('Impossible de verifier le PIN (serveur inaccessible).');
      return res.json() as Promise<{ status: string; resetRequired?: boolean }>;
    };

    const [pinCheckSettled, mlsInitSettled, storageSettled] = await Promise.allSettled([
      pinCheckFetch(),
      mlsService.init(ctx.getUserId(), ctx.getPin(), mlsStateResult?.bytes),
      getStorage(ctx.getUserId()),
    ]);

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
      ctx.resetMls();
      await resetDeviceAsFreshImpl(ctx, ctx.getUserId(), cb);
      ctx.setPin('');
      throw new Error(
        'Cet appareil a ete revoque. L etat local a ete reinitialise: reconnectez-vous avec votre PIN pour l enregistrer comme nouvel appareil.'
      );
    }
    if (pinCheckData.status === 'registered') cb.log('Premier appareil : PIN enregistre.');

    ctx.setStorage(storageSettled.value);
    ctx.setMyDeviceId(mlsService.getDeviceId());
    cb.log(`Identite MLS initialisee (device: ${ctx.getMyDeviceId()})`);
    console.log(
      `[INIT] MLS initialized for userId=${ctx.getUserId()} device=${ctx.getMyDeviceId()}`
    );
    cb.log('Base de donnees locale initialisee.');

    // Avertir uniquement en navigation privée réelle (stockage bloqué / éphémère).
    void isLikelyPrivateBrowsing()
      .then((privateBrowsing) => {
        if (!privateBrowsing) return;
        ctx.setMlsFatalError('private_mode');
        cb.log(
          "[AVERT] Navigation privée détectée - l'état MLS ne sera pas conservé après fermeture."
        );
        appendLog(
          "ℹ️ Mode navigation privée : vos messages ne seront pas conservés après fermeture de l'onglet."
        );
      })
      .catch(() => {});

    ctx.setAuthToken(await getToken());

    ctx.setIsLoggedIn(true);
    saveUserLocally({ id: ctx.getUserId(), admin: isGlobalAdmin() });
    cb.onMlsReady?.();

    if (!isTauriRuntime()) {
      await savePin(ctx.getPin());
    } else if (!(await BiometricService.isConfigured().catch(() => false))) {
      await savePin(ctx.getPin());
    }

    if (isTauriRuntime()) {
      import('@tauri-apps/api/core')
        .then(({ invoke }) =>
          invoke<{ ok: boolean; reason?: string }>('check_push_secret_health')
            .then((health) => {
              if (!health.ok && health.reason === 'no_secret') {
                ctx.setMlsFatalError('keystore_lost');
                cb.log(
                  '[AVERT] Keystore push perdu — les notifications background sont dégradées. Reconnectez-vous pour les réactiver.'
                );
                appendLog('⚠️ Notifications push dégradées — reconnectez-vous pour les réactiver.');
              }
            })
            .catch(() => {})
        )
        .catch(() => {});
    }

    void startPushService(ctx.getHistoryBaseUrl(), ctx.getAuthToken(), ctx.getMyDeviceId())
      .then(() => cb.log('[PUSH] Enregistrement token push termine.'))
      .catch((e) =>
        cb.log(`[WARN] Echec enregistrement push: ${e instanceof Error ? e.message : String(e)}`)
      );

    await consumeFcmCache(ctx.getPin(), ctx.getStorage()!).catch(() => {});

    await cb.loadAndRestoreConversations();

    try {
      const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
      const missingKeys: string[] = [];
      for (const [key, c] of cb.conversations.entries()) {
        if (isChannelConversationId(c.id)) continue;
        if (c.isReady && !localMlsGroups.has(c.id)) {
          cb.conversations.set(key, { ...c, isReady: false });
          missingKeys.push(key);
        }
      }
      if (missingKeys.length > 0) {
        cb.log(
          `[WARN] Groupes sans etat MLS local detectes - ${missingKeys.length} conversation(s) marquees non-pretes, reinvite declenchee au prochain connect.`
        );
        console.warn(
          `[INIT] ${missingKeys.length} conversation(s) missing local MLS state - marked not-ready`
        );
        await Promise.all(missingKeys.map((key) => cb.saveConversation(key).catch(() => {})));
      }
    } catch (e) {
      console.warn('[INIT] Erreur détection groupes MLS manquants:', e);
    }

    processDeviceInvitationsLocally(ctx, cb).catch((e) =>
      cb.log(`[WARN] Echec sync appareils (login): ${e instanceof Error ? e.message : String(e)}`)
    );

    setupMessageHandler({
      mlsService,
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      historyBaseUrl: ctx.getHistoryBaseUrl(),
      conversations: cb.conversations,
      messageReactions: cb.messageReactions,
      getSelectedContact: cb.getSelectedContact,
      setSelectedContact: cb.setSelectedContact,
      saveConversation: cb.saveConversation,
      deleteConversation: ctx.getStorage()
        ? (id) => ctx.getStorage()!.deleteConversation(id)
        : undefined,
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
        ctx.getCallService()?.handleCallSignal(senderId, groupId, callMsg);
      },
      onGroupReady: (() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        return (readyGroupId: string) => {
          const deferred = ctx.deferredWelcomeRequests.get(readyGroupId);
          if (deferred?.length) {
            ctx.deferredWelcomeRequests.delete(readyGroupId);
            for (const req of deferred) {
              handleWelcomeRequest({
                mlsService: ctx.ensureMls(),
                storage: ctx.getStorage(),
                userId: ctx.getUserId(),
                pin: ctx.getPin(),
                conversations: cb.conversations,
                log: cb.log,
                requesterUserId: req.requesterUserId,
                requesterDeviceId: req.requesterDeviceId,
                groupId: readyGroupId,
              }).catch(() => {});
            }
          }
          if (t !== null) clearTimeout(t);
          t = setTimeout(() => {
            t = null;
            processDeviceInvitationsLocally(ctx, cb).catch(() => {});
          }, 500);
        };
      })(),
      onMlsFatalError: (kind) => {
        ctx.setMlsFatalError(kind);
        if (kind === 'oom') {
          cb.log("[FATAL] Mémoire WASM insuffisante - rechargez l'application.");
          appendLog(
            "⚠️ Mémoire insuffisante — rechargez l'application pour continuer à recevoir des messages."
          );
        } else if (kind === 'private_mode') {
          cb.log(
            "[AVERT] Navigation privée détectée - l'état MLS ne sera pas conservé après fermeture."
          );
          appendLog(
            'ℹ️ Mode navigation privée : vos messages ne seront pas conservés après fermeture.'
          );
        } else if (kind === 'keystore_lost') {
          cb.log('[AVERT] Keystore Android perdu — notifications push dégradées.');
          appendLog('⚠️ Notifications push dégradées — reconnectez-vous pour les réactiver.');
        }
      },
      cancelGroupRecovery: (groupId) => cancelReAdd(groupId, ctx.connectionRecoveryTimers),
      log: cb.log,
    });

    if (mlsService.setBulkIngestHooks && cb.beginBulkMessageIngest && cb.endBulkMessageIngest) {
      mlsService.setBulkIngestHooks(cb.beginBulkMessageIngest, cb.endBulkMessageIngest);
    }

    if ('onWelcomeProcessed' in mlsService) {
      (mlsService as any).onWelcomeProcessed(async (groupId?: string) => {
        if (groupId) {
          cb.log(`[SYNC] Welcome traité pour ${groupId}, rafraîchissement...`);
          if (!cb.conversations.has(groupId)) {
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
            await cb
              .loadAndRestoreConversations()
              .catch((e) => cb.log(`[WARN] Erreur resync convs (Welcome): ${e}`));
          }
          cb.onLoadHistoryForConversation(groupId, groupId).catch((e) =>
            cb.log(`[WARN] Erreur refresh conv ${groupId}: ${e}`)
          );
        } else {
          cb.log('[SYNC] Welcome traité, rafraîchissement des conversations...');
          cb.loadAndRestoreConversations().catch((e) =>
            cb.log(`[WARN] Erreur refresh convs: ${e}`)
          );
        }
      });
    }

    mlsService.onWelcomeRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] welcome_request reçu de ${requesterUserId}:${requesterDeviceId} pour ${groupId}`
        );
        try {
          await handleWelcomeRequest({
            mlsService: ctx.ensureMls(),
            storage: ctx.getStorage(),
            userId: ctx.getUserId(),
            pin: ctx.getPin(),
            conversations: cb.conversations,
            log: cb.log,
            requesterUserId,
            requesterDeviceId,
            groupId,
            onNotReady: (terminalGroupId) => {
              const list = ctx.deferredWelcomeRequests.get(terminalGroupId) ?? [];
              list.push({ requesterUserId, requesterDeviceId });
              ctx.deferredWelcomeRequests.set(terminalGroupId, list);
              cb.log(`[WELCOME_REQ] ${terminalGroupId.slice(0, 8)}… pas encore prêt — report`);
            },
          });
        } catch (e) {
          cb.log(
            `[WARN] Echec handleWelcomeRequest: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    );

    const tabLeaderNow = await initTabLeadershipAsync(cb.log);
    // isTabLeaderState est géré dans useChatSession via le setTabLeaderPromotedHandler
    if (!tabLeaderNow) {
      cb.log('[TAB] Onglet follower — WebSocket actif dans un autre onglet Canari.');
    }

    await initializeConnection({
      mlsService,
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
      scheduleReconnect: () => scheduleReconnectImpl(ctx, cb),
      setIsWsConnected: (v) => ctx.setIsWsConnected(v),
      setReconnectAttempts: (v) => ctx.setReconnectAttempts(v),
      processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(ctx, cb),
      log: cb.log,
      onGroupMissing: (groupId) =>
        requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
      onGroupDeletedRemotely: (groupId) => markGroupDeletedRemotely(groupId, ctx, cb),
    });

    const STALE_SESSION_MS = 90 * 24 * 60 * 60 * 1_000;
    const lastActiveKey = `canari_last_active:${ctx.getUserId()}`;
    const lastActiveRaw = localStorage.getItem(lastActiveKey);
    if (lastActiveRaw) {
      const lastActive = parseInt(lastActiveRaw, 10);
      if (Number.isFinite(lastActive) && Date.now() - lastActive > STALE_SESSION_MS) {
        appendLog(
          '⚠️ Vous ne vous êtes pas connecté depuis plus de 3 mois. Certains anciens messages peuvent ne plus être disponibles.'
        );
      }
    }
    localStorage.setItem(lastActiveKey, String(Date.now()));

    if (!getIsTabLeader()) return;

    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls());

    for (const delay of [35_000, 70_000]) {
      setTimeout(() => {
        if ([...cb.conversations.values()].some((c) => !c.isReady)) {
          runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls(), 'retry');
        }
      }, delay);
    }

    startHealthCheckImpl(ctx, cb);
    startSyncWatchdogImpl(ctx, cb);
    startConnectionWatchdogImpl(ctx, cb);

    if (
      isTauriRuntime() &&
      !(await BiometricService.isConfigured()) &&
      !isBiometricPromptDismissed()
    ) {
      ctx.setShowBiometricEnrollPrompt(true);
    }
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    ctx.setLoginError(msg);
    cb.log(`Erreur: ${msg}`);
    console.error('[INIT] Login failed:', msg);
    ctx.resetMls();
    clearUserLocally();
    clearPin();
    if (cb.onLoginFailed) {
      cb.onLoginFailed(msg);
    } else {
      const cur = window.location.pathname + window.location.search;
      void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
    }
  } finally {
    ctx.setIsLoginInProgress(false);
  }
}

/**
 * On Tauri/Android (no biometrics), reads the PIN from push_context.json and delegates to loginImpl().
 * Returns true if login succeeded, false if manual PIN is still needed.
 */
export async function nativeStorageLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const nativeCtx = await invoke<{ pin?: string; userId?: string } | null>('load_push_context');
    if (!nativeCtx?.pin || !nativeCtx.userId || nativeCtx.userId !== ctx.getUserId()) return false;
    appendLog('[PIN] PIN restauré depuis stockage natif - login auto...');
    ctx.setPin(nativeCtx.pin);
    await loginImpl(ctx, cb);
    return ctx.isLoggedIn();
  } catch {
    return false;
  }
}

/**
 * Reads the PIN from the hardware biometric keystore and delegates to loginImpl().
 * Displays a user-friendly error if biometric authentication fails.
 */
export async function biometricLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  ctx.setLoginError('');
  cb.log('[BIOMETRIE] Tentative de connexion biométrique...');
  try {
    const savedUser = currentUserId();
    if (!savedUser) {
      ctx.setLoginError('Aucun utilisateur enregistre pour la biometrie.');
      cb.log('[BIOMETRIE] Echec - aucun utilisateur local');
      return;
    }
    cb.log(`[BIOMETRIE] Authentification pour userId=${savedUser.slice(0, 8)}...`);
    const retrieved = await BiometricService.authenticateAndGetSecret();
    if (!retrieved) {
      ctx.setLoginError("L'authentification biometrique a echoue. Entrez votre PIN manuellement.");
      cb.log('[BIOMETRIE] Echec - secret non récupéré, PIN manuel requis');
      return;
    }
    cb.log('[BIOMETRIE] PIN récupéré via biométrie - appel login()');
    ctx.setUserId(savedUser);
    ctx.setPin(retrieved);
    await loginImpl(ctx, cb);
  } catch (e) {
    ctx.setLoginError('Echec de la biometrie. Entrez votre PIN manuellement.');
    cb.log(`[BIOMETRIE] Exception: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  }
}

/**
 * Clears all session state (conversations, tokens, push registration),
 * deregisters the device push token, and redirects to /login.
 */
export function logoutImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  cb.log(`[LOGOUT] Déconnexion de userId=${ctx.getUserId()?.slice(0, 8) ?? 'inconnu'}...`);
  const tokenForPushCleanup = ctx.getAuthToken();
  const deviceForPushCleanup = ctx.getMyDeviceId();

  if (tokenForPushCleanup && deviceForPushCleanup) {
    void stopPushService(ctx.getHistoryBaseUrl(), tokenForPushCleanup, deviceForPushCleanup);
  }

  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  if (ctx.timers.health !== null) {
    clearInterval(ctx.timers.health);
    ctx.timers.health = null;
  }
  if (ctx.timers.syncWatchdog !== null) {
    clearInterval(ctx.timers.syncWatchdog);
    ctx.timers.syncWatchdog = null;
  }
  for (const t of ctx.connectionRecoveryTimers.values()) clearTimeout(t);
  ctx.connectionRecoveryTimers.clear();
  stopConnectionWatchdogImpl(ctx);
  ctx.setReconnectAttempts(0);
  ctx.setReconnectCircuitOpen(false);
  ctx.setTabLeaderSessionCb(null);
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  cb.conversations.clear();
  cb.setSelectedContact(null);
  ctx.setStorage(null);
  ctx.setAuthToken('');
  ctx.setShowBiometricEnrollPrompt(false);
  clearUserLocally();
  clearPinAndKey();
  clearAuth();
  cb.log('[LOGOUT] État local effacé - redirection vers /login');
  void goto('/login', { replaceState: true });
}
