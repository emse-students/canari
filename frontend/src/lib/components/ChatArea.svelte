<script lang="ts">
  import { ShieldCheck } from 'lucide-svelte';
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
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    replyingTo?: ChatMessage | null;
    onReply?: (message: ChatMessage) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, text: string) => void;
    onCancelReply?: () => void;
    authToken?: string;
    onFileSelected?: (file: File) => void;
    pendingMediaFile?: File | null;
    onCancelMedia?: () => void;
    isUploading?: boolean;
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
    onDelete,
    onEdit,
    onCancelReply,
    authToken = '',
    onFileSelected,
    pendingMediaFile = null,
    onCancelMedia,
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
    <div bind:this={chatContainer} class="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-3">
      {#each messageGroups as group, index (group.type === 'message' ? group.message.id : `${group.type}-${index}`)}
        {#if group.type === 'date_separator'}
          <div class="flex items-center justify-center my-4">
            <span class="text-xs font-medium text-gray-400 bg-cn-bg px-2">{group.date}</span>
          </div>
        {:else if group.type === 'time_separator'}
          <div class="flex justify-center my-2 opacity-0 hover:opacity-100 transition-opacity">
            <span class="text-[0.65rem] text-gray-300">{group.time}</span>
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
            <div class="flex justify-center my-2">
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
            <div class="flex gap-2 {msg.isOwn ? 'justify-end' : 'justify-start'}">
              {#if !msg.isOwn}
                <div class="flex flex-col items-center gap-1" style="width: 32px;">
                  {#if showSender}
                    <Avatar userId={msg.senderId} size="sm" />
                  {:else}
                    <div class="w-6"></div>
                  {/if}
                </div>
              {/if}

              <div class="flex flex-col {msg.isOwn ? 'items-end' : 'items-start'} max-w-[75%]">
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
        class="px-6 py-2 bg-red-50 border-t border-red-200 text-sm text-red-600 flex items-center gap-2"
      >
        <span>⚠️ {sendError}</span>
      </div>
    {/if}

    <ChatComposer
      {messageText}
      {onMessageChange}
      {onSend}
      {replyingTo}
      {onCancelReply}
      {onFileSelected}
      {pendingMediaFile}
      {onCancelMedia}
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
