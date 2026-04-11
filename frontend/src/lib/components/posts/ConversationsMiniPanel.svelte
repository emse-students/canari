<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { IndexedDbStorage, type ConversationMeta } from '$lib/db';
  import { getSavedUserId } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { deriveConversationIdentity } from '$lib/utils/chat/conversations';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { MessageCircle, ChevronRight, Users, Loader2 } from 'lucide-svelte';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';

  interface ConvItem {
    meta: ConversationMeta;
    contactId: string;
    displayName: string;
    isGroup: boolean;
    unreadCount?: number;
  }

  let items = $state<ConvItem[]>([]);
  let loading = $state(true);
  let resolvedNames = $state<Record<string, string>>({});

  // Filtre utilitaire pour exclure les canaux
  function isCommunityChannelId(id: string | undefined): boolean {
    return String(id ?? '').startsWith('channel_');
  }

  // ── Données en direct de la session globale ──────────────
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
            return {
              meta: { id: key, name: conv.name, updatedAt: 0 } as ConversationMeta,
              contactId,
              displayName:
                identity.conversationType === 'direct'
                  ? getUserDisplayNameSync(contactId, identity.displayName)
                  : conv.name,
              isGroup: identity.conversationType !== 'direct',
              unreadCount: conv.unreadCount ?? 0,
            };
          })
          .slice(0, 20)
      : []
  );

  const displayItems = $derived(globalSession.isLoggedIn ? liveItems : items);
  const isLoading = $derived(globalSession.isLoggedIn ? false : loading);

  onMount(async () => {
    const uid = getSavedUserId();
    if (!uid) {
      loading = false;
      return;
    }

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
          const displayName =
            identity.conversationType === 'direct'
              ? getUserDisplayNameSync(contactId, identity.displayName)
              : meta.name;
          return {
            meta,
            contactId: meta.id,
            displayName,
            isGroup: identity.conversationType !== 'direct',
          };
        });

      // Résolution asynchrone des noms d'affichage
      for (const item of items) {
        if (!item.isGroup) {
          const identity = deriveConversationIdentity(item.meta.name, uid, item.meta.id);
          const peerId = identity.directPeerId ?? identity.contactName;
          resolveUserDisplayName(peerId).then((resolved) => {
            if (resolved) {
              resolvedNames = { ...resolvedNames, [item.meta.id]: resolved };
            }
          });
        }
      }
    } catch {
      // Ignorer silencieusement les erreurs IDB
    } finally {
      loading = false;
    }
  });

  function navigateToConversation(contactId: string) {
    sessionStorage.setItem('canari_pending_contact', contactId);
    void goto('/chat');
  }

  function getEffectiveName(item: ConvItem): string {
    return resolvedNames[item.meta.id] ?? item.displayName;
  }

  function getAvatarUserId(item: ConvItem): string {
    if (item.isGroup) return item.meta.id;
    const uid = getSavedUserId() ?? '';
    const identity = deriveConversationIdentity(item.meta.name, uid, item.meta.id);
    return identity.directPeerId ?? identity.contactName;
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
        <Loader2 size={24} class="animate-spin text-amber-500" />
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
      <div class="flex flex-col gap-0.5 px-2 animate-in fade-in duration-300">
        {#each displayItems as item (item.meta.id)}
          <button
            type="button"
            class="w-full flex items-center gap-3.5 px-3 py-2.5 hover:bg-white/80 dark:hover:bg-white/5 transition-all duration-200 text-left rounded-2xl group hover:shadow-sm hover:translate-x-1 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 border border-transparent hover:border-black/5 dark:hover:border-white/5"
            onclick={() => navigateToConversation(item.meta.id)}
          >
            <!-- Avatar -->
            <div class="flex-shrink-0 relative">
              {#if item.isGroup}
                <div
                  class="w-10 h-10 rounded-xl shadow-inner border border-black/5 dark:border-white/5 bg-gradient-to-b from-gray-100 to-gray-200 dark:from-zinc-800 dark:to-zinc-900 text-gray-600 dark:text-gray-300 flex items-center justify-center transition-transform group-hover:scale-105"
                >
                  <Users size={18} strokeWidth={2} class="opacity-80" />
                </div>
              {:else}
                <div class="transition-transform duration-200 group-hover:scale-105">
                  <Avatar
                    userId={getAvatarUserId(item)}
                    size="sm"
                    fallbackLabel={getEffectiveName(item)}
                  />
                </div>
              {/if}

              <!-- Badge Non-lu -->
              {#if (item.unreadCount ?? 0) > 0}
                <span
                  class="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[0.7rem] font-bold flex items-center justify-center leading-none shadow-sm ring-2 ring-[var(--cn-surface)] dark:ring-[#151B2C] z-10 transition-transform group-hover:scale-110"
                >
                  {item.unreadCount! > 99 ? '99+' : item.unreadCount}
                </span>
              {/if}
            </div>

            <!-- Informations -->
            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <div
                class="text-[0.9rem] font-bold text-text-main truncate group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors {(item.unreadCount ??
                  0) > 0
                  ? 'text-text-main'
                  : ''}"
              >
                {getEffectiveName(item)}
              </div>
              <div class="text-[0.75rem] font-medium text-text-muted truncate mt-0.5">
                {item.isGroup ? 'Groupe de discussion' : 'Message direct'}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Footer (Bouton d'action principal) -->
  <div
    class="px-4 py-4 border-t border-black/5 dark:border-white/10 flex-shrink-0 bg-white/40 dark:bg-black/10 backdrop-blur-md"
  >
    <a
      href="/chat"
      class="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-[0.98] hover:-translate-y-0.5 active:translate-y-0 transition-all text-[#151B2C] text-[0.85rem] font-extrabold shadow-md shadow-amber-500/20 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
    >
      <MessageCircle size={18} strokeWidth={2.5} class="ml-0.5 mt-0.5" />
      Ouvrir la messagerie
    </a>
  </div>
</aside>

<style>
  /* Scrollbar discrète */
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
