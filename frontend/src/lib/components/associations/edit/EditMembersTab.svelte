<script lang="ts">
  import { draggableCard } from '$lib/actions/draggableCard';
  import { onMount } from 'svelte';
  import {
    addMember,
    removeMember,
    updateMemberRole,
    reorderMembers,
    ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY,
    LEAVE_REFUSAL,
    MEMBER_FLAGS_BEYOND_GRANTER,
    PUBLISHER_PRESET,
    SocialApiError,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { adminPresetFor, bdePresetFor, memberGrantable } from '$lib/associations/editSections';
  import { resolveUserDisplayName, rosterDisplayName } from '$lib/utils/users/displayName';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import { Download, GripVertical, UserPlus } from '@lucide/svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { m } from '$lib/paraglide/messages';
  import { showConfirm } from '$lib/stores/confirm.svelte';

  interface Props {
    asso: Association;
    /** Member list, owned by the parent (used for its permission gate) and mutated here. */
    members: AssociationMember[];
    /** userId → resolved display name, shared with the parent. */
    resolvedMemberNames: Record<string, string>;
    /**
     * The flags the viewer may grant or revoke (`grantableFlags`): the server refuses a write that
     * changes any other, so neither the presets nor the row editor offer one.
     */
    grantable: number;
  }

  let {
    asso,
    members = $bindable(),
    resolvedMemberNames = $bindable(),
    grantable,
  }: Props = $props();

  let newMemberUserId = $state('');
  let newMemberRole = $state('Membre');
  /**
   * What a new member is given. An institution's members are added to PUBLISH in its name (being
   * personnel gives no such right, D34-D36), so that is its default; elsewhere 0 is a simple member.
   * ASSOCIATION_ADMIN_PRESET is a full association admin.
   */
  const defaultPermissions = () => (asso.type === 'institution' ? PUBLISHER_PRESET : 0);
  // svelte-ignore state_referenced_locally
  let newMemberPermissions = $state(defaultPermissions());
  /**
   * The presets the viewer may hand out. The publisher preset is all-or-nothing (half of it is not
   * a publisher), so it is offered only when every bit is grantable; the admin preset is cut down
   * to what the viewer may grant (`grantableFlags`). The platform admin and a BDE super-admin of
   * this association may grant every flag, so they see it whole; an ordinary member sees it cut to
   * its own row.
   */
  const permissionOptions = $derived.by<PickerOption[]>(() => {
    // A new member holds nothing yet: an institution's is never handed MANAGE_MEMBERS.
    const forNew = memberGrantable(asso.type, grantable, 0);
    const options: PickerOption[] = [{ value: '0', label: m.asso_members_role_member() }];
    if ((PUBLISHER_PRESET & ~forNew) === 0) {
      options.push({ value: String(PUBLISHER_PRESET), label: m.asso_members_role_publisher() });
    }
    const admin = adminPresetFor(asso.type) & forNew;
    if (admin !== 0 && admin !== PUBLISHER_PRESET) {
      options.push({ value: String(admin), label: m.asso_members_role_admin() });
    }
    // A BDE's officers also validate its spaces' agenda, manage its associations and moderate (F9).
    const bdePreset = bdePresetFor(asso);
    const bde = bdePreset === null ? 0 : bdePreset & forNew;
    if (bde !== 0 && bde !== admin) {
      options.push({ value: String(bde), label: m.asso_members_role_bde() });
    }
    return options;
  });
  let addingMember = $state(false);
  let memberError = $state('');

  /** The two typed refusals of a member write get their own words; anything else is generic. */
  function memberWriteError(err: unknown, fallback: string): string {
    const code = err instanceof SocialApiError ? err.code : null;
    if (code === MEMBER_FLAGS_BEYOND_GRANTER) return m.asso_member_flags_beyond_granter_error();
    // Removing or demoting the last holder of "manage members", from the roster editor.
    if (code === LEAVE_REFUSAL.LAST_MEMBER_MANAGER) return m.asso_member_last_manager_error();
    if (code === ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY) {
      return m.asso_institution_members_admin_only_error();
    }
    console.error('[ASSO] member write failed', err);
    return fallback;
  }

  let exportingPdf = $state(false);

  let draggedIdx = $state(-1);
  let dragOverIdx = $state(-1);

  async function handleAddMember() {
    if (!newMemberUserId.trim()) return;
    addingMember = true;
    memberError = '';
    try {
      const member = await addMember(
        asso.id,
        newMemberUserId.trim(),
        newMemberRole,
        newMemberPermissions
      );
      members = [...members, member];
      resolvedMemberNames = {
        ...resolvedMemberNames,
        [member.userId]: rosterDisplayName(member),
      };
      resolveUserDisplayName(member.userId).then((resolved) => {
        if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [member.userId]: resolved };
      });
      newMemberUserId = '';
      newMemberRole = 'Membre';
      newMemberPermissions = defaultPermissions();
    } catch (err) {
      memberError = memberWriteError(err, m.common_save_error());
    } finally {
      addingMember = false;
    }
  }

  /**
   * Drops a member from the association, AFTER ASKING.
   *
   * The second of the two unguarded removals the user reported on 2026-09-17. The row's control is
   * an icon button with `asso_member_remove_title` as its only warning, and a press took the member
   * out and rewrote the list underneath it - no dialog, no undo, and nothing on screen naming what
   * had just gone. The community kick and the channel-access removal were already asking; these two
   * were simply never brought along.
   */
  async function handleRemoveMember(targetId: string) {
    if (
      !(await showConfirm(m.asso_member_remove_confirm(), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    ) {
      return;
    }
    try {
      await removeMember(asso.id, targetId);
      members = members.filter((m) => m.userId !== targetId);
    } catch (err) {
      memberError = memberWriteError(err, m.common_delete_error());
    }
  }

  /**
   * Applies a role rename and/or a new permission bitmask. `permissions` is undefined when the row
   * only renamed the role - `updateMemberRole` then leaves the bitmask alone, so the local copy
   * must not overwrite it with a guess either.
   */
  async function handleChangeRole(targetId: string, role: string, permissions?: number) {
    try {
      await updateMemberRole(asso.id, targetId, role, permissions);
      members = members.map((m) =>
        m.userId === targetId
          ? {
              ...m,
              role,
              ...(permissions === undefined ? {} : { permissions, isAdmin: permissions > 0 }),
            }
          : m
      );
    } catch (err) {
      memberError = memberWriteError(err, m.common_save_error());
    }
  }

  async function handleExportTrombinoscope() {
    if (exportingPdf) return;
    exportingPdf = true;
    try {
      await exportTrombinoscope(asso, members, resolvedMemberNames);
    } finally {
      exportingPdf = false;
    }
  }

  function onDragStart(idx: number) {
    draggedIdx = idx;
  }

  function onDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    dragOverIdx = idx;
  }

  async function onDrop(targetIdx: number) {
    if (draggedIdx < 0 || draggedIdx === targetIdx) return;
    const reordered = [...members];
    const [moved] = reordered.splice(draggedIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    members = reordered;
    draggedIdx = -1;
    dragOverIdx = -1;
    try {
      await reorderMembers(
        asso.id,
        reordered.map((m) => m.userId)
      );
    } catch (err) {
      // The order on screen is not the stored one until the next load: said, never swallowed.
      console.error('[ASSO] member reorder failed', err);
      memberError = m.common_save_error();
    }
  }

  function onDragEnd() {
    draggedIdx = -1;
    dragOverIdx = -1;
  }
</script>

<div class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-6 shadow-sm">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-text-main text-lg font-bold tracking-tight">{m.common_members_label()}</h2>
      <p class="text-text-muted mt-1 text-sm">
        {m.asso_members_subtitle()}
      </p>
    </div>
    <button
      type="button"
      onclick={handleExportTrombinoscope}
      disabled={exportingPdf}
      class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
    >
      <Download size={15} />
      {exportingPdf ? m.common_generating_label() : m.asso_members_pdf_button()}
    </button>
  </div>
  <div class="space-y-2">
    {#each members as member, idx (member.id)}
      <div
        role="listitem"
        use:draggableCard
        ondragstart={() => onDragStart(idx)}
        ondragover={(e) => onDragOver(e, idx)}
        ondrop={() => onDrop(idx)}
        ondragend={onDragEnd}
        class="flex items-start gap-2 rounded-2xl transition-opacity {draggedIdx === idx
          ? 'opacity-40'
          : ''} {dragOverIdx === idx && draggedIdx !== idx ? 'ring-accent/60 ring-2' : ''}"
      >
        <button
          type="button"
          aria-label={m.asso_members_drag_label()}
          data-drag-handle
          class="text-text-muted hover:text-text-main mt-3.5 shrink-0 cursor-grab touch-none transition-colors"
        >
          <GripVertical size={18} />
        </button>
        <div class="min-w-0 flex-1">
          <AssociationMemberRow
            {member}
            displayName={resolvedMemberNames[member.userId] ?? rosterDisplayName(member)}
            manage={true}
            isBDE={asso.isBDE}
            kind={asso.type}
            grantable={memberGrantable(asso.type, grantable, member.permissions ?? 0)}
            onRoleChange={handleChangeRole}
            onRemove={handleRemoveMember}
          />
        </div>
      </div>
    {/each}
  </div>

  <div class="border-cn-border border-t pt-5">
    <h3 class="text-text-main mb-3 flex items-center gap-2 text-sm font-bold">
      <UserPlus size={17} />
      {m.asso_members_add_title()}
    </h3>
    <form
      class="flex flex-col gap-3 lg:flex-row"
      onsubmit={(e) => {
        e.preventDefault();
        handleAddMember();
      }}
    >
      <div class="min-w-0 flex-1">
        <UserAutocomplete
          value={newMemberUserId}
          onValueChange={(v) => (newMemberUserId = v)}
          placeholder={m.asso_members_user_placeholder()}
          inputId="edit-add-member-autocomplete"
          onSubmit={handleAddMember}
        />
      </div>
      <input
        type="text"
        bind:value={newMemberRole}
        placeholder={m.asso_members_role_placeholder()}
        class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm lg:w-36"
      />
      <div class="w-full shrink-0 lg:w-auto">
        <Picker
          value={String(newMemberPermissions)}
          options={permissionOptions}
          onValueChange={(v) => (newMemberPermissions = Number(v))}
          label={m.asso_members_access_label()}
          variant="field"
        />
      </div>
      <button
        type="submit"
        disabled={addingMember || !newMemberUserId.trim()}
        class="bg-accent text-on-accent hover:bg-accent-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
      >
        {addingMember ? '…' : m.common_add_button()}
      </button>
    </form>
    {#if memberError}
      <p class="text-red-err mt-3 text-sm">{memberError}</p>
    {/if}
  </div>
</div>
