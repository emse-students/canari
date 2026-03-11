<script lang="ts">
  import { ShieldCheck, AlertTriangle } from 'lucide-svelte';
  import { tick } from 'svelte';
  import ChatHeader from './ChatHeader.svelte';
  import MessageBubble from './MessageBubble.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import EmptyState from './EmptyState.svelte';
  import Avatar from './Avatar.svelte';
  import { groupMessages } from '$lib/utils/messageGrouping';
  import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';

  interface Props {
    conversation: Conversation | null;
    messageText: string;
    onMessageChange: (value: string) => void;
    onSend: () => void;
    onInviteMembers: (ids: string[]) => void;
    onBack?: () => void;
    onOpenConversations?: () => void;
    isHidden?: boolean;
    // Group management
    groupMembers?: string[];
    sendError?: string;
    onGroupRename?: (name: string) => void;
    onGroupDelete?: () => void;
    onGroupRemoveMember?: (userId: string) => void;
    // Reactions & replies
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    replyingTo?: ChatMessage | null;
    onReply?: (message: ChatMessage) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, text: string) => void;
    onCancelReply?: () => void;
    authToken?: string;
    onFileSelected?: (file: File) => void;
    isUploading?: boolean;
  }

  let {
    conversation,
    messageText,
    onMessageChange,
    onSend,
    onInviteMembers,
    onBack,
    onOpenConversations,
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
    onDelete,
    onEdit,
    onCancelReply,
    authToken = '',
    onFileSelected,
    isUploading = false,
  }: Props = $props();

  let chatContainer = $state<HTMLDivElement>();

  // Group messages by date and time gaps
  let messageGroups = $derived(conversation ? groupMessages(conversation.messages) : []);

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
      {onInviteMembers}
      {onBack}
      {onOpenConversations}
      {groupMembers}
      {onGroupRename}
      {onGroupDelete}
      {onGroupRemoveMember}
    />

    <!-- Messages -->
    <div
      bind:this={chatContainer}
      class="flex-1 overflow-y-auto px-3 py-3 md:px-6 md:py-6 flex flex-col gap-2"
    >
      {#each messageGroups as group, index (group.type === 'message' ? group.message.id : `${group.type}-${index}`)}
        {#if group.type === 'date_separator'}
          <div class="flex justify-center my-3">
            <div class="px-3 py-1 bg-gray-100 rounded-full text-xs text-gray-500 font-medium">
              {group.date}
            </div>
          </div>
        {:else if group.type === 'time_separator'}
          <div class="flex justify-center my-2">
            <div class="px-2 py-0.5 text-[0.65rem] text-gray-400">
              {group.time}
            </div>
          </div>
        {:else if group.type === 'message'}
          {@const msg = group.message}
          {@const reactions =
            messageReactions instanceof Map
              ? messageReactions.get(msg.id) || []
              : messageReactions?.[msg.id] || []}
          {@const prevGroup = index > 0 ? messageGroups[index - 1] : null}
          {@const prevMsg = prevGroup?.type === 'message' ? prevGroup.message : null}
          {@const nextGroup = index < messageGroups.length - 1 ? messageGroups[index + 1] : null}
          {@const nextMsg = nextGroup?.type === 'message' ? nextGroup.message : null}
          {@const continuesFromPrev =
            !!prevMsg &&
            !msg.isSystem &&
            !prevMsg.isSystem &&
            prevMsg.senderId === msg.senderId &&
            prevMsg.isOwn === msg.isOwn}
          {@const continuesToNext =
            !!nextMsg &&
            !msg.isSystem &&
            !nextMsg.isSystem &&
            nextMsg.senderId === msg.senderId &&
            nextMsg.isOwn === msg.isOwn}
          {@const groupPosition = continuesFromPrev
            ? continuesToNext
              ? 'middle'
              : 'end'
            : continuesToNext
              ? 'start'
              : 'single'}
          {@const showSender = !msg.isOwn && groupPosition !== 'middle' && groupPosition !== 'end'}

          {#if msg.isSystem}
            <div
              class="flex justify-center my-2 animate-rise-in"
              style={`animation-delay: ${Math.min(index * 18, 180)}ms`}
            >
              <MessageBubble
                messageId={msg.id}
                senderId={msg.senderId}
                content={msg.content}
                timestamp={msg.timestamp}
                isOwn={msg.isOwn}
                isSystem={msg.isSystem}
                replyTo={msg.replyTo}
                {reactions}
                onReply={onReply ? () => onReply?.(msg) : undefined}
                {onReact}
                {authToken}
              />
            </div>
          {:else}
            <div
              class="flex gap-2 {msg.isOwn ? 'justify-end' : 'justify-start'} animate-rise-in"
              style={`animation-delay: ${Math.min(index * 18, 180)}ms`}
            >
              {#if !msg.isOwn}
                <div class="flex flex-col items-center gap-1" style="width: 28px;">
                  {#if showSender}
                    <Avatar userId={msg.senderId} size="sm" />
                  {:else}
                    <div class="w-6"></div>
                  {/if}
                </div>
              {/if}

              <div
                class="flex flex-col {msg.isOwn
                  ? 'items-end'
                  : 'items-start'} max-w-[88%] md:max-w-[75%]"
              >
                {#if showSender}
                  <div class="text-xs text-gray-500 px-2 mb-1 font-medium">
                    {msg.senderId}
                  </div>
                {/if}

                <MessageBubble
                  messageId={msg.id}
                  senderId={msg.senderId}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  isOwn={msg.isOwn}
                  isSystem={msg.isSystem}
                  replyTo={msg.replyTo}
                  {reactions}
                  readBy={msg.readBy}
                  isEdited={msg.isEdited}
                  isDeleted={msg.isDeleted}
                  {groupPosition}
                  onReply={onReply ? () => onReply?.(msg) : undefined}
                  {onReact}
                  {onDelete}
                  {onEdit}
                  {authToken}
                />
              </div>
            </div>
          {/if}
        {/if}
      {/each}
    </div>

    {#if sendError}
      <div
        class="px-3 md:px-6 py-2 bg-red-50 border-t border-red-200 text-sm text-red-600 flex items-center gap-2"
      >
        <AlertTriangle size={16} />
        <span>{sendError}</span>
      </div>
    {/if}

    <ChatComposer
      {messageText}
      {onMessageChange}
      {onSend}
      {replyingTo}
      {onCancelReply}
      {onFileSelected}
      {isUploading}
    />
  {:else}
    <EmptyState
      icon={ShieldCheck}
      title="Aucun échange sélectionné"
      description="Canari protège vos communications avec le protocole MLS."
    />
  {/if}
</section>
