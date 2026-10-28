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
import type { LoginErrorCode } from './loginErrors';
import type { AddMessageToChatOptions, Conversation, MessageBatchOrigin } from '$lib/types';

/**
 * The conditions the MLS fatal-error banner can state. `restore_shortfall` is the startup restore
 * reporting that rows it restored as active lack their MLS group (`measureRestoreShortfall`).
 */
export type MlsFatalErrorKind = 'oom' | 'private_mode' | 'keystore_lost' | 'restore_shortfall';

/**
 * What the caller of `onSessionExpired` already knows about the sign-out. `alreadySignedOut` is
 * true when the revoked-device reset has run `clearAuth` itself, so the handler redirects without
 * signing out a second time (one revocation, one `POST /api/auth/logout`).
 */
export interface SessionExpiredOutcome {
  alreadySignedOut?: boolean;
}

/** Callbacks that useChatSession needs from the parent composable (useConversations + UI glue). Passed to login(), logout(), reconnect helpers, etc. */
export interface ChatSessionCallbacks {
  /** Reactive map of all open conversations, keyed by conversation ID. */
  conversations: SvelteMap<string, Conversation>;
  /** Restores conversations from IndexedDB and re-checks MLS state consistency. */
  loadAndRestoreConversations: () => Promise<void>;
  /**
   * Retires the ending session's restore chain (`useConversations`' `RestoreGeneration`), so a
   * restore it queued never runs as that account after the sign-out, and one still running never
   * makes the next login's restore wait. Called by the teardown, next to the clearing of the map.
   */
  invalidateRestores: () => void;
  /**
   * Forgets the salon rows drawn from the store that no server page has confirmed yet
   * (`useConversations`' `salonRowsDrawnUnconfirmed`). They belong to the ending account, and a
   * failed load of theirs must not withdraw rows from the next account's first page of the same salon.
   * Called by the teardown, next to the clearing of the map.
   */
  forgetUnconfirmedSalonDraws: () => void;
  /**
   * Opens/closes the span during which a conversation may still appear from a startup source.
   *
   * The restore is only the first of those sources, and a deep-link landing that abandoned as soon
   * as it finished threw away the target of a first-contact notification just before the FCM cache
   * created it. The login sequence brackets the whole span so the landing waits for all of it.
   */
  beginConversationSource: () => void;
  endConversationSource: () => void;
  /**
   * Draws the notification landing's target from the local store (F1). Called with the open store
   * and the device key the moment the login holds both - on the vault path, before the token and
   * the revocation answer. Reads only; see `landingPreview.ts`.
   */
  previewLandingTarget?: (input: {
    storage: IStorage;
    deviceKeyB64: string;
    userId: string;
    /** How long the store took to open after the login asked for it - reported on the drawn line. */
    storeOpenMs: number;
    /** The login drawing it: only that login's discard may remove the row. */
    owner: number;
    /** False once that login has given up - a read landing afterwards draws nothing. */
    isCurrent: () => boolean;
  }) => Promise<void>;
  /**
   * Removes whatever {@link previewLandingTarget} drew for login `owner`: that login did not
   * finish. Synchronous, so a failing login never waits on a store before releasing its flag.
   */
  discardLandingPreview?: (reason: string, owner: number) => void;
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
    contactName: string,
    origin: MessageBatchOrigin
  ) => Promise<void>;
  saveConversation: (contactName: string) => Promise<void>;
  selectConversation: (name: string) => void;
  onChannelMemberJoined?: (event: any) => void;
  onChannelMemberKicked?: (event: any) => void;
  onRolePermissionsChanged?: (event: { roleId: string; permissions: string[] }) => void;
  onChannelUpdated?: (event: {
    channelId: string;
    name?: string;
    workspaceId?: string;
    /** The server's verdict on whether THIS device may post here. Absent = unchanged. */
    viewerCanWrite?: boolean;
  }) => void;
  onChannelDeleted?: (event: { channelId: string; workspaceId?: string }) => void;
  onWorkspaceUpdated?: (event: {
    workspaceId: string;
    imageMediaId?: string;
    channelsReordered?: boolean;
  }) => void;
  /**
   * This account emptied a community's unread ("Marquer tout comme lu") on one of its devices - this
   * one included. Addressed by the server to this account alone; the handler re-reads the counts
   * (one request), because the server's own count is the only one that knows what the clear covered
   * on a device that holds different messages.
   */
  onSalonUnreadCleared?: (event: { workspaceId: string }) => void;
  /**
   * This device's own role in a community changed, pushed by the server to the member it concerns.
   *
   * Carries what the role GRANTS rather than only its name: the client caches `viewerCanManage`,
   * which is derived from the permission set, and deriving it here from a label would be a second
   * copy of a rule social-service already owns.
   */
  onWorkspaceRoleChanged?: (event: {
    workspaceId: string;
    roleName: string;
    canManage: boolean;
    /** Whether the role lets this member govern salons. Absent (an older server) = unchanged. */
    canManageChannels?: boolean;
    /**
     * Whether the role lets this member pin or delete OTHER members' messages. Absent (an older
     * server) = unchanged.
     */
    canModerate?: boolean;
    permissions: string[];
  }) => void;
  onWorkspaceDeleted?: (event: { workspaceId: string; deletedBy?: string }) => void;
  onChannelMessageDeleted?: (event: {
    channelId: string;
    messageId: string;
    deletedBy?: string;
  }) => void;
  /** A participant's read watermark moved forward - `at` is how far they have now read. */
  onReadStateAdvanced?: (event: { conversationKey: string; senderId: string; at: number }) => void;
  /** Drains the orphan buffer for a conversation once it is added to the map
   *  (e.g. after processing an MLS Welcome). Called through MessageHandlerDeps. */
  drainOrphanMessages?: (convoKey: string) => void;
  onSendError: (msg: string) => void;
  /** Called as soon as the PIN is validated and MLS is initialised (isLoggedIn just flipped true),
   * before loadAndRestoreConversations(). Lets the PIN modal close immediately without
   * waiting for the full login flow (conversations, WebSocket, etc.) to complete. */
  onMlsReady?: () => void;
  /** Called when login fails (wrong PIN, server unreachable, etc.).
   * When provided, the redirect to /login is suppressed - the caller handles the error.
   * When absent, the default redirect to /login takes place.
   * `code` is the machine-readable reason: branch on it, never on `error`, which is a
   * localized string (see `loginErrors.ts`). */
  onLoginFailed?: (error: string, code?: LoginErrorCode) => void;
  /** Called when the session is definitively dead (refresh cookie expired/revoked, a
   * SessionExpiredError). Distinct from onLoginFailed: this is not a retryable error
   * shown in the PIN modal but an authentication loss - the caller should log the user
   * out and redirect straight to /login rather than surface a message in the modal. */
  onSessionExpired?: (outcome?: SessionExpiredOutcome) => void;
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
  getDeviceKey(): string;
  setDeviceKey(v: string): void;
  getAuthToken(): string;
  setAuthToken(v: string): void;
  getMyDeviceId(): string;
  setMyDeviceId(v: string): void;

  // ── Services ───────────────────────────────────────────────────────────────
  /** Returns the current MLS service instance, creating it lazily if needed. */
  ensureMls(): IMlsService;
  /**
   * Destroys the MLS instance (destroy + null) to force a clean reinitialisation. With `only`, only
   * when that is the instance held - see `MlsHolder.reset`.
   */
  resetMls(only?: IMlsService): void;
  /**
   * Lets go of the MLS client at a sign-out and destroys it once `finalWrite` (the teardown's final
   * checkpoint) has landed - see `mlsHolder.ts`. The next `ensureMls` builds a fresh client. `why`
   * names the end in the native log (a sign-out unless given).
   */
  retireMls(finalWrite: Promise<void>, why?: 'sign-out' | 'lost session'): Promise<void>;
  /** Settles once every retired client's final checkpoint has landed; a login waits for it. */
  whenMlsRetired(): Promise<void>;
  /** True while a retired client's final checkpoint is still being written. */
  isMlsRetiring(): boolean;
  getStorage(): IStorage | null;
  setStorage(v: IStorage | null): void;
  getHistoryBaseUrl(): string;

  // ── Flags ──────────────────────────────────────────────────────────────────
  isLoggedIn(): boolean;
  setIsLoggedIn(v: boolean): void;
  isWsConnected(): boolean;
  setIsWsConnected(v: boolean): void;
  getLoginError(): string;
  setLoginError(v: string): void;
  isReconnecting(): boolean;
  setIsReconnecting(v: boolean): void;
  /**
   * True from `pauseConnectionImpl` (app backgrounded) until `resumeConnectionImpl` (foreground).
   * While it holds, nothing may open a socket: a lost connection is the EXPECTED state, not a fault
   * for the reconnect ladder to repair.
   */
  isConnectionPaused(): boolean;
  setConnectionPaused(v: boolean): void;
  /**
   * True when this session was unlocked with no access token, because the device had no network
   * at launch (see `loginImpl`). The MLS state and the local message store are fully usable; only
   * the transport is missing. Cleared by `promoteOfflineSession` once a token is obtained.
   */
  isOfflineSession(): boolean;
  setIsOfflineSession(v: boolean): void;
  isSyncing(): boolean;
  setIsSyncing(v: boolean): void;
  getIsLoginInProgress(): boolean;
  setIsLoginInProgress(v: boolean): void;
  /**
   * True for exactly as long as `wipeRevokedDevice` is running.
   *
   * The wipe's FIRST act is to tear the live session down, which sets `isLoggedIn` false - and that
   * is the flag a login checks before deciding nobody owns the flow. So the wipe opens the door to
   * the login that then undoes it: measured on prod 2026-08-29, a login started 3 ms after the
   * `device_revoked` frame and reopened `CanariDB_<userId>` 24 ms before the delete, which then
   * blocked and left the store on a device its owner had declared lost.
   */
  isWipingRevokedDevice(): boolean;
  setWipingRevokedDevice(v: boolean): void;
  /** True while post-auth startup sync runs (conversations, WebSocket, pending MLS queue). */
  getIsMessagingInitializing(): boolean;
  setIsMessagingInitializing(v: boolean): void;

  // ── Reconnection ──────────────────────────────────────────────────────────
  /** Index into RECONNECT_DELAYS, nothing more - the ladder no longer terminates on a count. */
  getReconnectAttempts(): number;
  setReconnectAttempts(v: number): void;

  // ── Services (CallService access) ─────────────────────────────────────────
  /** Returns the current CallService instance (null before initServices). */
  getCallService(): any;

  // ── MLS errors ─────────────────────────────────────────────────────────────
  setMlsFatalError(v: MlsFatalErrorKind | null): void;

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
  deferredWelcomeRequests: SvelteMap<
    string,
    Array<{ requesterUserId: string; requesterDeviceId: string }>
  >;

  /** Updates the reactive flag exposed by useChatSession to the UI (follower banner). */
  setIsTabLeader(v: boolean): void;
  /** Callback for the tab-leader promotion -> WebSocket reconnection. */
  setTabLeaderSessionCb(cb: ChatSessionCallbacks | null): void;

  // ── Reconnection constants ─────────────────────────────────────────────────
  /** Backoff ladder; the last entry is the steady-state interval, which is climbed for ever. */
  readonly RECONNECT_DELAYS: number[];
}
