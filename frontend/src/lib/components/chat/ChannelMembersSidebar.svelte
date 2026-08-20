<script lang="ts">
  import { Users, X, ShieldAlert, User } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import { presenceMap, watchUsers, unwatchUsers } from '$lib/stores/presenceStore';
  import { channelService, type ChannelMemberDto } from '$lib/services/ChannelService';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** ID of the channel whose members are displayed. */
    selectedChannelId: string;
    /** ID of the currently authenticated user, used to highlight the current user. */
    currentUserId?: string;
    /** Layout mode: desktop shows the sidebar inline, mobile shows it full-screen. */
    mode?: 'desktop' | 'mobile';
    /** Whether the panel is visible (desktop mode only - the panel is collapsible at xl+). */
    isOpen?: boolean;
    /** Callback to close the sidebar (used in mobile mode). */
    onClose?: () => void;
  }

  let {
    selectedChannelId,
    currentUserId,
    mode = 'desktop',
    isOpen = true,
    onClose,
  }: Props = $props();

  let fetchedMembers: ChannelMemberDto[] = $state([]);

  async function loadMembers(channelId: string) {
    try {
      fetchedMembers = await channelService.listMembers(channelId);
    } catch {
      // Fall back to showing only the current user if the API call fails.
      fetchedMembers = currentUserId
        ? [{ id: currentUserId, userId: currentUserId, role: 'admin', joinedAt: '' }]
        : [];
    }
  }

  $effect(() => {
    if (selectedChannelId) {
      loadMembers(selectedChannelId);
    }
  });

  // Explicitly map to "userId" (not "name"): raw IDs (e.g. "usr_8fa9") must never reach the UI.
  let channelMembers = $derived(
    fetchedMembers.map((m) => ({ id: m.id, userId: m.userId, role: m.role }))
  );

  const members = $derived(
    channelMembers.map((m) => ({
      ...m,
      status: $presenceMap[m.userId] ? 'online' : 'offline',
    }))
  );

  $effect(() => {
    if (channelMembers.length > 0) {
      const ids = channelMembers.map((m) => m.userId);
      watchUsers(ids);
      return () => unwatchUsers(ids);
    }
  });

  const admins = $derived(members.filter((m) => m.role === 'admin' || m.role === 'moderator'));
  const regulars = $derived(members.filter((m) => m.role === 'member'));
</script>

<div
  class="{mode === 'desktop'
    ? isOpen
      ? 'hidden w-64 border-l border-black/5 lg:w-72 xl:flex dark:border-white/10'
      : 'hidden'
    : 'flex h-full w-full'} dark:bg-cn-ink/90 custom-scrollbar flex-col overflow-y-auto bg-white/70 backdrop-blur-2xl transition-all duration-300"
>
  {#if mode === 'mobile'}
    <div
      class="sticky top-0 z-10 flex items-center justify-between border-b border-black/5 bg-white/40 p-4 shadow-sm backdrop-blur-md md:p-5 dark:border-white/10 dark:bg-black/20"
    >
      <h2 class="text-text-main flex items-center gap-2.5 text-[0.95rem] font-bold">
        <div class="rounded-lg bg-amber-500/10 p-1.5 text-amber-600 dark:text-amber-400">
          <Users size={16} strokeWidth={2.5} />
        </div>
        {m.chat_channel_members_title()}
      </h2>
      <button
        type="button"
        onclick={() => onClose?.()}
        class="text-text-muted hover:text-text-main rounded-full bg-black/5 p-2 transition-all outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 dark:bg-white/10 dark:hover:bg-white/20"
        aria-label={m.common_close_label()}
      >
        <X size={18} strokeWidth={2.5} />
      </button>
    </div>
  {/if}

  <div class="space-y-8 p-4 md:p-5">
    <!-- Admins & Moderators section. -->
    {#if admins.length > 0}
      <div class="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <h3
          class="text-text-muted mb-3 flex items-center gap-2 px-2 text-[0.7rem] font-extrabold tracking-widest uppercase"
        >
          <ShieldAlert size={14} class="text-amber-500" strokeWidth={2.5} />
          {m.chat_admins_count_label({ admins: admins.length })}
        </h3>
        <div class="space-y-1.5">
          {#each admins as member (member.id)}
            <div
              class="group flex cursor-pointer items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 transition-all duration-200 hover:translate-x-1 hover:border-black/5 hover:bg-white/80 hover:shadow-sm dark:hover:border-white/5 dark:hover:bg-white/5"
            >
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                {#if member.status === 'online'}
                  <span
                    class="dark:ring-cn-ink absolute right-0 bottom-0 block h-3 w-3 rounded-full bg-emerald-500 shadow-sm ring-2 ring-white"
                  ></span>
                {/if}
              </div>
              <UserName
                userId={member.userId}
                class="text-text-main truncate text-[0.9rem] font-bold transition-colors group-hover:text-amber-600 dark:group-hover:text-amber-400"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Regular members section. -->
    {#if regulars.length > 0}
      <div
        class="animate-in fade-in slide-in-from-bottom-2 delay-75 duration-300"
        style="animation-fill-mode: backwards;"
      >
        <h3
          class="text-text-muted mb-3 flex items-center gap-2 px-2 text-[0.7rem] font-extrabold tracking-widest uppercase"
        >
          <User size={14} class="text-text-muted/70" strokeWidth={2.5} />
          {m.chat_members_count_label({ regulars: regulars.length })}
        </h3>
        <div class="space-y-1.5">
          {#each regulars as member (member.id)}
            <div
              class="group flex cursor-pointer items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 opacity-90 transition-all duration-200 hover:translate-x-1 hover:border-black/5 hover:bg-white/80 hover:opacity-100 hover:shadow-sm dark:hover:border-white/5 dark:hover:bg-white/5"
            >
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                {#if member.status === 'online'}
                  <span
                    class="dark:ring-cn-ink absolute right-0 bottom-0 block h-3 w-3 rounded-full bg-emerald-500 shadow-sm ring-2 ring-white"
                  ></span>
                {/if}
              </div>
              <UserName
                userId={member.userId}
                class="text-text-main truncate text-[0.9rem] font-medium transition-colors group-hover:text-amber-600 dark:group-hover:text-amber-400"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Premium scrollbar integration. */
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
