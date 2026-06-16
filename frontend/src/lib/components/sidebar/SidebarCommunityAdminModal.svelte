<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Settings, Users, Trash2, ShieldCheck, Upload, Loader } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { channelService, type ChannelMemberDto } from '$lib/services/ChannelService';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

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
    if (role === 'admin') return m.chat_role_admin();
    if (role === 'moderator') return m.chat_role_moderator();
    return m.chat_role_member();
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
    communityMembers = [];
    resolvedMemberNames = {};
    membersLoading = true;
    membersError = '';
    try {
      // Batch requests to avoid saturating the server on workspaces with many channels.
      const BATCH = 5;
      const channels = selectedWorkspace.channels;
      const allBatches: ChannelMemberDto[][] = [];
      for (let i = 0; i < channels.length; i += BATCH) {
        if (loadToken !== membersLoadToken) return;
        const batch = await Promise.all(
          channels.slice(i, i + BATCH).map((ch) => channelService.listMembers(ch.id))
        );
        allBatches.push(...(batch as ChannelMemberDto[][]));
      }

      const aggregate = new SvelteMap<string, 'member' | 'moderator' | 'admin'>();
      for (const members of allBatches) {
        for (const member of members as ChannelMemberDto[]) {
          const userId = member.userId?.trim().toLowerCase();
          if (!userId) continue;
          const nextRole = normalizeRoleLabel(member.role || 'member');
          const currentRole = aggregate.get(userId);
          aggregate.set(userId, currentRole ? strongerRole(currentRole, nextRole) : nextRole);
        }
      }

      if (loadToken !== membersLoadToken) return;

      const members = Array.from(aggregate.entries()).map(([userId, role]) => ({ userId, role }));

      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = getUserDisplayNameSync(m.userId, m.userId);
      }
      resolvedMemberNames = names;
      communityMembers = members.sort((a, b) =>
        (resolvedMemberNames[a.userId] ?? a.userId).localeCompare(
          resolvedMemberNames[b.userId] ?? b.userId
        )
      );

      for (const m of members) {
        void resolveUserDisplayName(m.userId).then((resolved) => {
          if (resolved) {
            resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
            // Re-sort once names are known
            communityMembers = [...communityMembers].sort((a, b) =>
              (resolvedMemberNames[a.userId] ?? a.userId).localeCompare(
                resolvedMemberNames[b.userId] ?? b.userId
              )
            );
          }
        });
      }
    } catch (e) {
      if (loadToken !== membersLoadToken) return;
      membersError = e instanceof Error ? e.message : m.chat_community_load_members_error();
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
    if (!open) {
      inviteStatus = '';
      inviteUserId = '';
      inviteRole = 'member';
      imageUploadError = '';
      activeTab = 'overview';
    }
  });

  let inviteLoading = $state(false);

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
      setTimeout(() => { inviteStatus = ''; }, 4000);
      void loadCommunityMembers();
    } catch (e) {
      inviteStatus = e instanceof Error ? e.message : m.chat_community_key_distribution_error();
      inviteUserId = savedId;
      inviteRole = savedRole;
    } finally {
      inviteLoading = false;
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
      // Pass workspaceDbId if available, otherwise fall back to the slug id
      const targetId = selectedWorkspace.workspaceDbId ?? selectedWorkspace.id;
      onUpdateWorkspaceImage?.(targetId, mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : m.chat_community_upload_error();
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }
</script>

<Modal {open} {onClose} title={m.chat_community_settings_title()} maxWidth="max-w-4xl">
  <div class="flex flex-col md:flex-row min-h-0 border-t border-cn-border/40">
    <!-- Barre de menu à gauche -->
    <div
      class="w-full md:w-64 md:flex-shrink-0 bg-[color-mix(in_srgb,var(--cn-surface)_60%,white)] border-b md:border-b-0 md:border-r border-cn-border/40 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-2 md:p-4 gap-1 md:gap-1 md:space-y-1"
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
      <button
        onclick={() => (activeTab = 'members')}
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors {activeTab ===
        'members'
          ? 'bg-amber-100 text-amber-900'
          : 'text-text-main hover:bg-black/5'}"
      >
        <Users size={18} />
        {m.chat_community_members_tab()}
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

    <!-- Contenu Principal -->
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
              <span class="font-bold block">{m.chat_community_e2e_active_title()}</span>
              <span class="text-xs text-text-muted">{m.chat_community_e2e_description()}</span>
            </div>
          </div>
        </div>
      {/if}

      {#if activeTab === 'members'}
        <div class="space-y-6 max-w-3xl">
          <h2 class="text-xl font-bold text-text-main">{m.chat_community_members_tab()}</h2>
          <p class="text-sm text-text-muted">{m.chat_community_members_description()}</p>

          <!-- Placer ici une liste factice ou une vraie table -->
          <div class="border border-cn-border rounded-xl bg-white overflow-hidden text-sm">
            <div class="p-4 flex items-center justify-between border-b border-cn-border bg-black/5">
              <span class="font-semibold text-text-main">{communityMembers.length} {m.chat_community_member_count_label()}</span>
              <button
                class="bg-amber-500 text-white rounded-lg px-3 py-1.5 text-xs font-bold hover:bg-amber-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={handleGenerateInvitation}
                disabled={inviteLoading}
              >
                {inviteLoading ? m.common_sending_label() : m.chat_community_generate_invite_button()}
              </button>
            </div>
            <div class="px-4 py-3 border-b border-cn-border bg-white/70 space-y-2.5">
              <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2.5">
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
              </div>
            </div>
            {#if inviteStatus}
              <div class="px-4 py-2 border-b border-cn-border text-xs font-medium text-text-muted">
                {inviteStatus}
              </div>
            {/if}
            {#if membersLoading}
              <div class="p-6 text-center text-text-muted">{m.chat_community_loading_members()}</div>
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
                      <span class="font-medium text-text-main truncate">
                        {resolvedMemberNames[member.userId] ?? member.userId}
                      </span>
                    </div>
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

      <!-- Action destructive accessible sur mobile : sur desktop elle est dans la barre
           latérale (hidden sur mobile), d'où l'inaccessibilité signalée. -->
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
