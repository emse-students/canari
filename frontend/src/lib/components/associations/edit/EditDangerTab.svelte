<script lang="ts">
  import { updateAssociation, deleteAssociation, type Association } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Building2, Trash2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
    /** Called with the refreshed association after archive/unarchive. */
    onUpdated: (a: Association) => void;
    /** Called after the association is deleted (parent navigates away). */
    onDeleted: () => void;
    /** 'list' tweaks the wording; defaults to association. */
    kind?: 'association' | 'list';
  }

  let { asso, onUpdated, onDeleted, kind = 'association' }: Props = $props();

  let archiving = $state(false);
  let error = $state('');

  async function handleToggleArchive() {
    const next = !asso.archived;
    if (
      next &&
      !(await showConfirm(
        kind === 'list'
          ? m.asso_danger_archive_confirm_list()
          : m.asso_danger_archive_confirm_asso(),
        { confirmLabel: m.asso_danger_archive_confirm_button() }
      ))
    )
      return;
    archiving = true;
    error = '';
    try {
      onUpdated(await updateAssociation(asso.id, { archived: next }));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Error';
    } finally {
      archiving = false;
    }
  }

  async function handleDelete() {
    if (
      !(await showConfirm(
        kind === 'list' ? m.asso_danger_delete_confirm_list() : m.asso_danger_delete_confirm_asso(),
        { danger: true, confirmLabel: m.common_delete_button() }
      ))
    )
      return;
    try {
      await deleteAssociation(asso.id);
      onDeleted();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Error deleting';
    }
  }
</script>

<div class="space-y-6">
  {#if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {/if}

  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-3 shadow-sm"
  >
    <h2 class="text-base font-bold text-text-main flex items-center gap-2">
      <Building2 size={18} />
      {asso.archived
        ? kind === 'list'
          ? m.asso_danger_archive_title_archived_list()
          : m.asso_danger_archive_title_archived_asso()
        : kind === 'list'
          ? m.asso_danger_archive_title_list()
          : m.asso_danger_archive_title_asso()}
    </h2>
    <p class="text-sm text-text-muted">
      {asso.archived
        ? kind === 'list'
          ? m.asso_danger_archived_desc_list()
          : m.asso_danger_archived_desc_asso()
        : kind === 'list'
          ? m.asso_danger_unarchived_desc_list()
          : m.asso_danger_unarchived_desc_asso()}
    </p>
    <button
      type="button"
      onclick={handleToggleArchive}
      disabled={archiving}
      class="rounded-xl border border-cn-border px-4 py-2.5 text-sm font-bold text-text-main hover:bg-cn-bg disabled:opacity-50"
    >
      {archiving
        ? '…'
        : asso.archived
          ? kind === 'list'
            ? m.asso_danger_reactivate_list()
            : m.asso_danger_reactivate_asso()
          : kind === 'list'
            ? m.asso_danger_archive_list()
            : m.asso_danger_archive_asso()}
    </button>
  </div>

  <div class="rounded-2xl border border-red-200 bg-red-50/60 p-6 space-y-3">
    <h2 class="text-base font-bold text-red-700 flex items-center gap-2">
      <Trash2 size={18} />
      {m.asso_danger_title()}
    </h2>
    <p class="text-sm text-red-800/90">
      {kind === 'list' ? m.asso_danger_delete_desc_list() : m.asso_danger_delete_desc_asso()}
    </p>
    <button
      type="button"
      onclick={handleDelete}
      class="rounded-xl bg-white border border-red-300 px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100"
    >
      {kind === 'list' ? m.asso_danger_delete_list() : m.asso_danger_delete_asso()}
    </button>
  </div>
</div>
