/**
 * Reactive composable owning the full chat session lifecycle:
 * MLS initialisation, WebSocket connection, reconnection, biometric enroll,
 * device sync, backup export/import, dev-tool helpers, and logout.
 *
 * Ce fichier est volontairement réduit au câblage pur : état réactif + construction
 * du SessionContext + délégation aux sous-modules session/*.
 */
import { MlsService } from '$lib/mlsService';
import type { IMlsService } from '$lib/mlsService';
import type { IStorage } from '$lib/db';
import { SvelteMap } from 'svelte/reactivity';
import { setTabLeaderPromotedHandler, getIsTabLeader } from '$lib/utils/chat/connection';
import { CallService } from '$lib/services/CallService';
import { RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { requestLeadershipTakeover } from '$lib/utils/chat/connection';

import type { SessionContext } from './session/sessionTypes';
export type { ChatSessionCallbacks } from './session/sessionTypes';

import {
  loginImpl,
  logoutImpl,
  nativeStorageLoginImpl,
  biometricLoginImpl,
  resetDeviceAsFreshImpl,
} from './session/sessionAuth';
import { dismissBiometricPromptImpl, enrollBiometricImpl } from './session/sessionBiometrics';
import {
  scheduleReconnectImpl,
  attemptReconnectImpl,
  pauseConnectionImpl,
  resumeConnectionImpl,
  startConnectionWatchdogImpl,
  stopConnectionWatchdogImpl,
  runGroupDiscoveryImpl,
} from './session/sessionConnection';
import { exportBackupImpl, importBackupImpl } from './session/sessionBackup';
import { processDeviceInvitationsLocally } from './session/sessionAuth';
import {
  addDevMemberImpl,
  generateDevKeyPackageImpl,
  processDevWelcomeImpl,
} from './session/sessionDevTools';

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
  /** After MAX_RECONNECT_ATTEMPTS failures the circuit opens and the user must manually retry. */
  const MAX_RECONNECT_ATTEMPTS = 20;
  let reconnectAttempts = 0;
  /** True once the circuit is open; cleared by an explicit manual retry. */
  let reconnectCircuitOpen = false;
  /**
   * Timers de reboot armés par `onGroupMissing` au moment de la connexion.
   * Indépendants du syncWatchdog : garantit le reboot même si discoverMissingGroups échoue.
   * Vidés au logout.
   */
  const connectionRecoveryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  /** welcome_requests reçues alors que le groupe terminal n'était pas encore prêt.
   *  Retraitées immédiatement quand onGroupReady() fire pour ce groupId. */
  const deferredWelcomeRequests = new SvelteMap<
    string,
    Array<{ requesterUserId: string; requesterDeviceId: string }>
  >();
  let isReconnecting = false;
  let isSyncing = false;
  /** True quand cet onglet est le leader MLS (tient le WebSocket). Réactif pour l'UI. */
  let isTabLeaderState = $state(false);
  /** Latest session callbacks for tab-leader promotion → WebSocket reconnect. */
  let tabLeaderSessionCb: import('./session/sessionTypes').ChatSessionCallbacks | null = null;

  // ── Backup status ─────────────────────────────────────────────────────────
  let isExporting = $state(false);
  let isImporting = $state(false);
  let isLoginInProgress = false; // plain boolean - guards against concurrent login() calls

  // ── Dev tools ─────────────────────────────────────────────────────────────
  let lastKeyPackage = $state('');
  let incomingBytesHex = $state('');
  let lastCommit = $state('');
  let lastWelcome = $state('');

  // ── Erreurs MLS fatales ───────────────────────────────────────────────────
  /** Erreur MLS non récupérable nécessitant une action utilisateur (OOM, mode privé, Keystore perdu). */
  let mlsFatalError = $state<'oom' | 'private_mode' | 'keystore_lost' | null>(null);

  const historyBaseUrl = (() => {
    const env = import.meta.env.VITE_DELIVERY_URL;
    if (env?.trim()) return env;
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3010';
  })();

  /** Object boxant les timers pour permettre la mutation depuis les sous-modules. */
  const timers: SessionContext['timers'] = {
    reconnect: null,
    health: null,
    syncWatchdog: null,
    connectionWatchdog: null,
  };

  /** Returns the current MLS service instance, creating it lazily if needed. */
  function ensureMls(): IMlsService {
    if (!mls) {
      if (typeof window === 'undefined') throw new Error('MLS unavailable outside browser context');
      mls = new MlsService();
    }
    return mls;
  }

  // ── Construction du SessionContext ────────────────────────────────────────

  const ctx: SessionContext = {
    // Identité
    getUserId: () => userId,
    setUserId: (v) => {
      userId = v;
    },
    getPin: () => pin,
    setPin: (v) => {
      pin = v;
    },
    getAuthToken: () => authToken,
    setAuthToken: (v) => {
      authToken = v;
    },
    getMyDeviceId: () => myDeviceId,
    setMyDeviceId: (v) => {
      myDeviceId = v;
    },

    // Services
    ensureMls,
    resetMls: () => {
      mls?.destroy?.();
      mls = null;
    },
    getStorage: () => storage,
    setStorage: (v) => {
      storage = v;
    },
    getHistoryBaseUrl: () => historyBaseUrl,

    // Drapeaux
    isLoggedIn: () => isLoggedIn,
    setIsLoggedIn: (v) => {
      isLoggedIn = v;
    },
    isWsConnected: () => isWsConnected,
    setIsWsConnected: (v) => {
      isWsConnected = v;
    },
    getLoginError: () => loginError,
    setLoginError: (v) => {
      loginError = v;
    },
    isReconnecting: () => isReconnecting,
    setIsReconnecting: (v) => {
      isReconnecting = v;
    },
    isSyncing: () => isSyncing,
    setIsSyncing: (v) => {
      isSyncing = v;
    },
    getIsLoginInProgress: () => isLoginInProgress,
    setIsLoginInProgress: (v) => {
      isLoginInProgress = v;
    },

    // Reconnexion
    getReconnectAttempts: () => reconnectAttempts,
    setReconnectAttempts: (v) => {
      reconnectAttempts = v;
    },
    isReconnectCircuitOpen: () => reconnectCircuitOpen,
    setReconnectCircuitOpen: (v) => {
      reconnectCircuitOpen = v;
    },

    // Services
    getCallService: () => callService,

    // Dev tools
    setLastKeyPackage: (v) => {
      lastKeyPackage = v;
    },
    setIncomingBytesHex: (v) => {
      incomingBytesHex = v;
    },
    getIncomingBytesHex: () => incomingBytesHex,
    setLastCommit: (v) => {
      lastCommit = v;
    },
    setLastWelcome: (v) => {
      lastWelcome = v;
    },

    // Biométrie
    setShowBiometricEnrollPrompt: (v) => {
      showBiometricEnrollPrompt = v;
    },

    // Erreurs MLS
    setMlsFatalError: (v) => {
      mlsFatalError = v;
    },

    // Timers
    timers,
    connectionRecoveryTimers,
    deferredWelcomeRequests,

    // Tab leader
    setTabLeaderSessionCb: (cb) => {
      tabLeaderSessionCb = cb;
    },

    // Constantes
    RECONNECT_DELAYS,
    MAX_RECONNECT_ATTEMPTS,
  };

  // ── Handler promotion tab leader ──────────────────────────────────────────

  setTabLeaderPromotedHandler(() => {
    const cb = tabLeaderSessionCb;
    if (!cb || !isLoggedIn || !getIsTabLeader()) return;
    isTabLeaderState = true;
    cb.log('[TAB] Promotion leader — connexion WebSocket...');
    void attemptReconnectImpl(ctx, cb);
  });

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
    /** True when this tab is the MLS leader (holds the WebSocket). False for follower tabs. */
    get isTabLeader() {
      return isTabLeaderState;
    },
    /**
     * Demande à l'onglet leader de libérer son leadership afin que cet onglet prenne la main.
     * No-op si cet onglet est déjà le leader.
     */
    requestTabTakeover() {
      if (isTabLeaderState) return;
      requestLeadershipTakeover();
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

    // erreurs MLS fatales
    /** Erreur MLS non récupérable : 'oom' (rechargement requis), 'private_mode' (stockage éphémère), 'keystore_lost' (reconnexion requise). */
    get mlsFatalError() {
      return mlsFatalError;
    },
    /** Réinitialise l'état d'erreur MLS fatale (ex: après que l'utilisateur a rechargé). */
    clearMlsFatalError() {
      mlsFatalError = null;
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
    initServices(log: (msg: string) => void) {
      if (mls) return;
      mls = new MlsService();
      log(isTauriRuntime() ? 'Initialisé en mode TAURI' : 'Initialisé en mode WEB (WASM)');
      callService = new CallService(mls);
      callService.callState.subscribe((s: any) => (callState = s));
    },
    /** Returns the current MLS service instance, creating it lazily if needed. */
    ensureMls,
    /** Runs the full login flow (PIN verify, MLS init, DB open, WS connect). */
    login: (cb: import('./session/sessionTypes').ChatSessionCallbacks) => loginImpl(ctx, cb),
    /** On Tauri/Android without biometrics, reads PIN from push_context.json and logs in silently. */
    nativeStorageLogin: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      nativeStorageLoginImpl(ctx, cb),
    /** Retrieves the PIN from the biometric keystore and delegates to login(). */
    biometricLogin: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      biometricLoginImpl(ctx, cb),
    /** Saves the PIN to the hardware keystore and clears it from memory. */
    enrollBiometric: () => enrollBiometricImpl(ctx),
    /** Persists the "dismissed" flag and hides the biometric enrolment banner. */
    dismissBiometricPrompt: () => dismissBiometricPromptImpl(ctx),
    /** Clears session state and redirects to /login. */
    logout: (cb: import('./session/sessionTypes').ChatSessionCallbacks) => logoutImpl(ctx, cb),
    /** Pauses WebSocket and clears background timers when the app is backgrounded. */
    pauseConnection: () => pauseConnectionImpl(ctx),
    /** Resumes WebSocket after app comes back to foreground. */
    resumeConnection: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      resumeConnectionImpl(ctx, cb),
    /** Schedules an exponential-backoff WebSocket reconnect attempt. */
    scheduleReconnect: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      scheduleReconnectImpl(ctx, cb),
    /** Performs one WebSocket reconnect attempt and re-runs device sync. */
    attemptReconnect: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      attemptReconnectImpl(ctx, cb),
    /** Fires discoverMissingGroups (factored to avoid duplication at call sites). */
    runGroupDiscovery: (
      cb: import('./session/sessionTypes').ChatSessionCallbacks,
      mlsSvc: IMlsService,
      label?: string
    ) => runGroupDiscoveryImpl(ctx, cb, mlsSvc, label),
    /** Exports an encrypted backup of all conversations (triggers browser download). */
    handleExport: (log: (msg: string) => void) =>
      exportBackupImpl(ctx, log, (v) => {
        isExporting = v;
      }),
    /** Imports a previously exported backup file and reloads conversations. */
    handleImport: (
      file: File,
      log: (msg: string) => void,
      clearConversations: () => void,
      reloadConversations: () => Promise<void>
    ) =>
      importBackupImpl(
        ctx,
        log,
        file,
        (v) => {
          isImporting = v;
        },
        clearConversations,
        reloadConversations
      ),
    /** Processes pending MLS invitations from our other devices (multi-device sync). */
    processDeviceInvitationsLocally: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      processDeviceInvitationsLocally(ctx, cb),
    /** Dev-tool: generates a new MLS KeyPackage for this device. */
    devGenerateKeyPackage: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      generateDevKeyPackageImpl(ctx, cb),
    /** Dev-tool: adds a member (KeyPackage hex) to an MLS group. */
    devAddMember: (cb: import('./session/sessionTypes').ChatSessionCallbacks, groupId: string) =>
      addDevMemberImpl(ctx, cb, groupId),
    /** Dev-tool: processes a Welcome message (hex) so this device joins the group. */
    devProcessWelcome: (cb: import('./session/sessionTypes').ChatSessionCallbacks) =>
      processDevWelcomeImpl(ctx, cb),
    /** Resets this device's MLS state and returns to a fresh state (called on server revocation). */
    resetDeviceAsFresh: (
      userIdToReset: string,
      cb: import('./session/sessionTypes').ChatSessionCallbacks
    ) => resetDeviceAsFreshImpl(ctx, userIdToReset, cb),
  };
}
