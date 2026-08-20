<script lang="ts">
  import {
    Settings,
    Users,
    Shield,
    Trash2,
    LogOut,
    ShieldCheck,
    Upload,
    Loader,
    Link2,
    History,
  } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { globalChannels } from '$lib/stores/globalChatSingleton.svelte';
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
  import {
    channelService,
    ChannelApiError,
    type WorkspaceInviteDto,
  } from '$lib/services/ChannelService';
  import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
  import {
    GRAINE_DEFAULT_HISTORY_VISIBILITY,
    type GraineHistoryVisibility,
  } from '$lib/crypto/graineConstants';
  import { m } from '$lib/paraglide/messages';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
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
    /** What this community lets a newcomer read, as the last backend listing said. */
    historyVisibility?: GraineHistoryVisibility;
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
    /** Callback fired when an admin deletes the selected workspace for every member. */
    onDeleteWorkspace?: (workspaceDbId: string, confirmationName: string) => void;
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
    onDeleteWorkspace,
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

  // ── History visibility ────────────────────────────────────────────────────
  // Mirrored into local state rather than read straight off the workspace, because the sidebar
  // entry is only corrected when the server's `workspace.updated` broadcast comes back - and the
  // select must not snap back to its old value while that is in flight.
  let historyVisibility = $state<GraineHistoryVisibility>(GRAINE_DEFAULT_HISTORY_VISIBILITY);
  let historyVisibilitySaving = $state(false);
  let historyVisibilityError = $state('');

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
  /**
   * What each role grants, and the grid's view of it - both DERIVED from the shared store.
   *
   * The panel used to own this state, so a role edited by another administrator while this grid was
   * open went on being drawn as it had been at load time - which is exactly what COMM-20 measured on
   * production. Held in `globalChannels`, an announcement reaches the table with nothing to refetch.
   */
  const roleBasePermissions = $derived(globalChannels.rolePermissions);
  const roleOverrides = $derived<PermissionGridOverride[]>(
    Object.entries(globalChannels.rolePermissions).flatMap(([roleId, perms]) =>
      perms.map((permission) => ({ roleId, permission, value: 'allow' as const }))
    )
  );
  let roleSaving = $state<Record<string, boolean>>({});

  // ── Shareable invite link ─────────────────────────────────────────────────
  // A community has exactly ONE live link. The two selects below bound the link about to be
  // MINTED; a link that already exists keeps whatever it was minted with, which is why its own
  // bounds are displayed as text rather than reflected back into the form.
  let shareLink = $state('');
  let shareInvite = $state<WorkspaceInviteDto | null>(null);
  let shareLoading = $state(false);
  let shareError = $state('');
  let shareCopied = $state(false);
  /** Days until expiry for the next link; 0 means it never expires. */
  let shareExpiryDays = $state(0);
  /** Cap on accepted joins for the next link; 0 means unlimited. */
  let shareMaxUses = $state(0);
  const SHARE_EXPIRY_CHOICES = [0, 1, 7, 30];
  const SHARE_MAX_USES_CHOICES = [0, 1, 5, 25, 100];

  /**
   * All workspace-level permissions, editable per role in the grid.
   *
   * SIX ROWS, NOT EIGHT. `channel.access` and `channel.send` were shown here and enforced nowhere;
   * they were deleted on 2026-08-19 rather than wired up, because reading is already decided by
   * whether a salon is public or private, and writing by the salon's own `writePolicy` - which is
   * per salon and therefore strictly more expressive than one switch across the community. A row
   * that cannot change an outcome is worse than a missing one: it reads as a control.
   */
  const roleGridPermissions: PermissionGridPermission[] = [
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
    if (role === 'admin') return 'bg-red-err/10 text-red-err';
    if (role === 'moderator') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    return 'bg-green-ok/10 text-green-ok';
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
      for (const role of roles) {
        try {
          const data = await channelService.getRolePermissions(role.id);
          perms[role.id] = data.permissions ?? [];
        } catch {
          perms[role.id] = [];
        }
      }
      globalChannels.setRolePermissions(perms);
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
      // SENT AS ONE CELL, AND THE ANSWER IS THE TRUTH. Sending the list this browser holds made two
      // administrators editing one role at the same moment erase each other's work, and left the
      // loser's grid showing a state the server had never had (COMM-20, production, 2026-08-20).
      // A base permission is either granted or not: only `allow` grants it, neutral revokes it.
      const saved = await channelService.setRolePermission(
        roleId,
        permissionKey,
        value === 'allow'
      );
      // APPLIED FROM THE RESPONSE, not from what was asked for: it carries anything somebody else
      // changed while this click was in flight, which is the whole point of sending a delta.
      globalChannels.handleRolePermissionsChanged({ roleId, permissions: saved.permissions });
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
      // Removing the last admin is refused with a code, which is what names the reason here - the
      // raw body would otherwise be printed at the user.
      const coded = e instanceof ChannelApiError ? describeCommunityRefusal(e.code) : null;
      membersError = coded ?? (e instanceof Error ? e.message : m.common_save_error());
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
      const resolvedName = await resolveUserDisplayName(savedId);
      const displayName = resolvedName ?? savedId;
      inviteStatus = m.chat_community_invite_sent_message({ savedId: displayName });
      setTimeout(() => (inviteStatus = ''), 4000);
      void loadCommunityMembers();
    } catch (e) {
      // CLASSIFIED BY CODE FIRST. `ChannelApiError.message` is the RAW response body, so the two
      // refusals that matter here - the invitee has never installed Canari, and the key service
      // could not be asked - used to reach the admin as an English backend sentence or a JSON
      // blob. They are different situations with different remedies and now say so.
      const coded = e instanceof ChannelApiError ? describeCommunityRefusal(e.code) : null;
      inviteStatus =
        coded ?? (e instanceof Error ? e.message : m.chat_community_key_distribution_error());
      inviteUserId = savedId;
      inviteRole = savedRole;
    } finally {
      inviteLoading = false;
    }
  }

  /**
   * Fetches the community's link, or replaces it when `rotate` is set.
   *
   * Rotating is the ONLY way to get a new token, so the plain call can be made freely: it returns
   * whatever link is already live rather than minting a fourth one nobody knows about, which is
   * what the old "generate" button did on every click.
   */
  async function loadShareLink(rotate: boolean) {
    const workspaceDbId = selectedWorkspace?.workspaceDbId;
    if (!workspaceDbId) return;
    shareLoading = true;
    shareError = '';
    shareCopied = false;
    try {
      const { publicAppUrl } = await import('$lib/utils/publicAppUrl');
      const invite = await channelService.createWorkspaceInvite(workspaceDbId, {
        rotate,
        expiresAt:
          shareExpiryDays > 0
            ? new Date(Date.now() + shareExpiryDays * 24 * 60 * 60 * 1000).toISOString()
            : null,
        maxUses: shareMaxUses > 0 ? shareMaxUses : null,
      });
      shareInvite = invite;
      shareLink = publicAppUrl(`/c/join/${invite.token}`);
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

  /** What the live link is bounded by, as one line - a token alone cannot say whether it expires. */
  const shareBounds = $derived.by(() => {
    if (!shareInvite) return '';
    const expiry = shareInvite.expiresAt
      ? m.chat_community_invite_bounds_expires({
          date: new Date(shareInvite.expiresAt).toLocaleDateString(),
        })
      : m.chat_community_invite_bounds_never();
    const uses =
      shareInvite.maxUses === null
        ? m.chat_community_invite_bounds_uses_unlimited({ uses: shareInvite.uses })
        : m.chat_community_invite_bounds_uses_capped({
            uses: shareInvite.uses,
            max: shareInvite.maxUses,
          });
    return `${expiry} - ${uses}`;
  });

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

  /**
   * Confirms then deletes the whole community for every member, irreversibly. Only rendered for
   * admins; the server re-checks MANAGE_WORKSPACE, so hiding the button is convenience, not the
   * gate - and it re-checks the typed name too, so neither is this dialog.
   */
  async function deleteCommunity() {
    const name = selectedWorkspace?.name ?? '';
    if (
      !(await showConfirm(m.chat_community_delete_confirm({ selectedWorkspace: name }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
        requireText: name,
      }))
    ) {
      return;
    }
    onDeleteWorkspace?.(selectedWorkspace?.workspaceDbId ?? '', name);
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

  /**
   * Publishes the community's history rule.
   *
   * The value is applied locally only once the server has ACCEPTED it: this decides what every
   * member's device hands a newcomer, so an optimistic flip would show an admin a community closed
   * while every device kept opening it.
   */
  async function saveHistoryVisibility(next: GraineHistoryVisibility) {
    const workspaceDbId = selectedWorkspace?.workspaceDbId;
    if (!workspaceDbId || next === historyVisibility) return;
    historyVisibilitySaving = true;
    historyVisibilityError = '';
    try {
      const result = await channelService.updateWorkspaceHistoryVisibility(workspaceDbId, next);
      historyVisibility = result.historyVisibility;
      Log.d('CHANNEL', `history visibility set to ${result.historyVisibility}`);
    } catch (e) {
      // Classified by the server's CODE, never by its sentence - the same contract every other
      // community refusal in this modal is read through.
      historyVisibilityError =
        describeCommunityRefusal(e instanceof ChannelApiError ? e.code : null) ??
        (e instanceof Error ? e.message : String(e));
    } finally {
      historyVisibilitySaving = false;
    }
  }

  // The selected community's rule, re-read whenever the modal opens on another one. Sourced from
  // the sidebar entry, which the server's broadcast keeps current on every member's device.
  $effect(() => {
    const declared = selectedWorkspace?.historyVisibility;
    historyVisibility = declared ?? GRAINE_DEFAULT_HISTORY_VISIBILITY;
  });

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
      historyVisibilityError = '';
      shareLink = '';
      shareInvite = null;
      shareCopied = false;
      activeTab = 'overview';
    }
  });
</script>

<!--
  THE ROLES TAB IS WIDER THAN THE OTHERS, because it is the only one holding a table. At
  `max-w-4xl` the 256px tab rail left the grid under 600px and its own horizontal scrollbar was
  doing the work - a matrix you have to drag sideways to read is a matrix nobody audits. The other
  tabs are forms and read worse when stretched, so the width follows the tab rather than the modal
  being widened for all of them.
-->
<Modal
  {open}
  {onClose}
  title={m.chat_community_settings_title()}
  maxWidth={activeTab === 'roles' ? 'max-w-6xl' : 'max-w-4xl'}
>
  <div class="flex flex-col md:flex-row min-h-0 border-t border-cn-border/40">
    <!-- Sidebar tabs -->
    <div
      class="w-full md:w-64 md:shrink-0 bg-cn-surface border-b md:border-b-0 md:border-r border-cn-border/40 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-2 md:p-4 gap-1 md:space-y-1"
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
          ? 'bg-cn-yellow/15 text-cn-dark'
          : 'text-text-main hover:bg-cn-bg'}"
      >
        <Settings size={18} />
        {m.chat_community_overview_tab()}
      </button>
      {#if canManage}
        <button
          onclick={() => (activeTab = 'roles')}
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
          'roles'
            ? 'bg-cn-yellow/15 text-cn-dark'
            : 'text-text-main hover:bg-cn-bg'}"
        >
          <Shield size={18} />
          {m.chat_community_roles_tab()}
        </button>
      {/if}
      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'members'
          ? 'bg-cn-yellow/15 text-cn-dark'
          : 'text-text-main hover:bg-cn-bg'}"
      >
        <Users size={18} />
        {m.common_members_label()}
      </button>

      <div class="hidden md:block mt-auto pt-4 space-y-2">
        <button
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-err hover:bg-red-err/10 transition-colors w-full"
          onclick={leaveCommunity}
        >
          <LogOut size={18} />
          {m.chat_community_leave_button()}
        </button>
        {#if canManage}
          <button
            class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-err hover:bg-red-err/10 transition-colors w-full"
            onclick={deleteCommunity}
          >
            <Trash2 size={18} />
            {m.chat_community_delete_button()}
          </button>
        {/if}
      </div>
    </div>

    <!-- Main content -->
    <div class="flex-1 bg-cn-bg p-6 overflow-y-auto min-h-75">
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">{m.chat_community_overview_tab()}</h2>

          <div class="flex items-center gap-6">
            <div class="relative shrink-0">
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
                  class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-cn-yellow text-cn-ink flex items-center justify-center cursor-pointer hover:bg-cn-yellow-hover transition-colors shadow"
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
                <p class="text-xs text-red-err">{imageUploadError}</p>
              {/if}
              <label class="text-xs font-bold uppercase text-text-muted" for="server-name"
                >{m.chat_community_name_label()}</label
              >
              <input
                id="server-name"
                class="w-full bg-cn-surface text-text-main border border-cn-border rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-cn-yellow/50 read-only:opacity-60 read-only:cursor-not-allowed"
                value={selectedWorkspace ? selectedWorkspace.name : ''}
                readonly={!canManage}
              />
            </div>
          </div>

          <div
            class="border border-cn-border bg-cn-surface rounded-xl p-4 shadow-sm text-sm text-text-main flex items-center gap-3"
          >
            <ShieldCheck size={24} class="text-green-ok" />
            <div class="flex-1">
              <span class="font-bold block">{m.chat_community_e2e_active_title()}</span>
              <span class="text-xs text-text-muted">{m.chat_community_e2e_description()}</span>
            </div>
          </div>

          {#if canManage}
            <div class="border border-cn-border bg-cn-surface rounded-xl p-4 shadow-sm space-y-3">
              <p
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
              >
                <History size={14} />
                {m.chat_community_history_visibility_label()}
              </p>
              <p class="text-sm text-text-muted">
                {m.chat_community_history_visibility_description()}
              </p>
              <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">
                <select
                  value={historyVisibility}
                  disabled={historyVisibilitySaving}
                  onchange={(event) =>
                    void saveHistoryVisibility(
                      (event.currentTarget as HTMLSelectElement).value as GraineHistoryVisibility
                    )}
                  class="rounded-xl border border-cn-border bg-cn-surface px-3 py-2 text-sm font-normal text-text-main disabled:opacity-50"
                >
                  <option value="shared">{m.chat_community_history_shared_option()}</option>
                  <option value="joined">{m.chat_community_history_joined_option()}</option>
                </select>
              </label>
              <p class="text-xs text-text-muted">
                {historyVisibility === 'shared'
                  ? m.chat_community_history_shared_note()
                  : m.chat_community_history_joined_note()}
              </p>
              {#if historyVisibilityError}
                <p class="text-xs text-red-err">{historyVisibilityError}</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'roles'}
        <div class="space-y-6">
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
            <div class="p-3 rounded-xl bg-red-err/10 text-red-err text-sm border border-red-err/30">
              {rolesError}
            </div>
          {:else if workspaceRoles.length > 0}
            <div class="border border-cn-border bg-cn-surface rounded-xl p-4 shadow-sm">
              <PermissionGrid
                roles={workspaceRoles}
                permissions={roleGridPermissions}
                overrides={roleOverrides}
                onToggle={handleRolePermissionToggle}
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

          <div class="border border-cn-border rounded-xl bg-cn-surface overflow-hidden text-sm">
            <div class="p-4 flex items-center justify-between border-b border-cn-border bg-cn-bg">
              <span class="font-semibold text-text-main"
                >{communityMembers.length} {m.chat_community_member_count_label()}</span
              >
            </div>
            {#if canManage}
              <div class="px-4 py-3 border-b border-cn-border bg-cn-bg/60 space-y-2.5">
                <div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2.5">
                  <!-- Members of this community are already here; inviting them again is not an action. -->
                  <UserAutocomplete
                    value={inviteUserId}
                    onValueChange={(v) => (inviteUserId = v)}
                    placeholder={m.chat_community_search_user_placeholder()}
                    inputId="community-invite-autocomplete"
                    excludeIds={communityMembers.map((member) => member.userId)}
                  />
                  <select
                    bind:value={inviteRole}
                    class="bg-cn-surface text-text-main border border-cn-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cn-yellow/40"
                  >
                    <option value="member">{m.chat_role_member()}</option>
                    <option value="moderator">{m.chat_role_moderator()}</option>
                    <option value="admin">{m.chat_role_admin()}</option>
                  </select>
                  <button
                    class="bg-cn-yellow text-cn-ink rounded-lg px-3 py-2 text-xs font-bold hover:bg-cn-yellow-hover transition disabled:opacity-50 disabled:cursor-not-allowed"
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
              <div class="p-6 text-center text-red-err">{membersError}</div>
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
                            class="w-32 bg-cn-surface text-text-main border border-cn-border rounded-lg px-2 py-1.5 text-xs font-semibold outline-none focus:ring-1 focus:ring-cn-yellow/50 disabled:opacity-50"
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
                              <Loader size={12} class="animate-spin text-cn-yellow" />
                            </span>
                          {/if}
                        </div>
                        <button
                          type="button"
                          onclick={() => handleRemoveMember(member.userId)}
                          disabled={memberRemoving[member.userId]}
                          class="rounded-lg border border-red-err/20 bg-red-err/5 px-2 py-1.5 text-xs font-bold text-red-err hover:bg-red-err/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
            <div class="border border-cn-border rounded-xl bg-cn-surface p-4 space-y-3 shadow-sm">
              <p
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
              >
                <Link2 size={14} />
                {m.chat_community_invite_link_label()}
              </p>
              <p class="text-sm text-text-muted">{m.chat_community_invite_link_description()}</p>
              <p class="text-sm text-text-muted">{m.chat_community_invite_single_link_note()}</p>

              <div class="flex flex-wrap gap-3">
                <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">
                  {m.chat_community_invite_expiry_label()}
                  <select
                    bind:value={shareExpiryDays}
                    class="rounded-xl border border-cn-border bg-cn-surface px-3 py-2 text-sm font-normal text-text-main"
                  >
                    {#each SHARE_EXPIRY_CHOICES as days (days)}
                      <option value={days}>
                        {days === 0
                          ? m.chat_community_invite_expiry_never()
                          : m.chat_community_invite_expiry_days({ days })}
                      </option>
                    {/each}
                  </select>
                </label>
                <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted">
                  {m.chat_community_invite_max_uses_label()}
                  <select
                    bind:value={shareMaxUses}
                    class="rounded-xl border border-cn-border bg-cn-surface px-3 py-2 text-sm font-normal text-text-main"
                  >
                    {#each SHARE_MAX_USES_CHOICES as count (count)}
                      <option value={count}>
                        {count === 0
                          ? m.chat_community_invite_max_uses_unlimited()
                          : m.chat_community_invite_max_uses_count({ count })}
                      </option>
                    {/each}
                  </select>
                </label>
              </div>

              {#if shareLink}
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    readonly
                    value={shareLink}
                    class="flex-1 min-w-0 rounded-xl border border-cn-border bg-cn-surface px-3 py-2 text-sm text-text-main"
                  />
                  <button
                    type="button"
                    onclick={() => void loadShareLink(true)}
                    disabled={shareLoading}
                    class="shrink-0 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold hover:bg-cn-bg disabled:opacity-50"
                  >
                    {m.chat_regenerate_link_button()}
                  </button>
                </div>
                <p class="text-xs text-text-muted">{shareBounds}</p>
                {#if shareCopied}
                  <p class="text-xs font-semibold text-green-ok">
                    {m.chat_link_copied_success()}
                  </p>
                {/if}
              {:else}
                <button
                  type="button"
                  onclick={() => void loadShareLink(false)}
                  disabled={shareLoading}
                  class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
                >
                  {shareLoading ? m.common_loading_label() : m.chat_generate_invite_link_button()}
                </button>
              {/if}
              {#if shareError}
                <p class="text-xs font-medium text-red-err">{shareError}</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Destructive action reachable on mobile (desktop keeps it in the sidebar). -->
      <div class="md:hidden mt-8 pt-4 border-t border-cn-border/40 space-y-2">
        <button
          class="flex w-full items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-err bg-red-err/10 hover:bg-red-err/20 transition-colors"
          onclick={leaveCommunity}
        >
          <LogOut size={18} />
          {m.chat_community_leave_button()}
        </button>
        {#if canManage}
          <button
            class="flex w-full items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-err bg-red-err/10 hover:bg-red-err/20 transition-colors"
            onclick={deleteCommunity}
          >
            <Trash2 size={18} />
            {m.chat_community_delete_button()}
          </button>
        {/if}
      </div>
    </div>
  </div>
</Modal>
