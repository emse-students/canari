<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addMember,
    removeMember,
    updateMemberRole,
    reorderMembers,
    listAssociationTags,
    ASSOCIATION_ADMIN_PRESET,
    type Association,
    type AssociationMember,
    type UserTag,
  } from '$lib/associations/api';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import { Download, GripVertical, Tag, UserPlus } from '@lucide/svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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

  let assoTags = $state<UserTag[]>([]);
  let assoTagsLoading = $state(false);
  let assoTagsError = $state('');

  let exportingPdf = $state(false);

  let draggedIdx = $state(-1);
  let dragOverIdx = $state(-1);

  onMount(loadAssociationTags);

  /** Loads active cotisation tags issued by this association. */
  async function loadAssociationTags() {
    assoTagsLoading = true;
    assoTagsError = '';
    try {
      assoTags = await listAssociationTags(asso.id);
    } catch (e) {
      assoTagsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      assoTagsLoading = false;
    }
  }

  function tagHolderName(tag: UserTag): string {
    return (
      resolvedMemberNames[tag.userId]?.trim() ||
      getUserDisplayNameSync(tag.userId, tag.userId.slice(0, 8) + '…')
    );
  }

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

  async function handleChangeRole(targetId: string, role: string, permissions: number) {
    try {
      await updateMemberRole(asso.id, targetId, role, permissions);
      members = members.map((m) =>
        m.userId === targetId ? { ...m, role, permissions, isAdmin: permissions > 0 } : m
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

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
  <div class="flex items-start justify-between gap-3 flex-wrap">
    <div>
      <h2 class="text-lg font-bold text-text-main tracking-tight">{m.common_members_label()}</h2>
      <p class="text-sm text-text-muted mt-1">
        {m.asso_members_subtitle()}
      </p>
    </div>
    <button
      type="button"
      onclick={handleExportTrombinoscope}
      disabled={exportingPdf}
      class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg transition-colors shrink-0 disabled:opacity-50"
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
          : ''} {dragOverIdx === idx && draggedIdx !== idx ? 'ring-2 ring-cn-yellow/60' : ''}"
      >
        <button
          type="button"
          aria-label={m.asso_members_drag_label()}
          class="mt-3.5 cursor-grab touch-none text-text-muted hover:text-text-main transition-colors shrink-0"
        >
          <GripVertical size={18} />
        </button>
        <div class="flex-1 min-w-0">
          <AssociationMemberRow
            {member}
            displayName={resolvedMemberNames[member.userId] ?? member.displayName ?? member.userId}
            manage={true}
            onRoleChange={handleChangeRole}
            onRemove={handleRemoveMember}
          />
        </div>
      </div>
    {/each}
  </div>

  <!-- Cotisation tags make no sense for promo lists; hidden there. -->
  {#if asso.type !== 'list'}
    <div class="border-t border-cn-border pt-5 space-y-3">
      <h3 class="text-sm font-bold text-text-main flex items-center gap-2">
        <Tag size={16} />
        {m.asso_members_tags_title()}
      </h3>
      <p class="text-xs text-text-muted">
        {m.asso_members_tags_desc()}
      </p>
      {#if assoTagsLoading}
        <p class="text-sm text-text-muted">{m.common_loading_label()}</p>
      {:else if assoTagsError}
        <p class="text-sm text-red-600">{assoTagsError}</p>
      {:else if assoTags.length === 0}
        <p class="text-sm text-text-muted">{m.asso_members_no_active_tags()}</p>
      {:else}
        <ul class="space-y-2">
          {#each assoTags as tag (tag.id)}
            <li
              class="flex items-center gap-3 rounded-xl border border-cn-border bg-cn-bg/40 px-4 py-3"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold text-text-main">{tag.tagName}</p>
                <p class="text-xs text-text-muted mt-0.5">
                  {tagHolderName(tag)}
                  {#if tag.expiresAt}
                    · {m.asso_members_tag_expires({
                      date: new Date(tag.expiresAt).toLocaleDateString(
                        getLocale() === 'en' ? 'en-US' : 'fr-FR'
                      ),
                    })}
                  {:else}
                    · {m.asso_members_tag_no_expiry()}
                  {/if}
                </p>
              </div>
              <span
                class="shrink-0 rounded-full bg-emerald-100 text-emerald-700 px-2.5 py-0.5 text-xs font-bold"
              >
                {m.asso_members_tag_active_badge()}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="border-t border-cn-border pt-5">
    <h3 class="text-sm font-bold text-text-main mb-3 flex items-center gap-2">
      <UserPlus size={17} />
      {m.asso_members_add_title()}
    </h3>
    <form
      class="flex flex-col lg:flex-row gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        handleAddMember();
      }}
    >
      <div class="flex-1 min-w-0">
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
        class="w-full lg:w-36 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
      />
      <select
        bind:value={newMemberPermissions}
        class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm w-full lg:w-auto"
      >
        <option value={0}>{m.asso_members_role_member()}</option>
        <option value={ASSOCIATION_ADMIN_PRESET}>{m.asso_members_role_admin()}</option>
      </select>
      <button
        type="submit"
        disabled={addingMember || !newMemberUserId.trim()}
        class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
      >
        {addingMember ? '…' : m.common_add_button()}
      </button>
    </form>
    {#if memberError}
      <p class="text-sm text-red-600 mt-3">{memberError}</p>
    {/if}
  </div>
</div>
