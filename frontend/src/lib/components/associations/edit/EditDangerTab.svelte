<script lang="ts">
  import { updateAssociation, deleteAssociation, type Association } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Building2, Trash2 } from '@lucide/svelte';

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

  const noun = $derived(kind === 'list' ? 'la liste' : "l'association");
  const Noun = $derived(kind === 'list' ? 'La liste' : "L'association");

  let archiving = $state(false);
  let error = $state('');

  async function handleToggleArchive() {
    const next = !asso.archived;
    if (
      next &&
      !(await showConfirm(
        `Archiver ${noun} ? Elle passera dans « Anciennes » et disparaîtra des « Mes associations » de ses membres.`,
        { confirmLabel: 'Archiver' }
      ))
    )
      return;
    archiving = true;
    error = '';
    try {
      onUpdated(await updateAssociation(asso.id, { archived: next }));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur';
    } finally {
      archiving = false;
    }
  }

  async function handleDelete() {
    if (
      !(await showConfirm(`Supprimer ${noun} ? Cette action est irréversible.`, {
        danger: true,
        confirmLabel: 'Supprimer',
      }))
    )
      return;
    try {
      await deleteAssociation(asso.id);
      onDeleted();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur lors de la suppression';
    }
  }
</script>

<div class="space-y-6">
  {#if error}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {/if}

  <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-3 shadow-sm">
    <h2 class="text-base font-bold text-text-main flex items-center gap-2">
      <Building2 size={18} />
      {asso.archived ? `${Noun} archivée` : `Archiver ${noun}`}
    </h2>
    <p class="text-sm text-text-muted">
      {asso.archived
        ? `${Noun} est archivée : elle apparaît sous « Anciennes » et n’est plus listée dans les « Mes associations » de ses membres. Vous pouvez la réactiver.`
        : `Déplace ${noun} vers « Anciennes » sans rien supprimer. Réversible à tout moment.`}
    </p>
    <button
      type="button"
      onclick={handleToggleArchive}
      disabled={archiving}
      class="rounded-xl border border-cn-border px-4 py-2.5 text-sm font-bold text-text-main hover:bg-cn-bg disabled:opacity-50"
    >
      {archiving ? '…' : asso.archived ? `Réactiver ${noun}` : `Archiver ${noun}`}
    </button>
  </div>

  <div class="rounded-2xl border border-red-200 bg-red-50/60 p-6 space-y-3">
    <h2 class="text-base font-bold text-red-700 flex items-center gap-2">
      <Trash2 size={18} />
      Zone de danger
    </h2>
    <p class="text-sm text-red-800/90">
      Supprime définitivement {noun} et ses liens (membres, événements d’agenda). Les messages du fil
      peuvent rester visibles selon la politique serveur.
    </p>
    <button
      type="button"
      onclick={handleDelete}
      class="rounded-xl bg-white border border-red-300 px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100"
    >
      Supprimer {noun}
    </button>
  </div>
</div>
