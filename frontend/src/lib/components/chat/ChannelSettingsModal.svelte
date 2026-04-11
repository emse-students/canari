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
  } from 'lucide-svelte';
  import Modal from '../shared/Modal.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';

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
    open: boolean;
    selectedChannelId: string;
    channelWorkspaces: ChannelSidebarWorkspace[];
    imageMediaId?: string | null;
    onInviteMember: (
      channelId: string,
      memberId: string,
      role: 'member' | 'moderator' | 'admin'
    ) => void;
    onUpdateMemberRole: (
      channelId: string,
      memberId: string,
      role: 'member' | 'moderator' | 'admin'
    ) => void;
    onRenameChannel?: (channelId: string, newName: string) => void;
    onDeleteChannel?: (channelId: string) => void;
    onLeaveChannel?: (channelId: string) => void;
    onUpdateChannelImage?: (channelId: string, mediaId: string) => void;
    onClose: () => void;
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
                    size="lg"
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
        <div class="space-y-6 max-w-4xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">Permissions du canal</h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              Ajustez les privilèges des rôles pour ce canal spécifique. Ces réglages sont appliqués
              à tous les membres possédant ce rôle.
            </p>
          </div>

          <div
            class="border border-black/10 dark:border-white/10 rounded-[1.5rem] overflow-x-auto bg-white/60 dark:bg-black/20 shadow-sm backdrop-blur-md"
          >
            <table class="w-full text-sm text-left">
              <thead
                class="bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/10"
              >
                <tr>
                  <th class="px-5 py-4 font-bold text-text-muted uppercase tracking-wider text-xs"
                    >Rôle</th
                  >
                  <th
                    class="px-5 py-4 font-bold text-text-muted uppercase tracking-wider text-xs text-center"
                    >Lire</th
                  >
                  <th
                    class="px-5 py-4 font-bold text-text-muted uppercase tracking-wider text-xs text-center"
                    >Écrire</th
                  >
                  <th
                    class="px-5 py-4 font-bold text-text-muted uppercase tracking-wider text-xs text-center"
                    >Gérer les Rôles</th
                  >
                </tr>
              </thead>
              <tbody class="divide-y divide-black/5 dark:divide-white/5">
                {#each communityRoleMatrix as roleItem (roleItem.id)}
                  <tr class="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <td class="px-5 py-4 flex items-center gap-2.5 font-bold text-text-main">
                      <div
                        class="p-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      >
                        <Key size={16} strokeWidth={2.5} />
                      </div>
                      {roleItem.label}
                    </td>

                    <td class="px-5 py-4 text-center">
                      <div class="flex justify-center">
                        {#if roleItem.permissions.read}
                          <div
                            class="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400"
                          >
                            <Check size={14} strokeWidth={3} />
                          </div>
                        {:else}
                          <Minus size={16} class="text-text-muted opacity-50" strokeWidth={3} />
                        {/if}
                      </div>
                    </td>

                    <td class="px-5 py-4 text-center">
                      <div class="flex justify-center">
                        {#if roleItem.permissions.write}
                          <div
                            class="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400"
                          >
                            <Check size={14} strokeWidth={3} />
                          </div>
                        {:else}
                          <Minus size={16} class="text-text-muted opacity-50" strokeWidth={3} />
                        {/if}
                      </div>
                    </td>

                    <td class="px-5 py-4 text-center">
                      <div class="flex justify-center">
                        {#if roleItem.permissions.roleManage}
                          <div
                            class="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400"
                          >
                            <Check size={14} strokeWidth={3} />
                          </div>
                        {:else}
                          <Minus size={16} class="text-text-muted opacity-50" strokeWidth={3} />
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
            <!-- Input Identifiant -->
            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="invite-id"
              >
                <Users size={14} /> Identifiant de l'utilisateur
              </label>
              <input
                id="invite-id"
                class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-amber-500/50 shadow-inner transition-all text-sm font-medium placeholder:font-normal placeholder:opacity-60"
                placeholder="ex: jolan.dupont"
                bind:value={permissionMembersId}
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
