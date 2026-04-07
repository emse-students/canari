<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { IndexedDbStorage, type ConversationMeta } from '$lib/db';
  import { getSavedUserId } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { deriveConversationIdentity } from '$lib/utils/chat/conversations';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { MessageCircle, ChevronRight } from 'lucide-svelte';
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

  // ── Live data from global session (reactive when logged in) ──────────────
  const liveItems = $derived(
    globalSession.isLoggedIn
      ? [...globalConvs.conversations.entries()]
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

      // Async resolve display names for direct conversations
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
      // silently ignore IDB errors
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
  class="hidden xl:flex flex-col w-72 h-full border-l border-cn-border/50 bg-[color-mix(in_srgb,var(--cn-surface)_60%,transparent)] backdrop-blur-sm overflow-hidden rounded-2xl"
>
  <!-- Header -->
  <div
    class="flex items-center justify-between px-4 py-3 border-b border-cn-border/50 flex-shrink-0"
  >
    <div class="flex items-center gap-2">
      <MessageCircle size={16} class="text-text-muted" />
      <span class="text-sm font-bold text-text-main">Discussions</span>
    </div>
    <a
      href="/chat"
      class="text-xs font-semibold text-cn-dark hover:text-cn-yellow transition-colors flex items-center gap-0.5"
    >
      Tout voir
      <ChevronRight size={13} />
    </a>
  </div>

  <!-- Conversation list -->
  <div class="flex-1 overflow-y-auto py-2">
    {#if isLoading}
      <div class="flex justify-center items-center py-8">
        <div
          class="w-5 h-5 border-2 border-cn-yellow border-t-transparent rounded-full animate-spin"
        ></div>
      </div>
    {:else if displayItems.length === 0}
      <div class="text-center py-8 px-4">
        <MessageCircle size={32} class="mx-auto mb-2 text-text-muted opacity-30" />
        <p class="text-xs text-text-muted">Aucune discussion</p>
        <a
          href="/chat"
          class="mt-2 inline-block text-xs font-semibold text-cn-dark hover:text-cn-yellow transition-colors"
        >
          Commencer
        </a>
      </div>
    {:else}
      {#each displayItems as item (item.meta.id)}
        <button
          type="button"
          class="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/30 dark:hover:bg-black/20 transition-colors text-left rounded-xl mx-1 my-0.5"
          style="width: calc(100% - 8px);"
          onclick={() => navigateToConversation(item.meta.id)}
        >
          <div class="flex-shrink-0 relative">
            <Avatar userId={getAvatarUserId(item)} size="sm" />
            {#if (item.unreadCount ?? 0) > 0}
              <span
                class="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 rounded-full bg-cn-yellow text-cn-dark text-[0.6rem] font-bold flex items-center justify-center px-0.5 leading-none"
              >
                {item.unreadCount! > 9 ? '9+' : item.unreadCount}
              </span>
            {/if}
          </div>
          <div class="flex-1 min-w-0">
            <div
              class="text-sm font-semibold text-text-main truncate {(item.unreadCount ?? 0) > 0
                ? 'text-text-main'
                : ''}"
            >
              {getEffectiveName(item)}
            </div>
            {#if item.isGroup}
              <div class="text-xs text-text-muted truncate">Groupe</div>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </div>

  <!-- Footer -->
  <div class="px-3 py-2 border-t border-cn-border/50 flex-shrink-0">
    <a
      href="/chat"
      class="flex items-center justify-center gap-2 w-full py-2 rounded-xl bg-cn-dark/5 hover:bg-cn-dark/10 transition-colors text-sm font-semibold text-text-main"
    >
      <MessageCircle size={15} />
      Ouvrir la messagerie
    </a>
  </div>
</aside>
