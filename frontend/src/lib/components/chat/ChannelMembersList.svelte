<script lang="ts">
  import { ShieldAlert, User } from '@lucide/svelte';
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
  }

  let { selectedChannelId, currentUserId }: Props = $props();

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

<!--
  CONTENT ONLY. This used to carry its own chrome twice over - a `mode` prop choosing between an
  inline `xl:flex` column and a full-screen sheet, its own header with its own close button, its own
  width and border - and `MainChatPage` mounted it twice to get both. `ConversationSidePanel` owns
  the shell now, so this file answers one question: who is in this channel.
-->
<div class="space-y-8 p-4 md:p-5">
  <!-- Admins & Moderators section. -->
  {#if admins.length > 0}
    <div class="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <h3
        class="text-text-muted text-2xs mb-3 flex items-center gap-2 px-2 font-bold tracking-widest uppercase"
      >
        <ShieldAlert size={14} class="text-amber-500" strokeWidth={2.5} />
        {m.chat_admins_count_label({ admins: admins.length })}
      </h3>
      <div class="space-y-1.5">
        {#each admins as member (member.id)}
          <div
            class="group hover:bg-cn-surface flex cursor-pointer items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 transition-all duration-200 hover:translate-x-1 hover:border-black/5 hover:shadow-sm dark:hover:border-white/5 dark:hover:bg-white/5"
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
              class="text-text-main truncate text-sm font-bold transition-colors group-hover:text-amber-600 dark:group-hover:text-amber-400"
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
        class="text-text-muted text-2xs mb-3 flex items-center gap-2 px-2 font-bold tracking-widest uppercase"
      >
        <User size={14} class="text-text-muted/70" strokeWidth={2.5} />
        {m.chat_members_count_label({ regulars: regulars.length })}
      </h3>
      <div class="space-y-1.5">
        {#each regulars as member (member.id)}
          <div
            class="group hover:bg-cn-surface flex cursor-pointer items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 opacity-90 transition-all duration-200 hover:translate-x-1 hover:border-black/5 hover:opacity-100 hover:shadow-sm dark:hover:border-white/5 dark:hover:bg-white/5"
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
              class="text-text-main truncate text-sm font-medium transition-colors group-hover:text-amber-600 dark:group-hover:text-amber-400"
            />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
