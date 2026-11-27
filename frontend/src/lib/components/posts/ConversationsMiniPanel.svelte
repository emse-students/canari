<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getSavedUserId } from '$lib/stores/user';
  import ConversationTile from '$lib/components/chat/ConversationTile.svelte';
  import { MessageCircle, ChevronRight, LoaderCircle } from '@lucide/svelte';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { isNeverAdmitted } from '$lib/utils/chat/admissionState';
  import {
    mergeHeldConversations,
    readStoredConversations,
    type HeldConversation,
  } from '$lib/utils/chat/heldConversations';
  import { requestConversationOpening } from '$lib/utils/chat/pendingChatOpening';
  import { m } from '$lib/paraglide/messages';

  /** The panel's ceiling: the twenty most recent conversations. */
  const PANEL_ROWS = 20;

  let idbItems = $state<HeldConversation[]>([]);
  let idbLoading = $state(true);

  /**
   * The stored rows merged with the live map (`heldConversations.ts`, the one rule the universal
   * search's Discussions section reads too): the stored baseline only seeds the list before the live
   * map is authoritative, so a cold /posts load does not flash empty and a deletion is not resurrected.
   */
  const displayItems = $derived.by(() => {
    const uid = globalSession.userId ?? getSavedUserId() ?? '';
    if (!uid) return [];
    return mergeHeldConversations({
      stored: idbItems,
      live: globalSession.isLoggedIn ? globalConvs.conversations.entries() : null,
      uid,
      liveAuthoritative: globalSession.isLoggedIn && globalConvs.conversationsRestored,
    }).slice(0, PANEL_ROWS);
  });

  const isLoading = $derived(idbLoading && displayItems.length === 0);

  onMount(async () => {
    const uid = getSavedUserId();
    if (!uid) {
      idbLoading = false;
      return;
    }
    try {
      idbItems = (await readStoredConversations(uid)).slice(0, PANEL_ROWS);
    } catch (e) {
      // A reader that fails silently is a panel that renders empty and says nothing, which reads as
      // "no conversations" - the one answer it must not invent.
      console.warn('[POSTS] could not read the stored conversations for the mini panel:', e);
    } finally {
      idbLoading = false;
    }
  });

  function navigateToConversation(metaId: string) {
    requestConversationOpening(metaId, sessionStorage);
    void goto(resolve('/chat'));
  }
</script>

<!--
  THE CEILING IS THE SCROLLPORT'S, NOT THE WINDOW'S.

  It was `max-h-[calc(100vh-8rem)]`: a hand-written sum of the same distances `--app-content-top`
  now expresses, and 100vh is a WINDOW measurement while this panel lives inside
  `.page-scroll-wrap`, which begins below the brand bar. Measured on the live estate 2026-09-22 at
  1920x945: the scrollport is 872px and the column leaves 808 of it once its own
  `--page-column-top` gutter is taken off the top AND the bottom - against a ceiling of 817. So a
  panel with enough conversations to reach its maximum stood 9px proud of the column it sticks in,
  and lifted off the bottom on the way down.

  Stated from the tokens instead, so it cannot drift from the shell again: the scrollport is the
  viewport minus where the content starts, and the panel may have that minus its gutter twice -
  once for the sticky offset above it, once for the gutter below. The sticky offset IS
  `--page-column-top`, which is why the same token appears twice rather than a number appearing
  once (see the token's own comment: a sticky offset is the same distance as the padding above it,
  or the element moves by the difference).
-->
<aside
  class="bg-cn-surface sticky top-(--page-column-top) hidden max-h-[calc(var(--app-viewport-height,100dvh)-var(--app-content-top)-2*var(--page-column-top))] w-[22rem] shrink-0 flex-col self-start overflow-hidden rounded-2xl shadow-sm transition-all duration-300 xl:flex"
>
  <!-- Header. -->
  <div
    class="bg-cn-surface flex shrink-0 items-center justify-between border-b border-black/5 px-5 py-4 dark:border-white/10"
  >
    <div class="flex items-center gap-2.5">
      <div class="bg-accent/10 text-accent-text rounded-lg p-1.5">
        <MessageCircle size={16} strokeWidth={2.5} />
      </div>
      <span class="text-text-main text-sm font-bold">{m.post_conversations_panel_title()}</span>
    </div>
    <a
      href={resolve('/chat')}
      class="text-2xs text-accent-text focus-visible:ring-accent-icon flex items-center gap-0.5 rounded font-bold transition-colors outline-none focus-visible:ring-2"
    >
      {m.post_conversations_see_all_label()}
      <ChevronRight size={14} strokeWidth={2.5} />
    </a>
  </div>

  <!-- Conversation list. -->
  <div class="flex-1 overflow-y-auto py-2">
    {#if isLoading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-3 py-10">
        <LoaderCircle size={24} class="text-accent-text animate-spin" />
        <span class="text-xs font-semibold">{m.common_loading_label()}</span>
      </div>
    {:else if displayItems.length === 0}
      <div class="animate-in fade-in slide-in-from-bottom-2 px-4 py-10 text-center duration-300">
        <div
          class="text-text-muted mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-black/5 opacity-60 shadow-inner dark:bg-white/5"
        >
          <MessageCircle size={24} strokeWidth={2} />
        </div>
        <p class="text-text-main mb-1 text-sm font-bold">{m.post_conversations_empty_title()}</p>
        <p class="text-text-muted mb-4 px-2 text-xs leading-relaxed font-medium">
          {m.post_conversations_empty_description()}
        </p>
        <a
          href={resolve('/chat')}
          class="bg-accent/10 text-accent-text hover:bg-accent/20 focus-visible:ring-accent-icon inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-bold transition-all outline-none focus-visible:ring-2 active:scale-95"
        >
          {m.chat_new_discussion_label()}
        </a>
      </div>
    {:else}
      <div class="animate-in fade-in flex flex-col px-2 duration-300">
        {#each displayItems as item (item.meta.id)}
          <ConversationTile
            conversationId={item.meta.id}
            contactName={item.contactId}
            displayName={item.displayName}
            displayNameResolved={item.displayNameResolved}
            conversationType={item.conversationType}
            lastMessage={item.lastMessageContent}
            isReady={item.isReady}
            awaitingAdmission={isNeverAdmitted(item.meta)}
            isSelected={false}
            unreadCount={item.unreadCount}
            imageMediaId={item.imageMediaId}
            lastActivityAt={item.lastActivityAt}
            onClick={() => navigateToConversation(item.meta.id)}
          />
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="bg-cn-surface shrink-0 border-t border-black/5 px-4 py-4 dark:border-white/10">
    <a
      href={resolve('/chat')}
      class="text-on-accent bg-accent shadow-accent/20 hover:bg-accent-hover hover:shadow-accent/30 focus-visible:ring-accent/50 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-bold shadow-md transition-all outline-none hover:shadow-lg focus-visible:ring-4 active:scale-[0.98]"
    >
      <MessageCircle size={18} strokeWidth={2.5} class="mt-0.5 ml-0.5" />
      {m.post_conversations_open_messaging_label()}
    </a>
  </div>
</aside>
