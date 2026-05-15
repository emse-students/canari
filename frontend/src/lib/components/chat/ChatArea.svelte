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
    /** The active conversation to display, or null when nothing is selected. */
    conversation: Conversation | null;
    /** Current value of the composer text area (controlled). */
    messageText: string;
    /** Whether the active conversation is a community channel. */
    isChannel?: boolean;
    /** Callback fired on each keystroke in the composer. */
    onMessageChange: (value: string) => void;
    /** Callback to submit the composed message. */
    onSend: () => void;
    /** Callback to invite one or more members by user ID. */
    onInviteMembers: (ids: string[]) => void;
    /** Callback to navigate back to the conversation list on mobile. */
    onBack?: () => void;
    /** Callback to open the full conversations drawer. */
    onOpenConversations?: () => void;
    /** Callback to open the channel settings modal. */
    onOpenSettings?: () => void;
    /** When true, the area is hidden on mobile (shown only on desktop). */
    isHidden?: boolean;
    // Group management
    /** List of member user IDs in the current group conversation. */
    groupMembers?: string[];
    /** Error message to display when the last send operation failed. */
    sendError?: string;
    /** Callback to rename the group conversation. */
    onGroupRename?: (name: string) => void;
    /** Callback to delete the group conversation. */
    onGroupDelete?: () => void;
    /** Callback fired when the current user leaves the group. */
    onGroupLeave?: () => void;
    /** Callback to remove a specific member from the group. */
    onGroupRemoveMember?: (userId: string) => void;
    // Reactions & replies
    /** Map of emoji reactions keyed by message ID. */
    messageReactions?: Record<string, MessageReaction[]> | Map<string, MessageReaction[]>;
    /** Message currently being replied to, shown as a preview in the composer. */
    replyingTo?: ChatMessage | null;
    /** Callback fired when the user chooses to reply to a message. */
    onReply?: (message: ChatMessage) => void;
    /** Callback to scroll/jump to a specific message by ID. */
    onNavigateToMessage?: (messageId: string) => void;
    /** Callback fired when the user adds an emoji reaction to a message. */
    onReact?: (messageId: string, emoji: string) => void;
    /** Callback to delete a message by ID. */
    onDelete?: (messageId: string) => void;
    /** Callback to edit a message by ID with new text. */
    onEdit?: (messageId: string, text: string) => void;
    /** Callback to cancel the current reply. */
    onCancelReply?: () => void;
    /** JWT auth token forwarded to message bubbles for media decryption. */
    authToken?: string;
    /** Callback fired when the user selects or drops files to attach. */
    onFilesSelected?: (files: File[]) => void;
    /** Files staged for sending but not yet uploaded. */
    pendingFiles?: File[];
    /** Callback to remove a staged file by its index. */
    onRemovePendingFile?: (index: number) => void;
    /** Whether a file upload is currently in progress. */
    isUploading?: boolean;
    /** Callback to initiate a call with the current contact. */
    onStartCall?: () => void;
    /** Optional media ID for the group or channel avatar image. */
    imageMediaId?: string | null;
    /** Callback to open the channel members sidebar. */
    onOpenMembers?: () => void;
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Whether the conversation history is being loaded (shows a skeleton). */
    isLoadingHistory?: boolean;
    /** Called when in-memory groups are exhausted; should load older messages from DB. Returns true if more may be available. */
    onLoadOlderMessages?: () => Promise<boolean>;
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
    onGroupLeave,
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
    isLoadingHistory = false,
    onLoadOlderMessages,
  }: Props = $props();

  const INITIAL_RENDER_GROUPS = 180;
  const RENDER_GROUPS_STEP = 140;
  const MAX_RENDERED_GROUPS = INITIAL_RENDER_GROUPS + RENDER_GROUPS_STEP * 2; // 460 — cap on DOM nodes

  let chatContainer = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  let _isMobile = $state(false);
  let _composerFocused = $state(false);
  let lastConversationKey = $state('');
  let lastMessageCount = $state(0);
  /** First index (inclusive) of the sliding render window inside messageGroups. */
  let windowStart = $state(0);
  let switchTime = $state(Date.now());
  let stickyDateLabel = $state('');
  let showStickyDate = $state(false);
  let stickyDateTimer: ReturnType<typeof setTimeout> | null = null;
  let searchQuery = $state('');
  let searchMatches = $state<string[]>([]);
  let activeSearchIndex = $state(-1);
  let showSearch = $state(false);
  /** Whether local DB may have messages older than what's currently in memory. */
  let hasMoreInDb = $state(true);
  let isLoadingOlder = $state(false);

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
  let windowEnd = $derived(Math.min(messageGroups.length, windowStart + MAX_RENDERED_GROUPS));
  let visibleMessageGroups = $derived(messageGroups.slice(windowStart, windowEnd));
  /** Groups hidden above the render window (older messages). */
  let hiddenGroupCount = $derived(windowStart);
  /** Groups hidden below the render window (newer messages, while scrolled far up). */
  let hiddenBelowCount = $derived(messageGroups.length - windowEnd);

  async function loadOlderGroups() {
    if (windowStart > 0) {
      windowStart = Math.max(0, windowStart - RENDER_GROUPS_STEP);
    } else if (onLoadOlderMessages && hasMoreInDb && !isLoadingOlder) {
      isLoadingOlder = true;
      try {
        const prevScrollHeight = chatContainer?.scrollHeight ?? 0;
        const prevScrollTop = chatContainer?.scrollTop ?? 0;
        const hasMore = await onLoadOlderMessages();
        if (!hasMore) hasMoreInDb = false;
        // New messages were prepended — restore scroll position so the
        // viewport doesn't jump back to the top.
        await tick();
        if (chatContainer) {
          chatContainer.scrollTop = prevScrollTop + (chatContainer.scrollHeight - prevScrollHeight);
        }
      } finally {
        isLoadingOlder = false;
      }
    }
  }

  function jumpToLatest() {
    windowStart = Math.max(0, messageGroups.length - INITIAL_RENDER_GROUPS);
    tick().then(() => requestAnimationFrame(() => scrollToBottom(true)));
    isNearBottom = true;
  }

  async function navigateToMessage(messageId: string) {
    const targetIndex = messageGroups.findIndex(
      (group) => group.type === 'message' && group.message.id === messageId
    );
    if (targetIndex === -1) {
      onNavigateToMessage?.(messageId);
      return;
    }

    if (targetIndex < windowStart || targetIndex >= windowEnd) {
      windowStart = Math.max(0, targetIndex - Math.floor(MAX_RENDERED_GROUPS / 2));
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
        windowStart = Math.max(0, messageGroups.length - INITIAL_RENDER_GROUPS);
        hasMoreInDb = !isChannel;
        tick().then(() => requestAnimationFrame(() => scrollToBottom(false)));
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
      _isMobile = mq.matches;
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
        {onGroupLeave}
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

    <!-- Messages (padding bas pour laisser défiler sous le composeur glass) -->
    <div
      bind:this={chatContainer}
      onscroll={handleScroll}
      class="chat-scrollbar chat-messages-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-6 flex flex-col gap-2"
    >
      {#if isLoadingHistory}
        <!-- Loading skeleton — hides per-message pop-in while history replays -->
        <div class="flex flex-col gap-3 px-1 py-4 animate-pulse" aria-hidden="true">
          {#each [0.55, 0.8, 0.4, 0.7, 0.5, 0.65, 0.45] as w, i (i)}
            <div class="flex {i % 2 === 0 ? 'justify-end' : 'justify-start'} gap-2">
              {#if i % 2 !== 0}
                <div
                  class="w-7 h-7 rounded-full bg-black/10 dark:bg-white/10 shrink-0 self-end"
                ></div>
              {/if}
              <div
                class="h-9 rounded-2xl bg-black/8 dark:bg-white/8"
                style="width: {Math.round(w * 100)}%; max-width: 22rem;"
              ></div>
            </div>
          {/each}
        </div>
      {:else}
        <ChatMessageGroups
          {visibleMessageGroups}
          {hiddenGroupCount}
          {loadOlderGroups}
          hasMoreInDb={hasMoreInDb && !!onLoadOlderMessages}
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
      {/if}
    </div>

    {#if sendError}
      <div class="chat-floating-alert md:text-sm">
        <TriangleAlert size={16} />
        <span>{sendError}</span>
      </div>
    {/if}

    {#if !isNearBottom || hiddenBelowCount > 0}
      <button
        type="button"
        onclick={jumpToLatest}
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

    <div class="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
      <ChatComposer
        {messageText}
        {onMessageChange}
        onFocusChange={(focused) => (_composerFocused = focused)}
        {onSend}
        {replyingTo}
        {onCancelReply}
        {onFilesSelected}
        {pendingFiles}
        {onRemovePendingFile}
        {isUploading}
        focusKey={conversation.id}
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
