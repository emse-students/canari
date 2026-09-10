<script lang="ts">
  import {
    Clock,
    Trash2,
    LogOut,
    UserMinus,
    Check,
    UserPlus,
    Users,
    X,
    PencilLine,
    Shield,
    Camera,
  } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import Modal from '../shared/Modal.svelte';
  import MultiUserSelector from '../shared/MultiUserSelector.svelte';
  import { fade } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';
  import { MediaService } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';

  /**
   * Props for the ChatGroupPanel component.
   * Renders the slide-in settings panel for a group or DM conversation, including
   * rename, member management, leave/delete actions, and the invite modal.
   */
  interface Props {
    /** Whether the panel is currently visible. */
    /** Display name shown in the panel identity card and used to seed the rename input. */
    effectiveDisplayName: string;
    /** Raw user/contact ID used for the DM avatar. */
    contactName: string;
    /** MLS group id (used to generate shareable invite links for group chats). */
    groupId?: string;
    /** Whether this is a group conversation (vs. a direct message). */
    isGroupConversation: boolean;
    /** Media-service id of the current group avatar; null when none is set. */
    imageMediaId?: string | null;
    /** ID of the currently authenticated user (used to label "Vous" in the member list). */
    currentUserId: string;
    /** List of member user IDs in the group. */
    groupMembers: string[];
    /** User IDs with an invite currently in flight, shown as optimistic pending rows. */
    pendingInvites?: string[];
    /** Callback to close the panel (parent clears showPanel). */
    onClose: () => void;
    /** Callback to rename the group, receiving the new trimmed name. */
    onRename?: (name: string) => void;
    /** Callback to set the group avatar, receiving the uploaded media-service id. */
    onSetImage?: (mediaId: string) => void;
    /** Callback to remove a specific member from the group. */
    onRemoveMember?: (userId: string) => void;
    /** Callback to delete the group conversation. */
    onGroupDelete?: () => void;
    /** Callback fired when the current user leaves the group. */
    onGroupLeave?: () => void;
    /** Callback to invite new members by user ID array. */
    onInviteMembers?: (ids: string[]) => void;
  }

  let {
    effectiveDisplayName,
    contactName,
    groupId = '',
    isGroupConversation,
    imageMediaId = null,
    currentUserId,
    groupMembers,
    pendingInvites = [],
    onClose,
    onRename,
    onSetImage,
    onRemoveMember,
    onGroupDelete,
    onGroupLeave,
    onInviteMembers,
  }: Props = $props();

  let confirmDelete = $state(false);
  let confirmLeave = $state(false);
  let showInviteModal = $state(false);
  let newMembers = $state<string[]>([]);
  let renameInput = $state('');

  // Optimistic rows: invitees still in flight and not yet in the authoritative member list.
  // THE NAMES THE REMOVE CONTROL ANNOUNCES. Every other cell of a member row renders a resolved
  // name; the control announced the raw id, which is the one surface that exists to be read out.
  const memberNames = userDisplayNames(() => groupMembers);

  const pendingDisplay = $derived(
    pendingInvites.filter((id) => !groupMembers.some((mem) => mem.toLowerCase() === id))
  );

  // ── Group avatar upload ─────────────────────────────────────────────────────
  let imageUploading = $state(false);
  let imageUploadError = $state('');
  let imageInput = $state<HTMLInputElement | null>(null);
  const mediaService = new MediaService();

  /** Uploads the selected image as a raw/public media blob and reports its id to the parent. */
  async function handleImageFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      imageUploadError = m.chat_group_image_invalid_type();
      input.value = '';
      return;
    }
    imageUploading = true;
    imageUploadError = '';
    try {
      const token = await getToken();
      const mediaId = await mediaService.uploadRaw(file, token);
      onSetImage?.(mediaId);
    } catch (e) {
      imageUploadError = e instanceof Error ? e.message : m.chat_group_image_upload_error();
    } finally {
      imageUploading = false;
      input.value = '';
    }
  }

  // ── Shareable invite link ──────────────────────────────────────────────────
  let shareLink = $state('');
  let shareLoading = $state(false);
  let shareError = $state('');
  let shareCopied = $state(false);

  /** Generates a shareable group invite link and copies it to the clipboard. */
  async function generateShareLink() {
    if (!groupId) {
      shareError = m.chat_group_no_group_error();
      return;
    }
    shareLoading = true;
    shareError = '';
    shareCopied = false;
    try {
      const { createGroupInvite } = await import('$lib/mls/groupInvites');
      const { publicAppUrl } = await import('$lib/utils/publicAppUrl');
      const { token } = await createGroupInvite(groupId);
      shareLink = publicAppUrl(`/g/join/${token}`);
      try {
        await navigator.clipboard.writeText(shareLink);
        shareCopied = true;
      } catch {
        /* clipboard blocked; link shown for manual copy */
      }
    } catch (e) {
      shareError = e instanceof Error ? e.message : m.chat_group_link_generation_error();
    } finally {
      shareLoading = false;
    }
  }

  // Reset internal state each time the panel is opened.
  //
  // THE SHARE-LINK FIELDS BELONG HERE AND WERE MISSING. This effect reset the rename input and the
  // two confirmations, so opening the panel on another conversation carried `shareLink` over - and
  // the panel then rendered the PREVIOUS group's join URL, with "Regenerer" and "Lien copie", under
  // the new group's name. A join link is a capability to enter one specific group, so the user who
  // copies what the panel shows hands out access to the group they just left, to an audience chosen
  // for the one they are looking at. Clearing is the whole fix: a link the panel did not generate
  // this session is a link it must not claim to have.
  $effect(() => {
    // Keyed on the conversation rather than on a `showPanel` flag: the panel is MOUNTED only while
    // it is showing now, so "opened" and "landed on another group" are the same event here.
    void groupId;
    renameInput = effectiveDisplayName;
    confirmDelete = false;
    confirmLeave = false;
    shareLink = '';
    shareCopied = false;
    shareError = '';
  });

  function submitRename() {
    const name = renameInput.trim();
    if (name && name !== effectiveDisplayName) {
      onRename?.(name);
    }
    onClose();
  }

  function handleRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') onClose();
  }

  function closePanel() {
    confirmDelete = false;
    confirmLeave = false;
    onClose();
  }

  function handleInviteMembers() {
    if (newMembers.length > 0 && onInviteMembers) {
      onInviteMembers(newMembers);
      newMembers = [];
      showInviteModal = false;
    }
  }
</script>

<!--
  CONTENT ONLY. This was the FOURTH mechanism for showing something about a conversation - a
  portalled `fixed inset-0` sheet with its own scrim, its own `role="dialog"`, its own header and
  its own 28rem width - reached from the same gear icon that opens the channel settings, which were
  a modal. Two buttons that mean "tell me about this conversation" drew themselves two different
  ways depending on whether it was a channel. `ConversationSidePanel` owns the shell; the subtitle
  that used to sit under the heading is gone with it, because the panel's title bar has one line.
-->
<div class="keyboard-aware-panel-scroll flex min-h-0 flex-1 flex-col gap-6 p-5 md:p-6">
  <!-- Group/contact identity card -->
  <div
    class="bg-cn-surface flex items-center gap-4 rounded-2xl border border-black/5 px-4 py-4 shadow-sm dark:border-white/10"
  >
    {#if isGroupConversation}
      <button
        type="button"
        onclick={() => imageInput?.click()}
        disabled={imageUploading}
        aria-label={m.chat_group_change_photo_label()}
        title={m.chat_group_change_photo_label()}
        class="group/avatar relative h-[3.25rem] w-[3.25rem] shrink-0 overflow-hidden rounded-2xl shadow-inner transition-transform outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 disabled:opacity-60"
      >
        <GroupAvatar {imageMediaId} name={effectiveDisplayName} variant="group" fill />
        <span
          class="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover/avatar:opacity-100"
        >
          {#if imageUploading}
            <Clock size={18} class="animate-spin" strokeWidth={2.5} />
          {:else}
            <Camera size={18} strokeWidth={2.5} />
          {/if}
        </span>
      </button>
      <input
        bind:this={imageInput}
        type="file"
        accept="image/*"
        class="hidden"
        onchange={handleImageFileChange}
      />
    {:else}
      <Avatar userId={contactName} size="lg" fallbackLabel={effectiveDisplayName} />
    {/if}
    <div class="min-w-0 flex-1">
      <div class="text-text-main mb-1 truncate text-base font-bold">
        {effectiveDisplayName}
      </div>
      <div
        class="text-text-muted text-2xs inline-flex items-center gap-1.5 font-bold tracking-wider uppercase"
      >
        <!--
                UNCONDITIONAL, BECAUSE IT STATES A FACT ABOUT THE CONVERSATION AND NOT ABOUT THIS
                DEVICE. It used to fork on `isReady` and show an amber "not joined" line, which is
                the machinery the user asked to stop exposing: the conversation is end-to-end
                encrypted whether or not this device already holds a key for it, and whether it
                does is a transient the recovery ladder owns. The only progress a user may see is
                "en cours de reception".
              -->
        <Shield size={14} class="text-emerald-500" strokeWidth={2.5} />
        {m.chat_group_secured_sync_label()}
      </div>
    </div>
  </div>

  {#if imageUploadError}
    <p class="-mt-3 px-1 text-xs font-medium text-red-600 dark:text-red-400">
      {imageUploadError}
    </p>
  {/if}

  <!-- Rename section -->
  {#if isGroupConversation}
    <div
      class="bg-cn-surface flex flex-col gap-3 rounded-2xl border border-black/5 p-4 shadow-sm md:p-5 dark:border-white/10"
    >
      <label
        for="group-rename-input"
        class="text-text-muted text-2xs mb-1 inline-flex items-center gap-2 font-bold tracking-wider uppercase"
      >
        <PencilLine size={14} />
        {m.chat_group_name_label()}
      </label>
      <div class="flex flex-col gap-3 sm:flex-row">
        <input
          id="group-rename-input"
          type="text"
          bind:value={renameInput}
          onkeydown={handleRenameKey}
          class="text-text-main bg-cn-surface flex-1 rounded-xl border border-black/10 px-4 py-3 text-sm font-semibold shadow-inner transition-all outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/50 dark:border-white/10"
        />
        <button
          onclick={submitRename}
          class="text-cn-ink inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3 font-bold shadow-sm shadow-amber-500/20 transition-all outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95"
          aria-label={m.chat_group_validate_rename_label()}
        >
          <Check size={16} strokeWidth={3} />
          {m.common_validate_button()}
        </button>
      </div>
    </div>
  {/if}

  <!-- Invite link section -->
  {#if isGroupConversation && groupId}
    <div class="flex flex-col gap-2">
      <span class="text-text-muted text-2xs px-1 font-bold tracking-wider uppercase">
        {m.chat_group_invite_link_title()}
      </span>
      <p class="text-text-muted px-1 text-xs leading-relaxed">
        {m.chat_group_invite_link_description()}
      </p>
      {#if shareLink}
        <div class="flex items-center gap-2 px-1">
          <input
            type="text"
            readonly
            value={shareLink}
            class="border-cn-border text-text-main min-w-0 flex-1 rounded-xl border bg-(--cn-surface) px-3 py-2 text-xs"
          />
          <button
            type="button"
            onclick={generateShareLink}
            class="border-cn-border hover:bg-cn-bg shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold"
          >
            {m.chat_group_regenerate_button()}
          </button>
        </div>
        {#if shareCopied}
          <p class="text-green-ok px-1 text-xs font-semibold">
            {m.chat_group_link_copied_label()}
          </p>
        {/if}
      {:else}
        <button
          type="button"
          onclick={generateShareLink}
          disabled={shareLoading}
          class="text-2xs mx-1 self-start rounded-xl bg-amber-500/10 px-3 py-1.5 font-bold text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
        >
          {shareLoading ? m.common_generating_label() : m.chat_group_generate_link_button()}
        </button>
      {/if}
      {#if shareError}
        <p class="px-1 text-xs font-medium text-red-600 dark:text-red-400">{shareError}</p>
      {/if}
    </div>
  {/if}

  <!-- Members section -->
  {#if isGroupConversation}
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2 px-1">
        <span
          class="text-text-muted text-2xs inline-flex items-center gap-2 font-bold tracking-wider uppercase"
        >
          <Users size={14} />
          {m.chat_group_members_count_label({ count: groupMembers.length })}
        </span>
        <button
          type="button"
          onclick={() => {
            showInviteModal = true;
          }}
          class="text-2xs inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-1.5 font-bold text-amber-600 transition-colors outline-none hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400"
        >
          <UserPlus size={14} strokeWidth={2.5} />
          {m.common_add_button()}
        </button>
      </div>

      {#if groupMembers.length > 0 || pendingDisplay.length > 0}
        <div
          class="bg-cn-surface overflow-hidden rounded-2xl border border-black/5 shadow-sm dark:border-white/10"
        >
          <ul class="flex max-h-[35dvh] flex-col overflow-y-auto">
            {#each groupMembers as member, index (member)}
              <li
                class="flex items-center justify-between gap-3 px-4 py-3.5 {index !==
                  groupMembers.length - 1 || pendingDisplay.length > 0
                  ? 'border-b border-black/5 dark:border-white/5'
                  : ''}"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <Avatar userId={member} size="sm" />
                  <UserName userId={member} class="text-text-main truncate text-sm font-semibold" />
                  {#if currentUserId && member.toLowerCase() === currentUserId.toLowerCase()}
                    <span
                      class="text-2xs shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 font-bold text-amber-500"
                      >{m.common_you_label()}</span
                    >
                  {/if}
                </div>

                {#if onRemoveMember}
                  <!--
                          THE ACCESSIBLE NAME IS THE ONE SURFACE THAT EXISTS TO BE READ ALOUD, and it
                          was the only one saying the id: every other cell of this row renders a
                          resolved name (`UserName` right above), while the control announced
                          "Retirer <64 hex>". `data-remove-member` carries the id for the campaign,
                          which used to address members through the label - the same one-attribute
                          pattern `data-conversation-tile` and `data-channel-row` already use.
                        -->
                  <button
                    data-remove-member={member}
                    onclick={() => onRemoveMember?.(member)}
                    aria-label={m.chat_group_remove_member_label({
                      member: memberNames.get(member) ?? member,
                    })}
                    title={m.chat_group_remove_member_title()}
                    class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2 transition-all outline-none hover:bg-red-500/10 hover:text-red-500 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95 dark:bg-white/5"
                  >
                    <UserMinus size={16} />
                  </button>
                {/if}
              </li>
            {/each}
            {#each pendingDisplay as pending, index (pending)}
              <li
                class="flex items-center justify-between gap-3 px-4 py-3.5 opacity-70 {index !==
                pendingDisplay.length - 1
                  ? 'border-b border-black/5 dark:border-white/5'
                  : ''}"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <Avatar userId={pending} size="sm" />
                  <UserName
                    userId={pending}
                    class="text-text-main truncate text-sm font-semibold"
                  />
                </div>
                <span
                  class="text-2xs shrink-0 animate-pulse rounded-md bg-amber-500/10 px-2 py-0.5 font-bold text-amber-500"
                  >{m.chat_group_invite_pending_label()}</span
                >
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <div
          class="text-text-muted rounded-2xl border border-dashed border-black/10 bg-white/30 px-4 py-6 text-center text-sm font-medium dark:border-white/20 dark:bg-black/10"
        >
          {m.chat_group_no_members_label()}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Leave / delete section (panel footer) -->
  {#if onGroupLeave || onGroupDelete}
    <div
      class="keyboard-aware-panel-footer bg-cn-surface mt-auto flex flex-col gap-3 border-t border-black/5 p-5 md:p-6 dark:border-white/10"
    >
      {#if onGroupLeave && !confirmLeave && !confirmDelete}
        <button
          onclick={() => {
            confirmLeave = true;
          }}
          class="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-orange-500/20 bg-orange-500/10 px-4 py-3.5 text-sm font-bold text-orange-600 transition-all outline-none hover:bg-orange-500/20 focus-visible:ring-2 focus-visible:ring-orange-500 active:scale-[0.98] dark:text-orange-400"
        >
          <LogOut size={18} strokeWidth={2.5} />
          {m.chat_group_leave_button()}
        </button>
      {/if}

      {#if confirmLeave}
        <div class="flex flex-col gap-3" transition:fade={{ duration: 150 }}>
          <p class="text-center text-xs font-bold tracking-wider text-orange-500 uppercase">
            {m.chat_group_leave_confirm_question()}
          </p>
          <div class="flex gap-3">
            <button
              onclick={() => {
                confirmLeave = false;
              }}
              class="text-text-main focus-visible:ring-text-muted bg-cn-surface flex-1 rounded-2xl border border-black/10 px-4 py-3.5 font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-[0.98] dark:border-white/10 dark:hover:bg-white/10"
            >
              {m.common_cancel_button()}
            </button>
            <button
              onclick={() => {
                onGroupLeave?.();
                closePanel();
              }}
              class="flex-1 rounded-2xl bg-orange-500 px-4 py-3.5 font-bold text-white shadow-md shadow-orange-500/20 transition-all outline-none hover:bg-orange-600 focus-visible:ring-2 focus-visible:ring-orange-500 active:scale-[0.98]"
            >
              {m.common_leave_button()}
            </button>
          </div>
        </div>
      {/if}

      {#if onGroupDelete && !confirmLeave}
        {#if !confirmDelete}
          <button
            onclick={() => {
              confirmDelete = true;
            }}
            class="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3.5 text-sm font-bold text-red-600 transition-all outline-none hover:bg-red-500/20 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-[0.98] dark:text-red-400"
          >
            <Trash2 size={18} strokeWidth={2.5} />
            {isGroupConversation
              ? m.chat_group_delete_group_button()
              : m.chat_group_delete_dm_button()}
          </button>
        {:else}
          <div class="flex flex-col gap-3" transition:fade={{ duration: 150 }}>
            <p class="text-center text-xs font-bold tracking-wider text-red-500 uppercase">
              {m.chat_group_delete_confirm_question()}
            </p>
            <div class="flex gap-3">
              <button
                onclick={() => {
                  confirmDelete = false;
                }}
                class="text-text-main focus-visible:ring-text-muted bg-cn-surface flex-1 rounded-2xl border border-black/10 px-4 py-3.5 font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-[0.98] dark:border-white/10 dark:hover:bg-white/10"
              >
                {m.common_cancel_button()}
              </button>
              <button
                onclick={() => {
                  onGroupDelete?.();
                  closePanel();
                }}
                class="flex-1 rounded-2xl bg-red-500 px-4 py-3.5 font-bold text-white shadow-md shadow-red-500/20 transition-all outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-[0.98]"
              >
                {m.common_delete_button()}
              </button>
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<!-- Invite modal -->
<Modal
  open={showInviteModal}
  onClose={() => {
    showInviteModal = false;
    newMembers = [];
  }}
  title={m.chat_group_invite_modal_title()}
>
  <div class="space-y-5 px-1">
    <p class="text-text-muted text-sm leading-relaxed font-medium">
      {m.chat_group_invite_description_prefix()}
      <span class="text-text-main font-bold">{effectiveDisplayName}</span>
      {m.chat_group_invite_description_suffix()}
    </p>

    <!--
      YOU CANNOT INVITE SOMEONE WHO IS ALREADY HERE, AND THAT INCLUDES YOURSELF.
      All three lists were already in this component's props and simply were not wired, so the
      picker offered existing members and the current user. Picking one enabled the submit button,
      submitting closed the modal exactly like a real invitation, and the roster did not move - a
      success that did nothing. Excluding them at the source is the fix; refusing them afterwards
      would only move the silence one step later.
    -->
    <MultiUserSelector
      users={newMembers}
      excludeIds={[...groupMembers, ...pendingInvites, currentUserId]}
      onUsersChange={(users) => {
        newMembers = users;
      }}
    />

    <button
      onclick={handleInviteMembers}
      disabled={newMembers.length === 0}
      class="text-cn-ink mt-2 w-full rounded-2xl bg-amber-500 py-3.5 font-bold shadow-lg shadow-amber-500/20 transition-all duration-200 outline-none hover:-translate-y-0.5 hover:bg-amber-400 focus-visible:ring-4 focus-visible:ring-amber-500/50 active:translate-y-0 disabled:transform-none disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
    >
      {m.chat_group_send_invite_button()}{newMembers.length > 0 ? ` (${newMembers.length})` : ''}
    </button>
  </div>
</Modal>
