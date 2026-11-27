<script lang="ts">
  import { Plus, X, Search, Shield } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import { m } from '$lib/paraglide/messages';
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';

  interface Props {
    /** Which sidebar tab is currently active. */
    activeSidebarTab: 'discussions' | 'channels';
    /** Whether the sidebar is rendered inside a slide-over drawer. */
    drawerMode?: boolean;
    /** Callback to close the drawer when in drawer mode. */
    onCloseDrawer?: () => void;
    /** Callback to open the new chat / new channel modal. */
    onOpenNewChat: () => void;
    /** Callback to open the community admin modal (channels tab only). */
    onOpenCommunityAdmin?: () => void;
  }

  let {
    activeSidebarTab,
    drawerMode = false,
    onCloseDrawer,
    onOpenNewChat,
    onOpenCommunityAdmin,
  }: Props = $props();
</script>

<div class="bg-cn-surface px-4 py-3">
  <div class="flex items-center gap-2">
    <!-- NO FILTER FIELD HERE ANY MORE (owner, 2026-11-26: ONE search for the whole app, its bar on
         the home page). Its Discussions section finds a conversation by its name AND by the words of
         its messages, on this device; the magnifier leads there, as the phone's header does. -->
    <h2 class="text-text-main min-w-0 flex-1 truncate text-base font-bold">
      {activeSidebarTab === 'channels' ? m.search_section_communities() : m.nav_chat_label()}
    </h2>
    <a
      href={resolve('/posts?search=1')}
      class="ui-icon-button text-text-main bg-cn-surface rounded-full border border-white/45 transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-black/40"
      title={m.search_label()}
      aria-label={m.search_label()}
      data-sidebar-search-link
    >
      <Search size={16} />
    </a>

    <button
      use:guideAnchor={'chat.new'}
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
        title={m.chat_manage_community_roles_label()}
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
