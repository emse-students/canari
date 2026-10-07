<script lang="ts">
  import { updateAssociation, deleteAssociation, type Association } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Building2, Trash2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { wordingFor, type AssociationKind } from '$lib/associations/kindWording';

  interface Props {
    asso: Association;
    /** Called with the refreshed association after archive/unarchive. */
    onUpdated: (a: Association) => void;
    /** Called after the association is deleted (parent navigates away). */
    onDeleted: () => void;
    /** The noun the panel speaks in (see `kindWording`); defaults to association. */
    kind?: AssociationKind;
    /**
     * Whether to offer the irreversible half of this panel.
     *
     * The two cards below are rights the SERVER separates and the client used to conflate: archive
     * is `PATCH :id { archived }`, admitted at `MANAGE_MEMBERS`, so an association's own admin and
     * a BDE `MANAGE_ASSO` super-admin both hold it; delete is `DELETE :id` behind a bare
     * `GlobalAdminGuard`. Gating the whole panel on the stricter of the two is what hid archiving
     * from everybody entitled to it, so the tier the panel cannot infer is passed in.
     *
     * Defaults to `false`: a destructive control is offered on an explicit grant, never by
     * omission.
     */
    canDelete?: boolean;
  }

  let { asso, onUpdated, onDeleted, kind = 'association', canDelete = false }: Props = $props();

  const words = $derived(wordingFor(kind).danger);

  let archiving = $state(false);
  let error = $state('');

  async function handleToggleArchive() {
    const next = !asso.archived;
    if (
      next &&
      !(await showConfirm(words.archiveConfirm(), {
        confirmLabel: m.asso_danger_archive_confirm_button(),
      }))
    )
      return;
    archiving = true;
    error = '';
    try {
      onUpdated(await updateAssociation(asso.id, { archived: next }));
    } catch (err) {
      error = m.common_save_error();
    } finally {
      archiving = false;
    }
  }

  async function handleDelete() {
    if (
      !(await showConfirm(words.deleteConfirm(), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deleteAssociation(asso.id);
      onDeleted();
    } catch (err) {
      error = m.common_delete_error();
    }
  }
</script>

<div class="space-y-6">
  {#if error}
    <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
      {error}
    </div>
  {/if}

  <div class="border-cn-border bg-cn-surface space-y-3 rounded-2xl border p-6 shadow-sm">
    <h2 class="text-text-main flex items-center gap-2 text-base font-bold">
      <Building2 size={18} />
      {asso.archived ? words.archiveTitleArchived() : words.archiveTitle()}
    </h2>
    <p class="text-text-muted text-sm">
      {asso.archived ? words.archivedDesc() : words.unarchivedDesc()}
    </p>
    <button
      type="button"
      onclick={handleToggleArchive}
      disabled={archiving}
      class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold disabled:opacity-50"
    >
      {archiving ? '…' : asso.archived ? words.reactivate() : words.archive()}
    </button>
  </div>

  {#if canDelete}
    <div class="border-red-err/30 bg-red-err/10 space-y-3 rounded-2xl border p-6">
      <h2 class="text-red-err flex items-center gap-2 text-base font-bold">
        <Trash2 size={18} />
        {m.asso_danger_title()}
      </h2>
      <p class="text-red-err text-sm">
        {words.deleteDesc()}
      </p>
      <button
        type="button"
        onclick={handleDelete}
        class="bg-cn-surface border-red-err/30 text-red-err hover:bg-red-err/20 rounded-xl border px-4 py-2.5 text-sm font-bold"
      >
        {words.delete()}
      </button>
    </div>
  {/if}
</div>
