<script lang="ts">
  import { ShieldAlert, Tag, User } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import ProfileLink from '$lib/components/shared/ProfileLink.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import { presenceMap, watchUsers, unwatchUsers } from '$lib/stores/presenceStore';
  import { channelService, type ChannelMemberDto } from '$lib/services/ChannelService';
  import { m } from '$lib/paraglide/messages';
  import { membersByFamilyName } from '$lib/utils/users/memberOrder.svelte';
  import { communityNicknameScope } from '$lib/utils/users/conversationNicknames.svelte';
  import NicknamesPanel from './NicknamesPanel.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    /** ID of the channel whose members are displayed. */
    selectedChannelId: string;
    /** ID of the currently authenticated user, used to highlight the current user. */
    currentUserId?: string;
    /** The salon's community (database id): its nicknames are the names shown, and edited here. */
    workspaceId?: string | null;
    /** The server's `viewerCanModerate` for that community - who may name a member. */
    canModerate?: boolean;
  }

  let {
    selectedChannelId,
    currentUserId,
    workspaceId = null,
    canModerate = false,
  }: Props = $props();

  const nicknameScope = $derived(workspaceId ? communityNicknameScope(workspaceId) : null);

  // ── "Modifier les pseudos" ───────────────────────────────────────────────────
  // A community's nicknames are the COMMUNITY's, so the screen lists its members, not this salon's.
  let showNicknames = $state(false);
  let communityMembers = $state<string[]>([]);

  async function openNicknames() {
    if (!workspaceId) return;
    try {
      communityMembers = (await channelService.listWorkspaceMembers(workspaceId)).map(
        (mem) => mem.userId
      );
    } catch (e) {
      // The salon's own members are a subset of the community's: shown rather than nothing, and said.
      console.warn(
        `[NICKNAME] members of community ${workspaceId.slice(0, 8)} unreadable - the salon's are listed: ${String(e)}`
      );
      communityMembers = channelMembers.map((mem) => mem.userId);
    }
    showNicknames = true;
  }

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

  // Read by family name in each section (user, 2026-10-05). A member is listed once their profile
  // has settled and never moves after that, so names landing late cannot reshuffle the list.
  const memberOrder = membersByFamilyName(() => channelMembers.map((m) => m.userId));

  const members = $derived.by(() => {
    const byId = new Map(channelMembers.map((m) => [m.userId, m]));
    return memberOrder.current.flatMap((id) => {
      const mem = byId.get(id);
      return mem ? [{ ...mem, status: $presenceMap[mem.userId] ? 'online' : 'offline' }] : [];
    });
  });

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
<div class="space-y-8 px-(--side-panel-inset) py-4 @md:py-5">
  {#if workspaceId && currentUserId}
    <Button
      variant="secondary"
      class="w-full justify-start"
      data-open-nicknames
      onclick={() => void openNicknames()}
    >
      <Tag size={16} />
      {m.chat_nicknames_open_button()}
    </Button>
  {/if}

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
              <ProfileLink userId={member.userId}
                ><Avatar userId={member.userId} size="sm" /></ProfileLink
              >
              {#if member.status === 'online'}
                <span
                  class="dark:ring-cn-ink absolute right-0 bottom-0 block h-3 w-3 rounded-full bg-emerald-500 shadow-sm ring-2 ring-white"
                ></span>
              {/if}
            </div>
            <UserName
              userId={member.userId}
              scope={nicknameScope}
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
              <ProfileLink userId={member.userId}
                ><Avatar userId={member.userId} size="sm" /></ProfileLink
              >
              {#if member.status === 'online'}
                <span
                  class="dark:ring-cn-ink absolute right-0 bottom-0 block h-3 w-3 rounded-full bg-emerald-500 shadow-sm ring-2 ring-white"
                ></span>
              {/if}
            </div>
            <UserName
              userId={member.userId}
              scope={nicknameScope}
              class="text-text-main truncate text-sm font-medium transition-colors group-hover:text-amber-600 dark:group-hover:text-amber-400"
            />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

{#if workspaceId && currentUserId}
  <NicknamesPanel
    open={showNicknames}
    members={communityMembers}
    viewerId={currentUserId}
    place={{ kind: 'community', workspaceId, canModerate }}
    onClose={() => (showNicknames = false)}
  />
{/if}
