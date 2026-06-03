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
  pin: string;
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
  onCallSignal?: (senderId: string, groupId: string, callMsg: unknown) => void;
  /**
   * Appelé quand un Welcome est traité avec succès et que le groupe est prêt.
   * Permet de relancer processPendingInvitations pour les invitations qui
   * avaient été skippées parce que la conversation n'était pas encore prête.
   */
  onGroupReady?: (groupId: string) => void;
  /**
   * Appelé quand un groupe est définitivement empoisonné (Poison Pill).
   * Permet à l'UI d'afficher un avertissement visible à l'utilisateur.
   */
  onGroupPoisoned?: (groupId: string) => void;
  /**
   * Appelé sur une erreur MLS fatale non récupérable nécessitant une action utilisateur.
   * - `'oom'` : OOM WASM détecté → rechargement de l'app recommandé.
   * - `'private_mode'` : navigation privée détectée (stockage indisponible) → état perdu à la fermeture.
   * - `'keystore_lost'` : Keystore Android perdu (TEE reset) → reconnexion recommandée.
   */
  onMlsFatalError?: (kind: 'oom' | 'private_mode' | 'keystore_lost') => void;
  log: (msg: string) => void;
}
