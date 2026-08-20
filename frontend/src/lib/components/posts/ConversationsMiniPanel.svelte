<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { IndexedDbStorage, type ConversationMeta } from '$lib/db';
  import type { Conversation } from '$lib/types';
  import { getSavedUserId } from '$lib/stores/user';
  import {
    deriveConversationIdentity,
    resolveConversationListPresentation,
  } from '$lib/utils/chat/conversations';
  import ConversationTile from '$lib/components/chat/ConversationTile.svelte';
  import { MessageCircle, ChevronRight, LoaderCircle } from '@lucide/svelte';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import { m } from '$lib/paraglide/messages';

  interface ConvItem {
    meta: ConversationMeta;
    contactId: string;
    displayName: string;
    /** See `ConversationListPresentation.displayNameResolved` - false means it is a placeholder. */
    displayNameResolved: boolean;
    conversationType: 'direct' | 'group';
    isReady: boolean;
    unreadCount: number;
    imageMediaId: string | null;
    lastMessageContent?: string;
  }

  let idbItems = $state<ConvItem[]>([]);
  let idbLoading = $state(true);

  function buildItemFromMeta(meta: ConversationMeta, uid: string): ConvItem {
    const identity = deriveConversationIdentity(meta.name, uid, meta.id);
    const pres = resolveConversationListPresentation(
      {
        id: meta.id,
        name: meta.name,
        contactName: identity.contactName,
        conversationType: identity.conversationType,
        directPeerId: identity.directPeerId,
        metaName: meta.name,
      },
      uid
    );
    return {
      meta,
      contactId: pres.contactId,
      displayName: pres.displayName,
      displayNameResolved: pres.displayNameResolved,
      conversationType: pres.conversationType,
      isReady: meta.lifecycle === 'active',
      unreadCount: 0,
      imageMediaId: null,
    };
  }

  function buildItemFromLive(
    key: string,
    conv: Conversation,
    uid: string,
    baseline?: ConvItem
  ): ConvItem {
    const pres = resolveConversationListPresentation(
      {
        id: conv.id,
        name: conv.name,
        contactName: conv.contactName,
        conversationType: conv.conversationType,
        directPeerId: conv.directPeerId,
        metaName: baseline?.meta.name,
        fallbackDisplayName: baseline?.displayName,
      },
      uid
    );
    return {
      meta: {
        id: key,
        name: conv.name,
        lifecycle: conv.lifecycle,
        updatedAt: Math.max(baseline?.meta.updatedAt ?? 0, conv.lastMessageAt ?? 0),
      },
      contactId: pres.contactId,
      displayName: pres.displayName,
      displayNameResolved: pres.displayNameResolved,
      conversationType: pres.conversationType,
      isReady: conv.lifecycle === 'active',
      unreadCount: conv.unreadCount ?? baseline?.unreadCount ?? 0,
      imageMediaId: conv.imageMediaId ?? baseline?.imageMediaId ?? null,
      lastMessageContent:
        conv.messages?.length > 0
          ? conv.messages[conv.messages.length - 1].content
          : baseline?.lastMessageContent,
    };
  }

  /**
   * Merge the IndexedDB baseline with the live globalConvs map.
   *
   * The baseline only seeds the list before the live map is authoritative (avoids a flash on
   * a cold /posts load). Once conversations have been restored, the live map is the sole
   * source of membership, so deletions disappear immediately instead of being resurrected
   * from the stale onMount snapshot.
   */
  const displayItems = $derived.by(() => {
    const uid = globalSession.userId ?? getSavedUserId() ?? '';
    if (!uid) return [];

    const liveAuthoritative = globalSession.isLoggedIn && globalConvs.conversationsRestored;
    const byId = new SvelteMap<string, ConvItem>();

    if (!liveAuthoritative) {
      for (const item of idbItems) {
        byId.set(item.meta.id, item);
      }
    }

    if (globalSession.isLoggedIn) {
      for (const [key, conv] of globalConvs.conversations.entries()) {
        if (isChannelConversationId(key) || isChannelConversationId(conv.id)) continue;
        const baseline = byId.get(key);
        byId.set(key, buildItemFromLive(key, conv, uid, baseline));
      }
    }

    return [...byId.values()].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt).slice(0, 20);
  });

  const isLoading = $derived(idbLoading && displayItems.length === 0);

  onMount(async () => {
    const uid = getSavedUserId();
    if (!uid) {
      idbLoading = false;
      return;
    }
    try {
      const storage = new IndexedDbStorage(uid);
      await storage.init();
      const convos = await storage.getConversations();
      idbItems = convos
        .filter((meta) => !isChannelConversationId(meta.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map((meta) => buildItemFromMeta(meta, uid));
    } catch {
      /* silent */
    } finally {
      idbLoading = false;
    }
  });

  function navigateToConversation(metaId: string) {
    sessionStorage.setItem('canari_pending_contact', metaId);
    void goto('/chat');
  }
</script>

<aside
  class="hidden h-full w-72 flex-col overflow-hidden rounded-[1.5rem] border border-black/5 bg-white/60 shadow-sm backdrop-blur-2xl transition-all duration-300 xl:flex dark:border-white/10 dark:bg-black/20"
>
  <!-- Header. -->
  <div
    class="flex flex-shrink-0 items-center justify-between border-b border-black/5 bg-white/40 px-5 py-4 dark:border-white/10 dark:bg-black/10"
  >
    <div class="flex items-center gap-2.5">
      <div class="rounded-lg bg-amber-500/10 p-1.5 text-amber-600 dark:text-amber-400">
        <MessageCircle size={16} strokeWidth={2.5} />
      </div>
      <span class="text-text-main text-[0.95rem] font-extrabold tracking-wide"
        >{m.post_conversations_panel_title()}</span
      >
    </div>
    <a
      href="/chat"
      class="flex items-center gap-0.5 rounded text-[0.7rem] font-bold tracking-wider text-amber-600 uppercase transition-colors outline-none hover:text-amber-500 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-500 dark:hover:text-amber-400"
    >
      {m.post_conversations_see_all_label()}
      <ChevronRight size={14} strokeWidth={2.5} />
    </a>
  </div>

  <!-- Conversation list. -->
  <div class="custom-scrollbar flex-1 overflow-y-auto py-2">
    {#if isLoading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-3 py-10">
        <LoaderCircle size={24} class="animate-spin text-amber-500" />
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
          href="/chat"
          class="inline-flex items-center justify-center rounded-xl bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-700 transition-all outline-none hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:text-amber-400"
        >
          {m.chat_new_discussion_label()}
        </a>
      </div>
    {:else}
      <div class="animate-in fade-in flex flex-col px-2 duration-300">
        {#each displayItems as item (item.meta.id)}
          <ConversationTile
            contactName={item.contactId}
            displayName={item.displayName}
            displayNameResolved={item.displayNameResolved}
            conversationType={item.conversationType}
            lastMessage={item.lastMessageContent}
            isReady={item.isReady}
            isSelected={false}
            unreadCount={item.unreadCount}
            imageMediaId={item.imageMediaId}
            onClick={() => navigateToConversation(item.meta.id)}
          />
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div
    class="flex-shrink-0 border-t border-black/5 bg-white/40 px-4 py-4 backdrop-blur-md dark:border-white/10 dark:bg-black/10"
  >
    <a
      href="/chat"
      class="text-cn-ink flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-[0.85rem] font-extrabold shadow-md shadow-amber-500/20 transition-all outline-none hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/30 focus-visible:ring-4 focus-visible:ring-amber-500/50 active:scale-[0.98]"
    >
      <MessageCircle size={18} strokeWidth={2.5} class="mt-0.5 ml-0.5" />
      {m.post_conversations_open_messaging_label()}
    </a>
  </div>
</aside>

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 20%, transparent);
    border-radius: 6px;
  }
  :global([data-theme='dark']) .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
  }
  .custom-scrollbar:hover::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 40%, transparent);
  }
  :global([data-theme='dark']) .custom-scrollbar:hover::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
  }
</style>
