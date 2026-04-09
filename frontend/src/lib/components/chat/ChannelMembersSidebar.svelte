<script lang="ts">
  import { Users, X } from 'lucide-svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import { presenceMap, watchUsers } from '$lib/stores/presenceStore';
  import { channelService, type ChannelMemberDto } from '$lib/services/ChannelService';

  interface Props {
    selectedChannelId: string;
    currentUserId?: string;
    mode?: 'desktop' | 'mobile';
    onClose?: () => void;
  }

  let { selectedChannelId, currentUserId, mode = 'desktop', onClose }: Props = $props();

  let fetchedMembers: ChannelMemberDto[] = $state([]);

  async function loadMembers(channelId: string) {
    try {
      fetchedMembers = await channelService.listMembers(channelId);
    } catch {
      // Fallback au cas où l'appel échoue
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

  // CRUCIAL : On nomme explicitement la propriété "userId" et non "name".
  // L'identifiant brut (ex: "usr_8fa9") ne doit jamais être affiché à l'écran.
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
      watchUsers(channelMembers.map((m) => m.userId));
    }
  });

  const admins = $derived(members.filter((m) => m.role === 'admin' || m.role === 'moderator'));
  const regulars = $derived(members.filter((m) => m.role === 'member'));
</script>

<div
  class="{mode === 'desktop'
    ? 'hidden w-64 xl:flex'
    : 'flex h-full w-full'} flex-col border-l border-white/20 dark:border-white/10 bg-white/50 dark:bg-black/30 backdrop-blur-xl overflow-y-auto"
>
  {#if mode === 'mobile'}
    <div class="flex items-center justify-between border-b border-black/5 dark:border-white/10 p-4 bg-white/50 dark:bg-black/40 backdrop-blur-md sticky top-0 z-10">
      <h2 class="text-sm font-semibold text-text-main flex items-center gap-2">
        <Users size={18} />
        Membres du canal
      </h2>
      <button
        type="button"
        onclick={() => onClose?.()}
        class="rounded-full bg-black/5 dark:bg-white/10 p-2 text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    </div>
  {/if}

  <div class="p-4 space-y-6">
    <!-- Section Administrateurs & Modérateurs -->
    {#if admins.length > 0}
      <div>
        <h3 class="text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2">
          Administrateurs — {admins.length}
        </h3>
        <div class="space-y-1">
          {#each admins as member (member.id)}
            <div class="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer group">
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                <span
                  class="absolute bottom-0 right-0 block h-3 w-3 rounded-full ring-2 ring-white dark:ring-zinc-900 {member.status === 'online'
                    ? 'bg-green-500'
                    : 'bg-zinc-400 dark:bg-zinc-600'}"
                ></span>
              </div>
              <!-- C'est le composant UserName qui se charge de transformer l'ID en "Prénom Nom" -->
              <UserName
                userId={member.userId}
                class="text-sm font-semibold text-text-main truncate group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Section Membres Réguliers -->
    {#if regulars.length > 0}
      <div>
        <h3 class="text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2">
          Membres — {regulars.length}
        </h3>
        <div class="space-y-1">
          {#each regulars as member (member.id)}
            <div class="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer group opacity-90 hover:opacity-100">
              <div class="relative shrink-0">
                <Avatar userId={member.userId} size="sm" />
                <span
                  class="absolute bottom-0 right-0 block h-3 w-3 rounded-full ring-2 ring-white dark:ring-zinc-900 {member.status === 'online'
                    ? 'bg-green-500'
                    : 'bg-zinc-400 dark:bg-zinc-600'}"
                ></span>
              </div>
              <!-- C'est le composant UserName qui se charge de transformer l'ID en "Prénom Nom" -->
              <UserName
                userId={member.userId}
                class="text-sm font-medium text-text-main truncate group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
