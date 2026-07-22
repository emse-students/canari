<script lang="ts">
  import {
    Shield,
    Settings,
    Users,
    Trash2,
    LogOut,
    Check,
    Minus,
    UserPlus,
    Loader,
    Lock,
    Globe,
    Bell,
    AtSign,
    BellOff,
  } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import { channelService, type ChannelNotificationLevel } from '$lib/services/ChannelService';
  import { m } from '$lib/paraglide/messages';

  interface ChannelSidebarItem {
    id: string;
    name: string;
    isPrivate?: boolean;
  }

  interface ChannelSidebarWorkspace {
    id: string;
    name: string;
    /** Real workspace UUID (the sidebar `id` is a slug-based local id). */
    workspaceDbId?: string | null;
    channels: ChannelSidebarItem[];
  }

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** ID of the channel being configured. */
    selectedChannelId: string;
    /** List of workspaces and their channels, used to resolve the channel name. */
    channelWorkspaces: ChannelSidebarWorkspace[];
    /** Callback to invite a user to the channel with a given role. Rejects on key-distribution failure. */
    onInviteMember: (
      channelId: string,
      memberId: string,
      role: 'member' | 'moderator' | 'admin'
    ) => Promise<void>;
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
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback fired when channel access settings are updated. */
    onUpdateChannelAccess?: (
      channelId: string,
      isPrivate: boolean,
      allowedUserIds: string[]
    ) => void;
  }

  let {
    open,
    selectedChannelId,
    channelWorkspaces,
    onInviteMember,
    onUpdateMemberRole,
    onRenameChannel,
    onDeleteChannel,
    onLeaveChannel,
    onClose,
    onUpdateChannelAccess,
  }: Props = $props();

  let activeTab = $state<'overview' | 'permissions' | 'invites'>('overview');

  let selectedWorkspace = $derived(
    channelWorkspaces.find((w) => w.channels.some((c) => c.id === selectedChannelId))
  );

  let selectedChannel = $derived(
    selectedWorkspace?.channels.find((c) => c.id === selectedChannelId)
  );

  let channelNameInput = $state('');

  // S'assurer que l'input se met a jour quand on change de canal
  $effect(() => {
    if (open && selectedChannel) {
      channelNameInput = selectedChannel.name;
    }
  });

  let permissionMembersId = $state('');
  let permissionRole = $state<'member' | 'moderator' | 'admin'>('member');
  let inviteLoading = $state(false);
  let inviteError = $state('');

  // ── Shareable community invite link ────────────────────────────────────────
  let shareLink = $state('');
  let shareLoading = $state(false);
  let shareError = $state('');
  let shareCopied = $state(false);

  /** Generates a shareable community invite link and copies it to the clipboard. */
  async function generateShareLink() {
    const wsId = selectedWorkspace?.workspaceDbId;
    if (!wsId) {
      shareError = m.chat_channel_community_not_found_error();
      return;
    }
    shareLoading = true;
    shareError = '';
    shareCopied = false;
    try {
      const { channelService } = await import('$lib/services/ChannelService');
      const { publicAppUrl } = await import('$lib/utils/publicAppUrl');
      const { token } = await channelService.createWorkspaceInvite(wsId);
      shareLink = publicAppUrl(`/c/join/${token}`);
      try {
        await navigator.clipboard.writeText(shareLink);
        shareCopied = true;
      } catch {
        // Clipboard may be blocked; the link is shown for manual copy.
      }
    } catch (e) {
      shareError = e instanceof Error ? e.message : m.chat_channel_invite_link_error();
    } finally {
      shareLoading = false;
    }
  }

  async function handleInviteAction() {
    const id = permissionMembersId.trim();
    if (!id) return;
    inviteLoading = true;
    inviteError = '';
    const savedId = permissionMembersId;
    const savedRole = permissionRole;
    permissionMembersId = '';
    permissionRole = 'member';
    try {
      await onInviteMember(selectedChannelId, savedId, savedRole);
    } catch (e) {
      inviteError = e instanceof Error ? e.message : m.chat_channel_invite_key_error();
      permissionMembersId = savedId;
      permissionRole = savedRole;
    } finally {
      inviteLoading = false;
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
  let accessAllowedUserIds = $state<string[]>([]);
  let accessLoaded = $state(false);
  let addingUserId = $state('');

  $effect(() => {
    if (open && activeTab === 'permissions' && selectedChannelId && !accessLoaded) {
      void loadChannelAccess();
    }
    if (!open) {
      activeTab = 'overview';
      accessLoaded = false;
      accessSaved = false;
      accessError = '';
      accessIsPrivate = false;
      accessAllowedUserIds = [];
      addingUserId = '';
      permissionMembersId = '';
      permissionRole = 'member';
      inviteError = '';
      inviteLoading = false;
    }
  });

  async function loadChannelAccess() {
    accessLoading = true;
    accessError = '';
    try {
      const data = await channelService.getChannelAccess(selectedChannelId);
      accessIsPrivate = data.isPrivate;
      accessAllowedUserIds = data.allowedUsers ?? [];
      accessLoaded = true;
    } catch (e) {
      accessError = e instanceof Error ? e.message : m.chat_channel_access_load_error();
    } finally {
      accessLoading = false;
    }
  }

  async function saveChannelAccess() {
    accessSaving = true;
    accessSaved = false;
    accessError = '';
    try {
      await channelService.updateChannelAccess(
        selectedChannelId,
        accessIsPrivate,
        accessAllowedUserIds
      );
      onUpdateChannelAccess?.(selectedChannelId, accessIsPrivate, accessAllowedUserIds);
      accessSaved = true;
      setTimeout(() => {
        accessSaved = false;
      }, 2500);
    } catch (e) {
      accessError = e instanceof Error ? e.message : m.chat_channel_access_save_error();
    } finally {
      accessSaving = false;
    }
  }

  function addAllowedUser() {
    const uid = addingUserId.trim().toLowerCase();
    if (uid && !accessAllowedUserIds.includes(uid)) {
      accessAllowedUserIds = [...accessAllowedUserIds, uid];
    }
    addingUserId = '';
  }

  function removeAllowedUser(userId: string) {
    accessAllowedUserIds = accessAllowedUserIds.filter((u) => u !== userId);
  }

  // Personal per-channel push notification level (all | mentions | none).
  let notifLevel = $state<ChannelNotificationLevel>('all');
  let notifLoading = $state(false);
  let notifSaving = $state(false);
  let notifLoadedFor = $state('');

  // (Re)load the notification level whenever the modal opens on a different channel.
  $effect(() => {
    if (open && selectedChannelId && notifLoadedFor !== selectedChannelId) {
      notifLoadedFor = selectedChannelId;
      void loadNotifLevel();
    }
    if (!open) notifLoadedFor = '';
  });

  async function loadNotifLevel() {
    notifLoading = true;
    try {
      notifLevel = await channelService.getNotificationLevel(selectedChannelId);
    } catch {
      notifLevel = 'all';
    } finally {
      notifLoading = false;
    }
  }

  /** Persists the chosen level optimistically, reverting on failure. */
  async function setNotifLevel(level: ChannelNotificationLevel) {
    if (level === notifLevel || notifSaving) return;
    const previous = notifLevel;
    notifLevel = level;
    notifSaving = true;
    try {
      await channelService.setNotificationLevel(selectedChannelId, level);
    } catch {
      notifLevel = previous;
    } finally {
      notifSaving = false;
    }
  }

  function handleRenameChannel() {
    const trimmed = channelNameInput.trim().toLowerCase();
    if (trimmed && trimmed !== selectedChannel?.name) {
      onRenameChannel?.(selectedChannelId, trimmed);
    }
  }

  async function handleDeleteChannel() {
    if (
      !(await showConfirm(m.chat_delete_channel_confirm({ channel: selectedChannel?.name ?? '' }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    onDeleteChannel?.(selectedChannelId);
    onClose();
  }

  async function handleLeaveChannel() {
    if (
      !(await showConfirm(m.chat_leave_channel_confirm({ channel: selectedChannel?.name ?? '' }), {
        danger: true,
        confirmLabel: m.common_leave_button(),
      }))
    )
      return;
    onLeaveChannel?.(selectedChannelId);
    onClose();
  }
</script>

<Modal {open} {onClose} title={m.chat_channel_settings_title()} maxWidth="max-w-4xl">
  <div class="-mx-6 -my-4 flex flex-col md:flex-row h-full md:h-[65vh] max-h-[800px]">
    <!-- Barre de menu laterale (Onglets sur mobile) -->
    <div
      class="w-full md:w-64 shrink-0 bg-white/40 dark:bg-black/20 border-b md:border-b-0 md:border-r border-black/5 dark:border-white/10 flex flex-row md:flex-col overflow-x-auto md:overflow-x-visible p-3 md:p-5 gap-2 md:gap-1 custom-scrollbar"
    >
      <h3
        class="hidden md:flex text-[0.7rem] font-extrabold uppercase tracking-widest text-text-muted mb-3 px-2 items-center gap-2"
      >
        <span class="text-amber-500 text-lg leading-none">{m.chat_channel_prefix()}</span>
        <span class="truncate"
          >{selectedChannel ? selectedChannel.name : m.chat_channel_label()}</span
        >
      </h3>

      <button
        onclick={() => (activeTab = 'overview')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'overview'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Settings size={18} strokeWidth={2.5} />
        {m.chat_channel_overview_tab()}
      </button>

      <button
        onclick={() => (activeTab = 'permissions')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'permissions'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Shield size={18} strokeWidth={2.5} />
        {m.chat_channel_permissions_tab()}
      </button>

      <button
        onclick={() => (activeTab = 'invites')}
        class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'invites'
          ? 'bg-amber-500/15 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 shadow-sm'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Users size={18} strokeWidth={2.5} />
        {m.chat_channel_invitations_roles_tab()}
      </button>

      <!-- Boutons de danger (Desktop uniquement, places en bas) -->
      <div class="hidden md:flex md:flex-col mt-auto pt-6 gap-2">
        <button
          type="button"
          onclick={handleLeaveChannel}
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <LogOut size={18} strokeWidth={2.5} />
          {m.chat_leave_channel_button()}
        </button>
        <button
          type="button"
          onclick={handleDeleteChannel}
          class="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Trash2 size={18} strokeWidth={2.5} />
          {m.chat_delete_channel_button()}
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="flex-1 bg-transparent p-5 md:p-8 overflow-y-auto custom-scrollbar">
      <!-- ================= ONGLET : VUE D'ENSEMBLE ================= -->
      {#if activeTab === 'overview'}
        <div class="space-y-6 max-w-2xl">
          <h2 class="text-xl font-bold text-text-main">{m.chat_channel_overview_tab()}</h2>
          <div class="space-y-4">
            <div class="space-y-2">
              <label class="text-xs font-bold uppercase text-text-muted" for="channel-name"
                >{m.chat_channel_name_label()}</label
              >
              <div class="flex gap-2">
                <input
                  id="channel-name"
                  class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-500/50 shadow-inner transition-all"
                  bind:value={channelNameInput}
                  onkeydown={(e) => e.key === 'Enter' && handleRenameChannel()}
                  placeholder={m.chat_channel_name_placeholder()}
                />
              </div>
              <button
                type="button"
                onclick={handleRenameChannel}
                disabled={!channelNameInput.trim() ||
                  channelNameInput.trim() === selectedChannel?.name}
                class="rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-amber-500/20 disabled:shadow-none"
              >
                {m.chat_rename_channel_button()}
              </button>
            </div>
          </div>

          <!-- Notifications (personal per-channel level) -->
          <div class="space-y-3 pt-2">
            <div class="flex items-center gap-2">
              <Bell size={16} class="text-amber-500" strokeWidth={2.5} />
              <h3 class="text-sm font-bold text-text-main">
                {m.chat_channel_notifications_label()}
              </h3>
            </div>
            <p class="text-xs text-text-muted">{m.chat_channel_notifications_description()}</p>
            <div class="grid grid-cols-3 gap-2" aria-busy={notifLoading || notifSaving}>
              <button
                type="button"
                onclick={() => setNotifLevel('all')}
                disabled={notifLoading}
                class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {notifLevel ===
                'all'
                  ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-black/10 dark:border-white/10 text-text-muted hover:bg-black/5 dark:hover:bg-white/5'}"
              >
                <Bell size={18} strokeWidth={2.5} />
                {m.chat_channel_notif_all_label()}
              </button>
              <button
                type="button"
                onclick={() => setNotifLevel('mentions')}
                disabled={notifLoading}
                class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {notifLevel ===
                'mentions'
                  ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-black/10 dark:border-white/10 text-text-muted hover:bg-black/5 dark:hover:bg-white/5'}"
              >
                <AtSign size={18} strokeWidth={2.5} />
                {m.chat_channel_notif_mentions_label()}
              </button>
              <button
                type="button"
                onclick={() => setNotifLevel('none')}
                disabled={notifLoading}
                class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {notifLevel ===
                'none'
                  ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-black/10 dark:border-white/10 text-text-muted hover:bg-black/5 dark:hover:bg-white/5'}"
              >
                <BellOff size={18} strokeWidth={2.5} />
                {m.chat_channel_notif_none_label()}
              </button>
            </div>
          </div>

          <!-- Zone de danger (Visible uniquement sur mobile dans cet onglet) -->
          <div class="md:hidden pt-6 border-t border-black/10 dark:border-white/10 space-y-3">
            <h3 class="text-xs font-bold uppercase tracking-wider text-red-500 px-1 mb-2">
              {m.chat_danger_zone_label()}
            </h3>
            <button
              type="button"
              onclick={handleLeaveChannel}
              class="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 active:scale-[0.98] transition-all"
            >
              <LogOut size={18} strokeWidth={2.5} />
              {m.chat_leave_channel_button()}
            </button>
            <button
              type="button"
              onclick={handleDeleteChannel}
              class="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 active:scale-[0.98] transition-all"
            >
              <Trash2 size={18} strokeWidth={2.5} />
              {m.chat_delete_channel_button()}
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= ONGLET : PERMISSIONS ================= -->
      {#if activeTab === 'permissions'}
        <div class="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">
              {m.chat_channel_access_title()}
            </h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              {m.chat_channel_access_description()}
            </p>
          </div>

          {#if accessLoading}
            <div class="flex items-center gap-2 text-sm text-text-muted">
              <Loader size={16} class="animate-spin" />
              {m.common_loading_label()}
            </div>
          {:else if accessError}
            <div
              class="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-sm border border-red-200 dark:border-red-800"
            >
              {accessError}
            </div>
          {:else}
            <div
              class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 space-y-5 shadow-sm"
            >
              <!-- Visibility toggle -->
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3">
                  {#if accessIsPrivate}
                    <div class="p-2 rounded-xl bg-amber-500/10 text-amber-600">
                      <Lock size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="font-bold text-text-main text-sm">
                        {m.chat_channel_private_label()}
                      </p>
                      <p class="text-xs text-text-muted">
                        {m.chat_channel_private_description()}
                      </p>
                    </div>
                  {:else}
                    <div class="p-2 rounded-xl bg-emerald-500/10 text-emerald-600">
                      <Globe size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="font-bold text-text-main text-sm">
                        {m.chat_channel_public_label()}
                      </p>
                      <p class="text-xs text-text-muted">
                        {m.chat_channel_public_description()}
                      </p>
                    </div>
                  {/if}
                </div>
                <button
                  type="button"
                  onclick={() => {
                    accessIsPrivate = !accessIsPrivate;
                  }}
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors {accessIsPrivate
                    ? 'bg-amber-500'
                    : 'bg-black/10 dark:bg-white/20'}"
                  role="switch"
                  aria-checked={accessIsPrivate}
                >
                  <span class="sr-only">{m.chat_toggle_private_channel_label()}</span>
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {accessIsPrivate
                      ? 'translate-x-6'
                      : 'translate-x-1'}"
                  ></span>
                </button>
              </div>

              <!-- Member allowlist (only when private) -->
              {#if accessIsPrivate}
                <div class="border-t border-black/5 dark:border-white/10 pt-4 space-y-3">
                  <p
                    class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                  >
                    <Users size={13} />
                    {m.chat_allowed_members_label()}
                  </p>

                  <!-- Existing allowed users -->
                  {#if accessAllowedUserIds.length === 0}
                    <p class="text-sm text-text-muted italic">
                      {m.chat_no_allowed_members_warning()}
                    </p>
                  {:else}
                    <ul class="space-y-1.5">
                      {#each accessAllowedUserIds as uid (uid)}
                        <li
                          class="flex items-center justify-between gap-2 rounded-xl bg-black/5 dark:bg-white/5 px-3 py-2"
                        >
                          <div class="flex items-center gap-2 min-w-0">
                            <Avatar userId={uid} size="sm" />
                            <UserName
                              userId={uid}
                              class="text-sm font-medium text-text-main truncate"
                            />
                          </div>
                          <button
                            type="button"
                            onclick={() => removeAllowedUser(uid)}
                            class="text-red-500 hover:text-red-700 transition-colors flex-shrink-0"
                            title={m.common_remove_label()}
                          >
                            <Minus size={14} strokeWidth={3} />
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  <!-- Add a user -->
                  <div class="space-y-2 pt-1">
                    <p
                      class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                    >
                      <UserPlus size={13} />
                      {m.chat_add_member_label()}
                    </p>
                    <div class="flex gap-2 items-start">
                      <div class="flex-1">
                        <UserAutocomplete
                          value={addingUserId}
                          onValueChange={(v) => (addingUserId = v)}
                          placeholder={m.chat_search_user_placeholder()}
                        />
                      </div>
                      <button
                        type="button"
                        onclick={addAllowedUser}
                        disabled={!addingUserId.trim()}
                        class="rounded-xl bg-amber-500 px-3 py-2.5 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-md shadow-amber-500/20 mt-0"
                      >
                        <Check size={14} strokeWidth={3} />
                        {m.common_add_button()}
                      </button>
                    </div>
                  </div>
                </div>
              {/if}

              <!-- Save -->
              <div
                class="flex items-center gap-3 border-t border-black/5 dark:border-white/10 pt-4"
              >
                <button
                  type="button"
                  onclick={saveChannelAccess}
                  disabled={accessSaving}
                  class="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2 shadow-md shadow-amber-500/20"
                >
                  {#if accessSaving}
                    <Loader size={14} class="animate-spin" /> {m.common_saving_label()}
                  {:else}
                    <Check size={14} strokeWidth={3} /> {m.common_save_button()}
                  {/if}
                </button>
                {#if accessSaved}
                  <span class="text-xs font-medium text-emerald-600 flex items-center gap-1">
                    <Check size={12} strokeWidth={3} />
                    {m.common_saved_label()}
                  </span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- ================= ONGLET : INVITATIONS & ROLES ================= -->
      {#if activeTab === 'invites'}
        <div class="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div>
            <h2 class="text-xl font-extrabold text-text-main mb-1">
              {m.chat_channel_invitations_roles_title()}
            </h2>
            <p class="text-sm font-medium text-text-muted leading-relaxed">
              {m.chat_channel_invitations_description()}
            </p>
          </div>

          <!-- Lien d'invitation partageable (communaute entiere) -->
          <div
            class="bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-[1.5rem] p-5 md:p-6 space-y-3 shadow-sm backdrop-blur-md"
          >
            <p class="text-xs font-bold uppercase tracking-wider text-text-muted">
              {m.chat_community_invite_link_label()}
            </p>
            <p class="text-sm text-text-muted leading-relaxed">
              {m.chat_community_invite_link_description()}
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
                  {m.chat_regenerate_link_button()}
                </button>
              </div>
              {#if shareCopied}
                <p class="text-xs font-semibold text-emerald-600">{m.chat_link_copied_success()}</p>
              {/if}
            {:else}
              <button
                type="button"
                onclick={generateShareLink}
                disabled={shareLoading}
                class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
              >
                {shareLoading ? m.common_generating_label() : m.chat_generate_invite_link_button()}
              </button>
            {/if}
            {#if shareError}
              <p class="text-xs font-medium text-red-600 dark:text-red-400">{shareError}</p>
            {/if}
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
                <Users size={14} />
                {m.chat_search_user_label()}
              </label>
              <UserAutocomplete
                value={permissionMembersId}
                onValueChange={(v) => (permissionMembersId = v)}
                placeholder={m.chat_search_user_name_or_id_placeholder()}
                inputId="invite-autocomplete"
              />
            </div>

            <!-- Select Role -->
            <div class="space-y-2">
              <label
                class="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5"
                for="role-select"
              >
                <Shield size={14} />
                {m.chat_assign_role_label()}
              </label>
              <select
                id="role-select"
                class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-amber-500/50 shadow-inner transition-all text-sm font-semibold appearance-none"
                bind:value={permissionRole}
              >
                <option value="member" class="bg-white dark:bg-zinc-900 font-medium"
                  >{m.chat_role_member_description()}</option
                >
                <option value="moderator" class="bg-white dark:bg-zinc-900 font-medium"
                  >{m.chat_role_moderator_description()}</option
                >
                <option value="admin" class="bg-white dark:bg-zinc-900 font-medium"
                  >{m.chat_role_admin_description()}</option
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
                disabled={!permissionMembersId.trim() || inviteLoading}
                class="flex-1 rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 disabled:shadow-none"
              >
                <UserPlus size={18} strokeWidth={2.5} />
                {inviteLoading ? m.common_sending_label() : m.chat_send_invitation_button()}
              </button>

              <button
                type="button"
                onclick={handleUpdateRoleAction}
                disabled={!permissionMembersId.trim()}
                class="flex-1 rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 px-4 py-3 text-sm font-bold text-text-main hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Shield size={18} strokeWidth={2.5} />
                {m.common_update_button()}
              </button>
            </div>
            {#if inviteError}
              <p class="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{inviteError}</p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* Scrollbar discrete pour le menu et le contenu */
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
