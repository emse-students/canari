<script lang="ts">
  import { ShieldCheck } from 'lucide-svelte';
  import { tick } from 'svelte';
  import ChatHeader from './ChatHeader.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import EmptyState from './EmptyState.svelte';

  interface ChatMessage {
    id: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
    isSystem?: boolean;
    replyTo?: {
      id: string;
      senderId: string;
      content: string;
    };
  }

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: ChatMessage[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  interface Props {
    conversation: Conversation | null;
    messageText: string;
    inviteMemberInput: string;
    onMessageChange: (value: string) => void;
    onInviteInputChange: (value: string) => void;
    onSend: () => void;
    onInviteMember: () => void;
    onBack?: () => void;
    isHidden?: boolean;
    // Group management
    groupMembers?: string[];
    sendError?: string;
    onGroupRename?: (name: string) => void;
    onGroupDelete?: () => void;
    onGroupRemoveMember?: (userId: string) => void;
    // Reactions & replies
    messageReactions?: Map<string, MessageReaction[]>;
    replyingTo?: ChatMessage | null;
    onReply?: (message: ChatMessage) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onCancelReply?: () => void;
  }

  let {
    conversation,
    messageText,
    inviteMemberInput,
    onMessageChange,
    onInviteInputChange,
    onSend,
    onInviteMember,
    onBack,
    isHidden = false,
    groupMembers = [],
    sendError = '',
    onGroupRename,
    onGroupDelete,
    onGroupRemoveMember,
    messageReactions,
    replyingTo,
    onReply,
    onReact,
    onCancelReply,
  }: Props = $props();

  let chatContainer = $state<HTMLDivElement>();

  $effect(() => {
    if (conversation?.messages) {
      tick().then(() => {
        if (chatContainer) {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      });
    }
  });
</script>

<section class="flex-1 flex flex-col bg-cn-bg {isHidden ? 'hidden md:flex' : ''}">
  {#if conversation}
    <ChatHeader
      contactName={conversation.contactName}
      displayName={conversation.name}
      isReady={conversation.isReady}
      {inviteMemberInput}
      {onInviteInputChange}
      {onInviteMember}
      {onBack}
      {groupMembers}
      {onGroupRename}
      {onGroupDelete}
      {onGroupRemoveMember}
    />

    <!-- Messages -->
    <div bind:this={chatContainer} class="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-2">
      {#each conversation.messages as msg (msg.id)}
        <MessageBubble
          messageId={msg.id}
          senderId={msg.senderId}
          content={msg.content}
          timestamp={msg.timestamp}
          isOwn={msg.isOwn}
          isSystem={msg.isSystem}
          replyTo={msg.replyTo}
          reactions={messageReactions?.get(msg.id) || []}
          onReply={onReply ? () => onReply?.(msg) : undefined}
          {onReact}
        />
      {/each}
    </div>

    {#if sendError}
      <div
        class="px-6 py-2 bg-red-50 border-t border-red-200 text-sm text-red-600 flex items-center gap-2"
      >
        <span>⚠️ {sendError}</span>
      </div>
    {/if}

    <ChatComposer {messageText} {onMessageChange} {onSend} {replyingTo} {onCancelReply} />
  {:else}
    <EmptyState
      icon={ShieldCheck}
      title="Aucun échange sélectionné"
      description="Canari protège vos communications avec le protocole MLS."
    />
  {/if}
</section>
