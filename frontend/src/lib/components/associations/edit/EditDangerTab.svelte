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
    <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
      {error}
    </div>
  {/if}

  <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
    <h2 class="text-text-main flex items-center gap-2 text-base font-bold">
      <Building2 size={18} />
      {asso.archived
        ? kind === 'list'
          ? m.asso_danger_archive_title_archived_list()
          : m.asso_danger_archive_title_archived_asso()
        : kind === 'list'
          ? m.asso_danger_archive_title_list()
          : m.asso_danger_archive_title_asso()}
    </h2>
    <p class="text-text-muted text-sm">
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
      class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold disabled:opacity-50"
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

  <div class="border-red-err/30 bg-red-err/10 space-y-3 rounded-2xl border p-6">
    <h2 class="text-red-err flex items-center gap-2 text-base font-bold">
      <Trash2 size={18} />
      {m.asso_danger_title()}
    </h2>
    <p class="text-red-err text-sm">
      {kind === 'list' ? m.asso_danger_delete_desc_list() : m.asso_danger_delete_desc_asso()}
    </p>
    <button
      type="button"
      onclick={handleDelete}
      class="bg-cn-surface border-red-err/30 text-red-err hover:bg-red-err/20 rounded-xl border px-4 py-2.5 text-sm font-bold"
    >
      {kind === 'list' ? m.asso_danger_delete_list() : m.asso_danger_delete_asso()}
    </button>
  </div>
</div>
