<script lang="ts">
  import { ShieldCheck, TriangleAlert } from 'lucide-svelte';
  import { ArrowDown, Search, ChevronUp, ChevronDown, X } from 'lucide-svelte';
  import { tick, untrack } from 'svelte';
  import { slide } from 'svelte/transition';
  import ChatHeader from './ChatHeader.svelte';
  import ChatMessageGroups from './ChatMessageGroups.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import EmptyState from '../shared/EmptyState.svelte';
  import { groupMessages } from '$lib/utils/messageGrouping';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
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
    onOpenMembers?: () => void;
    currentUserId?: string;
  }

  let {
    conversation,
    messageText,
    isChannel = false,
    onMessageChange,
    onSend,
    onInviteMembers,
    onBack,
    onOpenConversations: _onOpenConversations,
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
    onOpenMembers,
    currentUserId = '',
  }: Props = $props();

  const INITIAL_RENDER_GROUPS = 180;
  const RENDER_GROUPS_STEP = 140;

  let chatContainer = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  let isMobile = $state(false);
  let composerFocused = $state(false);
  let lastConversationKey = $state('');
  let lastMessageCount = $state(0);
  let renderedGroupCount = $state(INITIAL_RENDER_GROUPS);
  let switchTime = $state(Date.now());
  let stickyDateLabel = $state('');
  let showStickyDate = $state(false);
  let stickyDateTimer: ReturnType<typeof setTimeout> | null = null;
  let searchQuery = $state('');
  let searchMatches = $state<string[]>([]);
  let activeSearchIndex = $state(-1);
  let showSearch = $state(false);

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
    updateStickyDateIndicator();
  }

  function clearStickyDateTimer() {
    if (!stickyDateTimer) return;
    clearTimeout(stickyDateTimer);
    stickyDateTimer = null;
  }

  function updateStickyDateIndicator() {
    if (!chatContainer) return;
    const dates = Array.from(
      chatContainer.querySelectorAll<HTMLElement>('[data-chat-date-separator]')
    );
    if (dates.length === 0) return;

    const containerTop = chatContainer.getBoundingClientRect().top;
    let currentDate = dates[0].dataset.chatDateSeparator ?? '';

    for (const item of dates) {
      const y = item.getBoundingClientRect().top - containerTop;
      if (y <= 40) {
        currentDate = item.dataset.chatDateSeparator ?? currentDate;
      } else {
        break;
      }
    }

    if (!currentDate) return;
    stickyDateLabel = currentDate;
    showStickyDate = true;
    clearStickyDateTimer();
    stickyDateTimer = setTimeout(() => {
      showStickyDate = false;
    }, 1400);
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
      targetElement.classList.add('chat-message-jump-highlight');
      setTimeout(() => {
        targetElement.classList.remove('chat-message-jump-highlight');
      }, 1800);
    }
  }

  function searchableText(message: ChatMessage): string {
    try {
      return getPreviewText(parseEnvelope(message.content));
    } catch {
      return message.content;
    }
  }

  function refreshSearchMatches() {
    const q = searchQuery.trim().toLowerCase();
    if (!conversation || q.length < 2) {
      searchMatches = [];
      activeSearchIndex = -1;
      return;
    }
    const hits = conversation.messages
      .filter((m) => searchableText(m).toLowerCase().includes(q))
      .map((m) => m.id);
    searchMatches = hits;
    activeSearchIndex = hits.length > 0 ? 0 : -1;
  }

  async function jumpSearch(delta: 1 | -1) {
    if (searchMatches.length === 0) return;
    const next = (activeSearchIndex + delta + searchMatches.length) % searchMatches.length;
    activeSearchIndex = next;
    await navigateToMessage(searchMatches[next]);
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

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px), (pointer: coarse)');
    const apply = () => {
      isMobile = mq.matches;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  });

  // Quand le clavier virtuel se ferme (viewport height augmente), si on était en bas,
  // scroller de nouveau en bas pour éviter l'espace vide sous le dernier message.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height;
    const onResize = () => {
      const newHeight = vv.height;
      const keyboardClosed = newHeight > prevHeight;
      prevHeight = newHeight;
      if (keyboardClosed && isNearBottom) {
        tick().then(() => scrollToBottom(false));
      }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  });

  $effect(() => {
    refreshSearchMatches();
  });

  $effect(() => {
    return () => {
      clearStickyDateTimer();
    };
  });
</script>

<section
  class="relative flex-1 min-h-0 min-w-0 flex flex-col bg-transparent {isHidden
    ? 'hidden md:flex'
    : ''}"
>
  {#if conversation}
    <div>
      <ChatHeader
        contactName={conversation.contactName}
        displayName={conversation.name}
        isReady={conversation.isReady}
        {isChannel}
        isGroupConversation={(conversation.conversationType ?? 'group') === 'group'}
        {imageMediaId}
        {onInviteMembers}
        {onBack}
        {onOpenSettings}
        {groupMembers}
        {currentUserId}
        {onGroupRename}
        {onGroupDelete}
        {onGroupRemoveMember}
        {onStartCall}
        {onOpenMembers}
        onToggleSearch={() => {
          showSearch = !showSearch;
          if (!showSearch) {
            searchQuery = '';
            searchMatches = [];
            activeSearchIndex = -1;
          }
        }}
        searchActive={showSearch}
      />
    </div>

    {#if showSearch}
      <div class="px-3 md:px-6 pt-2 pb-0.5" transition:slide={{ duration: 180 }}>
        <div class="chat-search-panel">
          <div class="chat-search-input-wrap">
            <Search size={15} class="opacity-60" />
            <input
              type="text"
              value={searchQuery}
              oninput={(e) => (searchQuery = e.currentTarget.value)}
              placeholder="Rechercher dans la conversation"
              class="chat-search-input"
            />
            {#if searchQuery}
              <button
                type="button"
                onclick={() => {
                  searchQuery = '';
                  searchMatches = [];
                  activeSearchIndex = -1;
                }}
                class="chat-search-action"
                aria-label="Effacer la recherche"
              >
                <X size={15} />
              </button>
            {/if}
          </div>
          <div class="chat-search-nav">
            <span class="chat-search-count">
              {searchMatches.length > 0 && activeSearchIndex >= 0
                ? `${activeSearchIndex + 1}/${searchMatches.length}`
                : '0/0'}
            </span>
            <button
              type="button"
              onclick={() => void jumpSearch(-1)}
              class="chat-search-action"
              aria-label="Occurrence précédente"
              disabled={searchMatches.length === 0}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              onclick={() => void jumpSearch(1)}
              class="chat-search-action"
              aria-label="Occurrence suivante"
              disabled={searchMatches.length === 0}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        </div>
      </div>
    {/if}

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
        {currentUserId}
        searchQuery={searchQuery.trim()}
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

    {#if showStickyDate && stickyDateLabel}
      <div class="chat-sticky-date-indicator">{stickyDateLabel}</div>
    {/if}

    <div class="relative z-20">
      <ChatComposer
        {messageText}
        {onMessageChange}
        onFocusChange={(focused) => (composerFocused = focused)}
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
