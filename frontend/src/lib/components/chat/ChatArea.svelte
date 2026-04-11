<script lang="ts">
  import { ShieldCheck, TriangleAlert } from 'lucide-svelte';
  import { ArrowDown } from 'lucide-svelte';
  import { tick, untrack } from 'svelte';
  import ChatHeader from './ChatHeader.svelte';
  import ChatMessageGroups from './ChatMessageGroups.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import EmptyState from '../shared/EmptyState.svelte';
  import { groupMessages } from '$lib/utils/messageGrouping';
  import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';

  interface Props {
    conversation: Conversation | null;
    messageText: string;
    isChannel?: boolean;
    onMessageChange: (value: string) => void;
    onSend: () => void;
    onInviteMembers: (ids: string[]) => void;
    onBack?: () => void;
    onOpenConversations?: () => void;
    onOpenSettings?: () => void;
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
    onStartCall?: () => void;
    imageMediaId?: string | null;
  }

  let {
    conversation,
    messageText,
    isChannel = false,
    onMessageChange,
    onSend,
    onInviteMembers,
    onBack,
    onOpenConversations,
    onOpenSettings,
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
    onStartCall,
    imageMediaId = null,
  }: Props = $props();

  const INITIAL_RENDER_GROUPS = 180;
  const RENDER_GROUPS_STEP = 140;

  let chatContainer = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  let lastConversationKey = $state('');
  let lastMessageCount = $state(0);
  let renderedGroupCount = $state(INITIAL_RENDER_GROUPS);
  let switchTime = $state(Date.now());

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
    const convoKey = conversation ? `${conversation.id}-${conversation.contactName}` : '';
    const messageCount = conversation?.messages.length ?? 0;

    untrack(() => {
      if (!conversation) {
        lastConversationKey = '';
        lastMessageCount = 0;
        return;
      }

      const hasConversationChanged = convoKey !== lastConversationKey;
      const hasNewMessage = messageCount > lastMessageCount;

      if (hasConversationChanged) {
        switchTime = Date.now();
        renderedGroupCount = INITIAL_RENDER_GROUPS;
        tick().then(() => scrollToBottom(false));
        isNearBottom = true;
      } else if (hasNewMessage && isNearBottom) {
        tick().then(() => scrollToBottom(true));
      }

      lastConversationKey = convoKey;
      lastMessageCount = messageCount;
    });
  });
</script>

<section
  class="relative flex-1 min-h-0 min-w-0 flex flex-col bg-transparent {isHidden
    ? 'hidden md:flex'
    : ''}"
>
  {#if conversation}
    <ChatHeader
      contactName={conversation.contactName}
      displayName={conversation.name}
      isReady={conversation.isReady}
      {isChannel}
      isGroupConversation={(conversation.conversationType ?? 'group') === 'group'}
      {imageMediaId}
      {onInviteMembers}
      {onBack}
      {onOpenConversations}
      {onOpenSettings}
      {groupMembers}
      {onGroupRename}
      {onGroupDelete}
      {onGroupRemoveMember}
      {onStartCall}
    />

    <!-- Messages -->
    <div
      bind:this={chatContainer}
      onscroll={handleScroll}
      class="chat-scrollbar flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-6 pb-4 md:pb-6 flex flex-col gap-2"
    >
      <ChatMessageGroups
        {visibleMessageGroups}
        {hiddenGroupCount}
        {loadOlderGroups}
        {messageReactions}
        {onReply}
        onNavigateToMessage={navigateToMessage}
        {onReact}
        {onDelete}
        {onEdit}
        {switchTime}
        {authToken}
      />
    </div>

    {#if sendError}
      <div class="chat-floating-alert md:text-sm">
        <TriangleAlert size={16} />
        <span>{sendError}</span>
      </div>
    {/if}

    {#if !isNearBottom}
      <button
        type="button"
        onclick={() => scrollToBottom(true)}
        class="chat-scroll-bottom-button"
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
