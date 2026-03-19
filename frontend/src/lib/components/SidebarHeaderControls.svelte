<script lang="ts">
  import { Plus, X, Search, Archive } from 'lucide-svelte';

  interface Props {
    activeSidebarTab: 'discussions' | 'channels';
    showArchivedConversations?: boolean;
    searchQuery: string;
    drawerMode?: boolean;
    onCloseDrawer?: () => void;
    onTabChange: (tab: 'discussions' | 'channels') => void;
    onSearchQueryChange: (value: string) => void;
    onToggleArchivedView?: () => void;
    onOpenNewChat: () => void;
  }

  let {
    activeSidebarTab,
    showArchivedConversations = false,
    searchQuery,
    drawerMode = false,
    onCloseDrawer,
    onTabChange,
    onSearchQueryChange,
    onToggleArchivedView,
    onOpenNewChat,
  }: Props = $props();
</script>

<div
  class="px-4 py-3 border-b border-white/50 dark:border-white/10 sticky top-0 bg-white/35 dark:bg-gray-900/45 backdrop-blur-md z-10"
>
  <div
    class="grid grid-cols-2 rounded-2xl bg-white/35 dark:bg-black/25 p-1 gap-1 w-full border border-white/40 dark:border-white/10"
  >
    <button
      type="button"
      onclick={() => onTabChange('discussions')}
      class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab ===
      'discussions'
        ? 'bg-white/70 dark:bg-black/40 text-text-main shadow-sm border border-white/50 dark:border-white/10'
        : 'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30'}"
    >
      Discussions
    </button>
    <button
      type="button"
      onclick={() => onTabChange('channels')}
      class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab ===
      'channels'
        ? 'bg-white/70 dark:bg-black/40 text-text-main shadow-sm border border-white/50 dark:border-white/10'
        : 'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30'}"
    >
      Canaux
    </button>
  </div>
</div>

<div
  class="px-4 py-3 border-b border-white/50 dark:border-white/10 bg-white/30 dark:bg-gray-900/40 backdrop-blur-sm"
>
  <div class="flex items-center gap-2">
    <div class="flex-1 relative">
      <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        type="text"
        value={searchQuery}
        oninput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
        placeholder="Rechercher..."
        class="w-full rounded-2xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
      />
    </div>

    <button
      onclick={onOpenNewChat}
      class="w-8 h-8 rounded-full bg-white/65 dark:bg-black/30 hover:bg-white/80 dark:hover:bg-black/40 border border-white/45 dark:border-white/10 text-text-main transition-colors flex items-center justify-center"
      title={activeSidebarTab === 'channels' ? 'Nouveau canal' : 'Nouvelle discussion'}
      aria-label={activeSidebarTab === 'channels' ? 'Nouveau canal' : 'Nouvelle discussion'}
    >
      <Plus size={16} />
    </button>
    {#if activeSidebarTab === 'discussions'}
      <button
        type="button"
        onclick={() => onToggleArchivedView?.()}
        class="w-8 h-8 rounded-full border text-text-main transition-colors flex items-center justify-center {showArchivedConversations
          ? 'bg-amber-100/90 dark:bg-amber-500/20 border-amber-300/70 dark:border-amber-300/30'
          : 'bg-white/65 dark:bg-black/30 border-white/45 dark:border-white/10 hover:bg-white/80 dark:hover:bg-black/40'}"
        aria-label={showArchivedConversations
          ? 'Afficher les discussions actives'
          : 'Afficher la corbeille'}
        title={showArchivedConversations ? 'Discussions actives' : 'Corbeille'}
      >
        <Archive size={15} />
      </button>
    {/if}
    {#if drawerMode}
      <button
        type="button"
        onclick={() => onCloseDrawer?.()}
        class="p-2 rounded-lg text-text-muted bg-white/65 dark:bg-black/30 border border-white/45 dark:border-white/10"
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    {/if}
  </div>
</div>
