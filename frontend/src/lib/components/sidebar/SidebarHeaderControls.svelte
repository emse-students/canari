<script lang="ts">
  import { Plus, X, Search, Shield } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

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
  class="border-b border-white/50 bg-white/30 px-4 py-3 backdrop-blur-sm dark:border-white/10 dark:bg-gray-900/40"
>
  <div class="flex items-center gap-2">
    <div class="relative flex-1">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        type="text"
        value={searchQuery}
        oninput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
        placeholder={m.chat_search_placeholder()}
        class="w-full rounded-2xl border border-white/50 bg-white/60 py-2.5 pr-4 pl-10 text-sm outline-none focus:ring-2 focus:ring-amber-400/45 dark:border-white/10 dark:bg-black/30"
      />
    </div>

    <button
      onclick={onOpenNewChat}
      class="text-text-main flex h-8 w-8 items-center justify-center rounded-full border border-white/45 bg-white/65 transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-black/30 dark:hover:bg-black/40"
      title={activeSidebarTab === 'channels'
        ? m.chat_new_channel_title()
        : m.chat_new_discussion_title()}
      aria-label={activeSidebarTab === 'channels'
        ? m.chat_new_channel_label()
        : m.chat_new_discussion_label()}
    >
      <Plus size={16} />
    </button>
    {#if activeSidebarTab === 'channels'}
      <button
        type="button"
        onclick={() => onOpenCommunityAdmin?.()}
        class="text-text-main flex h-8 w-8 items-center justify-center rounded-full border border-white/45 bg-white/65 transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-black/30 dark:hover:bg-black/40"
        aria-label={m.chat_manage_community_roles_label()}
        title={m.chat_manage_community_roles_title()}
      >
        <Shield size={15} />
      </button>
    {/if}

    {#if drawerMode}
      <button
        type="button"
        onclick={() => onCloseDrawer?.()}
        class="text-text-muted rounded-lg border border-white/45 bg-white/65 p-2 dark:border-white/10 dark:bg-black/30"
        aria-label={m.common_close_label()}
      >
        <X size={16} />
      </button>
    {/if}
  </div>
</div>
