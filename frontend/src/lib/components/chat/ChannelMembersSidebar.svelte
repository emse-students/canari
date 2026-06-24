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
    /** Callback to close the sidebar (used in mobile mode). */
    onClose?: () => void;
  }

  let { selectedChannelId, currentUserId, mode = 'desktop', onClose }: Props = $props();

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
    ? 'hidden w-64 lg:w-72 xl:flex border-l border-black/5 dark:border-white/10'
    : 'flex h-full w-full'} flex-col bg-white/70 dark:bg-[#151B2C]/90 backdrop-blur-2xl overflow-y-auto custom-scrollbar transition-all duration-300"
>
  {#if mode === 'mobile'}
    <div
      class="flex items-center justify-between border-b border-black/5 dark:border-white/10 p-4 md:p-5 bg-white/40 dark:bg-black/20 backdrop-blur-md sticky top-0 z-10 shadow-sm"
    >
      <h2 class="text-[0.95rem] font-bold text-text-main flex items-center gap-2.5">
        <div class="p-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
          <Users size={16} strokeWidth={2.5} />
        </div>
        {m.chat_channel_members_title()}
      </h2>
      <button
        type="button"
        onclick={() => onClose?.()}
        class="p-2 rounded-full bg-black/5 dark:bg-white/10 text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/20 active:scale-95 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label={m.common_close_label()}
      >
        <X size={18} strokeWidth={2.5} />
      </button>
    </div>
  {/if}

  <div class="p-4 md:p-5 space-y-8">
    <!-- Admins & Moderators section. -->
    {#if admins.length > 0}
      <div class="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <h3
          class="text-[0.7rem] font-extrabold uppercase tracking-widest text-text-muted mb-3 px-2 flex items-center gap-2"
        >
          <ShieldAlert size={14} class="text-amber-500" strokeWidth={2.5} />
          {m.chat_admins_count_label({ admins: admins.length })}
        </h3>
        <div class="space-y-1.5">
          {#each admins as member (member.id)}
            <div
              class="flex items-center gap-3 px-3 py-2.5 rounded-2xl hover:bg-white/80 dark:hover:bg-white/5 transition-all duration-200 cursor-pointer group hover:shadow-sm hover:translate-x-1 border border-transparent hover:border-black/5 dark:hover:border-white/5"
            >
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                {#if member.status === 'online'}
                  <span
                    class="absolute bottom-0 right-0 block h-3 w-3 rounded-full ring-2 ring-white dark:ring-[#151B2C] shadow-sm bg-emerald-500"
                  ></span>
                {/if}
              </div>
              <UserName
                userId={member.userId}
                class="text-[0.9rem] font-bold text-text-main truncate group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Regular members section. -->
    {#if regulars.length > 0}
      <div
        class="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75"
        style="animation-fill-mode: backwards;"
      >
        <h3
          class="text-[0.7rem] font-extrabold uppercase tracking-widest text-text-muted mb-3 px-2 flex items-center gap-2"
        >
          <User size={14} class="text-text-muted/70" strokeWidth={2.5} />
          {m.chat_members_count_label({ regulars: regulars.length })}
        </h3>
        <div class="space-y-1.5">
          {#each regulars as member (member.id)}
            <div
              class="flex items-center gap-3 px-3 py-2.5 rounded-2xl hover:bg-white/80 dark:hover:bg-white/5 transition-all duration-200 cursor-pointer group opacity-90 hover:opacity-100 hover:shadow-sm hover:translate-x-1 border border-transparent hover:border-black/5 dark:hover:border-white/5"
            >
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                {#if member.status === 'online'}
                  <span
                    class="absolute bottom-0 right-0 block h-3 w-3 rounded-full ring-2 ring-white dark:ring-[#151B2C] shadow-sm bg-emerald-500"
                  ></span>
                {/if}
              </div>
              <UserName
                userId={member.userId}
                class="text-[0.9rem] font-medium text-text-main truncate group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors"
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
