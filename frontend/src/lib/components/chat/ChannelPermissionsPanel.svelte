<script lang="ts">
  interface ChannelSidebarItem {
    id: string;
    name: string;
    isPrivate?: boolean;
  }

  interface ChannelSidebarWorkspace {
    id: string;
    name: string;
    channels: ChannelSidebarItem[];
  }

  interface Props {
    selectedChannelId: string;
    channelWorkspaces: ChannelSidebarWorkspace[];
    onInviteMember: (channelId: string, memberId: string, role: 'member' | 'moderator' | 'admin') => void;
    onUpdateMemberRole: (channelId: string, memberId: string, role: 'member' | 'moderator' | 'admin') => void;
  }

  let { selectedChannelId, channelWorkspaces, onInviteMember, onUpdateMemberRole }: Props = $props();

  let memberId = $state('');
  let role = $state<'member' | 'moderator' | 'admin'>('member');

  let selectedWorkspace = $derived(
    channelWorkspaces.find((workspace) =>
      workspace.channels.some((channel) => channel.id === selectedChannelId)
    ) ?? channelWorkspaces[0]
  );

  let selectedChannel = $derived(
    selectedWorkspace?.channels.find((channel) => channel.id === selectedChannelId) ??
      selectedWorkspace?.channels[0]
  );

  function handleInvite() {
    const normalizedMember = memberId.trim().toLowerCase();
    const channelId = selectedChannel?.id;
    if (!normalizedMember || !channelId) return;
    onInviteMember(channelId, normalizedMember, role);
  }

  function handleRoleUpdate() {
    const normalizedMember = memberId.trim().toLowerCase();
    const channelId = selectedChannel?.id;
    if (!normalizedMember || !channelId) return;
    onUpdateMemberRole(channelId, normalizedMember, role);
  }
</script>

<aside
  class="hidden xl:flex h-full w-80 shrink-0 flex-col border-l border-cn-border/80 bg-[color-mix(in_srgb,var(--cn-surface)_82%,white)] p-4 backdrop-blur-md"
>
  <div class="rounded-2xl border border-cn-border bg-white/70 p-4">
    <p class="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-text-muted">Permissions</p>
    <h3 class="mt-1 text-base font-black text-text-main">Canal actif</h3>
    {#if selectedWorkspace && selectedChannel}
      <p class="mt-2 text-sm font-semibold text-text-main">{selectedWorkspace.name} / # {selectedChannel.name}</p>
      <p class="mt-1 text-xs text-text-muted">
        Gere ici les invitations et les roles canal. Le modele global communaute arrive ensuite.
      </p>
    {:else}
      <p class="mt-2 text-sm text-text-muted">Selectionne un canal pour administrer ses membres.</p>
    {/if}
  </div>

  <div class="mt-4 rounded-2xl border border-cn-border bg-white/70 p-4">
    <label class="block text-xs font-semibold uppercase tracking-wide text-text-muted" for="channel-member-id"
      >Utilisateur</label
    >
    <input
      id="channel-member-id"
      type="text"
      value={memberId}
      oninput={(event) => (memberId = (event.target as HTMLInputElement).value)}
      placeholder="Ex: jolan"
      class="mt-2 w-full rounded-xl border border-cn-border bg-white/80 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
    />

    <label class="mt-3 block text-xs font-semibold uppercase tracking-wide text-text-muted" for="channel-role"
      >Role</label
    >
    <select
      id="channel-role"
      value={role}
      onchange={(event) => (role = (event.target as HTMLSelectElement).value as 'member' | 'moderator' | 'admin')}
      class="mt-2 w-full rounded-xl border border-cn-border bg-white/80 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
    >
      <option value="member">Membre</option>
      <option value="moderator">Moderateur</option>
      <option value="admin">Admin</option>
    </select>

    <div class="mt-4 grid grid-cols-1 gap-2">
      <button
        type="button"
        onclick={handleInvite}
        disabled={!selectedChannel || !memberId.trim()}
        class="rounded-xl bg-cn-dark px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
      >
        Inviter dans le canal
      </button>
      <button
        type="button"
        onclick={handleRoleUpdate}
        disabled={!selectedChannel || !memberId.trim()}
        class="rounded-xl border border-cn-border bg-white px-3 py-2 text-sm font-semibold text-text-main hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-45"
      >
        Changer le role
      </button>
    </div>
  </div>
</aside>
