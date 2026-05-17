<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Settings, Users, Trash2, ShieldCheck, Upload, Loader } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { channelService, type ChannelMemberDto } from '$lib/services/ChannelService';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface ChannelItem {
    id: string;
    name: string;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    imageMediaId?: string | null;
    workspaceDbId?: string;
    channels: ChannelItem[];
  }

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** List of all available community workspaces. */
    workspaces: ChannelWorkspace[];
    /** ID of the workspace currently being administered. */
    selectedWorkspaceId: string;
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback to update the avatar image of the selected workspace. */
    onUpdateWorkspaceImage?: (workspaceDbId: string, mediaId: string) => void;
    /** Callback fired when the current user leaves the selected workspace. */
    onLeaveWorkspace?: (workspaceDbId: string) => void;
    /** Callback to send a community membership invitation with the given role. */
    onInviteCommunityMember?: (
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
  }

  let {
    open,
    workspaces,
    selectedWorkspaceId,
    onClose,
    onUpdateWorkspaceImage,
    onLeaveWorkspace,
    onInviteCommunityMember,
  }: Props = $props();

  let activeTab = $state<'overview' | 'members'>('overview');

  let selectedWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  );

  // Image upload state
  let imageUploading = $state(false);
  let imageUploadError = $state('');
  let inviteStatus = $state('');
  let inviteUserId = $state('');
  let inviteRole = $state<'member' | 'moderator' | 'admin'>('member');
  let communityMembers = $state<Array<{ userId: string; role: 'member' | 'moderator' | 'admin' }>>(
    []
  );
  let membersLoading = $state(false);
  let membersError = $state('');
  let membersLoadToken = 0;
  let resolvedMemberNames = $state<Record<string, string>>({});
  const mediaService = new MediaService();

  function normalizeRoleLabel(roleName: string): 'member' | 'moderator' | 'admin' {
    const normalized = roleName.trim().toLowerCase();
    if (
      normalized === 'admin' ||
      normalized === 'administrateur' ||
      normalized === 'owner' ||
      normalized === 'proprietaire' ||
      normalized === 'propriétaire'
    ) {
      return 'admin';
    }
    if (normalized === 'moderator' || normalized === 'modérateur' || normalized === 'moderateur') {
      return 'moderator';
    }
    return 'member';
  }

  function strongerRole(
    current: 'member' | 'moderator' | 'admin',
    next: 'member' | 'moderator' | 'admin'
  ): 'member' | 'moderator' | 'admin' {
    const rank = { member: 1, moderator: 2, admin: 3 } as const;
    return rank[next] > rank[current] ? next : current;
  }

  function roleLabel(role: 'member' | 'moderator' | 'admin'): string {
    if (role === 'admin') return 'Administrateur';
    if (role === 'moderator') return 'Modérateur';
    return 'Membre';
  }

  function roleBadgeClass(role: 'member' | 'moderator' | 'admin'): string {
    if (role === 'admin') return 'bg-red-100 text-red-700';
    if (role === 'moderator') return 'bg-blue-100 text-blue-700';
    return 'bg-emerald-100 text-emerald-700';
  }

  async function loadCommunityMembers() {
    if (!open || activeTab !== 'members') return;
    if (!selectedWorkspace || selectedWorkspace.channels.length === 0) {
      communityMembers = [];
      membersError = '';
      return;
    }

    const loadToken = ++membersLoadToken;
    membersLoading = true;
    membersError = '';
    try {
      const perChannelMembers = await Promise.all(
        selectedWorkspace.channels.map((channel) => channelService.listMembers(channel.id))
      );

      const aggregate = new SvelteMap<string, 'member' | 'moderator' | 'admin'>();
      for (const members of perChannelMembers) {
        for (const member of members as ChannelMemberDto[]) {
          const userId = member.userId?.trim().toLowerCase();
          if (!userId) continue;
          const nextRole = normalizeRoleLabel(member.role || 'member');
          const currentRole = aggregate.get(userId);
          aggregate.set(userId, currentRole ? strongerRole(currentRole, nextRole) : nextRole);
        }
      }

      if (loadToken !== membersLoadToken) return;

      communityMembers = Array.from(aggregate.entries())
        .map(([userId, role]) => ({ userId, role }))
        .sort((a, b) => a.userId.localeCompare(b.userId));

      const names: Record<string, string> = {};
      for (const m of communityMembers) {
        names[m.userId] = getUserDisplayNameSync(m.userId, m.userId);
      }
      resolvedMemberNames = names;
      for (const m of communityMembers) {
        resolveUserDisplayName(m.userId).then((resolved) => {
          if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
        });
      }
    } catch (e) {
      if (loadToken !== membersLoadToken) return;
      membersError = e instanceof Error ? e.message : 'Impossible de charger les membres.';
      communityMembers = [];
    } finally {
      if (loadToken === membersLoadToken) membersLoading = false;
    }
  }

  $effect(() => {
    void open;
    void activeTab;
    void selectedWorkspace?.id;
    if (open && activeTab === 'members') {
      void loadCommunityMembers();
    }
  });

  function handleGenerateInvitation() {
    const memberId = inviteUserId.trim();
    if (!selectedWorkspace?.name) {
      inviteStatus = "Sélectionnez d'abord une communauté.";
      return;
    }

    if (!memberId) {
      inviteStatus = 'Sélectionnez un utilisateur dans la liste.';
      return;
    }

    if (!onInviteCommunityMember) {
      inviteStatus = "L'invitation communautaire n'est pas disponible dans ce contexte.";
      return;
    }

    onInviteCommunityMember(memberId, inviteRole);
    inviteStatus = `Invitation envoyée à ${memberId} (${inviteRole}).`;
    inviteUserId = '';
    inviteRole = 'member';
    void loadCommunityMembers();
  }

  async function handleImageFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !selectedWorkspace?.id) return;

    if (!file.type.startsWith('image/')) {
      imageUploadError = 'Veuillez sélectionner une image.';
      return;
    }

    imageUploading = true;
    imageUploadError = '';
    try {
      const token = await getToken();
      const mediaId = await mediaService.uploadRaw(file, token);
      // Pass workspaceDbId if available, otherwise fall back to the slug id
      const targetId = selectedWorkspace.workspaceDbId ?? selectedWorkspace.id;
      onUpdateWorkspaceImage?.(targetId, mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : 'Échec du téléversement.';
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }
</script>

<Modal {open} {onClose} title="Paramètres de la communauté" maxWidth="max-w-4xl">
  <div class="flex flex-col md:flex-row min-h-0 border-t border-cn-border/40">
    <!-- Barre de menu à gauche -->
    <div
      class="w-full md:w-64 md:flex-shrink-0 bg-[color-mix(in_srgb,var(--cn-surface)_60%,white)] border-b md:border-b-0 md:border-r border-cn-border/40 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-2 md:p-4 gap-1 md:gap-1 md:space-y-1"
    >
      <h3
        class="hidden md:block text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2"
      >
        {selectedWorkspace ? selectedWorkspace.name : 'Communauté'}
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'overview'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Settings size={18} />
        Vue d'ensemble
      </button>
      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'members'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Users size={18} />
        Membres
      </button>

      <div class="hidden md:block mt-auto pt-4 space-y-2">
        <button
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors w-full"
          onclick={() => {
            if (confirm(`Quitter la communauté "${selectedWorkspace?.name}" ?`)) {
              onLeaveWorkspace?.(selectedWorkspace?.workspaceDbId ?? '');
              onClose();
            }
          }}
        >
          <Trash2 size={18} />
          Quitter la communauté
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="flex-1 bg-white/50 p-6 overflow-y-auto min-h-[300px]">
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">Vue d'ensemble</h2>

          <div class="flex items-center gap-6">
            <div class="relative flex-shrink-0">
              <div class="w-24 h-24 rounded-full overflow-hidden shadow-md">
                <GroupAvatar
                  imageMediaId={selectedWorkspace?.imageMediaId}
                  name={selectedWorkspace?.name ?? ''}
                  variant="community"
                  fill
                  shape="circle"
                />
              </div>
              <label
                class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center cursor-pointer hover:bg-amber-600 transition-colors shadow"
                title="Changer l'image"
              >
                {#if imageUploading}
                  <Loader size={14} class="animate-spin" />
                {:else}
                  <Upload size={14} />
                {/if}
                <input
                  type="file"
                  accept="image/*"
                  class="sr-only"
                  disabled={imageUploading}
                  onchange={handleImageFileChange}
                />
              </label>
            </div>
            <div class="flex-1 space-y-2">
              {#if imageUploadError}
                <p class="text-xs text-red-600">{imageUploadError}</p>
              {/if}
              <label class="text-xs font-bold uppercase text-text-muted" for="server-name"
                >Nom de la communauté</label
              >
              <input
                id="server-name"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50"
                value={selectedWorkspace ? selectedWorkspace.name : ''}
              />
            </div>
          </div>

          <div
            class="border border-cn-border bg-white rounded-xl p-4 shadow-sm text-sm text-text-main flex items-center gap-3"
          >
            <ShieldCheck size={24} class="text-green-500" />
            <div class="flex-1">
              <span class="font-bold block">Chiffrement E2E Actif</span>
              <span class="text-xs text-text-muted"
                >Les canaux de cette communauté utilisent Secure Group Messaging (MLS).</span
              >
            </div>
          </div>
        </div>
      {/if}

      {#if activeTab === 'members'}
        <div class="space-y-6 max-w-3xl">
          <h2 class="text-xl font-bold text-text-main">Membres</h2>
          <p class="text-sm text-text-muted">
            Gestion des membres de la communauté et de leurs rôles globaux.
          </p>

          <!-- Placer ici une liste factice ou une vraie table -->
          <div class="border border-cn-border rounded-xl bg-white overflow-hidden text-sm">
            <div class="p-4 flex items-center justify-between border-b border-cn-border bg-black/5">
              <span class="font-semibold text-text-main">{communityMembers.length} Membre(s)</span>
              <button
                class="bg-amber-500 text-white rounded-lg px-3 py-1.5 text-xs font-bold hover:bg-amber-600 transition"
                onclick={handleGenerateInvitation}
              >
                Générer une invitation
              </button>
            </div>
            <div class="px-4 py-3 border-b border-cn-border bg-white/70 space-y-2.5">
              <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2.5">
                <UserAutocomplete
                  value={inviteUserId}
                  onValueChange={(v) => (inviteUserId = v)}
                  placeholder="Rechercher un utilisateur…"
                  inputId="community-invite-autocomplete"
                />
                <select
                  bind:value={inviteRole}
                  class="bg-white border border-cn-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/40"
                >
                  <option value="member">Membre</option>
                  <option value="moderator">Modérateur</option>
                  <option value="admin">Administrateur</option>
                </select>
              </div>
            </div>
            {#if inviteStatus}
              <div class="px-4 py-2 border-b border-cn-border text-xs font-medium text-text-muted">
                {inviteStatus}
              </div>
            {/if}
            {#if membersLoading}
              <div class="p-6 text-center text-text-muted">Chargement des membres...</div>
            {:else if membersError}
              <div class="p-6 text-center text-red-600">{membersError}</div>
            {:else if communityMembers.length === 0}
              <div class="p-6 text-center text-text-muted">
                Aucun membre à afficher pour le moment.
              </div>
            {:else}
              <div class="divide-y divide-cn-border/70">
                {#each communityMembers as member (member.userId)}
                  <div class="px-4 py-3 flex items-center justify-between gap-3">
                    <span class="font-medium text-text-main truncate"
                      >{resolvedMemberNames[member.userId] ?? member.userId}</span
                    >
                    <span
                      class={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${roleBadgeClass(member.role)}`}
                    >
                      {roleLabel(member.role)}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
