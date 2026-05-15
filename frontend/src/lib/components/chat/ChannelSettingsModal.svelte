<script lang="ts">
  import {
    Shield,
    Settings,
    Users,
    Key,
    Trash2,
    LogOut,
    Check,
    Minus,
    UserPlus,
    Upload,
    Loader,
    Lock,
    Globe,
  } from 'lucide-svelte';
  import Modal from '../shared/Modal.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { channelService } from '$lib/services/ChannelService';

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
    /** Whether the modal is visible. */
    open: boolean;
    /** ID of the channel being configured. */
    selectedChannelId: string;
    /** List of workspaces and their channels, used to resolve the channel name. */
    channelWorkspaces: ChannelSidebarWorkspace[];
    /** Optional media ID for the channel's current avatar image. */
    imageMediaId?: string | null;
    /** Callback to invite a user to the channel with a given role. */
    onInviteMember: (
      channelId: string,
      memberId: string,
      role: 'member' | 'moderator' | 'admin'
    ) => void;
    /** Callback to update the role of an existing channel member. */
    onUpdateMemberRole: (
      channelId: string,
      memberId: string,
      role: 'member' | 'moderator' | 'admin'
    ) => void;
    /** Callback to rename the channel. */
    onRenameChannel?: (channelId: string, newName: string) => void;
    /** Callback to permanently delete the channel. */
    onDeleteChannel?: (channelId: string) => void;
    /** Callback fired when the current user leaves the channel. */
    onLeaveChannel?: (channelId: string) => void;
    /** Callback to update the channel's avatar image. */
    onUpdateChannelImage?: (channelId: string, mediaId: string) => void;
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback fired when channel access settings (isPrivate, allowedRoles) are updated. */
    onUpdateChannelAccess?: (channelId: string, isPrivate: boolean, allowedRoleIds: string[]) => void;
  }

  let {
    open,
    selectedChannelId,
    channelWorkspaces,
    imageMediaId = null,
    onInviteMember,
    onUpdateMemberRole,
    onRenameChannel,
    onDeleteChannel,
    onLeaveChannel,
    onUpdateChannelImage,
    onClose,
    onUpdateChannelAccess,
  }: Props = $props();

  let activeTab = $state<'overview' | 'permissions' | 'invites'>('permissions');

  let selectedWorkspace = $derived(
    channelWorkspaces.find((w) => w.channels.some((c) => c.id === selectedChannelId))
  );

  let selectedChannel = $derived(
    selectedWorkspace?.channels.find((c) => c.id === selectedChannelId)
  );

  let channelNameInput = $state('');

  // S'assurer que l'input se met à jour quand on change de canal
  $effect(() => {
    if (open && selectedChannel) {
      channelNameInput = selectedChannel.name;
    }
  });

  let permissionMembersId = $state('');
  let permissionRole = $state<'member' | 'moderator' | 'admin'>('member');

  interface RoleMatrixItem {
    id: string;
    label: string;
    permissions: {
      read: boolean;
      write: boolean;
      channelManage: boolean;
      memberInvite: boolean;
      memberKick: boolean;
      roleManage: boolean;
    };
  }

  const communityRoleMatrix: RoleMatrixItem[] = [
    {
      id: 'admin',
      label: 'Administrateur',
      permissions: {
        read: true,
        write: true,
        channelManage: true,
        memberInvite: true,
        memberKick: true,
        roleManage: true,
      },
    },
    {
      id: 'moderator',
      label: 'Modérateur',
      permissions: {
        read: true,
        write: true,
        channelManage: true,
        memberInvite: true,
        memberKick: true,
        roleManage: false,
      },
    },
    {
      id: 'member',
      label: 'Membre',
      permissions: {
        read: true,
        write: true,
        channelManage: false,
        memberInvite: true,
        memberKick: false,
        roleManage: false,
      },
    },
  ];

  function handleInviteAction() {
    if (permissionMembersId.trim()) {
      onInviteMember(selectedChannelId, permissionMembersId, permissionRole);
      permissionMembersId = '';
      permissionRole = 'member';
    }
  }

  function handleUpdateRoleAction() {
    if (permissionMembersId.trim()) {
      onUpdateMemberRole(selectedChannelId, permissionMembersId, permissionRole);
      permissionMembersId = '';
      permissionRole = 'member';
    }
  }

  // Access control state (loaded lazily when permissions tab opens)
  let accessLoading = $state(false);
  let accessError = $state('');
  let accessSaving = $state(false);
  let accessSaved = $state(false);
  let accessIsPrivate = $state(false);
  let accessAllowedRoleIds = $state<string[]>([]);
  let workspaceRoles = $state<{ id: string; name: string; priority: number }[]>([]);
  let accessLoaded = $state(false);

  $effect(() => {
    if (open && activeTab === 'permissions' && selectedChannelId && !accessLoaded) {
      void loadChannelAccess();
    }
    if (!open) {
      accessLoaded = false;
      accessSaved = false;
      accessError = '';
    }
  });

  async function loadChannelAccess() {
    accessLoading = true;
    accessError = '';
    try {
      const data = await channelService.getChannelAccess(selectedChannelId);
      accessIsPrivate = data.isPrivate;
      accessAllowedRoleIds = data.allowedRoles ?? [];
      workspaceRoles = data.workspaceRoles ?? [];
      accessLoaded = true;
    } catch (e) {
      accessError = e instanceof Error ? e.message : 'Erreur chargement accès';
    } finally {
      accessLoading = false;
    }
  }

  async function saveChannelAccess() {
    accessSaving = true;
    accessSaved = false;
    accessError = '';
    try {
      await channelService.updateChannelAccess(selectedChannelId, accessIsPrivate, accessAllowedRoleIds);
      onUpdateChannelAccess?.(selectedChannelId, accessIsPrivate, accessAllowedRoleIds);
      accessSaved = true;
      setTimeout(() => { accessSaved = false; }, 2500);
    } catch (e) {
      accessError = e instanceof Error ? e.message : 'Erreur sauvegarde';
    } finally {
      accessSaving = false;
    }
  }

  function toggleAllowedRole(roleId: string) {
    if (accessAllowedRoleIds.includes(roleId)) {
      accessAllowedRoleIds = accessAllowedRoleIds.filter((id) => id !== roleId);
    } else {
      accessAllowedRoleIds = [...accessAllowedRoleIds, roleId];
    }
  }

  // Image upload state
  let imageUploading = $state(false);
  let imageUploadError = $state('');
  const mediaService = new MediaService();

  async function handleImageFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      imageUploadError = 'Veuillez sélectionner une image.';
      return;
    }
    imageUploading = true;
    imageUploadError = '';
    try {
      const token = await getToken();
      const mediaId = await mediaService.uploadRaw(file, token);
      onUpdateChannelImage?.(selectedChannelId, mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : 'Échec du téléversement.';
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }

  function handleRenameChannel() {
    const trimmed = channelNameInput.trim().toLowerCase();
    if (trimmed && trimmed !== selectedChannel?.name) {
      onRenameChannel?.(selectedChannelId, trimmed);
    }
  }

  function handleDeleteChannel() {
    if (confirm(`Supprimer définitivement le canal #${selectedChannel?.name} ?`)) {
      onDeleteChannel?.(selectedChannelId);
      onClose();
    }
  }

  function handleLeaveChannel() {
    if (confirm(`Quitter le canal #${selectedChannel?.name} ?`)) {
      onLeaveChannel?.(selectedChannelId);
      onClose();
    }
  }
</script>

<Modal {open} {onClose} title="Paramètres du canal" maxWidth="max-w-4xl">
  <div class="-mx-6 -my-4 flex flex-col md:flex-row h-full md:h-[65vh] max-h-[800px]">
    <!-- Barre de menu latérale (Onglets sur mobile) -->
    <div
      class="w-full md:w-64 shrink-0 bg-white/40 dark:bg-black/20 border-b md:border-b-0 md:border-r border-black/5 dark:border-white/10 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-3 md:p-5 gap-2 md:gap-1 custom-scrollbar"
    >
      <h3
        class="hidden md:flex text-[0.7rem] font-extrabold uppercase tracking-widest text-text-muted mb-3 px-2 items-center gap-2"
      >
        <span class="text-amber-500 text-lg leading-none">#</span>
        <span class="truncate">{selectedChannel ? selectedChannel.name : 'Canal'}</span>
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'overview'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Settings size={18} strokeWidth={2.5} />
        Vue d'ensemble
      </button>

      <button
        onclick={() => (activeTab = 'permissions')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'permissions'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Shield size={18} strokeWidth={2.5} />
        Permissions
      </button>

      <button
        onclick={() => (activeTab = 'invites')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'invites'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Users size={18} strokeWidth={2.5} />
        Invitations & Rôles
      </button>

      <!-- Boutons de danger (Desktop uniquement, placés en bas) -->
      <div class="hidden md:flex md:flex-col mt-auto pt-6 gap-2">
        <button
          type="button"
          onclick={handleLeaveChannel}
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <LogOut size={18} strokeWidth={2.5} />
          Quitter le canal
        </button>
        <button
          type="button"
          onclick={handleDeleteChannel}
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Trash2 size={18} strokeWidth={2.5} />
          Supprimer le canal
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="flex-1 bg-transparent p-5 md:p-8 overflow-y-auto custom-scrollbar">
      <!-- ================= ONGLET : VUE D'ENSEMBLE ================= -->
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">Vue d'ensemble</h2>
          <div class="space-y-4">
            <!-- Channel image -->
            <div class="flex items-center gap-5">
              <div class="relative flex-shrink-0">
                <div class="w-20 h-20 rounded-2xl overflow-hidden">
                  <GroupAvatar
                    {imageMediaId}
                    name={selectedChannel?.name ?? ''}
                    variant="channel"
                    fill
                  />
                </div>
                <label
                  class="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-amber-500 text-white flex items-center justify-center cursor-pointer hover:bg-amber-600 transition-colors shadow"
                  title="Changer l'image"
                >
                  {#if imageUploading}
                    <Loader size={12} class="animate-spin" />
                  {:else}
                    <Upload size={12} />
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
              <div class="flex-1">
                {#if imageUploadError}
                  <p class="text-xs text-red-600 mb-2">{imageUploadError}</p>
                {/if}
                <p class="text-sm text-text-muted">
                  Cliquez sur l'icône pour changer l'image du canal.
                </p>
              </div>
            </div>
            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="channel-name"
                >Nom du canal</label
              >
              <div class="flex gap-2">
                <input
                  id="channel-name"
                  class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl pl-9 pr-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-500/50 shadow-inner transition-all"
                  bind:value={channelNameInput}
                  onkeydown={(e) => e.key === 'Enter' && handleRenameChannel()}
                  placeholder="nom-du-canal"
                />
              </div>
              <button
                type="button"
                onclick={handleRenameChannel}
                disabled={!channelNameInput.trim() ||
                  channelNameInput.trim() === selectedChannel?.name}
                class="rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-amber-500/20 disabled:shadow-none"
              >
                Renommer
              </button>
            </div>
          </div>

          <!-- Zone de danger (Visible uniquement sur mobile dans cet onglet) -->
          <div class="md:hidden pt-6 border-t border-black/10 dark:border-white/10 space-y-3">
            <h3 class="text-xs font-bold uppercase tracking-wider text-red-500 px-1 mb-2">
              Zone de danger
            </h3>
            <button
              type="button"
              onclick={handleLeaveChannel}
              class="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 active:scale-[0.98] transition-all"
            >
              <LogOut size={18} strokeWidth={2.5} />
              Quitter le canal
            </button>
            <button
              type="button"
              onclick={handleDeleteChannel}
              class="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 active:scale-[0.98] transition-all"
            >
              <Trash2 size={18} strokeWidth={2.5} />
              Supprimer le canal
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= ONGLET : PERMISSIONS ================= -->
      {#if activeTab === 'permissions'}
        <div class="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">Accès au canal</h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              Définissez si le canal est ouvert à tous les membres ou restreint à certains rôles.
            </p>
          </div>

          {#if accessLoading}
            <div class="flex items-center gap-2 text-sm text-text-muted">
              <Loader size={16} class="animate-spin" /> Chargement…
            </div>
          {:else if accessError}
            <div class="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-sm border border-red-200 dark:border-red-800">
              {accessError}
            </div>
          {:else}
            <div class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 space-y-5 shadow-sm">
              <!-- Visibility toggle -->
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3">
                  {#if accessIsPrivate}
                    <div class="p-2 rounded-xl bg-amber-500/10 text-amber-600">
                      <Lock size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="font-bold text-text-main text-sm">Canal privé</p>
                      <p class="text-xs text-text-muted">Seuls les rôles sélectionnés peuvent accéder</p>
                    </div>
                  {:else}
                    <div class="p-2 rounded-xl bg-emerald-500/10 text-emerald-600">
                      <Globe size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="font-bold text-text-main text-sm">Canal public</p>
                      <p class="text-xs text-text-muted">Tous les membres de la communauté peuvent accéder</p>
                    </div>
                  {/if}
                </div>
                <button
                  type="button"
                  onclick={() => { accessIsPrivate = !accessIsPrivate; }}
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors {accessIsPrivate ? 'bg-amber-500' : 'bg-black/10 dark:bg-white/20'}"
                  role="switch"
                  aria-checked={accessIsPrivate}
                >
                  <span class="sr-only">Rendre le canal privé</span>
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {accessIsPrivate ? 'translate-x-6' : 'translate-x-1'}"
                  ></span>
                </button>
              </div>

              <!-- Role selection (only when private) -->
              {#if accessIsPrivate}
                <div class="border-t border-black/5 dark:border-white/10 pt-4 space-y-3">
                  <p class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
                    <Key size={13} /> Rôles autorisés
                  </p>
                  {#if workspaceRoles.length === 0}
                    <p class="text-sm text-text-muted">Aucun rôle disponible dans cette communauté.</p>
                  {:else}
                    <div class="space-y-2">
                      {#each workspaceRoles as role (role.id)}
                        <label class="flex items-center gap-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={accessAllowedRoleIds.includes(role.id)}
                            onchange={() => toggleAllowedRole(role.id)}
                            class="w-4 h-4 rounded border-black/20 text-amber-500 focus:ring-amber-500/50 accent-amber-500"
                          />
                          <span class="text-sm font-semibold text-text-main group-hover:text-amber-600 transition-colors">
                            {role.name}
                          </span>
                        </label>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Save -->
              <div class="flex items-center gap-3 border-t border-black/5 dark:border-white/10 pt-4">
                <button
                  type="button"
                  onclick={saveChannelAccess}
                  disabled={accessSaving}
                  class="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2 shadow-md shadow-amber-500/20"
                >
                  {#if accessSaving}
                    <Loader size={14} class="animate-spin" /> Sauvegarde…
                  {:else}
                    <Check size={14} strokeWidth={3} /> Enregistrer
                  {/if}
                </button>
                {#if accessSaved}
                  <span class="text-xs font-medium text-emerald-600 flex items-center gap-1">
                    <Check size={12} strokeWidth={3} /> Sauvegardé
                  </span>
                {/if}
              </div>
            </div>

            <!-- Static permissions reference table -->
            <div>
              <h3 class="text-sm font-bold text-text-muted mb-3 uppercase tracking-wider">Référence des permissions</h3>
              <div class="border border-black/10 dark:border-white/10 rounded-[1.5rem] overflow-x-auto bg-white/60 dark:bg-black/20 shadow-sm backdrop-blur-md">
                <table class="w-full text-sm text-left">
                  <thead class="bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/10">
                    <tr>
                      <th class="px-5 py-3 font-bold text-text-muted uppercase tracking-wider text-xs">Rôle</th>
                      <th class="px-5 py-3 font-bold text-text-muted uppercase tracking-wider text-xs text-center">Lire</th>
                      <th class="px-5 py-3 font-bold text-text-muted uppercase tracking-wider text-xs text-center">Écrire</th>
                      <th class="px-5 py-3 font-bold text-text-muted uppercase tracking-wider text-xs text-center">Gérer</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-black/5 dark:divide-white/5">
                    {#each communityRoleMatrix as roleItem (roleItem.id)}
                      <tr class="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td class="px-5 py-3 flex items-center gap-2.5 font-bold text-text-main">
                          <div class="p-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            <Key size={14} strokeWidth={2.5} />
                          </div>
                          {roleItem.label}
                        </td>
                        <td class="px-5 py-3 text-center">
                          <div class="flex justify-center">
                            {#if roleItem.permissions.read}
                              <div class="w-5 h-5 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <Check size={12} strokeWidth={3} />
                              </div>
                            {:else}
                              <Minus size={14} class="text-text-muted opacity-50" strokeWidth={3} />
                            {/if}
                          </div>
                        </td>
                        <td class="px-5 py-3 text-center">
                          <div class="flex justify-center">
                            {#if roleItem.permissions.write}
                              <div class="w-5 h-5 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <Check size={12} strokeWidth={3} />
                              </div>
                            {:else}
                              <Minus size={14} class="text-text-muted opacity-50" strokeWidth={3} />
                            {/if}
                          </div>
                        </td>
                        <td class="px-5 py-3 text-center">
                          <div class="flex justify-center">
                            {#if roleItem.permissions.roleManage}
                              <div class="w-5 h-5 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <Check size={12} strokeWidth={3} />
                              </div>
                            {:else}
                              <Minus size={14} class="text-text-muted opacity-50" strokeWidth={3} />
                            {/if}
                          </div>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- ================= ONGLET : INVITATIONS & RÔLES ================= -->
      {#if activeTab === 'invites'}
        <div class="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">Invitations & Rôles</h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              Invitez de nouveaux membres dans le canal ou modifiez le rôle d'un membre existant.
            </p>
          </div>

          <div
            class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 md:p-6 space-y-5 shadow-sm backdrop-blur-md"
          >
            <!-- Recherche utilisateur -->
            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="invite-autocomplete"
              >
                <Users size={14} /> Rechercher un utilisateur
              </label>
              <UserAutocomplete
                value={permissionMembersId}
                onValueChange={(v) => (permissionMembersId = v)}
                placeholder="Nom ou identifiant…"
                inputId="invite-autocomplete"
              />
            </div>

            <!-- Select Rôle -->
            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="role-select"
              >
                <Shield size={14} /> Rôle à attribuer
              </label>
              <select
                id="role-select"
                class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-amber-500/50 shadow-inner transition-all text-sm font-semibold appearance-none"
                bind:value={permissionRole}
              >
                <option value="member" class="bg-white dark:bg-zinc-900 font-medium"
                  >Membre (Lecture et Écriture)</option
                >
                <option value="moderator" class="bg-white dark:bg-zinc-900 font-medium"
                  >Modérateur (Gestion des membres)</option
                >
                <option value="admin" class="bg-white dark:bg-zinc-900 font-medium"
                  >Administrateur (Contrôle total)</option
                >
              </select>
            </div>

            <!-- Actions -->
            <div
              class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-black/5 dark:border-white/10"
            >
              <button
                type="button"
                onclick={handleInviteAction}
                disabled={!permissionMembersId.trim()}
                class="flex-1 rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 disabled:shadow-none"
              >
                <UserPlus size={18} strokeWidth={2.5} /> Envoyer l'invitation
              </button>

              <button
                type="button"
                onclick={handleUpdateRoleAction}
                disabled={!permissionMembersId.trim()}
                class="flex-1 rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 px-4 py-3 text-sm font-bold text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Shield size={18} strokeWidth={2.5} /> Mettre à jour
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* Scrollbar discrète pour le menu et le contenu */
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
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
