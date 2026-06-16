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
      conversationType: pres.conversationType,
      isReady: meta.isReady,
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
        isReady: conv.isReady,
        updatedAt: Math.max(baseline?.meta.updatedAt ?? 0, conv.lastMessageAt ?? 0),
      },
      contactId: pres.contactId,
      displayName: pres.displayName,
      conversationType: pres.conversationType,
      isReady: conv.isReady,
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
  class="hidden xl:flex flex-col w-72 h-full border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 backdrop-blur-2xl overflow-hidden rounded-[1.5rem] shadow-sm transition-all duration-300"
>
  <!-- En-tête -->
  <div
    class="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10 flex-shrink-0 bg-white/40 dark:bg-black/10"
  >
    <div class="flex items-center gap-2.5">
      <div class="p-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
        <MessageCircle size={16} strokeWidth={2.5} />
      </div>
      <span class="text-[0.95rem] font-extrabold text-text-main tracking-wide">{m.post_conversations_panel_title()}</span>
    </div>
    <a
      href="/chat"
      class="text-[0.7rem] font-bold text-amber-600 dark:text-amber-500 hover:text-amber-500 dark:hover:text-amber-400 transition-colors flex items-center gap-0.5 uppercase tracking-wider outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
    >
      {m.post_conversations_see_all_label()}
      <ChevronRight size={14} strokeWidth={2.5} />
    </a>
  </div>

  <!-- Liste des conversations -->
  <div class="flex-1 overflow-y-auto py-2 custom-scrollbar">
    {#if isLoading}
      <div class="flex flex-col justify-center items-center py-10 gap-3 text-text-muted">
        <LoaderCircle size={24} class="animate-spin text-amber-500" />
        <span class="text-xs font-semibold">{m.common_loading_label()}</span>
      </div>
    {:else if displayItems.length === 0}
      <div class="text-center py-10 px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div
          class="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mx-auto mb-3 text-text-muted opacity-60 shadow-inner"
        >
          <MessageCircle size={24} strokeWidth={2} />
        </div>
        <p class="text-sm font-bold text-text-main mb-1">{m.post_conversations_empty_title()}</p>
        <p class="text-xs font-medium text-text-muted px-2 mb-4 leading-relaxed">
          {m.post_conversations_empty_description()}
        </p>
        <a
          href="/chat"
          class="inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-500/20 active:scale-95 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {m.chat_new_discussion_label()}
        </a>
      </div>
    {:else}
      <div class="flex flex-col px-2 animate-in fade-in duration-300">
        {#each displayItems as item (item.meta.id)}
          <ConversationTile
            contactName={item.contactId}
            displayName={item.displayName}
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
    class="px-4 py-4 border-t border-black/5 dark:border-white/10 flex-shrink-0 bg-white/40 dark:bg-black/10 backdrop-blur-md"
  >
    <a
      href="/chat"
      class="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-[0.98] transition-all text-[#151B2C] text-[0.85rem] font-extrabold shadow-md shadow-amber-500/20 hover:shadow-lg hover:shadow-amber-500/30 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
    >
      <MessageCircle size={18} strokeWidth={2.5} class="ml-0.5 mt-0.5" />
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
