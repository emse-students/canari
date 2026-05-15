<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { IndexedDbStorage, type ConversationMeta } from '$lib/db';
  import { getSavedUserId } from '$lib/stores/user';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { deriveConversationIdentity } from '$lib/utils/chat/conversations';
  import ConversationTile from '$lib/components/chat/ConversationTile.svelte';
  import { MessageCircle, ChevronRight, LoaderCircle } from 'lucide-svelte';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';

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

  let items = $state<ConvItem[]>([]);
  let loading = $state(true);

  function isCommunityChannelId(id: string | undefined): boolean {
    return String(id ?? '').startsWith('channel_');
  }

  const liveItems = $derived(
    globalSession.isLoggedIn
      ? [...globalConvs.conversations.entries()]
          .filter(([key, conv]) => !isCommunityChannelId(key) && !isCommunityChannelId(conv.id))
          .map(([key, conv]) => {
            const uid = globalSession.userId ?? getSavedUserId() ?? '';
            const identity = deriveConversationIdentity(key, uid, conv.id);
            const contactId =
              identity.conversationType === 'direct'
                ? (identity.directPeerId ?? identity.contactName)
                : conv.id;
            const msgs = conv.messages;
            return {
              meta: { id: key, name: conv.name, isReady: conv.isReady, updatedAt: 0 } as ConversationMeta,
              contactId,
              displayName:
                identity.conversationType === 'direct'
                  ? getUserDisplayNameSync(contactId, identity.displayName)
                  : conv.name,
              conversationType: identity.conversationType,
              isReady: conv.isReady,
              unreadCount: conv.unreadCount ?? 0,
              imageMediaId: conv.imageMediaId ?? null,
              lastMessageContent: msgs.length > 0 ? msgs[msgs.length - 1].content : undefined,
            } satisfies ConvItem;
          })
          .slice(0, 20)
      : []
  );

  const displayItems = $derived(globalSession.isLoggedIn ? liveItems : items);
  const isLoading = $derived(globalSession.isLoggedIn ? false : loading);

  onMount(async () => {
    const uid = getSavedUserId();
    if (!uid) { loading = false; return; }
    try {
      const storage = new IndexedDbStorage(uid);
      await storage.init();
      const convos = await storage.getConversations();
      items = convos
        .filter((meta) => !isCommunityChannelId(meta.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map((meta) => {
          const identity = deriveConversationIdentity(meta.name, uid, meta.id);
          const contactId =
            identity.conversationType === 'direct'
              ? (identity.directPeerId ?? identity.contactName)
              : meta.id;
          return {
            meta,
            contactId,
            displayName:
              identity.conversationType === 'direct'
                ? getUserDisplayNameSync(contactId, identity.displayName)
                : meta.name,
            conversationType: identity.conversationType,
            isReady: meta.isReady,
            unreadCount: 0,
            imageMediaId: null,
          } satisfies ConvItem;
        });
    } catch { /* silent */ } finally {
      loading = false;
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
      <span class="text-[0.95rem] font-extrabold text-text-main tracking-wide">Discussions</span>
    </div>
    <a
      href="/chat"
      class="text-[0.7rem] font-bold text-amber-600 dark:text-amber-500 hover:text-amber-500 dark:hover:text-amber-400 transition-colors flex items-center gap-0.5 uppercase tracking-wider outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
    >
      Tout voir
      <ChevronRight size={14} strokeWidth={2.5} />
    </a>
  </div>

  <!-- Liste des conversations -->
  <div class="flex-1 overflow-y-auto py-2 custom-scrollbar">
    {#if isLoading}
      <div class="flex flex-col justify-center items-center py-10 gap-3 text-text-muted">
        <LoaderCircle size={24} class="animate-spin text-amber-500" />
        <span class="text-xs font-semibold">Chargement...</span>
      </div>
    {:else if displayItems.length === 0}
      <div class="text-center py-10 px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div
          class="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mx-auto mb-3 text-text-muted opacity-60 shadow-inner"
        >
          <MessageCircle size={24} strokeWidth={2} />
        </div>
        <p class="text-sm font-bold text-text-main mb-1">Aucune discussion privée</p>
        <p class="text-xs font-medium text-text-muted px-2 mb-4 leading-relaxed">
          Démarrez un message direct ou un groupe privé avec vos contacts.
        </p>
        <a
          href="/chat"
          class="inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-500/20 active:scale-95 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Nouvelle discussion
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
      Ouvrir la messagerie
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
