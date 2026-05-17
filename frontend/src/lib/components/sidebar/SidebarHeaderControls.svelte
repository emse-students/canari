<script lang="ts">
  import { Plus, X, Search, Shield } from '@lucide/svelte';

  interface Props {
    /** Which sidebar tab is currently active. */
    activeSidebarTab: 'discussions' | 'channels';
    /** Current search filter string. */
    searchQuery: string;
    /** Whether the sidebar is rendered inside a slide-over drawer. */
    drawerMode?: boolean;
    /** Callback to close the drawer when in drawer mode. */
    onCloseDrawer?: () => void;
    /** Callback fired when the search input changes. */
    onSearchQueryChange: (value: string) => void;
    /** Callback to open the new chat / new channel modal. */
    onOpenNewChat: () => void;
    /** Callback to open the community admin modal (channels tab only). */
    onOpenCommunityAdmin?: () => void;
  }

  let {
    activeSidebarTab,
    searchQuery,
    drawerMode = false,
    onCloseDrawer,
    onSearchQueryChange,
    onOpenNewChat,
    onOpenCommunityAdmin,
  }: Props = $props();
</script>

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
    {#if activeSidebarTab === 'channels'}
      <button
        type="button"
        onclick={() => onOpenCommunityAdmin?.()}
        class="w-8 h-8 rounded-full border border-white/45 dark:border-white/10 bg-white/65 dark:bg-black/30 hover:bg-white/80 dark:hover:bg-black/40 text-text-main transition-colors flex items-center justify-center"
        aria-label="Gerer les communautes et roles"
        title="Gerer les communautes et roles"
      >
        <Shield size={15} />
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
