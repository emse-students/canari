import type { IMlsService } from '../IMlsService';
import type { IStorage } from '$lib/db';
import type { AddMessageToChatOptions, Conversation, MessageReaction } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';

/**
 * Dependencies injected into setupMessageHandler.
 * All event callbacks are optional so partial implementations can be used in unit tests.
 */
export interface MessageHandlerDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
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
    contactName: string
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
  onChannelMemberKicked?: (event: {
    channelId: string;
    channelName?: string;
    workspaceId?: string;
    kickedBy?: string;
  }) => void;
  onChannelUpdated?: (event: { channelId: string; name?: string; workspaceId?: string }) => void;
  onChannelDeleted?: (event: { channelId: string; workspaceId?: string }) => void;
  onWorkspaceUpdated?: (event: { workspaceId: string; imageMediaId?: string }) => void;
  onReadReceiptReceived?: (event: {
    conversationKey: string;
    senderId: string;
    messageIds: string[];
  }) => void;
  onCallSignal?: (senderId: string, groupId: string, callMsg: unknown) => void;
  /**
   * Called when a Welcome is processed successfully and the group is ready.
   * Lets processPendingInvitations re-run for invitations that were skipped
   * because the conversation was not ready yet.
   */
  onGroupReady?: (groupId: string) => void;
  /**
   * Shared map of per-group recovery timers (the same one as
   * `useChatSession.connectionRecoveryTimers`). Single source of truth: the message pipeline and
   * the connection layer arm/cancel their timers in this common map, so a `cancelReAdd` after a
   * successful Welcome cancels ALL of the group's timers - no more need for a
   * `cancelGroupRecovery` callback to bridge two separate maps.
   */
  recoveryTimers: SvelteMap<string, ReturnType<typeof setTimeout>>;
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
