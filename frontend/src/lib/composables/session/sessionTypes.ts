/**
 * Types partagés pour le découpage du composable useChatSession :
 * - `ChatSessionCallbacks` : interface des callbacks injectés par le parent (useConversations + UI)
 * - `SessionContext` : boîte d'état réactif passée à chaque sous-module via getters/setters
 *
 * Toutes les fonctions des modules session/* reçoivent `ctx: SessionContext` comme premier
 * paramètre à la place de la closure de useChatSession.
 */
import type { SvelteMap } from 'svelte/reactivity';
import type { IMlsService } from '$lib/mlsService';
import type { BulkIngestPhase } from '$lib/mls-client';
import type { IStorage } from '$lib/db';
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
  beginBulkMessageIngest?: (phase: BulkIngestPhase) => void;
  endBulkMessageIngest?: (phase: BulkIngestPhase) => void | Promise<void>;
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
  /** Appelé dès que le PIN est validé et MLS initialisé (isLoggedIn vient de passer à true),
   * avant loadAndRestoreConversations(). Permet de fermer le modal PIN immédiatement
   * sans attendre la fin complète du login (conversations, WebSocket, etc.). */
  onMlsReady?: () => void;
  /** Appelé quand le login échoue (PIN incorrect, serveur inaccessible, etc.).
   * Si fourni, la redirection vers /login n'a PAS lieu - le caller gère l'erreur.
   * Si absent, on redirige vers /login comme avant. */
  onLoginFailed?: (error: string) => void;
  log: (msg: string) => void;
  messageReactions: SvelteMap<string, any[]>;
  getSelectedContact: () => string | null;
  setSelectedContact: (v: string | null) => void;
  onLoadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
}

/**
 * Boîte d'état réactif passée à chaque sous-module session/*.
 * Expose via getters/setters les variables `$state` définies dans useChatSession,
 * ainsi que les timers mutables (partagés par référence dans un objet boxé).
 */
export interface SessionContext {
  // ── Identité ───────────────────────────────────────────────────────────────
  getUserId(): string;
  setUserId(v: string): void;
  getPin(): string;
  setPin(v: string): void;
  getAuthToken(): string;
  setAuthToken(v: string): void;
  getMyDeviceId(): string;
  setMyDeviceId(v: string): void;

  // ── Services ───────────────────────────────────────────────────────────────
  /** Retourne l'instance MLS courante, la crée lazily si nécessaire. */
  ensureMls(): IMlsService;
  /** Détruit l'instance MLS (destroy + null) pour forcer une réinitialisation propre. */
  resetMls(): void;
  getStorage(): IStorage | null;
  setStorage(v: IStorage | null): void;
  getHistoryBaseUrl(): string;

  // ── Drapeaux ───────────────────────────────────────────────────────────────
  isLoggedIn(): boolean;
  setIsLoggedIn(v: boolean): void;
  isWsConnected(): boolean;
  setIsWsConnected(v: boolean): void;
  getLoginError(): string;
  setLoginError(v: string): void;
  isReconnecting(): boolean;
  setIsReconnecting(v: boolean): void;
  isSyncing(): boolean;
  setIsSyncing(v: boolean): void;
  getIsLoginInProgress(): boolean;
  setIsLoginInProgress(v: boolean): void;
  /** True while post-auth startup sync runs (conversations, WebSocket, pending MLS queue). */
  getIsMessagingInitializing(): boolean;
  setIsMessagingInitializing(v: boolean): void;

  // ── Reconnexion ────────────────────────────────────────────────────────────
  getReconnectAttempts(): number;
  setReconnectAttempts(v: number): void;
  isReconnectCircuitOpen(): boolean;
  setReconnectCircuitOpen(v: boolean): void;

  // ── Services (accès au callService) ───────────────────────────────────────
  /** Retourne le CallService courant (null avant initServices). */
  getCallService(): any;

  // ── Dev tools ──────────────────────────────────────────────────────────────
  setLastKeyPackage(v: string): void;
  setIncomingBytesHex(v: string): void;
  getIncomingBytesHex(): string;
  setLastCommit(v: string): void;
  setLastWelcome(v: string): void;

  // ── Biométrie ──────────────────────────────────────────────────────────────
  setShowBiometricEnrollPrompt(v: boolean): void;

  // ── Erreurs MLS ────────────────────────────────────────────────────────────
  setMlsFatalError(v: 'oom' | 'private_mode' | 'keystore_lost' | null): void;

  /**
   * Timers mutables dans un objet boxé pour éviter de re-passer les références
   * à chaque appel de fonction.
   */
  timers: {
    reconnect: ReturnType<typeof setTimeout> | null;
    health: ReturnType<typeof setInterval> | null;
    syncWatchdog: ReturnType<typeof setInterval> | null;
    connectionWatchdog: ReturnType<typeof setInterval> | null;
  };
  connectionRecoveryTimers: SvelteMap<string, ReturnType<typeof setTimeout>>;
  deferredWelcomeRequests: SvelteMap<
    string,
    Array<{ requesterUserId: string; requesterDeviceId: string }>
  >;

  /** Met à jour le flag réactif exposé par useChatSession pour l'UI (bannière follower). */
  setIsTabLeader(v: boolean): void;
  /** Callback pour la promotion tab leader → reconnexion WebSocket. */
  setTabLeaderSessionCb(cb: ChatSessionCallbacks | null): void;

  // ── Constantes de reconnexion ──────────────────────────────────────────────
  readonly RECONNECT_DELAYS: number[];
  readonly MAX_RECONNECT_ATTEMPTS: number;
}
