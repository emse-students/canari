/**
 * Shared types for the useChatSession composable split:
 * - `ChatSessionCallbacks`: callbacks injected by the parent (useConversations + UI glue).
 * - `SessionContext`: reactive state box passed to every sub-module via getters/setters.
 *
 * Every function in session/* takes `ctx: SessionContext` as its first parameter
 * instead of closing over the useChatSession scope directly.
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
  onChannelUpdated?: (event: { channelId: string; name?: string; workspaceId?: string }) => void;
  onChannelDeleted?: (event: { channelId: string; workspaceId?: string }) => void;
  onWorkspaceUpdated?: (event: { workspaceId: string; imageMediaId?: string }) => void;
  onReadReceiptReceived?: (event: {
    conversationKey: string;
    senderId: string;
    messageIds: string[];
  }) => void;
  /** Vide le buffer d'orphelins pour une conversation quand elle est ajoutée à la map
   *  (ex: après traitement d'un Welcome MLS). Appelé via MessageHandlerDeps. */
  drainOrphanMessages?: (convoKey: string) => void;
  onSendError: (msg: string) => void;
  /** Called as soon as the PIN is validated and MLS is initialised (isLoggedIn just flipped true),
   * before loadAndRestoreConversations(). Lets the PIN modal close immediately without
   * waiting for the full login flow (conversations, WebSocket, etc.) to complete. */
  onMlsReady?: () => void;
  /** Called when login fails (wrong PIN, server unreachable, etc.).
   * When provided, the redirect to /login is suppressed - the caller handles the error.
   * When absent, the default redirect to /login takes place. */
  onLoginFailed?: (error: string) => void;
  /** Called when the session is definitively dead (refresh cookie expired/revoked, a
   * SessionExpiredError). Distinct from onLoginFailed: this is not a retryable error
   * shown in the PIN modal but an authentication loss - the caller should log the user
   * out and redirect straight to /login rather than surface a message in the modal. */
  onSessionExpired?: () => void;
  log: (msg: string) => void;
  messageReactions: SvelteMap<string, any[]>;
  getSelectedContact: () => string | null;
  setSelectedContact: (v: string | null) => void;
  onLoadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
}

/**
 * Reactive state box passed to every session/* sub-module.
 * Exposes the `$state` variables from useChatSession via getters/setters,
 * plus mutable timers shared by reference inside a boxed object.
 */
export interface SessionContext {
  // ── Identity ──────────────────────────────────────────────────────────────
  getUserId(): string;
  setUserId(v: string): void;
  getPin(): string;
  setPin(v: string): void;
  getAuthToken(): string;
  setAuthToken(v: string): void;
  getMyDeviceId(): string;
  setMyDeviceId(v: string): void;

  // ── Services ───────────────────────────────────────────────────────────────
  /** Returns the current MLS service instance, creating it lazily if needed. */
  ensureMls(): IMlsService;
  /** Destroys the MLS instance (destroy + null) to force a clean reinitialisation. */
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

  // ── Reconnection ──────────────────────────────────────────────────────────
  getReconnectAttempts(): number;
  setReconnectAttempts(v: number): void;
  isReconnectCircuitOpen(): boolean;
  setReconnectCircuitOpen(v: boolean): void;

  // ── Services (CallService access) ─────────────────────────────────────────
  /** Returns the current CallService instance (null before initServices). */
  getCallService(): any;

  // ── Dev tools ──────────────────────────────────────────────────────────────
  setLastKeyPackage(v: string): void;
  setIncomingBytesHex(v: string): void;
  getIncomingBytesHex(): string;
  setLastCommit(v: string): void;
  setLastWelcome(v: string): void;

  // ── Biometrics ────────────────────────────────────────────────────────────
  setShowBiometricEnrollPrompt(v: boolean): void;

  // ── Erreurs MLS ────────────────────────────────────────────────────────────
  setMlsFatalError(v: 'oom' | 'private_mode' | 'keystore_lost' | null): void;

  /**
   * Mutable timers in a boxed object so sub-modules can mutate them without
   * having to receive updated references on every call.
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

  /** Updates the reactive flag exposed by useChatSession to the UI (follower banner). */
  setIsTabLeader(v: boolean): void;
  /** Callback pour la promotion tab leader → reconnexion WebSocket. */
  setTabLeaderSessionCb(cb: ChatSessionCallbacks | null): void;

  // ── Constantes de reconnexion ──────────────────────────────────────────────
  readonly RECONNECT_DELAYS: number[];
  readonly MAX_RECONNECT_ATTEMPTS: number;
}
