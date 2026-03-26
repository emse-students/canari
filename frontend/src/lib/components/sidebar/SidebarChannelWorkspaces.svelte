<script lang="ts">
  import { Plus, ChevronDown, ChevronRight, Hash, Lock } from 'lucide-svelte';
  import Avatar from '../shared/Avatar.svelte';

  interface ChannelItem {
    id: string;
    name: string;
    unreadCount?: number;
    isPrivate?: boolean;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    avatarUserId: string;
    channels: ChannelItem[];
  }

  interface Props {
    filteredChannelWorkspaces: ChannelWorkspace[];
    expandedWorkspaceIds: string[];
    selectedChannelId: string;
    onToggleWorkspace: (workspaceId: string) => void;
    onOpenNewGroup: () => void;
    onSelectChannel: (channelId: string) => void;
  }

  let {
    filteredChannelWorkspaces,
    expandedWorkspaceIds,
    selectedChannelId,
    onToggleWorkspace,
    onOpenNewGroup,
    onSelectChannel,
  }: Props = $props();
</script>

<div class="space-y-2">
  {#each filteredChannelWorkspaces as workspace (workspace.id)}
    {@const isExpanded = expandedWorkspaceIds.includes(workspace.id)}
    <section class="rounded-2xl overflow-hidden">
      <div class="flex items-center gap-2 px-2 py-2 hover:bg-cn-bg rounded-xl transition-colors">
        <button
          type="button"
          onclick={() => onToggleWorkspace(workspace.id)}
          class="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <span class="text-text-muted">
            {#if isExpanded}
              <ChevronDown size={14} />
            {:else}
              <ChevronRight size={14} />
            {/if}
          </span>
          <div class="w-9 h-9 rounded-xl overflow-hidden flex-shrink-0">
            <Avatar userId={workspace.avatarUserId} size="lg" />
          </div>
          <div class="flex-1 min-w-0 font-semibold text-text-main truncate">
            {workspace.name}
          </div>
        </button>
        <button
          type="button"
          onclick={onOpenNewGroup}
          class="w-7 h-7 rounded-full hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-text-muted inline-flex items-center justify-center flex-shrink-0"
          aria-label="Ajouter un canal"
        >
          <Plus size={14} />
        </button>
      </div>

      {#if isExpanded}
        <div class="pl-10 pr-2 pb-2 space-y-1">
          {#each workspace.channels as channel (channel.id)}
            <button
              type="button"
              onclick={() => onSelectChannel(channel.id)}
              class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors {selectedChannelId ===
              channel.id
                ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_16%,transparent)] text-text-main'
                : 'hover:bg-cn-bg text-text-muted'}"
            >
              <span class="opacity-70">
                {#if channel.isPrivate}
                  <Lock size={14} />
                {:else}
                  <Hash size={14} />
                {/if}
              </span>
              <span class="flex-1 truncate text-sm font-medium">{channel.name}</span>
              {#if channel.unreadCount}
                <span
                  class="min-w-5 h-5 px-1 rounded-full bg-cn-dark text-cn-yellow text-[0.65rem] font-extrabold inline-flex items-center justify-center"
                >
                  {channel.unreadCount}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/each}

  {#if filteredChannelWorkspaces.length === 0}
    <div class="text-center py-8 px-4 text-text-muted text-sm">Aucun canal correspondant.</div>
  {/if}
</div>
