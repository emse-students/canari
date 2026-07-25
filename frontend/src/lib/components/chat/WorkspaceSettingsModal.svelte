<script lang="ts">
  import { Shield, Settings, Users, Trash2, LogOut, Check, UserPlus, Loader } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import PermissionGrid, {
    type PermissionGridRole,
    type PermissionGridOverride,
    type PermissionGridPermission,
  } from '../shared/PermissionGrid.svelte';
  import { channelService } from '$lib/services/ChannelService';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Workspace ID (UUID from DB). */
    workspaceId: string;
    /** Workspace display name. */
    workspaceName: string;
    /** Workspace slug. */
    workspaceSlug: string;
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback when the user leaves the workspace. */
    onLeaveWorkspace?: (workspaceId: string) => void;
    /** Callback to invite a member. */
    onInviteMember?: (memberId: string, role: 'member' | 'moderator' | 'admin') => Promise<void>;
    /** Callback to update a member's role. */
    onUpdateMemberRole?: (memberId: string, role: 'member' | 'moderator' | 'admin') => void;
  }

  let {
    open,
    workspaceId,
    workspaceName,
    workspaceSlug,
    onClose,
    onLeaveWorkspace,
    onInviteMember,
    onUpdateMemberRole,
  }: Props = $props();

  let activeTab = $state<'overview' | 'roles' | 'members'>('overview');

  // ── Roles & Permissions state ──────────────────────────────────────────
  let rolesLoading = $state(false);
  let rolesError = $state('');
  let workspaceRoles: PermissionGridRole[] = $state([]);
  let roleOverrides: PermissionGridOverride[] = $state([]);
  let roleBasePermissions: Record<string, string[]> = $state({});
  let roleSaving: Record<string, boolean> = $state({});

  /** All workspace-level permissions (editable for roles). */
  const roleGridPermissions: PermissionGridPermission[] = [
    {
      key: 'channel.view',
      label: 'Voir les canaux',
      tooltip: 'Voir les canaux dans la liste de la communauté.',
    },
    {
      key: 'channel.read',
      label: 'Lire les messages',
      tooltip: 'Lire les messages dans les canaux.',
    },
    {
      key: 'channel.send',
      label: 'Envoyer des messages',
      tooltip: 'Envoyer des messages dans les canaux.',
    },
    {
      key: 'channel.upload',
      label: 'Envoyer des fichiers',
      tooltip: 'Envoyer des pièces jointes.',
    },
    {
      key: 'channel.manage',
      label: 'Gérer les canaux',
      tooltip: 'Créer, renommer, archiver des canaux.',
    },
    {
      key: 'channel.moderate',
      label: 'Modérer les messages',
      tooltip: 'Épingler ou supprimer les messages des autres.',
    },
    {
      key: 'member.invite',
      label: 'Inviter des membres',
      tooltip: 'Inviter de nouveaux membres dans la communauté.',
    },
    {
      key: 'member.kick',
      label: 'Expulser des membres',
      tooltip: 'Expulser des membres de la communauté.',
    },
    {
      key: 'role.manage',
      label: 'Gérer les rôles',
      tooltip: 'Créer, modifier ou supprimer les rôles.',
    },
    {
      key: 'workspace.manage',
      label: 'Gérer la communauté',
      tooltip: 'Droits administrateur complets.',
    },
  ];

  // ── Members state ──────────────────────────────────────────────────────
  let membersLoading = $state(false);
  let membersError = $state('');
  let workspaceMembers: Array<{ id: string; userId: string; role: string; joinedAt: string }> =
    $state([]);
  let memberRoleSelections: Record<string, 'member' | 'moderator' | 'admin'> = $state({});
  let memberRoleSaving: Record<string, boolean> = $state({});
  let memberRemoving: Record<string, boolean> = $state({});

  // ── Invite state ───────────────────────────────────────────────────────
  let inviteUserId = $state('');
  let inviteRole = $state<'member' | 'moderator' | 'admin'>('member');
  let inviteLoading = $state(false);
  let inviteError = $state('');

  // ── Shareable invite link ──────────────────────────────────────────────
  let shareLink = $state('');
  let shareLoading = $state(false);
  let shareError = $state('');
  let shareCopied = $state(false);

  $effect(() => {
    if (open && activeTab === 'roles' && workspaceRoles.length === 0) {
      void loadRolesAndPermissions();
    }
    if (open && activeTab === 'members' && workspaceMembers.length === 0) {
      void loadMembers();
    }
    if (!open) {
      activeTab = 'overview';
      workspaceRoles = [];
      roleBasePermissions = {};
      roleOverrides = [];
      workspaceMembers = [];
      memberRoleSelections = {};
      inviteUserId = '';
      inviteRole = 'member';
      inviteError = '';
      shareLink = '';
      shareCopied = false;
    }
  });

  async function loadRolesAndPermissions() {
    rolesLoading = true;
    rolesError = '';
    try {
      // Load roles from the workspace
      const wsData = (await channelService.getWorkspaceBySlug(workspaceSlug)) as any;
      const roles: PermissionGridRole[] = (wsData?.roles ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        priority: r.priority ?? 10,
      }));
      workspaceRoles = roles;

      // Load base permissions for each role
      const perms: Record<string, string[]> = {};
      for (const role of roles) {
        try {
          const data = await channelService.getRolePermissions(role.id);
          perms[role.id] = data.permissions ?? [];
        } catch {
          perms[role.id] = [];
        }
      }
      roleBasePermissions = perms;

      // Build overrides from base permissions (PermissionGrid expects overrides format)
      const overrides: PermissionGridOverride[] = [];
      for (const role of roles) {
        const rolePerms = perms[role.id] ?? [];
        for (const perm of rolePerms) {
          overrides.push({ roleId: role.id, permission: perm, value: 'allow' as const });
        }
      }
      roleOverrides = overrides;
    } catch (e) {
      rolesError = e instanceof Error ? e.message : 'Erreur lors du chargement des rôles.';
    } finally {
      rolesLoading = false;
    }
  }

  async function handleRolePermissionToggle(
    roleId: string,
    permissionKey: string,
    value: 'allow' | 'deny' | 'neutral'
  ) {
    roleSaving = { ...roleSaving, [roleId]: true };
    try {
      const currentPerms = roleBasePermissions[roleId] ?? [];
      let newPerms: string[];
      if (value === 'allow') {
        newPerms = [...new Set([...currentPerms, permissionKey])];
      } else {
        newPerms = currentPerms.filter((p) => p !== permissionKey);
      }
      await channelService.setRolePermissions(roleId, newPerms);
      roleBasePermissions = { ...roleBasePermissions, [roleId]: newPerms };
      // Update overrides
      if (value === 'neutral') {
        roleOverrides = roleOverrides.filter(
          (o) => !(o.roleId === roleId && o.permission === permissionKey)
        );
      } else if (value === 'allow') {
        const existing = roleOverrides.findIndex(
          (o) => o.roleId === roleId && o.permission === permissionKey
        );
        if (existing >= 0) {
          roleOverrides[existing] = { ...roleOverrides[existing], value };
          roleOverrides = [...roleOverrides];
        } else {
          roleOverrides = [...roleOverrides, { roleId, permission: permissionKey, value }];
        }
      }
    } catch (e) {
      rolesError = e instanceof Error ? e.message : 'Erreur lors de la mise à jour.';
    } finally {
      const updated = { ...roleSaving };
      delete updated[roleId];
      roleSaving = updated;
    }
  }

  async function loadMembers() {
    membersLoading = true;
    membersError = '';
    try {
      const wsData = (await channelService.getWorkspaceBySlug(workspaceSlug)) as any;
      const members: Array<{ id: string; userId: string; role: string; joinedAt: string }> = [];
      if (wsData?.members) {
        for (const m of wsData.members) {
          const memberRoles = (wsData.roles ?? []).filter((r: any) =>
            (m.roleIds ?? []).includes(r.id)
          );
          const highestRole = memberRoles.sort(
            (a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0)
          )[0];
          const roleName = highestRole?.name ?? 'Membre';
          const canonicalRole =
            roleName.toLowerCase().includes('admin') ||
            roleName.toLowerCase().includes('administrateur')
              ? 'admin'
              : roleName.toLowerCase().includes('modérateur') ||
                  roleName.toLowerCase().includes('moderateur')
                ? 'moderator'
                : 'member';
          members.push({
            id: m.id,
            userId: m.userId,
            role: canonicalRole,
            joinedAt: m.createdAt ?? '',
          });
        }
      }
      workspaceMembers = members;
      const selections: Record<string, 'member' | 'moderator' | 'admin'> = {};
      for (const m of members) {
        selections[m.userId] = m.role as 'member' | 'moderator' | 'admin';
      }
      memberRoleSelections = selections;
    } catch (e) {
      membersError = e instanceof Error ? e.message : 'Erreur lors du chargement des membres.';
    } finally {
      membersLoading = false;
    }
  }

  async function handleMemberRoleUpdate(userId: string) {
    const newRole = memberRoleSelections[userId];
    if (!newRole) return;
    memberRoleSaving = { ...memberRoleSaving, [userId]: true };
    try {
      onUpdateMemberRole?.(userId, newRole);
      await loadMembers();
    } catch {
      // handled by parent
    } finally {
      const updated = { ...memberRoleSaving };
      delete updated[userId];
      memberRoleSaving = updated;
    }
  }

  async function handleRemoveMember(userId: string) {
    const confirmed = await showConfirm(
      'Retirer ce membre de la communauté ? Il sera retiré de tous les canaux.',
      {
        danger: true,
        confirmLabel: 'Retirer',
      }
    );
    if (!confirmed) return;
    memberRemoving = { ...memberRemoving, [userId]: true };
    try {
      await channelService.kickFromWorkspace(workspaceId, userId);
      await loadMembers();
    } catch (e) {
      membersError = e instanceof Error ? e.message : 'Erreur lors du retrait.';
    } finally {
      const updated = { ...memberRemoving };
      delete updated[userId];
      memberRemoving = updated;
    }
  }

  async function handleInviteAction() {
    const id = inviteUserId.trim();
    if (!id) return;
    inviteLoading = true;
    inviteError = '';
    const savedId = inviteUserId;
    const savedRole = inviteRole;
    inviteUserId = '';
    inviteRole = 'member';
    try {
      await onInviteMember?.(savedId, savedRole);
    } catch (e) {
      inviteError = e instanceof Error ? e.message : "Erreur lors de l'invitation.";
      inviteUserId = savedId;
      inviteRole = savedRole;
    } finally {
      inviteLoading = false;
    }
  }

  async function generateShareLink() {
    shareLoading = true;
    shareError = '';
    shareCopied = false;
    try {
      const { publicAppUrl } = await import('$lib/utils/publicAppUrl');
      const { token } = await channelService.createWorkspaceInvite(workspaceId);
      shareLink = publicAppUrl(`/c/join/${token}`);
      try {
        await navigator.clipboard.writeText(shareLink);
        shareCopied = true;
      } catch {
        // Clipboard may be blocked
      }
    } catch (e) {
      shareError = e instanceof Error ? e.message : 'Erreur lors de la génération du lien.';
    } finally {
      shareLoading = false;
    }
  }

  async function handleLeaveWorkspace() {
    const confirmed = await showConfirm(`Quitter la communauté "${workspaceName}" ?`, {
      danger: true,
      confirmLabel: 'Quitter',
    });
    if (!confirmed) return;
    onLeaveWorkspace?.(workspaceId);
    onClose();
  }
</script>

<Modal {open} {onClose} title="Paramètres de la communauté" maxWidth="max-w-4xl">
  <div class="-mx-6 -my-4 flex flex-col md:flex-row h-full md:h-[65vh] max-h-[800px]">
    <!-- Barre de menu latérale -->
    <div
      class="w-full md:w-64 shrink-0 bg-white/40 dark:bg-black/20 border-b md:border-b-0 md:border-r border-black/5 dark:border-white/10 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-3 md:p-5 gap-2 md:gap-1 custom-scrollbar"
    >
      <h3
        class="hidden md:flex text-[0.7rem] font-extrabold uppercase tracking-widest text-text-muted mb-3 px-2 items-center gap-2"
      >
        <span class="text-violet-500 text-lg leading-none">⚡</span>
        <span class="truncate">{workspaceName}</span>
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-violet-500 {activeTab ===
        'overview'
          ? 'bg-violet-500/15 dark:bg-violet-500/20 text-violet-700 dark:text-violet-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Settings size={18} strokeWidth={2.5} />
        Vue d'ensemble
      </button>

      <button
        onclick={() => (activeTab = 'roles')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-violet-500 {activeTab ===
        'roles'
          ? 'bg-violet-500/15 dark:bg-violet-500/20 text-violet-700 dark:text-violet-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Shield size={18} strokeWidth={2.5} />
        Rôles & Permissions
      </button>

      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-violet-500 {activeTab ===
        'members'
          ? 'bg-violet-500/15 dark:bg-violet-500/20 text-violet-700 dark:text-violet-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Users size={18} strokeWidth={2.5} />
        Membres
      </button>

      <!-- Danger zone -->
      <div class="hidden md:flex md:flex-col mt-auto pt-6 gap-2">
        <button
          type="button"
          onclick={handleLeaveWorkspace}
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <LogOut size={18} strokeWidth={2.5} />
          Quitter la communauté
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
            <div
              class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 space-y-3 shadow-sm"
            >
              <p class="text-xs font-bold uppercase tracking-wider text-text-muted">Informations</p>
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-text-muted w-20">Nom :</span>
                  <span class="text-sm font-bold text-text-main">{workspaceName}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-text-muted w-20">Slug :</span>
                  <span class="text-sm font-mono text-text-main">{workspaceSlug}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Danger zone mobile -->
          <div class="md:hidden pt-6 border-t border-black/10 dark:border-white/10 space-y-3">
            <h3 class="text-xs font-bold uppercase tracking-wider text-red-500 px-1 mb-2">
              Zone de danger
            </h3>
            <button
              type="button"
              onclick={handleLeaveWorkspace}
              class="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 active:scale-[0.98] transition-all"
            >
              <LogOut size={18} strokeWidth={2.5} />
              Quitter la communauté
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= ONGLET : RÔLES & PERMISSIONS ================= -->
      {#if activeTab === 'roles'}
        <div class="space-y-6 max-w-4xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">Rôles & Permissions</h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              Gérez les rôles de la communauté et leurs permissions de base. Ces permissions
              s'appliquent à tous les canaux (sauf si des overrides sont définis par canal).
            </p>
          </div>

          {#if rolesLoading}
            <div class="flex items-center gap-2 text-sm text-text-muted">
              <Loader size={16} class="animate-spin" />
              Chargement...
            </div>
          {:else if rolesError}
            <div
              class="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-sm border border-red-200 dark:border-red-800"
            >
              {rolesError}
            </div>
          {:else if workspaceRoles.length === 0}
            <p class="text-sm text-text-muted italic">Aucun rôle trouvé.</p>
          {:else}
            <div
              class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 space-y-4 shadow-sm"
            >
              <PermissionGrid
                roles={workspaceRoles}
                permissions={roleGridPermissions}
                overrides={roleOverrides}
                onToggle={handleRolePermissionToggle}
                lockAdmin={false}
              />
            </div>
          {/if}
        </div>
      {/if}

      <!-- ================= ONGLET : MEMBRES ================= -->
      {#if activeTab === 'members'}
        <div class="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">Membres</h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              Gérez les membres de la communauté, leurs rôles et les invitations.
            </p>
          </div>

          <!-- Liste des membres -->
          <div
            class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 md:p-6 space-y-4 shadow-sm"
          >
            <p
              class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
            >
              <Users size={14} />
              Membres de la communauté
            </p>

            {#if membersLoading}
              <div class="flex items-center gap-2 text-sm text-text-muted">
                <Loader size={14} class="animate-spin" />
                Chargement...
              </div>
            {:else if membersError}
              <p class="text-xs font-medium text-red-600 dark:text-red-400">{membersError}</p>
            {:else if workspaceMembers.length === 0}
              <p class="text-sm text-text-muted italic">Aucun membre.</p>
            {:else}
              <ul class="space-y-2">
                {#each workspaceMembers as member (member.userId)}
                  <li
                    class="flex items-center justify-between gap-3 rounded-xl bg-black/5 dark:bg-white/5 px-3 py-2.5"
                  >
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                      <Avatar userId={member.userId} size="sm" />
                      <UserName
                        userId={member.userId}
                        class="text-sm font-medium text-text-main truncate"
                      />
                      <span
                        class="shrink-0 text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full {member.role ===
                        'admin'
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                          : member.role === 'moderator'
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}"
                      >
                        {member.role === 'admin'
                          ? 'Admin'
                          : member.role === 'moderator'
                            ? 'Modéro'
                            : 'Membre'}
                      </span>
                    </div>

                    <div class="flex items-center gap-1.5 shrink-0">
                      <div class="relative">
                        <select
                          class="w-32 bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-lg px-2 py-1.5 text-xs font-semibold outline-none focus:ring-1 focus:ring-violet-500/50 appearance-none disabled:opacity-50"
                          value={memberRoleSelections[member.userId] ?? member.role}
                          disabled={memberRoleSaving[member.userId]}
                          onchange={async (e) => {
                            const val = (e.target as HTMLSelectElement).value;
                            if (val === 'member' || val === 'moderator' || val === 'admin') {
                              memberRoleSelections = {
                                ...memberRoleSelections,
                                [member.userId]: val,
                              };
                              // Auto-save on change
                              await handleMemberRoleUpdate(member.userId);
                            }
                          }}
                        >
                          <option value="member">Membre</option>
                          <option value="moderator">Modérateur</option>
                          <option value="admin">Administrateur</option>
                        </select>
                        {#if memberRoleSaving[member.userId]}
                          <span class="absolute right-1.5 top-1/2 -translate-y-1/2">
                            <Loader size={12} class="animate-spin text-violet-500" />
                          </span>
                        {/if}
                      </div>

                      <button
                        type="button"
                        onclick={() => handleRemoveMember(member.userId)}
                        disabled={memberRemoving[member.userId]}
                        class="rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-1"
                        title="Retirer de la communauté"
                      >
                        {#if memberRemoving[member.userId]}
                          <Loader size={12} class="animate-spin" />
                        {:else}
                          <Trash2 size={12} strokeWidth={2.5} />
                        {/if}
                      </button>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- Invitation -->
          <div
            class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 md:p-6 space-y-5 shadow-sm"
          >
            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="ws-invite-autocomplete"
              >
                <Users size={14} />
                Inviter un membre
              </label>
              <UserAutocomplete
                value={inviteUserId}
                onValueChange={(v) => (inviteUserId = v)}
                placeholder="Rechercher un utilisateur..."
                inputId="ws-invite-autocomplete"
              />
            </div>

            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="ws-role-select"
              >
                <Shield size={14} />
                Rôle
              </label>
              <select
                id="ws-role-select"
                class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-violet-500/50 shadow-inner transition-all text-sm font-semibold appearance-none"
                bind:value={inviteRole}
              >
                <option value="member">Membre</option>
                <option value="moderator">Modérateur</option>
                <option value="admin">Administrateur</option>
              </select>
            </div>

            <div
              class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-black/5 dark:border-white/10"
            >
              <button
                type="button"
                onclick={handleInviteAction}
                disabled={!inviteUserId.trim() || inviteLoading}
                class="flex-1 rounded-xl bg-violet-500 px-4 py-3 text-sm font-bold text-white hover:bg-violet-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-violet-500/20 disabled:shadow-none"
              >
                <UserPlus size={18} strokeWidth={2.5} />
                {inviteLoading ? 'Envoi...' : 'Inviter'}
              </button>
            </div>
            {#if inviteError}
              <p class="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{inviteError}</p>
            {/if}
          </div>

          <!-- Lien d'invitation -->
          <div
            class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 md:p-6 space-y-3 shadow-sm"
          >
            <p class="text-xs font-bold uppercase tracking-wider text-text-muted">
              Lien d'invitation
            </p>
            <p class="text-sm text-text-muted leading-relaxed">
              Générez un lien partageable pour inviter de nouveaux membres à rejoindre la
              communauté.
            </p>
            {#if shareLink}
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  readonly
                  value={shareLink}
                  class="flex-1 min-w-0 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
                />
                <button
                  type="button"
                  onclick={generateShareLink}
                  class="shrink-0 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold hover:bg-cn-bg"
                >
                  Régénérer
                </button>
              </div>
              {#if shareCopied}
                <p class="text-xs font-semibold text-emerald-600">Lien copié !</p>
              {/if}
            {:else}
              <button
                type="button"
                onclick={generateShareLink}
                disabled={shareLoading}
                class="rounded-xl bg-violet-500 px-4 py-2 text-sm font-bold text-white hover:bg-violet-400 disabled:opacity-50"
              >
                {shareLoading ? 'Génération...' : "Générer un lien d'invitation"}
              </button>
            {/if}
            {#if shareError}
              <p class="text-xs font-medium text-red-600 dark:text-red-400">{shareError}</p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
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
