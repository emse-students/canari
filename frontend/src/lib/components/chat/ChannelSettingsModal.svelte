<script lang="ts">
  import { Shield, Settings, Users, Key, Trash2 } from 'lucide-svelte';
  import Modal from '../shared/Modal.svelte';

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
    onClose: () => void;
  }

  let {
    open,
    selectedChannelId,
    channelWorkspaces,
    onInviteMember,
    onUpdateMemberRole,
    onClose,
  }: Props = $props();

  let activeTab = $state<'overview' | 'permissions' | 'invites'>('permissions');

  let selectedWorkspace = $derived(
    channelWorkspaces.find((w) => w.channels.some((c) => c.id === selectedChannelId))
  );

  let selectedChannel = $derived(
    selectedWorkspace?.channels.find((c) => c.id === selectedChannelId)
  );

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
      label: 'Admin',
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
      label: 'Moderateur',
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

  function permissionMark(hasPerm: boolean) {
    return hasPerm ? '✓' : '—';
  }

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
</script>

<Modal {open} {onClose} title="Paramètres du canal" maxWidth="max-w-4xl">
  <div class="flex flex-col md:flex-row h-[70vh] min-h-[500px] border-t border-cn-border/40">
    <!-- Barre de menu à gauche -->
    <div
      class="w-full md:w-64 bg-[color-mix(in_srgb,var(--cn-surface)_60%,white)] border-r border-cn-border/40 flex flex-col p-4 space-y-1"
    >
      <h3 class="text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2">
        #{selectedChannel ? selectedChannel.name : 'Canal'}
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
        onclick={() => (activeTab = 'permissions')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'permissions'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Shield size={18} />
        Permissions
      </button>
      <button
        onclick={() => (activeTab = 'invites')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'invites'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Users size={18} />
        Invitations & Rôles
      </button>

      <div class="mt-auto pt-4 space-y-2">
        <button
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors w-full"
        >
          <Trash2 size={18} />
          Supprimer le canal
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="flex-1 bg-white/50 p-6 overflow-y-auto">
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">Vue d'ensemble</h2>
          <div class="space-y-4">
            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="channel-name"
                >Nom du canal</label
              >
              <input
                id="channel-name"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50"
                value={selectedChannel ? selectedChannel.name : ''}
              />
            </div>
            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="channel-desc"
                >Description</label
              >
              <textarea
                id="channel-desc"
                rows="3"
                placeholder="Règles ou sujet principal de ce canal..."
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
              ></textarea>
            </div>
          </div>
        </div>
      {/if}

      {#if activeTab === 'permissions'}
        <div class="space-y-6 max-w-3xl">
          <h2 class="text-xl font-bold text-text-main">Permissions</h2>
          <p class="text-sm text-text-muted">
            Ajustez les privilèges des rôles pour ce canal spécifique. Les permissions définies ici
            écrasent celles du serveur.
          </p>

          <div class="border border-cn-border rounded-xl overflow-hidden bg-white">
            <table class="min-w-full text-sm">
              <thead class="bg-black/5 border-b border-cn-border">
                <tr class="text-left text-text-muted">
                  <th class="px-4 py-3 font-semibold">Rôle</th>
                  <th class="px-4 py-3 font-semibold text-center">Lire</th>
                  <th class="px-4 py-3 font-semibold text-center">Écrire</th>
                  <th class="px-4 py-3 font-semibold text-center">Modérer</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-cn-border line-height">
                {#each communityRoleMatrix as roleItem (roleItem.id)}
                  <tr class="text-text-main hover:bg-black/5 transition-colors">
                    <td class="px-4 py-3 flex items-center gap-2 font-medium">
                      <Key size={14} class="text-amber-500" />
                      {roleItem.label}
                    </td>
                    <td class="px-4 py-3 text-center text-green-600 font-bold"
                      >{permissionMark(roleItem.permissions.read)}</td
                    >
                    <td class="px-4 py-3 text-center text-green-600 font-bold"
                      >{permissionMark(roleItem.permissions.write)}</td
                    >
                    <td
                      class="px-4 py-3 text-center {roleItem.permissions.roleManage
                        ? 'text-green-600 font-bold'
                        : 'text-gray-400'}"
                    >
                      {permissionMark(roleItem.permissions.roleManage)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}

      {#if activeTab === 'invites'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">Gérer les accès</h2>
          <p class="text-sm text-text-muted">Invitez des membres ou modifiez leurs rôles.</p>

          <div class="bg-white border border-cn-border rounded-xl p-5 space-y-4 shadow-sm">
            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="invite-id"
                >Identifiant de l'utilisateur</label
              >
              <input
                id="invite-id"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50"
                placeholder="Ex: jolan"
                bind:value={permissionMembersId}
              />
            </div>

            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="role-select"
                >Rôle à attribuer</label
              >
              <select
                id="role-select"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50"
                bind:value={permissionRole}
              >
                <option value="member">Membre</option>
                <option value="moderator">Modérateur</option>
                <option value="admin">Administrateur</option>
              </select>
            </div>

            <div class="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onclick={handleInviteAction}
                disabled={!permissionMembersId.trim()}
                class="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Users size={16} /> Envoyer l'invitation
              </button>
              <button
                type="button"
                onclick={handleUpdateRoleAction}
                disabled={!permissionMembersId.trim()}
                class="rounded-xl border border-cn-border bg-white px-4 py-2.5 text-sm font-semibold text-text-main hover:bg-black/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Shield size={16} /> Mettre à jour le rôle
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>
