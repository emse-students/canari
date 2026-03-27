/**
 * Reactive composable owning the full chat session lifecycle:
 * MLS initialisation, WebSocket connection, reconnection, biometric enroll,
 * device sync, backup export/import, dev-tool helpers, and logout.
 *
 * Kept separate from conversation state (useConversations) so each concern
 * has a single place to change.
 */
import { goto } from '$app/navigation';
import { TauriMlsService, WebMlsService } from '$lib/mlsService';
import type { IMlsService } from '$lib/mlsService';
import { getStorage } from '$lib/db';
import type { IStorage } from '$lib/db';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { computePinVerifier } from '$lib/utils/chat/auth';
import { getToken, clearAuth } from '$lib/stores/auth';
import {
  addDevMember,
  exportUserBackup,
  generateDevKeyPackage,
  importUserBackup,
  processDevWelcome,
  syncOwnDevicesToGroups,
} from '$lib/utils/chat/actions';
import { setupMessageHandler, initializeConnection } from '$lib/utils/chat/connection';
import { BiometricService } from '$lib/services/biometric';
import { CallService } from '$lib/services/CallService';
import type { Conversation } from '$lib/types';

export interface ChatSessionCallbacks {
  conversations: SvelteMap<string, Conversation>;
  loadAndRestoreConversations: () => Promise<void>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem?: boolean,
    messageId?: string,
    timestamp?: Date
  ) => Promise<void>;
  addSystemMessage: (content: string, contactName: string) => Promise<void>;
  saveConversation: (contactName: string) => Promise<void>;
  selectConversation: (name: string) => void;
  onChannelMemberJoined: (event: any) => void;
  onChannelMemberKicked: (event: any) => void;
  onSendError: (msg: string) => void;
  onShowSyncGuidePrompt: () => void;
  log: (msg: string) => void;
  messageReactions: SvelteMap<string, any[]>;
  getSelectedContact: () => string | null;
  setSelectedContact: (v: string | null) => void;
  setMobileView: (v: 'list' | 'chat') => void;
  onLoadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
}

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
  let isReconnecting = false;
  let isSyncing = false;

  // ── Backup ────────────────────────────────────────────────────────────────
  let isExporting = $state(false);
  let isImporting = $state(false);

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

  function ensureMls(): IMlsService {
    if (!mls) {
      if (typeof window === 'undefined') throw new Error('MLS unavailable outside browser context');
      const w = window as Window & { __TAURI_INTERNALS__?: unknown };
      mls = w.__TAURI_INTERNALS__ ? new TauriMlsService() : new WebMlsService();
    }
    return mls;
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async function login(cb: ChatSessionCallbacks) {
    if (!userId.trim() || !pin.trim()) {
      loginError = 'Veuillez remplir tous les champs.';
      return;
    }

    loginError = '';
    userId = userId.trim().toLowerCase();
    const hadLocalState = Boolean(localStorage.getItem('mls_autosave_' + userId));

    try {
      const mlsService = ensureMls();
      cb.log('Verification du PIN...');

      const verifier = await computePinVerifier(userId, pin);
      const verifierPayload = JSON.stringify({ userId, verifier });
      let verifierRes = await fetch(`${historyBaseUrl}/api/mls-api/pin-verifier/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: verifierPayload,
      });
      if (verifierRes.status === 404 || verifierRes.status === 405) {
        verifierRes = await fetch(`${historyBaseUrl}/api/mls-api/pin-verifier/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: verifierPayload,
        });
      }
      if (!verifierRes.ok) throw new Error('Impossible de verifier le PIN (serveur inaccessible).');
      const verifierData = await verifierRes.json();
      if (verifierData.status === 'mismatch') {
        throw new Error(
          'PIN incorrect : ce PIN ne correspond pas a celui enregistre pour cet utilisateur. Tous vos appareils doivent utiliser le meme PIN.'
        );
      }
      if (verifierData.status === 'registered') cb.log('Premier appareil : PIN enregistre.');

      cb.log('Initialisation MLS...');
      const { fromHex } = await import('$lib/utils/hex');
      const saved = localStorage.getItem('mls_autosave_' + userId);
      const stateBytes = saved ? fromHex(saved) : undefined;
      if (stateBytes) cb.log('Etat charge depuis le stockage local.');

      await mlsService.init(userId, pin, stateBytes);
      myDeviceId = mlsService.getDeviceId();
      cb.log(`Identite MLS initialisee (device: ${myDeviceId})`);

      storage = await getStorage(userId);
      cb.log('Base de donnees locale initialisee.');

      authToken = await getToken();

      isLoggedIn = true;
      localStorage.setItem('canari_saved_user', userId);
      localStorage.setItem('canari_saved_pin', pin);
      localStorage.setItem('canari_authToken', authToken);

      await cb.loadAndRestoreConversations();

      try {
        const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
        const hasMissing = [...cb.conversations.values()].some(
          (c) => c.isReady && !localMlsGroups.has(c.groupId)
        );
        if (hasMissing) {
          cb.log('[WARN] Groupes sans etat MLS detectes — reinitialisation du cache.');
          localStorage.removeItem(`known_own_devices:${userId}`);
        }
      } catch {
        /* non-blocking diagnostic */
      }

      syncOwnDevicesToGroupsLocally(cb).catch(() => {});

      const syncGuideKey = `canari_sync_guide_seen_${userId}`;
      if (!hadLocalState && localStorage.getItem(syncGuideKey) !== '1') {
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
        selectedContact: cb.getSelectedContact(),
        setSelectedContact: cb.setSelectedContact,
        setMobileView: cb.setMobileView,
        saveConversation: cb.saveConversation,
        addMessageToChat: cb.addMessageToChat,
        addSystemMessage: cb.addSystemMessage,
        loadHistoryForConversation: cb.onLoadHistoryForConversation,
        onChannelMemberJoined: cb.onChannelMemberJoined,
        onChannelMemberKicked: cb.onChannelMemberKicked,
        onCallSignal: (senderId: string, callMsg: any) => {
          callService?.handleCallSignal(senderId, callMsg);
        },
        log: cb.log,
      });

      await initializeConnection({
        mlsService,
        userId,
        pin,
        scheduleReconnect: () => scheduleReconnect(cb),
        setIsWsConnected: (v) => (isWsConnected = v),
        setReconnectAttempts: (v) => (reconnectAttempts = v),
        syncOwnDevicesToGroupsLocally: () => syncOwnDevicesToGroupsLocally(cb),
        log: cb.log,
      });

      const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (isTauri && !(await BiometricService.isConfigured())) {
        showBiometricEnrollPrompt = true;
      }
    } catch (_e: unknown) {
      const msg = _e instanceof Error ? _e.message : String(_e);
      loginError = msg;
      cb.log(`Erreur: ${msg}`);
      localStorage.removeItem('canari_saved_user');
      localStorage.removeItem('canari_saved_pin');
      const cur = window.location.pathname + window.location.search;
      void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
    }
  }

  async function biometricLogin(cb: ChatSessionCallbacks) {
    loginError = '';
    try {
      const savedUser = localStorage.getItem('canari_saved_user');
      if (!savedUser) {
        loginError = 'Aucun utilisateur enregistre pour la biometrie.';
        return;
      }
      const retrieved = await BiometricService.authenticateAndGetSecret();
      if (!retrieved) {
        loginError = "L'authentification biometrique a echoue. Entrez votre PIN manuellement.";
        return;
      }
      userId = savedUser;
      pin = retrieved;
      await login(cb);
    } catch (e) {
      loginError = 'Echec de la biometrie. Entrez votre PIN manuellement.';
      console.error(e);
    }
  }

  async function enrollBiometric() {
    try {
      await BiometricService.enableBiometric(pin);
      showBiometricEnrollPrompt = false;
    } catch (e) {
      console.error('Biometric enrollment failed:', e);
    }
  }

  function logout(cb: ChatSessionCallbacks) {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    isLoggedIn = false;
    isWsConnected = false;
    cb.conversations.clear();
    cb.setSelectedContact(null);
    storage = null;
    authToken = '';
    showBiometricEnrollPrompt = false;
    localStorage.removeItem('canari_saved_user');
    localStorage.removeItem('canari_saved_pin');
    clearAuth();
    void goto('/login', { replaceState: true });
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

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

  async function attemptReconnect(cb: ChatSessionCallbacks) {
    reconnectTimer = null;
    if (!isLoggedIn || isReconnecting) return;
    isReconnecting = true;
    try {
      cb.log('Reconnexion en cours...');
      const token = await getToken();
      const mlsService = ensureMls();
      await mlsService.connect(token);
      mlsService.onDisconnect(() => scheduleReconnect(cb));
      isWsConnected = true;
      reconnectAttempts = 0;
      cb.log('[OK] Reconnecte au reseau.');
      syncOwnDevicesToGroupsLocally(cb).catch(() => {});
    } catch {
      scheduleReconnect(cb);
    } finally {
      isReconnecting = false;
    }
  }

  // ── Device sync ───────────────────────────────────────────────────────────

  async function syncOwnDevicesToGroupsLocally(cb: ChatSessionCallbacks) {
    if (isSyncing) return;
    isSyncing = true;
    try {
      await syncOwnDevicesToGroups({
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

  async function devGenerateKeyPackage(log: (msg: string) => void) {
    try {
      lastKeyPackage = await generateDevKeyPackage({ mlsService: ensureMls(), pin });
    } catch (_e: unknown) {
      log(`Err GenKeyPackage: ${_e instanceof Error ? _e.message : String(_e)}`);
    }
  }

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
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    if (w.__TAURI_INTERNALS__) {
      mls = new TauriMlsService();
      log('Initialisé en mode TAURI');
    } else {
      mls = new WebMlsService();
      log('Initialisé en mode WEB (WASM)');
    }
    callService = new CallService(mls);
    callService.callState.subscribe((s: any) => (callState = s));
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    // identity (read/write so parent can bind)
    get userId() {
      return userId;
    },
    set userId(v: string) {
      userId = v;
    },
    get pin() {
      return pin;
    },
    set pin(v: string) {
      pin = v;
    },
    get authToken() {
      return authToken;
    },
    set authToken(v: string) {
      authToken = v;
    },
    get myDeviceId() {
      return myDeviceId;
    },
    get loginError() {
      return loginError;
    },
    get historyBaseUrl() {
      return historyBaseUrl;
    },

    // status
    get isLoggedIn() {
      return isLoggedIn;
    },
    get isWsConnected() {
      return isWsConnected;
    },
    get showBiometricEnrollPrompt() {
      return showBiometricEnrollPrompt;
    },
    set showBiometricEnrollPrompt(v: boolean) {
      showBiometricEnrollPrompt = v;
    },
    get storage() {
      return storage;
    },

    // services
    get callService() {
      return callService;
    },
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
    get isExporting() {
      return isExporting;
    },
    get isImporting() {
      return isImporting;
    },

    // dev tools state
    get lastKeyPackage() {
      return lastKeyPackage;
    },
    get incomingBytesHex() {
      return incomingBytesHex;
    },
    set incomingBytesHex(v: string) {
      incomingBytesHex = v;
    },
    get lastCommit() {
      return lastCommit;
    },
    get lastWelcome() {
      return lastWelcome;
    },

    // actions
    initServices,
    ensureMls,
    login,
    biometricLogin,
    enrollBiometric,
    logout,
    scheduleReconnect,
    attemptReconnect,
    syncOwnDevicesToGroupsLocally,
    handleExport,
    handleImport,
    devGenerateKeyPackage,
    devAddMember,
    devProcessWelcome,
  };
}
