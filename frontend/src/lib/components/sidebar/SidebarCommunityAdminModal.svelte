<script lang="ts">
  import {
    Settings,
    Users,
    Shield,
    Trash2,
    ShieldCheck,
    Upload,
    Loader,
    Link2,
  } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import PermissionGrid, {
    type PermissionGridRole,
    type PermissionGridOverride,
    type PermissionGridPermission,
  } from '../shared/PermissionGrid.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { channelService } from '$lib/services/ChannelService';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface ChannelItem {
    id: string;
    name: string;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    imageMediaId?: string | null;
    workspaceDbId?: string;
    /** Server-authoritative: true when the current user holds MANAGE_WORKSPACE here. Gates admin controls. */
    viewerCanManage?: boolean;
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
    /** Callback to send a community membership invitation with the given role. Rejects on key-distribution failure. */
    onInviteCommunityMember?: (
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => Promise<void>;
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

  type CanonicalRole = 'member' | 'moderator' | 'admin';

  let activeTab = $state<'overview' | 'roles' | 'members'>('overview');

  let selectedWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  );

  /**
   * Whether the current user may manage this workspace, per the server-authoritative
   * MANAGE_WORKSPACE flag. Admin-only controls (image, roles, member management) stay hidden
   * until the backend listing confirms the permission (fail-closed).
   */
  let canManage = $derived(selectedWorkspace?.viewerCanManage ?? false);

  const mediaService = new MediaService();

  // ── Image / invite state ────────────────────────────────────────────────
  let imageUploading = $state(false);
  let imageUploadError = $state('');
  let inviteStatus = $state('');
  let inviteUserId = $state('');
  let inviteRole = $state<CanonicalRole>('member');
  let inviteLoading = $state(false);

  // ── Members state ─────────────────────────────────────────────────────────
  let communityMembers = $state<Array<{ userId: string; role: CanonicalRole }>>([]);
  let membersLoading = $state(false);
  let membersError = $state('');
  let membersLoadToken = 0;
  let memberRoleSaving = $state<Record<string, boolean>>({});
  let memberRemoving = $state<Record<string, boolean>>({});

  // ── Roles & permissions state ───────────────────────────────────────────
  let rolesLoading = $state(false);
  let rolesError = $state('');
  let workspaceRoles = $state<PermissionGridRole[]>([]);
  let roleOverrides = $state<PermissionGridOverride[]>([]);
  let roleBasePermissions = $state<Record<string, string[]>>({});
  let roleSaving = $state<Record<string, boolean>>({});

  // ── Shareable invite link ─────────────────────────────────────────────────
  let shareLink = $state('');
  let shareLoading = $state(false);
  let shareError = $state('');
  let shareCopied = $state(false);

  /** All workspace-level permissions, editable per role in the grid. */
  const roleGridPermissions: PermissionGridPermission[] = [
    {
      key: 'channel.access',
      label: m.chat_permission_access_channel_label(),
      tooltip: m.chat_permission_access_channel_tooltip(),
    },
    {
      key: 'channel.send',
      label: m.chat_permission_send_messages_label(),
      tooltip: m.chat_permission_send_messages_tooltip(),
    },
    {
      key: 'channel.manage',
      label: m.chat_permission_manage_channel_label(),
      tooltip: m.chat_permission_manage_channel_tooltip(),
    },
    {
      key: 'channel.moderate',
      label: m.chat_permission_moderate_label(),
      tooltip: m.chat_permission_moderate_tooltip(),
    },
    {
      key: 'member.invite',
      label: m.chat_permission_invite_label(),
      tooltip: m.chat_permission_invite_tooltip(),
    },
    {
      key: 'member.kick',
      label: m.chat_permission_kick_label(),
      tooltip: m.chat_permission_kick_tooltip(),
    },
    {
      key: 'role.manage',
      label: m.chat_permission_manage_roles_label(),
      tooltip: m.chat_permission_manage_roles_tooltip(),
    },
    {
      key: 'workspace.manage',
      label: m.chat_permission_manage_workspace_label(),
      tooltip: m.chat_permission_manage_workspace_tooltip(),
    },
  ];

  function normalizeRoleLabel(roleName: string): CanonicalRole {
    const normalized = roleName.trim().toLowerCase();
    if (normalized.includes('admin')) return 'admin';
    if (normalized.includes('mod')) return 'moderator';
    return 'member';
  }

  /** Maps a canonical role to the workspace role name the backend stores. */
  function roleToBackendName(role: CanonicalRole): string {
    if (role === 'admin') return 'Administrateur';
    if (role === 'moderator') return 'Modérateur';
    return 'Membre';
  }

  function roleLabel(role: CanonicalRole): string {
    if (role === 'admin') return m.chat_role_admin();
    if (role === 'moderator') return m.chat_role_moderator();
    return m.chat_role_member();
  }

  function roleBadgeClass(role: CanonicalRole): string {
    if (role === 'admin') return 'bg-red-500/10 text-red-600 dark:text-red-400';
    if (role === 'moderator') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  }

  /** Loads members + their highest role from the workspace listing (server-authoritative). */
  async function loadCommunityMembers() {
    if (!selectedWorkspace) return;
    const loadToken = ++membersLoadToken;
    membersLoading = true;
    membersError = '';
    try {
      const wsData = (await channelService.getWorkspaceBySlug(selectedWorkspace.id)) as {
        members?: Array<{ userId: string; roleIds?: string[] }>;
        roles?: Array<{ id: string; name: string; priority?: number }>;
      };
      if (loadToken !== membersLoadToken) return;

      const roles = wsData.roles ?? [];
      const members = (wsData.members ?? []).map((mem) => {
        const memberRoles = roles.filter((r) => (mem.roleIds ?? []).includes(r.id));
        const highest = memberRoles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
        return { userId: mem.userId, role: normalizeRoleLabel(highest?.name ?? 'member') };
      });
      communityMembers = members.sort((a, b) => a.userId.localeCompare(b.userId));
    } catch (e) {
      if (loadToken !== membersLoadToken) return;
      membersError = e instanceof Error ? e.message : m.chat_community_load_members_error();
      communityMembers = [];
    } finally {
      if (loadToken === membersLoadToken) membersLoading = false;
    }
  }

  /** Loads workspace roles and their base permissions for the permission grid. */
  async function loadRolesAndPermissions() {
    if (!selectedWorkspace) return;
    rolesLoading = true;
    rolesError = '';
    try {
      const wsData = (await channelService.getWorkspaceBySlug(selectedWorkspace.id)) as {
        roles?: Array<{ id: string; name: string; priority?: number }>;
      };
      const roles: PermissionGridRole[] = (wsData.roles ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority ?? 10,
      }));
      workspaceRoles = roles;

      const perms: Record<string, string[]> = {};
      const overrides: PermissionGridOverride[] = [];
      for (const role of roles) {
        try {
          const data = await channelService.getRolePermissions(role.id);
          perms[role.id] = data.permissions ?? [];
        } catch {
          perms[role.id] = [];
        }
        for (const perm of perms[role.id]) {
          overrides.push({ roleId: role.id, permission: perm, value: 'allow' });
        }
      }
      roleBasePermissions = perms;
      roleOverrides = overrides;
    } catch (e) {
      rolesError = e instanceof Error ? e.message : m.chat_community_load_members_error();
    } finally {
      rolesLoading = false;
    }
  }

  /**
   * Handles a workspace role permission toggle from the PermissionGrid.
   * With `disableDeny`, only `allow` and `neutral` are ever emitted; `deny` is kept
   * in the signature for type compatibility with the grid's callback type.
   */
  async function handleRolePermissionToggle(
    roleId: string,
    permissionKey: string,
    value: 'allow' | 'deny' | 'neutral'
  ) {
    Log.d('handleRolePermissionToggle', { roleId, permissionKey, value });
    roleSaving = { ...roleSaving, [roleId]: true };
    try {
      const current = roleBasePermissions[roleId] ?? [];
      // A base permission is either granted or not: only `allow` adds it; neutral removes it.
      const next =
        value === 'allow'
          ? [...new Set([...current, permissionKey])]
          : current.filter((p) => p !== permissionKey);
      await channelService.setRolePermissions(roleId, next);
      roleBasePermissions = { ...roleBasePermissions, [roleId]: next };
      roleOverrides = [
        ...roleOverrides.filter((o) => !(o.roleId === roleId && o.permission === permissionKey)),
        ...(value === 'allow'
          ? [{ roleId, permission: permissionKey, value: 'allow' as const }]
          : []),
      ];
    } catch (e) {
      rolesError = e instanceof Error ? e.message : m.common_save_error();
    } finally {
      const updated = { ...roleSaving };
      delete updated[roleId];
      roleSaving = updated;
    }
  }

  /** Persists a member's new role via the workspace-scoped endpoint, then refreshes the list. */
  async function handleMemberRoleUpdate(userId: string, role: CanonicalRole) {
    const workspaceDbId = selectedWorkspace?.workspaceDbId;
    if (!workspaceDbId) return;
    memberRoleSaving = { ...memberRoleSaving, [userId]: true };
    try {
      await channelService.updateWorkspaceMemberRole(
        workspaceDbId,
        userId,
        roleToBackendName(role)
      );
      await loadCommunityMembers();
    } catch (e) {
      membersError = e instanceof Error ? e.message : m.common_save_error();
    } finally {
      const updated = { ...memberRoleSaving };
      delete updated[userId];
      memberRoleSaving = updated;
    }
  }

  async function handleRemoveMember(userId: string) {
    const workspaceDbId = selectedWorkspace?.workspaceDbId;
    if (!workspaceDbId) return;
    if (
      !(await showConfirm(m.chat_community_remove_member_confirm(), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    ) {
      return;
    }
    memberRemoving = { ...memberRemoving, [userId]: true };
    try {
      await channelService.kickFromWorkspace(workspaceDbId, userId);
      communityMembers = communityMembers.filter((mem) => mem.userId !== userId);
    } catch (e) {
      membersError = e instanceof Error ? e.message : m.common_save_error();
    } finally {
      const updated = { ...memberRemoving };
      delete updated[userId];
      memberRemoving = updated;
    }
  }

  async function handleGenerateInvitation() {
    const memberId = inviteUserId.trim();
    if (!selectedWorkspace?.name) {
      inviteStatus = m.chat_community_select_first_error();
      return;
    }
    if (!memberId) {
      inviteStatus = m.chat_community_select_user_error();
      return;
    }
    if (!onInviteCommunityMember) {
      inviteStatus = m.chat_community_invite_unavailable_error();
      return;
    }
    inviteLoading = true;
    inviteStatus = '';
    const savedId = inviteUserId;
    const savedRole = inviteRole;
    inviteUserId = '';
    inviteRole = 'member';
    try {
      await onInviteCommunityMember(savedId, savedRole);
      inviteStatus = m.chat_community_invite_sent_message({ savedId });
      setTimeout(() => (inviteStatus = ''), 4000);
      void loadCommunityMembers();
    } catch (e) {
      inviteStatus = e instanceof Error ? e.message : m.chat_community_key_distribution_error();
      inviteUserId = savedId;
      inviteRole = savedRole;
    } finally {
      inviteLoading = false;
    }
  }

  async function generateShareLink() {
    const workspaceDbId = selectedWorkspace?.workspaceDbId;
    if (!workspaceDbId) return;
    shareLoading = true;
    shareError = '';
    shareCopied = false;
    try {
      const { publicAppUrl } = await import('$lib/utils/publicAppUrl');
      const { token } = await channelService.createWorkspaceInvite(workspaceDbId);
      shareLink = publicAppUrl(`/c/join/${token}`);
      try {
        await navigator.clipboard.writeText(shareLink);
        shareCopied = true;
      } catch {
        // Clipboard may be blocked; the link stays visible for manual copy.
      }
    } catch (e) {
      shareError = e instanceof Error ? e.message : m.chat_channel_invite_link_error();
    } finally {
      shareLoading = false;
    }
  }

  /** Confirms then leaves/removes the selected community, closing the modal on success. */
  async function leaveCommunity() {
    if (
      !(await showConfirm(
        m.chat_community_leave_confirm({ selectedWorkspace: selectedWorkspace?.name ?? '' }),
        { danger: true, confirmLabel: m.common_leave_button() }
      ))
    ) {
      return;
    }
    onLeaveWorkspace?.(selectedWorkspace?.workspaceDbId ?? '');
    onClose();
  }

  async function handleImageFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !selectedWorkspace?.id) return;
    if (!file.type.startsWith('image/')) {
      imageUploadError = m.chat_community_select_image_error();
      return;
    }
    imageUploading = true;
    imageUploadError = '';
    try {
      const token = await getToken();
      const mediaId = await mediaService.uploadRaw(file, token);
      const targetId = selectedWorkspace.workspaceDbId ?? selectedWorkspace.id;
      onUpdateWorkspaceImage?.(targetId, mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : m.chat_community_upload_error();
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }

  // Load data lazily when a tab becomes active; reset transient state on close.
  $effect(() => {
    void selectedWorkspace?.id;
    if (open && activeTab === 'members') void loadCommunityMembers();
    if (open && activeTab === 'roles') void loadRolesAndPermissions();
    if (!open) {
      inviteStatus = '';
      inviteUserId = '';
      inviteRole = 'member';
      imageUploadError = '';
      shareLink = '';
      shareCopied = false;
      activeTab = 'overview';
    }
  });
</script>

<Modal {open} {onClose} title={m.chat_community_settings_title()} maxWidth="max-w-4xl">
  <div class="flex flex-col md:flex-row min-h-0 border-t border-cn-border/40">
    <!-- Sidebar tabs -->
    <div
      class="w-full md:w-64 md:flex-shrink-0 bg-[color-mix(in_srgb,var(--cn-surface)_60%,white)] border-b md:border-b-0 md:border-r border-cn-border/40 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-2 md:p-4 gap-1 md:space-y-1"
    >
      <h3
        class="hidden md:block text-xs font-bold uppercase tracking-wider text-text-muted mb-2 px-2"
      >
        {selectedWorkspace ? selectedWorkspace.name : m.chat_community_fallback_name()}
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'overview'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Settings size={18} />
        {m.chat_community_overview_tab()}
      </button>
      {#if canManage}
        <button
          onclick={() => (activeTab = 'roles')}
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
          'roles'
            ? 'bg-amber-100 text-amber-900'
            : 'text-text-main hover:bg-black/5'}"
        >
          <Shield size={18} />
          {m.chat_community_roles_tab()}
        </button>
      {/if}
      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'members'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Users size={18} />
        {m.common_members_label()}
      </button>

      <div class="hidden md:block mt-auto pt-4 space-y-2">
        <button
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors w-full"
          onclick={leaveCommunity}
        >
          <Trash2 size={18} />
          {m.chat_community_leave_button()}
        </button>
      </div>
    </div>

    <!-- Main content -->
    <div class="flex-1 bg-white/50 p-6 overflow-y-auto min-h-[300px]">
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">{m.chat_community_overview_tab()}</h2>

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
              {#if canManage}
                <label
                  class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center cursor-pointer hover:bg-amber-600 transition-colors shadow"
                  title={m.chat_community_change_image_title()}
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
              {/if}
            </div>
            <div class="flex-1 space-y-2">
              {#if imageUploadError}
                <p class="text-xs text-red-600">{imageUploadError}</p>
              {/if}
              <label class="text-xs font-bold uppercase text-text-muted" for="server-name"
                >{m.chat_community_name_label()}</label
              >
              <input
                id="server-name"
                class="w-full bg-white border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-amber-500/50 read-only:opacity-60 read-only:cursor-not-allowed"
                value={selectedWorkspace ? selectedWorkspace.name : ''}
                readonly={!canManage}
              />
            </div>
          </div>

          <div
            class="border border-cn-border bg-white rounded-xl p-4 shadow-sm text-sm text-text-main flex items-center gap-3"
          >
            <ShieldCheck size={24} class="text-green-500" />
            <div class="flex-1">
              <span class="font-bold block">{m.chat_community_e2e_active_title()}</span>
              <span class="text-xs text-text-muted">{m.chat_community_e2e_description()}</span>
            </div>
          </div>
        </div>
      {/if}

      {#if activeTab === 'roles'}
        <div class="space-y-6 max-w-3xl">
          <div>
            <h2 class="text-xl font-bold text-text-main mb-1">{m.chat_community_roles_tab()}</h2>
            <p class="text-sm text-text-muted">{m.chat_community_roles_description()}</p>
          </div>

          {#if rolesLoading}
            <div class="flex items-center gap-2 text-sm text-text-muted">
              <Loader size={16} class="animate-spin" />
              {m.common_loading_label()}
            </div>
          {:else if rolesError}
            <div class="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-200">
              {rolesError}
            </div>
          {:else if workspaceRoles.length > 0}
            <div class="border border-cn-border bg-white rounded-xl p-4 shadow-sm">
              <PermissionGrid
                roles={workspaceRoles}
                permissions={roleGridPermissions}
                overrides={roleOverrides}
                onToggle={handleRolePermissionToggle}
                lockAdmin={false}
                disableDeny={true}
              />
            </div>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'members'}
        <div class="space-y-6 max-w-3xl">
          <h2 class="text-xl font-bold text-text-main">{m.common_members_label()}</h2>
          <p class="text-sm text-text-muted">{m.chat_community_members_description()}</p>

          <div class="border border-cn-border rounded-xl bg-white overflow-hidden text-sm">
            <div class="p-4 flex items-center justify-between border-b border-cn-border bg-black/5">
              <span class="font-semibold text-text-main"
                >{communityMembers.length} {m.chat_community_member_count_label()}</span
              >
            </div>
            {#if canManage}
              <div class="px-4 py-3 border-b border-cn-border bg-white/70 space-y-2.5">
                <div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2.5">
                  <UserAutocomplete
                    value={inviteUserId}
                    onValueChange={(v) => (inviteUserId = v)}
                    placeholder={m.chat_community_search_user_placeholder()}
                    inputId="community-invite-autocomplete"
                  />
                  <select
                    bind:value={inviteRole}
                    class="bg-white border border-cn-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/40"
                  >
                    <option value="member">{m.chat_role_member()}</option>
                    <option value="moderator">{m.chat_role_moderator()}</option>
                    <option value="admin">{m.chat_role_admin()}</option>
                  </select>
                  <button
                    class="bg-amber-500 text-white rounded-lg px-3 py-2 text-xs font-bold hover:bg-amber-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    onclick={handleGenerateInvitation}
                    disabled={inviteLoading}
                  >
                    {inviteLoading
                      ? m.common_sending_label()
                      : m.chat_community_generate_invite_button()}
                  </button>
                </div>
              </div>
            {/if}
            {#if inviteStatus}
              <div class="px-4 py-2 border-b border-cn-border text-xs font-medium text-text-muted">
                {inviteStatus}
              </div>
            {/if}
            {#if membersLoading}
              <div class="p-6 text-center text-text-muted">
                {m.chat_community_loading_members()}
              </div>
            {:else if membersError}
              <div class="p-6 text-center text-red-600">{membersError}</div>
            {:else if communityMembers.length === 0}
              <div class="p-6 text-center text-text-muted">{m.chat_community_no_members()}</div>
            {:else}
              <div class="divide-y divide-cn-border/70">
                {#each communityMembers as member (member.userId)}
                  <div class="px-4 py-3 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Avatar userId={member.userId} size="sm" />
                      <UserName
                        userId={member.userId}
                        class="font-medium text-text-main truncate"
                      />
                    </div>
                    {#if canManage}
                      <div class="flex items-center gap-1.5 shrink-0">
                        <div class="relative">
                          <select
                            class="w-32 bg-white border border-cn-border rounded-lg px-2 py-1.5 text-xs font-semibold outline-none focus:ring-1 focus:ring-amber-500/50 disabled:opacity-50"
                            value={member.role}
                            disabled={memberRoleSaving[member.userId]}
                            onchange={(e) => {
                              const val = (e.target as HTMLSelectElement).value;
                              if (val === 'member' || val === 'moderator' || val === 'admin') {
                                void handleMemberRoleUpdate(member.userId, val);
                              }
                            }}
                          >
                            <option value="member">{m.chat_role_member()}</option>
                            <option value="moderator">{m.chat_role_moderator()}</option>
                            <option value="admin">{m.chat_role_admin()}</option>
                          </select>
                          {#if memberRoleSaving[member.userId]}
                            <span class="absolute right-1.5 top-1/2 -translate-y-1/2">
                              <Loader size={12} class="animate-spin text-amber-500" />
                            </span>
                          {/if}
                        </div>
                        <button
                          type="button"
                          onclick={() => handleRemoveMember(member.userId)}
                          disabled={memberRemoving[member.userId]}
                          class="rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs font-bold text-red-600 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                          title={m.chat_community_remove_member_title()}
                        >
                          {#if memberRemoving[member.userId]}
                            <Loader size={12} class="animate-spin" />
                          {:else}
                            <Trash2 size={12} strokeWidth={2.5} />
                          {/if}
                        </button>
                      </div>
                    {:else}
                      <span
                        class={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${roleBadgeClass(member.role)}`}
                      >
                        {roleLabel(member.role)}
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          {#if canManage}
            <div class="border border-cn-border rounded-xl bg-white p-4 space-y-3 shadow-sm">
              <p
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
              >
                <Link2 size={14} />
                {m.chat_community_invite_link_label()}
              </p>
              <p class="text-sm text-text-muted">{m.chat_community_invite_link_description()}</p>
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
                    disabled={shareLoading}
                    class="shrink-0 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold hover:bg-cn-bg disabled:opacity-50"
                  >
                    {m.chat_regenerate_link_button()}
                  </button>
                </div>
                {#if shareCopied}
                  <p class="text-xs font-semibold text-emerald-600">
                    {m.chat_link_copied_success()}
                  </p>
                {/if}
              {:else}
                <button
                  type="button"
                  onclick={generateShareLink}
                  disabled={shareLoading}
                  class="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {shareLoading ? m.common_loading_label() : m.chat_generate_invite_link_button()}
                </button>
              {/if}
              {#if shareError}
                <p class="text-xs font-medium text-red-600">{shareError}</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Destructive action reachable on mobile (desktop keeps it in the sidebar). -->
      <div class="md:hidden mt-8 pt-4 border-t border-cn-border/40">
        <button
          class="flex w-full items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
          onclick={leaveCommunity}
        >
          <Trash2 size={18} />
          {m.chat_community_leave_button()}
        </button>
      </div>
    </div>
  </div>
</Modal>
