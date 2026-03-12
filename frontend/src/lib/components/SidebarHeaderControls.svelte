<script lang="ts">
  import { Plus, X, Search } from 'lucide-svelte';

  interface Props {
    activeSidebarTab: 'discussions' | 'channels';
    searchQuery: string;
    drawerMode?: boolean;
    onCloseDrawer?: () => void;
    onTabChange: (tab: 'discussions' | 'channels') => void;
    onSearchQueryChange: (value: string) => void;
    onOpenNewChat: () => void;
  }

  let {
    activeSidebarTab,
    searchQuery,
    drawerMode = false,
    onCloseDrawer,
    onTabChange,
    onSearchQueryChange,
    onOpenNewChat,
  }: Props = $props();
</script>

<div
  class="px-4 py-3 border-b border-cn-bg sticky top-0 bg-[var(--surface-elevated)]/90 backdrop-blur-md z-10"
>
  <div class="grid grid-cols-2 rounded-2xl bg-cn-bg p-1 gap-1 w-full">
    <button
      type="button"
      onclick={() => onTabChange('discussions')}
      class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab ===
      'discussions'
        ? 'bg-[var(--surface-elevated)] text-text-main shadow-sm border border-cn-border'
        : 'text-text-muted hover:text-text-main hover:bg-[color-mix(in_srgb,var(--surface-elevated)_70%,transparent)]'}"
    >
      Discussions
    </button>
    <button
      type="button"
      onclick={() => onTabChange('channels')}
      class="px-3 py-2 rounded-xl text-sm font-semibold transition-colors {activeSidebarTab ===
      'channels'
        ? 'bg-[var(--surface-elevated)] text-text-main shadow-sm border border-cn-border'
        : 'text-text-muted hover:text-text-main hover:bg-[color-mix(in_srgb,var(--surface-elevated)_70%,transparent)]'}"
    >
      Canaux
    </button>
  </div>
</div>

<div class="px-4 py-3 border-b border-cn-border bg-[var(--surface-elevated)]/80 backdrop-blur-sm">
  <div class="flex items-center gap-2">
    <div class="flex-1 relative">
      <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        type="text"
        value={searchQuery}
        oninput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
        placeholder="Rechercher..."
        class="w-full rounded-2xl bg-cn-bg pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-cn-yellow/40"
      />
    </div>

    <button
      onclick={onOpenNewChat}
      class="w-8 h-8 rounded-full bg-cn-bg hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-text-main transition-colors flex items-center justify-center"
      title={activeSidebarTab === 'channels' ? 'Nouveau groupe' : 'Nouvelle discussion'}
      aria-label={activeSidebarTab === 'channels' ? 'Nouveau groupe' : 'Nouvelle discussion'}
    >
      <Plus size={16} />
    </button>
    {#if drawerMode}
      <button
        type="button"
        onclick={() => onCloseDrawer?.()}
        class="p-2 rounded-lg text-text-muted bg-cn-bg"
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    {/if}
  </div>
</div>
