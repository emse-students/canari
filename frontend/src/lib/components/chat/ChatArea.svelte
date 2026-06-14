<script lang="ts">
  import { ShieldCheck, TriangleAlert, Loader2 } from '@lucide/svelte';
  import { ArrowDown, Search, ChevronUp, ChevronDown, X, ChevronLeft, Pin } from '@lucide/svelte';
  import { tick, untrack } from 'svelte';
  import { slide } from 'svelte/transition';
  import ChatHeader from './ChatHeader.svelte';
  import ChatMessageGroups from './ChatMessageGroups.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import PollComposerModal from '../channels/PollComposerModal.svelte';
  import ConversationMediaPanel from './ConversationMediaPanel.svelte';
  import type { ChannelPollDraft } from '$lib/utils/chat/channelCrypto';
  import EmptyState from '../shared/EmptyState.svelte';
  import type { SharedContent } from '$lib/utils/chat/sharedContent';
  import { groupMessages, isMessageGroupRow } from '$lib/utils/messageGrouping';
  import { computeMessageListSwitchTime } from '$lib/utils/chat/messageUtils';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import type { ChatMessage, MessageReaction, Conversation } from '$lib/types';
  import type { PendingMediaFile } from '$lib/media';
  import { getKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
  import { swipeBack } from '$lib/actions/swipeBack';
  import { typingUsersFor } from '$lib/stores/typingStore.svelte';
  import { pinnedMessageIds } from '$lib/stores/pinStore.svelte';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

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
    /** Optional callback emitting throttled typing start/stop signals. */
    onTyping?: (isTyping: boolean) => void;
    /** Optional callback to send a picked GIF by direct URL. */
    onSendGif?: (url: string) => void;
    /** Optional callback to create a poll (channels only). Enables the "Sondage" button. */
    onCreatePoll?: (draft: ChannelPollDraft) => void | Promise<void>;
    /** Loads the conversation's shared media/links/files from the local history. */
    onLoadSharedContent?: (conversationId: string) => Promise<SharedContent>;
    /**
     * Full-conversation search over the entire local history. Returns matching message IDs
     * (oldest-first), or `null` to signal the caller to fall back to in-memory search
     * (e.g. community channels, whose messages are not persisted locally).
     */
    onSearchAll?: (conversationId: string, query: string) => Promise<string[] | null>;
    /** Callback to toggle a message's pinned state. */
    onTogglePin?: (messageId: string) => void;
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
    /** Callback to remove the conversation locally when it was deleted by another participant. */
    onGroupDeleteLocally?: () => void;
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
    /** Callback fired when the user chooses to forward a message to another conversation. */
    onForward?: (message: ChatMessage) => void;
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
    pendingFiles?: PendingMediaFile[];
    /** Callback to remove a staged file by its index. */
    onRemovePendingFile?: (index: number) => void;
    /** Whether a file upload is currently in progress. */
    isUploading?: boolean;
    /** Callback to start an audio-only call. */
    onStartAudioCall?: () => void;
    /** Callback to start a video call. */
    onStartVideoCall?: () => void;
    /** Optional media ID for the group or channel avatar image. */
    imageMediaId?: string | null;
    /** Callback to open the channel members sidebar. */
    onOpenMembers?: () => void;
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Whether the conversation history is being loaded (shows a skeleton). */
    isLoadingHistory?: boolean;
    /** Whether MLS is catching up messages after reconnect (shows a blocking overlay). */
    isCatchingUpMessages?: boolean;
    /** Called when in-memory groups are exhausted; should load older messages from DB. Returns true if more may be available. */
    onLoadOlderMessages?: () => Promise<boolean>;
    /** Exposes the scrollable messages element (for programmatic scroll from messaging). */
    onMessagesScrollEl?: (el: HTMLDivElement | null) => void;
  }

  let {
    conversation,
    messageText,
    isChannel = false,
    onMessageChange,
    onSend,
    onTyping,
    onSendGif,
    onCreatePoll,
    onLoadSharedContent,
    onSearchAll,
    onTogglePin,
    onInviteMembers,
    onBack,
    onOpenConversations: _onOpenConversations,
    onOpenSettings,
    isHidden = false,
    groupMembers = [],
    sendError = '',
    onGroupRename,
    onGroupDelete,
    onGroupDeleteLocally,
    onGroupLeave,
    onGroupRemoveMember,
    messageReactions,
    replyingTo,
    onReply,
    onForward,
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
    onStartAudioCall,
    onStartVideoCall,
    imageMediaId = null,
    onOpenMembers,
    currentUserId = '',
    isLoadingHistory = false,
    isCatchingUpMessages = false,
    onLoadOlderMessages,
    onMessagesScrollEl,
  }: Props = $props();

  /** Whether the poll composer modal is open (channels only). */
  let showPollComposer = $state(false);

  const INITIAL_RENDER_GROUPS = 180;
  const RENDER_GROUPS_STEP = 140;
  const MAX_RENDERED_GROUPS = INITIAL_RENDER_GROUPS + RENDER_GROUPS_STEP * 2; // 460 - cap on DOM nodes

  let chatContainer = $state<HTMLDivElement>();
  let isNearBottom = $state(true);
  let _isMobile = $state(false);
  let _composerFocused = $state(false);
  let lastConversationKey = $state('');
  let lastMessageCount = $state(0);
  /** First index (inclusive) of the sliding render window inside messageGroups. */
  let windowStart = $state(0);
  /** Messages at or before this time do not play the "just received" animation. */
  let switchTime = $state(Date.now());
  let catchupWasActive = $state(false);
  let stickyDateLabel = $state('');
  let showStickyDate = $state(false);
  let stickyDateTimer: ReturnType<typeof setTimeout> | null = null;
  let searchQuery = $state('');
  let searchMatches = $state<string[]>([]);
  let activeSearchIndex = $state(-1);
  /** True when search could only cover the in-memory messages (channels). */
  let searchLimitedToLoaded = $state(false);
  /** Monotonic token to drop stale async search results. */
  let searchSeq = 0;
  let showSearch = $state(false);
  let showMediaPanel = $state(false);
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

  /**
   * Robustly pins the view to the latest message when entering a conversation.
   * A single rAF scroll often fires before late-settling content (images, fonts,
   * the freshly rendered group window) has finished growing the list, leaving the
   * view above the bottom. Re-pinning across a few frames and two short delays
   * guarantees we actually land on the last message.
   */
  function scrollToBottomSettled() {
    if (!chatContainer) return;
    scrollToBottom(false);
    let frames = 0;
    const repin = () => {
      scrollToBottom(false);
      if (++frames < 5) requestAnimationFrame(repin);
    };
    requestAnimationFrame(repin);
    setTimeout(() => scrollToBottom(false), 250);
    setTimeout(() => scrollToBottom(false), 600);
  }

  function handleScroll() {
    if (!chatContainer) return;
    const distanceFromBottom =
      chatContainer.scrollHeight - (chatContainer.scrollTop + chatContainer.clientHeight);
    isNearBottom = distanceFromBottom < 120;
    updateStickyDateIndicator();
    if (chatContainer.scrollTop < 80) {
      void loadOlderGroups();
    }
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

  /**
   * Single snapshot for the open chat UI. Props passed to children use `chatView?.xxx ?? default`
   * (optional chaining) even inside `{#if chatView}` because Svelte 5 re-evaluates prop expressions
   * during component teardown, after `chatView` has already transitioned to null. Without the
   * optional chain, `chatView.contactName` throws "Cannot read properties of null" at teardown,
   * which corrupts the signal graph and freezes the app on Android.
   */
  const chatView = $derived.by(() => {
    const c = conversation;
    if (!c?.id) return null;
    void c.messages.length;
    void c.deletedRemotely;
    void c.isReady;
    void c.lastMessageAt;
    const pres = resolveConversationListPresentation(
      {
        id: c.id,
        name: c.name,
        contactName: c.contactName ?? c.id,
        conversationType: c.conversationType,
        directPeerId: c.directPeerId,
      },
      currentUserId ?? ''
    );
    const convType = c.conversationType ?? 'group';
    return {
      conversation: c,
      contactName: c.contactName ?? pres.contactId,
      displayName: pres.displayName,
      isReady: c.isReady,
      isGroup: convType === 'group',
      isDirect: convType === 'direct',
    };
  });

  /** Pinned message IDs for the active conversation (reactive). */
  const pinnedIds = $derived(chatView ? pinnedMessageIds(chatView.conversation.id) : []);
  let showPinned = $state(false);

  /** Resolves a short preview for a pinned message, or null when it isn't loaded in memory. */
  function pinnedPreview(messageId: string): string | null {
    const m = chatView?.conversation.messages.find((x) => x.id === messageId);
    if (!m) return null;
    const text = searchableText(m).replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 77)}…` : text || 'Message';
  }

  /** Reactive "X écrit…" label for the active conversation, excluding the current user. */
  const typingLabel = $derived.by(() => {
    const convId = chatView?.conversation.id;
    if (!convId) return '';
    const me = currentUserId.trim().toLowerCase();
    const typers = typingUsersFor(convId).filter((u) => u !== me);
    if (typers.length === 0) return '';
    const names = typers.map((u) => getUserDisplayNameSync(u, u));
    if (names.length === 1) return `${names[0]} écrit…`;
    if (names.length === 2) return `${names[0]} et ${names[1]} écrivent…`;
    return 'Plusieurs personnes écrivent…';
  });

  // Group messages by date and time gaps
  let messageGroups = $derived(chatView ? groupMessages(chatView.conversation.messages) : []);
  let windowEnd = $derived(Math.min(messageGroups.length, windowStart + MAX_RENDERED_GROUPS));
  let visibleMessageGroups = $derived(messageGroups.slice(windowStart, windowEnd));
  /** Groups hidden above the render window (older messages). */
  let _hiddenGroupCount = $derived(windowStart);
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
        // New messages were prepended - restore scroll position so the
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
      (group) => isMessageGroupRow(group) && group.message.id === messageId
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

  /** Filters the in-memory loaded messages (fallback / channels). */
  function inMemoryMatches(q: string): string[] {
    if (!chatView) return [];
    return chatView.conversation.messages
      .filter((m) => searchableText(m).toLowerCase().includes(q))
      .map((m) => m.id);
  }

  async function refreshSearchMatches() {
    const q = searchQuery.trim().toLowerCase();
    if (!chatView || q.length < 2) {
      searchMatches = [];
      activeSearchIndex = -1;
      searchLimitedToLoaded = false;
      return;
    }
    const seq = ++searchSeq;
    const convId = chatView.conversation.id;

    // Full-history search via the local store (DMs/groups); null falls back to in-memory
    // (channels, whose messages aren't persisted locally).
    let ids: string[] | null = null;
    if (onSearchAll) {
      try {
        ids = await onSearchAll(convId, q);
      } catch {
        ids = null;
      }
    }
    if (seq !== searchSeq) return; // a newer query superseded this one

    if (ids === null) {
      searchMatches = inMemoryMatches(q);
      searchLimitedToLoaded = isChannel;
    } else {
      searchMatches = ids;
      searchLimitedToLoaded = false;
    }
    activeSearchIndex = searchMatches.length > 0 ? 0 : -1;
  }

  /**
   * Scrolls to a message, first paging older history into memory if it isn't loaded yet
   * (bounded). Lets a full-history search result that lives far up the timeline be reached.
   */
  async function navigateToMessageEnsureLoaded(messageId: string) {
    let attempts = 0;
    while (
      onLoadOlderMessages &&
      !(chatView?.conversation.messages.some((m) => m.id === messageId) ?? false) &&
      attempts < 120
    ) {
      const hasMore = await onLoadOlderMessages();
      attempts++;
      await tick();
      if (!hasMore) break;
    }
    await navigateToMessage(messageId);
  }

  async function jumpSearch(delta: 1 | -1) {
    if (searchMatches.length === 0) return;
    const next = (activeSearchIndex + delta + searchMatches.length) % searchMatches.length;
    activeSearchIndex = next;
    await navigateToMessageEnsureLoaded(searchMatches[next]);
  }

  $effect(() => {
    const c = conversation;
    const convoKey = c ? `${c.id}-${c.contactName}` : '';
    const messageCount = c?.messages.length ?? 0;
    const catchupActive = isLoadingHistory || isCatchingUpMessages;

    untrack(() => {
      if (!c) {
        lastConversationKey = '';
        lastMessageCount = 0;
        catchupWasActive = false;
        return;
      }

      if (catchupWasActive && !catchupActive) {
        switchTime = computeMessageListSwitchTime(c.messages);
      }
      catchupWasActive = catchupActive;

      const hasConversationChanged = convoKey !== lastConversationKey;
      const hasNewMessage = messageCount > lastMessageCount;

      if (hasConversationChanged) {
        switchTime = computeMessageListSwitchTime(c.messages);
        windowStart = Math.max(0, messageGroups.length - INITIAL_RENDER_GROUPS);
        hasMoreInDb = !isChannel;
        tick().then(() => scrollToBottomSettled());
        isNearBottom = true;
      } else if (hasNewMessage && !catchupActive) {
        // Always scroll to bottom for own messages; for others only if already near bottom.
        const ownMessageAdded = c.messages.at(-1)?.isOwn === true;
        if (isNearBottom || ownMessageAdded) {
          tick().then(() => scrollToBottom(true));
        }
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

  $effect(() => {
    onMessagesScrollEl?.(chatContainer ?? null);
    return () => onMessagesScrollEl?.(null);
  });

  $effect(() => {
    if (!_composerFocused || !chatContainer) return;
    untrack(() => {
      tick().then(() => requestAnimationFrame(() => scrollToBottom(false)));
    });
  });

  let keyboardWasOpen = false;
  $effect(() => {
    const kbOpen = getKeyboardViewport().isOpen;
    if (!chatContainer) {
      keyboardWasOpen = kbOpen;
      return;
    }
    if (!keyboardWasOpen && kbOpen && _composerFocused && isNearBottom) {
      tick().then(() => requestAnimationFrame(() => scrollToBottom(false)));
    }
    if (keyboardWasOpen && !kbOpen && isNearBottom) {
      tick().then(() => requestAnimationFrame(() => scrollToBottom(false)));
    }
    keyboardWasOpen = kbOpen;
  });

  $effect(() => {
    void searchQuery;
    void refreshSearchMatches();
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
  use:swipeBack={{ onBack: onBack ?? (() => {}), enabled: _isMobile && !!onBack }}
>
  {#if chatView}
    <div>
      <ChatHeader
        contactName={chatView?.contactName ?? ''}
        groupId={chatView?.conversation.id ?? ''}
        displayName={chatView?.displayName ?? ''}
        isReady={chatView?.isReady ?? false}
        {isChannel}
        isGroupConversation={chatView?.isGroup ?? false}
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
        {onStartAudioCall}
        {onStartVideoCall}
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
        onOpenMedia={onLoadSharedContent ? () => (showMediaPanel = true) : undefined}
      />
    </div>

    {#if onLoadSharedContent && chatView}
      <ConversationMediaPanel
        open={showMediaPanel}
        conversationId={chatView.conversation.id}
        {authToken}
        loadSharedContent={onLoadSharedContent}
        onClose={() => (showMediaPanel = false)}
        onOpenSearch={() => (showSearch = true)}
      />
    {/if}

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
                  searchLimitedToLoaded = false;
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
        {#if searchLimitedToLoaded && searchQuery.trim().length >= 2}
          <p class="px-1 pt-1 text-[0.7rem] text-text-muted">
            Recherche limitée aux messages chargés. Faites défiler vers le haut pour en charger
            davantage.
          </p>
        {/if}
      </div>
    {/if}

    {#if pinnedIds.length > 0}
      <div class="px-3 md:px-6 pt-1">
        <button
          type="button"
          onclick={() => (showPinned = !showPinned)}
          class="flex w-full items-center gap-2 rounded-xl border border-cn-border bg-[var(--cn-surface)]/80 px-3 py-1.5 text-left text-sm text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <Pin size={14} class="shrink-0 text-amber-500" />
          <span class="font-semibold"
            >{pinnedIds.length} message{pinnedIds.length > 1 ? 's' : ''} épinglé{pinnedIds.length > 1
              ? 's'
              : ''}</span
          >
          <ChevronDown size={15} class="ml-auto transition-transform {showPinned ? 'rotate-180' : ''}" />
        </button>
        {#if showPinned}
          <div
            transition:slide={{ duration: 150 }}
            class="mt-1 flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-xl border border-cn-border bg-[var(--cn-surface)] p-1"
          >
            {#each pinnedIds as pid (pid)}
              <div
                class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-sm text-text-main"
                  onclick={() => {
                    showPinned = false;
                    void navigateToMessageEnsureLoaded(pid);
                  }}
                >
                  {pinnedPreview(pid) ?? 'Message épinglé'}
                </button>
                {#if onTogglePin}
                  <button
                    type="button"
                    onclick={() => onTogglePin?.(pid)}
                    class="shrink-0 rounded-lg p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                    aria-label="Désépingler"
                    title="Désépingler"
                  >
                    <X size={14} />
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Messages (padding bas pour laisser défiler sous le composeur glass) -->
    <div class="relative flex-1 min-h-0 flex flex-col">
      <div
        bind:this={chatContainer}
        onscroll={handleScroll}
        class="chat-scrollbar chat-messages-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-6 flex flex-col gap-2"
      >
        {#if isLoadingHistory}
          <!-- Loading skeleton - hides per-message pop-in while history replays -->
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
            {isLoadingOlder}
            {messageReactions}
            {currentUserId}
            searchQuery={searchQuery.trim()}
            {onReply}
            {onForward}
            onNavigateToMessage={navigateToMessage}
            {onReact}
            {onDelete}
            {onEdit}
            {onTogglePin}
            {pinnedIds}
            {switchTime}
            {authToken}
            isDirect={chatView?.isDirect ?? false}
            isMobile={_isMobile}
          />
        {/if}
      </div>
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
        {#if hiddenBelowCount > 0}
          <span
            class="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 text-cn-dark text-[0.6rem] font-extrabold inline-flex items-center justify-center shadow-sm shadow-amber-500/30 pointer-events-none"
            aria-hidden="true"
          >
            {hiddenBelowCount > 99 ? '99+' : hiddenBelowCount}
          </span>
        {/if}
      </button>
    {/if}

    {#if showStickyDate && stickyDateLabel}
      <div class="chat-sticky-date-indicator">{stickyDateLabel}</div>
    {/if}

    {#if conversation?.deletedRemotely}
      <div
        class="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-4 py-3 bg-[var(--color-surface)] border-t border-black/8 dark:border-white/10"
      >
        <p class="text-sm text-[var(--color-text-muted)] text-center">
          Cette conversation a été supprimée.
        </p>
        <button
          onclick={() => onGroupDeleteLocally?.()}
          class="px-4 py-1.5 rounded-lg text-sm font-medium bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 active:scale-95 transition-all"
        >
          Supprimer localement
        </button>
      </div>
    {:else}
      <div class="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
        <ChatComposer
          {messageText}
          {onMessageChange}
          {onTyping}
          {onSendGif}
          onCreatePoll={isChannel && onCreatePoll ? () => (showPollComposer = true) : undefined}
          {typingLabel}
          onFocusChange={(focused) => (_composerFocused = focused)}
          {onSend}
          {replyingTo}
          {onCancelReply}
          {onFilesSelected}
          {pendingFiles}
          {onRemovePendingFile}
          {isUploading}
          interactionLocked={isCatchingUpMessages}
        />
      </div>
    {/if}

    {#if isChannel && onCreatePoll}
      <PollComposerModal
        open={showPollComposer}
        onClose={() => (showPollComposer = false)}
        onCreate={onCreatePoll}
      />
    {/if}

    {#if isCatchingUpMessages}
      <div
        class="absolute top-0 inset-x-0 z-40 flex items-center justify-center gap-2 py-1.5 px-4 bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-medium border-b border-amber-500/20 pointer-events-none"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 size={11} class="animate-spin shrink-0" strokeWidth={2.5} />
        Synchronisation MLS en cours - envoi temporairement indisponible
      </div>
    {/if}
  {:else}
    {#if onBack}
      <!-- Safety net: when a conversation ID is selected but its object is null (e.g. load race),
           the back button must still be reachable on mobile or the user is completely stuck. -->
      <header
        class="md:hidden bg-white/70 dark:bg-black/50 px-3 py-3 border-b border-black/5 dark:border-white/10 flex items-center backdrop-blur-2xl z-20"
      >
        <button
          onclick={onBack}
          aria-label="Retour au menu"
          class="p-1 rounded-xl text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all"
        >
          <ChevronLeft size={24} />
        </button>
      </header>
    {/if}
    <EmptyState
      icon={ShieldCheck}
      title="Aucun échange sélectionné"
      description="Canari protège vos communications avec le protocole MLS."
    />
  {/if}
</section>
