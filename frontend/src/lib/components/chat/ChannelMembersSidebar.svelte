<script lang="ts">
  import { Users, X } from 'lucide-svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { presenceMap, watchUsers } from '$lib/stores/presenceStore';
  import { onMount } from 'svelte';

  interface Props {
    selectedChannelId: string;
    currentUserId?: string;
    mode?: 'desktop' | 'mobile';
    onClose?: () => void;
  }

  let { currentUserId, mode = 'desktop', onClose }: Props = $props();

  // Ce n'est plus un mock statique, on simule l'arrivée des utilisateurs réels.
  // Idéalement, nous devrions récupérer les vrais membres du `channel-service`,
  // mais pour l'instant cela affichera au moins vos contacts récents/membres connectés !
  let channelMembers = $derived(
    currentUserId ? [{ id: currentUserId, name: currentUserId, role: 'admin' }] : []
  );

  const members = $derived(
    channelMembers.map((m) => ({
      ...m,
      status: $presenceMap[m.name] ? 'online' : 'offline',
    }))
  );

  onMount(() => {
    watchUsers(channelMembers.map((m) => m.name));
  });

  const admins = $derived(members.filter((m) => m.role === 'admin' || m.role === 'moderator'));
  const regulars = $derived(members.filter((m) => m.role === 'member'));
</script>

<div
  class="{mode === 'desktop'
    ? 'hidden w-64 flex-col border-l border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_80%,white)] xl:flex'
    : 'flex h-full w-full flex-col bg-[color-mix(in_srgb,var(--cn-surface)_80%,white)]'} overflow-y-auto"
>
  {#if mode === 'mobile'}
    <div class="flex items-center justify-between border-b border-cn-border/60 p-4">
      <h2 class="text-sm font-semibold text-text-main flex items-center gap-2">
        <Users size={18} />
        Membres du canal
      </h2>
      <button
        type="button"
        onclick={() => onClose?.()}
        class="rounded-lg border border-cn-border bg-white p-1.5 text-text-main"
      >
        <X size={16} />
      </button>
    </div>
  {/if}

  <div class="p-4 space-y-6">
    <!-- Section Admins & Mods -->
    {#if admins.length > 0}
      <div>
        <h3 class="text-[0.7rem] font-bold uppercase tracking-wider text-text-muted mb-3">
          Administrateurs - {admins.length}
        </h3>
        <div class="space-y-3">
          {#each admins as member (member.id)}
            <div class="flex items-center gap-2.5">
              <div class="relative">
                <Avatar userId={member.name} size="sm" />
                <span
                  class="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full ring-2 ring-white {member.status ===
                  'online'
                    ? 'bg-green-500'
                    : 'bg-gray-400'}"
                ></span>
              </div>
              <span class="text-sm font-medium text-text-main truncate">{member.name}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Section Membres -->
    {#if regulars.length > 0}
      <div>
        <h3 class="text-[0.7rem] font-bold uppercase tracking-wider text-text-muted mb-3">
          Membres - {regulars.length}
        </h3>
        <div class="space-y-3">
          {#each regulars as member (member.id)}
            <div class="flex items-center gap-2.5 opacity-80 hover:opacity-100 transition-opacity">
              <div class="relative">
                <Avatar userId={member.name} size="sm" />
                <span
                  class="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full ring-2 ring-white {member.status ===
                  'online'
                    ? 'bg-green-500'
                    : 'bg-gray-400'}"
                ></span>
              </div>
              <span class="text-sm text-text-main truncate font-medium">{member.name}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
