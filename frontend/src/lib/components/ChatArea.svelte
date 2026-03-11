<script lang="ts">
  import { ShieldCheck, AlertTriangle } from 'lucide-svelte';
  import { ArrowDown } from 'lucide-svelte';
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
    onNavigateToMessage?: (messageId: string) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, text: string) => void;
    onCancelReply?: () => void;
    authToken?: string;
    onFilesSelected?: (files: File[]) => void;
    pendingFiles?: File[];
    onRemovePendingFile?: (index: number) => void;
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
    onNavigateToMessage,
    onReact,
    onDelete,
    onEdit,
    onCancelReply,
    authToken = '',
    onFilesSelected,
    pendingFiles = [],
    onRemovePendingFile,
    isUploading = false,
  }: Props = $props();

  const INITIAL_RENDER_GROUPS = 180;
  const RENDER_GROUPS_STEP = 140;

  let chatContainer = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  let lastConversationKey = $state('');
  let lastMessageCount = $state(0);
  let renderedGroupCount = $state(INITIAL_RENDER_GROUPS);

  function scrollToBottom(smooth = true) {
    if (!chatContainer) return;
    chatContainer.scrollTo({
      top: chatContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function handleScroll() {
    if (!chatContainer) return;
    const distanceFromBottom =
      chatContainer.scrollHeight - (chatContainer.scrollTop + chatContainer.clientHeight);
    isNearBottom = distanceFromBottom < 120;
  }

  // Group messages by date and time gaps
  let messageGroups = $derived(conversation ? groupMessages(conversation.messages) : []);
  let visibleMessageGroups = $derived(messageGroups.slice(-renderedGroupCount));
  let hiddenGroupCount = $derived(Math.max(messageGroups.length - visibleMessageGroups.length, 0));

  function loadOlderGroups() {
    renderedGroupCount += RENDER_GROUPS_STEP;
  }

  async function navigateToMessage(messageId: string) {
    const targetIndex = messageGroups.findIndex(
      (group) => group.type === 'message' && group.message.id === messageId
    );
    if (targetIndex === -1) {
      onNavigateToMessage?.(messageId);
      return;
    }

    const groupsFromEnd = messageGroups.length - targetIndex;
    if (groupsFromEnd > renderedGroupCount) {
      renderedGroupCount = groupsFromEnd + 8;
      await tick();
    }

    const targetElement = document.getElementById(`msg-${messageId}`);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  $effect(() => {
    const convoKey = conversation ? `${conversation.groupId}-${conversation.contactName}` : '';
    const messageCount = conversation?.messages.length ?? 0;

    if (!conversation) {
      lastConversationKey = '';
      lastMessageCount = 0;
      return;
    }

    const hasConversationChanged = convoKey !== lastConversationKey;
    const hasNewMessage = messageCount > lastMessageCount;

    if (hasConversationChanged) {
      renderedGroupCount = INITIAL_RENDER_GROUPS;
      tick().then(() => scrollToBottom(false));
      isNearBottom = true;
    } else if (hasNewMessage && isNearBottom) {
      tick().then(() => scrollToBottom(true));
    }

    lastConversationKey = convoKey;
    lastMessageCount = messageCount;
  });
</script>

<section
  class="relative flex-1 min-h-0 min-w-0 flex flex-col bg-cn-bg {isHidden ? 'hidden md:flex' : ''}"
>
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
      onscroll={handleScroll}
      class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-6 pb-32 md:pb-36 flex flex-col gap-2"
    >
      {#if hiddenGroupCount > 0}
        <div class="sticky top-2 z-10 flex justify-center mb-1">
          <button
            type="button"
            onclick={loadOlderGroups}
            class="px-3 py-1 rounded-full bg-white/80 backdrop-blur border border-cn-border text-xs text-cn-dark hover:bg-white transition-colors shadow-sm"
          >
            Charger les messages precedents ({hiddenGroupCount})
          </button>
        </div>
      {/if}

      {#each visibleMessageGroups as group, index (group.type === 'message' ? group.message.id : `${group.type}-${index}`)}
        {#if group.type === 'date_separator'}
          <div class="flex justify-center my-3">
            <div
              class="px-3 py-1 bg-cn-bg rounded-full text-xs text-cn-muted font-medium border border-cn-border/70"
            >
              {group.date}
            </div>
          </div>
        {:else if group.type === 'time_separator'}
          <div class="flex justify-center my-2">
            <div class="px-2 py-0.5 text-[0.65rem] text-cn-muted/80">
              {group.time}
            </div>
          </div>
        {:else if group.type === 'message'}
          {@const msg = group.message}
          {@const reactions =
            messageReactions instanceof Map
              ? messageReactions.get(msg.id) || []
              : messageReactions?.[msg.id] || []}
          {@const prevGroup = index > 0 ? visibleMessageGroups[index - 1] : null}
          {@const prevMsg = prevGroup?.type === 'message' ? prevGroup.message : null}
          {@const nextGroup =
            index < visibleMessageGroups.length - 1 ? visibleMessageGroups[index + 1] : null}
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
                  <div class="text-xs text-cn-muted px-2 mb-1 font-medium">
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
                  editedAt={msg.editedAt}
                  isDeleted={msg.isDeleted}
                  {groupPosition}
                  onReply={onReply ? () => onReply?.(msg) : undefined}
                  onNavigateToMessage={navigateToMessage}
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
        class="absolute bottom-24 left-3 right-3 md:left-6 md:right-6 px-3 py-2 bg-red-50/95 border border-red-200 rounded-lg text-sm text-red-600 flex items-center justify-center gap-2 shadow-sm z-10"
      >
        <AlertTriangle size={16} />
        <span>{sendError}</span>
      </div>
    {/if}

    {#if !isNearBottom}
      <button
        type="button"
        onclick={() => scrollToBottom(true)}
        class="absolute right-4 md:right-8 bottom-28 md:bottom-32 w-10 h-10 rounded-full bg-cn-dark text-cn-yellow shadow-lg hover:shadow-xl transition-all hover:scale-105 z-20"
        aria-label="Revenir en bas de la discussion"
        title="Revenir en bas"
      >
        <span class="inline-flex items-center justify-center w-full h-full">
          <ArrowDown size={18} />
        </span>
      </button>
    {/if}

    <div class="relative z-20">
      <ChatComposer
        {messageText}
        {onMessageChange}
        {onSend}
        {replyingTo}
        {onCancelReply}
        {onFilesSelected}
        {pendingFiles}
        {onRemovePendingFile}
        {isUploading}
      />
    </div>
  {:else}
    <EmptyState
      icon={ShieldCheck}
      title="Aucun échange sélectionné"
      description="Canari protège vos communications avec le protocole MLS."
    />
  {/if}
</section>
