<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addMember,
    removeMember,
    updateMemberRole,
    reorderMembers,
    ASSOCIATION_ADMIN_PRESET,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import { Download, GripVertical, UserPlus } from '@lucide/svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
    /** Member list, owned by the parent (used for its permission gate) and mutated here. */
    members: AssociationMember[];
    /** userId → resolved display name, shared with the parent. */
    resolvedMemberNames: Record<string, string>;
  }

  let { asso, members = $bindable(), resolvedMemberNames = $bindable() }: Props = $props();

  let newMemberUserId = $state('');
  let newMemberRole = $state('Membre');
  /** 0 = simple member; ASSOCIATION_ADMIN_PRESET = full association admin. */
  let newMemberPermissions = $state(0);
  let addingMember = $state(false);
  let memberError = $state('');

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
        [member.userId]:
          getUserDisplayNameSync(member.userId) || member.displayName?.trim() || member.userId,
      };
      resolveUserDisplayName(member.userId).then((resolved) => {
        if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [member.userId]: resolved };
      });
      newMemberUserId = '';
      newMemberRole = 'Membre';
      newMemberPermissions = 0;
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      addingMember = false;
    }
  }

  async function handleRemoveMember(targetId: string) {
    try {
      await removeMember(asso.id, targetId);
      members = members.filter((m) => m.userId !== targetId);
    } catch (err) {
      memberError = err instanceof Error ? err.message : 'Erreur';
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
      memberError = err instanceof Error ? err.message : 'Erreur';
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
    } catch {
      // Non-fatal: local order already updated; backend will reflect on next load
    }
  }

  function onDragEnd() {
    draggedIdx = -1;
    dragOverIdx = -1;
  }
</script>

<div class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
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
        draggable={true}
        ondragstart={() => onDragStart(idx)}
        ondragover={(e) => onDragOver(e, idx)}
        ondrop={() => onDrop(idx)}
        ondragend={onDragEnd}
        class="flex items-start gap-2 rounded-2xl transition-opacity {draggedIdx === idx
          ? 'opacity-40'
          : ''} {dragOverIdx === idx && draggedIdx !== idx ? 'ring-cn-yellow/60 ring-2' : ''}"
      >
        <button
          type="button"
          aria-label={m.asso_members_drag_label()}
          class="text-text-muted hover:text-text-main mt-3.5 shrink-0 cursor-grab touch-none transition-colors"
        >
          <GripVertical size={18} />
        </button>
        <div class="min-w-0 flex-1">
          <AssociationMemberRow
            {member}
            displayName={resolvedMemberNames[member.userId] ??
              member.displayName ??
              getUserDisplayNameSync(member.userId)}
            manage={true}
            isBDE={asso.isBDE}
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
      <select
        bind:value={newMemberPermissions}
        class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm lg:w-auto"
      >
        <option value={0}>{m.asso_members_role_member()}</option>
        <option value={ASSOCIATION_ADMIN_PRESET}>{m.asso_members_role_admin()}</option>
      </select>
      <button
        type="submit"
        disabled={addingMember || !newMemberUserId.trim()}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
      >
        {addingMember ? '…' : m.common_add_button()}
      </button>
    </form>
    {#if memberError}
      <p class="text-red-err mt-3 text-sm">{memberError}</p>
    {/if}
  </div>
</div>
