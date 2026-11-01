import type { IMlsService } from '../IMlsService';
import type { EventTime } from '$lib/utils/chat/visibleNotices';
import type { IStorage } from '$lib/db';
import type {
  AddMessageToChatOptions,
  Conversation,
  MessageBatchOrigin,
  MessageReaction,
} from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import type { AnnouncedJoinAsk } from '$lib/utils/chat/actions';
import type { SettledJoinAsk } from '$lib/utils/chat/joinRequests.svelte';

/**
 * Dependencies injected into setupMessageHandler.
 * All event callbacks are optional so partial implementations can be used in unit tests.
 */
export interface MessageHandlerDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  /**
   * The key the local store is sealed with NOW, read at every write.
   *
   * A function and never a value, because these deps live for the whole session while the key does
   * not: an in-session PIN change re-seals the store and moves the session's key
   * (`performPinChange` -> `SessionContext.setDeviceKey`), and a value captured at login kept sealing
   * every later message under the key the store had just been migrated off. Call it at the write,
   * never once up front - a copy is exactly what went stale.
   */
  deviceKey: () => string;
  historyBaseUrl: string;
  conversations: SvelteMap<string, Conversation>;
  messageReactions: SvelteMap<string, MessageReaction[]>;
  getSelectedContact: () => string | null;
  setSelectedContact: (value: string | null) => void;
  saveConversation: (contactName: string) => Promise<void>;
  /** Delete a conversation from the local DB. Used when migrating away from a dead MLS group. */
  deleteConversation?: (key: string) => Promise<void>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  batchAddMessages?: (
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string,
    origin: MessageBatchOrigin
  ) => Promise<void>;
  loadHistoryForConversation: (contactName: string, groupId: string) => Promise<void>;
  onChannelMemberJoined?: (event: {
    channelId: string;
    channelName?: string;
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    visibility?: 'public' | 'private';
    roleName?: string;
    joinedBy?: string;
  }) => void;
  /**
   * A member lost access to a channel or to a whole community. Broadcast to EVERY remaining
   * member as well as the target, so `kickedUserId` is what decides whether the receiver is the
   * one being removed - without it a client purges state on someone else's behalf.
   * An empty `channelId` means the removal was community-wide.
   */
  onChannelMemberKicked?: (event: {
    channelId: string;
    channelName?: string;
    workspaceId?: string;
    /** The user being removed. Compare with the local user id before touching any state. */
    kickedUserId: string;
    kickedBy?: string;
    /** The actor's device that commits the key-group Remove itself, when the actor named one. */
    actorDeviceId?: string;
    /** Channel removals only: a public channel stays readable, so nothing is lost. */
    channelIsPrivate?: boolean;
  }) => void;
  /**
   * The actor of a removal RELEASED the key-group Remove it claimed and did not commit
   * (`channel.member.removal-released`): this scope's remaining members elect a committer. An empty
   * `channelId` is the community's key group.
   */
  onChannelRemovalReleased?: (event: {
    workspaceId: string;
    channelId: string;
    removedUserId: string;
    /** The actor who released it - never elected for it. */
    releasedBy: string;
    /** The actor's device that released it - re-decided only where the tree holds its leaf. */
    releasedByDevice: string;
  }) => void;
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
    /** The community's salons were rearranged: re-read the order, the event names no salon. */
    channelsReordered?: boolean;
  }) => void;
  /** This account cleared a community's unread on some device - see `sessionTypes.onSalonUnreadCleared`. */
  onSalonUnreadCleared?: (event: { workspaceId: string }) => void;
  /** This device's own role in a community changed - see `sessionTypes.onWorkspaceRoleChanged`. */
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
  /**
   * A new person's ask the server announced to every online admitted member (`group.join_ask`),
   * raised before this device's member once its own tree says the person holds no leaf
   * (`raiseAnnouncedJoinAsk`).
   */
  onJoinAsk?: (ask: AnnouncedJoinAsk) => void;
  /** An ask answered, by whichever member, as the server holds it (`group.join_ask.settled`). */
  onJoinAskSettled?: (settled: SettledJoinAsk) => void;
  /** A participant's read watermark moved forward - `at` is how far they have now read. */
  onReadStateAdvanced?: (event: { conversationKey: string; senderId: string; at: number }) => void;
  /**
   * A call signal arrived. `at` is when its frame happened (`receivedNoticeTime`: the frame's
   * `sentAt` and the server's acceptance), `null` when neither is known - the call record is dated
   * by it, never by when this device processed the frame.
   */
  onCallSignal?: (
    senderId: string,
    groupId: string,
    callMsg: unknown,
    at: EventTime | null
  ) => void;
  /**
   * Called when a Welcome is processed successfully and the group is ready: resumes what the outbox
   * held for it and re-runs the invitations skipped while it was not (`sessionAuth`'s
   * `announceGroupReady`, reached as `captureGroupReadyAnnouncer()` so a Welcome processed after the
   * session ended announces nothing into the next). REQUIRED: these deps are also the pipeline's
   * `RecoveryDeps`, whose external join raises the same seam.
   */
  onGroupReady: (groupId: string) => void;
  /**
   * Called on a fatal, unrecoverable MLS error requiring user action.
   * - `'oom'`: WASM OOM detected -> app reload recommended.
   * - `'private_mode'`: private browsing detected (storage unavailable) -> state lost on close.
   * - `'keystore_lost'`: Android Keystore lost (TEE reset) -> re-login recommended.
   */
  onMlsFatalError?: (kind: 'oom' | 'private_mode' | 'keystore_lost') => void;
  /**
   * Replays the buffered orphan messages for a conversation that has just been added to the
   * map. Called after a successful MLS Welcome (FIX 3-4).
   */
  drainOrphanMessages?: (convoKey: string) => void;
  log: (msg: string) => void;
}
