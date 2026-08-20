<script lang="ts">
  import {
    Settings,
    Trash2,
    LogOut,
    Check,
    Loader,
    Lock,
    Globe,
    Bell,
    AtSign,
    BellOff,
    MessageSquareText,
  } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import {
    channelService,
    type ChannelNotificationLevel,
    type ChannelWritePolicy,
  } from '$lib/services/ChannelService';
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
      allowedUserIds: string[],
      writePolicy?: ChannelWritePolicy
    ) => void;
  }

  let {
    open,
    selectedChannelId,
    channelWorkspaces,
    onRenameChannel,
    onDeleteChannel,
    onLeaveChannel,
    onClose,
    onUpdateChannelAccess,
  }: Props = $props();

  let activeTab = $state<'general' | 'access'>('general');

  let selectedWorkspace = $derived(
    channelWorkspaces.find((w) => w.channels.some((c) => c.id === selectedChannelId))
  );

  let selectedChannel = $derived(
    selectedWorkspace?.channels.find((c) => c.id === selectedChannelId)
  );

  let channelNameInput = $state('');

  // Ensure the input updates when switching channels
  $effect(() => {
    if (open && selectedChannel) {
      channelNameInput = selectedChannel.name;
    }
  });

  // ── Access control state ─────────────────────────────────────────────────
  let accessLoading = $state(false);
  let accessError = $state('');
  let accessSaving = $state(false);
  let accessSaved = $state(false);
  let accessIsPrivate = $state(false);
  let accessAllowedUserIds = $state<string[]>([]);
  let accessLoaded = $state(false);
  let addingUserId = $state('');
  let writePolicy = $state<ChannelWritePolicy>('everyone');

  // ── Member access list (for removing users from private channel) ───────
  let membersLoading = $state(false);
  let membersError = $state('');
  let channelMembers = $state<
    Array<{ id: string; userId: string; role: string; joinedAt: string }>
  >([]);
  let memberRemoving = $state<Record<string, boolean>>({});

  $effect(() => {
    if (open && activeTab === 'access' && selectedChannelId && !accessLoaded) {
      void loadChannelAccess();
    }
    if (!open) {
      activeTab = 'general';
      accessLoaded = false;
      accessSaved = false;
      accessError = '';
      accessIsPrivate = false;
      accessAllowedUserIds = [];
      addingUserId = '';
      writePolicy = 'everyone';
      channelMembers = [];
      membersError = '';
      memberRemoving = {};
    }
  });

  /** Derived list of workspace member IDs for filtering the user autocomplete. */
  let workspaceMemberIds = $derived(channelMembers.map((m) => m.userId));

  async function loadChannelAccess() {
    accessLoading = true;
    accessError = '';
    try {
      const data = await channelService.getChannelAccess(selectedChannelId);
      accessIsPrivate = data.isPrivate;
      accessAllowedUserIds = data.allowedUsers ?? [];
      writePolicy = data.writePolicy ?? 'everyone';
      // Always load the member list so the user autocomplete is scoped to workspace members.
      await loadMembers();
      accessLoaded = true;
    } catch (e) {
      accessError = e instanceof Error ? e.message : m.chat_channel_access_load_error();
    } finally {
      accessLoading = false;
    }
  }

  async function loadMembers() {
    membersLoading = true;
    membersError = '';
    try {
      // Workspace scope on purpose: this panel manages community membership, and the private
      // access picker has to offer people who are not in the channel yet.
      channelMembers = await channelService.listMembers(selectedChannelId, 'workspace');
    } catch (e) {
      membersError = e instanceof Error ? e.message : m.chat_channel_load_members_error();
    } finally {
      membersLoading = false;
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
        accessAllowedUserIds,
        writePolicy
      );
      onUpdateChannelAccess?.(
        selectedChannelId,
        accessIsPrivate,
        accessAllowedUserIds,
        writePolicy
      );
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

  async function handleRemoveMemberFromChannel(userId: string) {
    const confirmed = await showConfirm(m.chat_channel_remove_access_confirm(), {
      danger: true,
      confirmLabel: m.common_remove_label(),
    });
    if (!confirmed) return;
    memberRemoving = { ...memberRemoving, [userId]: true };
    try {
      await channelService.removeMemberFromChannel(selectedChannelId, userId);
      accessAllowedUserIds = accessAllowedUserIds.filter((u) => u !== userId);
      // Also remove from displayed member list
      channelMembers = channelMembers.filter((m) => m.userId !== userId);
    } catch (e) {
      membersError = e instanceof Error ? e.message : 'Erreur lors du retrait.';
    } finally {
      const updated = { ...memberRemoving };
      delete updated[userId];
      memberRemoving = updated;
    }
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
  <div class="-mx-6 -my-4 flex h-full max-h-[800px] flex-col md:h-[65vh] md:flex-row">
    <!-- Barre de menu latérale (Onglets sur mobile) -->
    <div
      class="custom-scrollbar flex w-full shrink-0 flex-row gap-2 overflow-x-auto border-b border-black/5 bg-white/40 p-3 md:w-64 md:flex-col md:gap-1 md:overflow-x-visible md:border-r md:border-b-0 md:p-5 dark:border-white/10 dark:bg-black/20"
    >
      <h3
        class="text-text-muted mb-3 hidden items-center gap-2 px-2 text-[0.7rem] font-extrabold tracking-widest uppercase md:flex"
      >
        <span class="text-lg leading-none text-amber-500">{m.chat_channel_prefix()}</span>
        <span class="truncate"
          >{selectedChannel ? selectedChannel.name : m.chat_channel_label()}</span
        >
      </h3>

      <button
        onclick={() => (activeTab = 'general')}
        class="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'general'
          ? 'bg-amber-500/15 text-amber-700 shadow-sm dark:bg-amber-500/20 dark:text-amber-400'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Settings size={18} strokeWidth={2.5} />
        {m.chat_channel_overview_tab()}
      </button>

      <button
        onclick={() => (activeTab = 'access')}
        class="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {activeTab ===
        'access'
          ? 'bg-amber-500/15 text-amber-700 shadow-sm dark:bg-amber-500/20 dark:text-amber-400'
          : 'text-text-main hover:bg-black/5 dark:hover:bg-white/5'}"
      >
        <Lock size={18} strokeWidth={2.5} />
        {m.chat_channel_access_tab()}
      </button>

      <!-- Boutons de danger (Desktop uniquement, placés en bas) -->
      <div class="mt-auto hidden gap-2 pt-6 md:flex md:flex-col">
        <!-- Only a private channel can be left: a public one is readable by every member of the
             community, so there is no per-member access to give up. Leaving is a community-level
             action there ("Quitter la communaute", in the community panel). -->
        {#if selectedChannel?.isPrivate}
          <button
            type="button"
            onclick={handleLeaveChannel}
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold text-orange-600 transition-colors outline-none hover:bg-orange-500/10 focus-visible:ring-2 focus-visible:ring-orange-500 dark:text-orange-400"
          >
            <LogOut size={18} strokeWidth={2.5} />
            {m.chat_leave_channel_button()}
          </button>
        {/if}
        <button
          type="button"
          onclick={handleDeleteChannel}
          class="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold text-red-600 transition-colors outline-none hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400"
        >
          <Trash2 size={18} strokeWidth={2.5} />
          {m.chat_delete_channel_button()}
        </button>
      </div>
    </div>

    <!-- Contenu Principal -->
    <div class="custom-scrollbar flex-1 overflow-y-auto bg-transparent p-5 md:p-8">
      <!-- ================= ONGLET : GÉNÉRAL ================= -->
      {#if activeTab === 'general'}
        <div class="max-w-2xl space-y-6">
          <h2 class="text-text-main text-xl font-bold">{m.chat_channel_overview_tab()}</h2>
          <div class="space-y-4">
            <div class="space-y-2">
              <label class="text-text-muted text-xs font-bold uppercase" for="channel-name"
                >{m.chat_channel_name_label()}</label
              >
              <div class="flex gap-2">
                <input
                  id="channel-name"
                  class="w-full rounded-xl border border-black/10 bg-white/80 px-4 py-3 text-sm font-semibold shadow-inner transition-all outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10 dark:bg-black/40"
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
                class="text-cn-ink rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold shadow-md shadow-amber-500/20 transition-all hover:bg-amber-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                {m.chat_rename_channel_button()}
              </button>
            </div>
          </div>

          <!-- Notifications (personal per-channel level) -->
          <div class="space-y-3 pt-2">
            <div class="flex items-center gap-2">
              <Bell size={16} class="text-amber-500" strokeWidth={2.5} />
              <h3 class="text-text-main text-sm font-bold">
                {m.chat_channel_notifications_label()}
              </h3>
            </div>
            <p class="text-text-muted text-xs">{m.chat_channel_notifications_description()}</p>
            <div class="grid grid-cols-3 gap-2" aria-busy={notifLoading || notifSaving}>
              <button
                type="button"
                onclick={() => setNotifLevel('all')}
                disabled={notifLoading}
                class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {notifLevel ===
                'all'
                  ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'text-text-muted border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}"
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
                  : 'text-text-muted border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}"
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
                  : 'text-text-muted border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}"
              >
                <BellOff size={18} strokeWidth={2.5} />
                {m.chat_channel_notif_none_label()}
              </button>
            </div>
          </div>

          <!-- Zone de danger (Visible uniquement sur mobile dans cet onglet) -->
          <div class="space-y-3 border-t border-black/10 pt-6 md:hidden dark:border-white/10">
            <h3 class="mb-2 px-1 text-xs font-bold tracking-wider text-red-500 uppercase">
              {m.chat_danger_zone_label()}
            </h3>
            <!-- Private channels only - see the desktop block above. -->
            {#if selectedChannel?.isPrivate}
              <button
                type="button"
                onclick={handleLeaveChannel}
                class="flex w-full items-center justify-center gap-3 rounded-xl border border-orange-500/20 bg-orange-500/10 px-4 py-3.5 text-sm font-bold text-orange-600 transition-all active:scale-[0.98] dark:text-orange-400"
              >
                <LogOut size={18} strokeWidth={2.5} />
                {m.chat_leave_channel_button()}
              </button>
            {/if}
            <button
              type="button"
              onclick={handleDeleteChannel}
              class="flex w-full items-center justify-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3.5 text-sm font-bold text-red-600 transition-all active:scale-[0.98] dark:text-red-400"
            >
              <Trash2 size={18} strokeWidth={2.5} />
              {m.chat_delete_channel_button()}
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= ONGLET : ACCÈS ================= -->
      {#if activeTab === 'access'}
        <div class="animate-in fade-in slide-in-from-bottom-2 max-w-2xl space-y-6 duration-300">
          <div>
            <h2 class="text-text-main mb-1 text-xl font-extrabold">
              {m.chat_channel_access_title()}
            </h2>
            <p class="text-text-muted text-sm leading-relaxed font-medium">
              {m.chat_channel_access_description()}
            </p>
          </div>

          {#if accessLoading}
            <div class="text-text-muted flex items-center gap-2 text-sm">
              <Loader size={16} class="animate-spin" />
              {m.common_loading_label()}
            </div>
          {:else if accessError}
            <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-3 text-sm">
              {accessError}
            </div>
          {:else}
            <div
              class="space-y-5 rounded-[1.5rem] border border-black/5 bg-white/60 p-5 shadow-sm dark:border-white/10 dark:bg-black/20"
            >
              <!-- ═══ Visibility toggle ═══ -->
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3">
                  {#if accessIsPrivate}
                    <div class="text-amber-warn rounded-xl bg-amber-500/10 p-2">
                      <Lock size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="text-text-main text-sm font-bold">
                        {m.chat_channel_private_label()}
                      </p>
                      <p class="text-text-muted text-xs">
                        {m.chat_channel_private_description()}
                      </p>
                    </div>
                  {:else}
                    <div class="text-green-ok rounded-xl bg-emerald-500/10 p-2">
                      <Globe size={18} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p class="text-text-main text-sm font-bold">
                        {m.chat_channel_public_label()}
                      </p>
                      <p class="text-text-muted text-xs">
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

              <!-- ═══ Qui peut écrire ? ═══ -->
              <div class="space-y-2 border-t border-black/5 pt-4 dark:border-white/10">
                <div class="flex items-center gap-2">
                  <MessageSquareText size={16} class="text-amber-500" strokeWidth={2.5} />
                  <p class="text-text-muted text-xs font-bold tracking-wider uppercase">
                    {m.chat_channel_who_can_write()}
                  </p>
                </div>
                <select
                  class="w-full appearance-none rounded-xl border border-black/10 bg-white/80 px-4 py-3 text-sm font-semibold shadow-inner transition-all outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10 dark:bg-black/40"
                  bind:value={writePolicy}
                >
                  <option value="everyone">{m.chat_channel_write_everyone()}</option>
                  <option value="admins_moderators">{m.chat_channel_write_admins_mods()}</option>
                  <option value="admins">{m.chat_channel_write_admins()}</option>
                </select>
                <p class="text-text-muted text-xs">{m.chat_channel_admins_join_hint()}</p>
              </div>

              <!-- ═══ Member allowlist (only when private) ═══ -->
              {#if accessIsPrivate}
                <div class="space-y-3 border-t border-black/5 pt-4 dark:border-white/10">
                  <p
                    class="text-text-muted flex items-center gap-1.5 text-xs font-bold tracking-wider uppercase"
                  >
                    <Lock size={13} />
                    {m.chat_allowed_members_label()}
                  </p>

                  <!-- Existing allowed users -->
                  {#if accessAllowedUserIds.length === 0}
                    <p class="text-text-muted text-sm italic">
                      {m.chat_no_allowed_members_warning()}
                    </p>
                  {:else}
                    <ul class="space-y-1.5">
                      {#each accessAllowedUserIds as uid (uid)}
                        <li
                          class="flex items-center justify-between gap-2 rounded-xl bg-black/5 px-3 py-2 dark:bg-white/5"
                        >
                          <div class="flex min-w-0 items-center gap-2">
                            <Avatar userId={uid} size="sm" />
                            <UserName
                              userId={uid}
                              class="text-text-main truncate text-sm font-medium"
                            />
                          </div>
                          <button
                            type="button"
                            onclick={() => handleRemoveMemberFromChannel(uid)}
                            disabled={memberRemoving[uid]}
                            class="hover:text-red-err flex-shrink-0 text-red-500 transition-colors disabled:opacity-50"
                            title={m.chat_channel_remove_access_title()}
                          >
                            {#if memberRemoving[uid]}
                              <Loader size={14} class="animate-spin" />
                            {:else}
                              <Trash2 size={14} strokeWidth={2.5} />
                            {/if}
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  <!-- Add a user -->
                  <div class="space-y-2 pt-1">
                    <p
                      class="text-text-muted flex items-center gap-1.5 text-xs font-bold tracking-wider uppercase"
                    >
                      {m.chat_channel_add_user_label()}
                    </p>
                    <div class="flex items-start gap-2">
                      <div class="flex-1">
                        <!--
                          Already-granted users are not offered again. `addAllowedUser` deduped
                          them silently, so picking one looked like it worked and changed nothing.
                        -->
                        <UserAutocomplete
                          value={addingUserId}
                          onValueChange={(v) => (addingUserId = v)}
                          placeholder={m.chat_search_user_placeholder()}
                          filterUserIds={workspaceMemberIds}
                          excludeIds={accessAllowedUserIds}
                        />
                      </div>
                      <button
                        type="button"
                        onclick={addAllowedUser}
                        disabled={!addingUserId.trim()}
                        class="text-cn-ink mt-0 flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2.5 text-sm font-bold shadow-md shadow-amber-500/20 transition-all hover:bg-amber-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
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
                class="flex items-center gap-3 border-t border-black/5 pt-4 dark:border-white/10"
              >
                <button
                  type="button"
                  onclick={saveChannelAccess}
                  disabled={accessSaving}
                  class="text-cn-ink flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold shadow-md shadow-amber-500/20 transition-all hover:bg-amber-400 active:scale-95 disabled:opacity-50"
                >
                  {#if accessSaving}
                    <Loader size={14} class="animate-spin" /> {m.common_saving_label()}
                  {:else}
                    <Check size={14} strokeWidth={3} /> {m.common_save_button()}
                  {/if}
                </button>
                {#if accessSaved}
                  <span class="text-green-ok flex items-center gap-1 text-xs font-medium">
                    <Check size={12} strokeWidth={3} />
                    {m.common_saved_label()}
                  </span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* Discreet scrollbar for the menu and the content */
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
