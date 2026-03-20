<script lang="ts">
  import { tick } from 'svelte';
  import Modal from './Modal.svelte';

  interface ChannelItem {
    id: string;
    name: string;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    channels: ChannelItem[];
  }

  interface Props {
    open: boolean;
    workspaces: ChannelWorkspace[];
    selectedWorkspaceId: string;
    selectedChannelId: string;
    communityName: string;
    memberId: string;
    roleName: 'member' | 'moderator' | 'admin';
    onClose: () => void;
    onWorkspaceChange: (value: string) => void;
    onChannelChange: (value: string) => void;
    onCommunityNameChange: (value: string) => void;
    onMemberIdChange: (value: string) => void;
    onRoleNameChange: (value: 'member' | 'moderator' | 'admin') => void;
    onCreateCommunity: () => void;
    onInviteMember: () => void;
    onUpdateRole: () => void;
  }

  let {
    open,
    workspaces,
    selectedWorkspaceId,
    selectedChannelId,
    communityName,
    memberId,
    roleName,
    onClose,
    onWorkspaceChange,
    onChannelChange,
    onCommunityNameChange,
    onMemberIdChange,
    onRoleNameChange,
    onCreateCommunity,
    onInviteMember,
    onUpdateRole,
  }: Props = $props();

  let communityInput: HTMLInputElement | undefined;

  $effect(() => {
    if (!open) return;
    void tick().then(() => communityInput?.focus());
  });

  let selectedWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  );
</script>

<Modal {open} {onClose} title="Communautes & roles">
  <div class="space-y-5 pt-1">
    <section class="space-y-2 rounded-xl border border-cn-border bg-white/40 p-3">
      <h3 class="text-sm font-semibold text-text-main">Creer une communaute</h3>
      <div class="flex gap-2">
        <input
          bind:this={communityInput}
          type="text"
          value={communityName}
          oninput={(e) => onCommunityNameChange((e.target as HTMLInputElement).value)}
          placeholder="Ex: Asso Robotique"
          class="w-full rounded-xl border border-white/55 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        />
        <button
          type="button"
          onclick={onCreateCommunity}
          disabled={!communityName.trim()}
          class="rounded-xl bg-cn-dark px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Creer
        </button>
      </div>
    </section>

    <section class="space-y-2 rounded-xl border border-cn-border bg-white/40 p-3">
      <h3 class="text-sm font-semibold text-text-main">Membres & permissions</h3>

      <div class="grid grid-cols-1 gap-2">
        <label class="text-xs font-medium text-text-muted" for="workspace-select">Communaute</label>
        <select
          id="workspace-select"
          value={selectedWorkspace?.id ?? ''}
          onchange={(e) => onWorkspaceChange((e.target as HTMLSelectElement).value)}
          class="rounded-xl border border-white/55 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        >
          {#each workspaces as workspace (workspace.id)}
            <option value={workspace.id}>{workspace.name}</option>
          {/each}
        </select>
      </div>

      <div class="grid grid-cols-1 gap-2">
        <label class="text-xs font-medium text-text-muted" for="channel-select">Canal</label>
        <select
          id="channel-select"
          value={selectedChannelId}
          onchange={(e) => onChannelChange((e.target as HTMLSelectElement).value)}
          class="rounded-xl border border-white/55 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        >
          {#if selectedWorkspace?.channels?.length}
            {#each selectedWorkspace.channels as channel (channel.id)}
              <option value={channel.id}>{channel.name}</option>
            {/each}
          {:else}
            <option value="">Aucun canal</option>
          {/if}
        </select>
      </div>

      <div class="grid grid-cols-1 gap-2">
        <label class="text-xs font-medium text-text-muted" for="member-id">Utilisateur</label>
        <input
          id="member-id"
          type="text"
          value={memberId}
          oninput={(e) => onMemberIdChange((e.target as HTMLInputElement).value)}
          placeholder="Ex: jolan"
          class="rounded-xl border border-white/55 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        />
      </div>

      <div class="grid grid-cols-1 gap-2">
        <label class="text-xs font-medium text-text-muted" for="role-select">Role</label>
        <select
          id="role-select"
          value={roleName}
          onchange={(e) => onRoleNameChange((e.target as HTMLSelectElement).value as 'member' | 'moderator' | 'admin')}
          class="rounded-xl border border-white/55 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        >
          <option value="member">Membre</option>
          <option value="moderator">Moderateur</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onclick={onInviteMember}
          disabled={!memberId.trim() || !selectedChannelId}
          class="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Inviter
        </button>
        <button
          type="button"
          onclick={onUpdateRole}
          disabled={!memberId.trim() || !selectedChannelId}
          class="rounded-xl border border-cn-border bg-white/80 px-3 py-2 text-sm font-semibold text-text-main hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Changer role
        </button>
      </div>
    </section>
  </div>
</Modal>
