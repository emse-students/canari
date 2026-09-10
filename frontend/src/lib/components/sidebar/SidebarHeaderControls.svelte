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
  class="border-b border-white/50 bg-white/30 px-4 py-3 dark:border-white/10 dark:bg-gray-900/40"
>
  <div class="flex items-center gap-2">
    <div class="relative flex-1">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        type="text"
        value={searchQuery}
        oninput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
        placeholder={m.chat_search_placeholder()}
        class="bg-cn-surface w-full rounded-2xl border border-white/50 py-2.5 pr-4 pl-10 text-sm outline-none focus:ring-2 focus:ring-amber-400/45 dark:border-white/10"
      />
    </div>

    <button
      onclick={onOpenNewChat}
      class="ui-icon-button text-text-main bg-cn-surface rounded-full border border-white/45 transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-black/40"
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
        class="ui-icon-button text-text-main bg-cn-surface rounded-full border border-white/45 transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-black/40"
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
        class="ui-icon-button text-text-muted bg-cn-surface rounded-lg border border-white/45 dark:border-white/10"
        aria-label={m.common_close_label()}
      >
        <X size={16} />
      </button>
    {/if}
  </div>
</div>
