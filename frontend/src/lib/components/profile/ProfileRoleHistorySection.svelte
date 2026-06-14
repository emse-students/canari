<script lang="ts">
  import {
    createMyRoleHistory,
    deleteMyRoleHistory,
    formatRoleHistoryPeriod,
    type UserRoleHistoryRow,
  } from '$lib/profile/api';
  import { listAssociations, type Association } from '$lib/associations/api';
  import { groupAssociationsForSelect, listOptionLabel } from '$lib/associations/selectGroups';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { Plus, Trash2 } from '@lucide/svelte';

  interface Props {
    entries: UserRoleHistoryRow[];
    editable?: boolean;
    onChanged?: () => void | Promise<void>;
  }

  const props: Props = $props();
  const entries = $derived(props.entries);
  const editable = $derived(props.editable ?? false);

  let showForm = $state(false);
  let saving = $state(false);
  let formError = $state('');
  let associations = $state<Association[]>([]);

  let formAssociationId = $state('');
  let formRoleTitle = $state('');
  let formStartYear = $state<number | ''>('');
  let formEndYear = $state<number | ''>('');

  const grouped = $derived(groupAssociationsForSelect(associations));
  const assoOptions = $derived(grouped.assos);
  const listOptions = $derived(grouped.lists);

  async function ensureAssociations() {
    if (associations.length > 0) return;
    try {
      associations = await listAssociations();
    } catch {
      associations = [];
    }
  }

  async function openForm() {
    formError = '';
    formAssociationId = '';
    formRoleTitle = '';
    formStartYear = '';
    formEndYear = '';
    showForm = true;
    await ensureAssociations();
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!formAssociationId || !formRoleTitle.trim()) {
      formError = 'Association et rôle requis.';
      return;
    }
    saving = true;
    formError = '';
    try {
      await createMyRoleHistory({
        associationId: formAssociationId,
        roleTitle: formRoleTitle.trim(),
        ...(formStartYear !== '' ? { startYear: Number(formStartYear) } : {}),
        ...(formEndYear !== '' ? { endYear: Number(formEndYear) } : {}),
      });
      showForm = false;
      await props.onChanged?.();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      saving = false;
    }
  }

  async function handleDelete(entry: UserRoleHistoryRow) {
    if (
      !await showConfirm(`Supprimer « ${entry.roleTitle} » (${entry.associationName}) ?`, {
        danger: true,
        confirmLabel: 'Supprimer',
      })
    ) {
      return;
    }
    try {
      await deleteMyRoleHistory(entry.id);
      await props.onChanged?.();
    } catch {
      /* ignore */
    }
  }
</script>

<div class="space-y-3">
  {#if entries.length === 0 && !showForm}
    <p class="text-sm text-text-muted">
      {editable
        ? 'Ajoutez vos anciens mandats (ex. Président BDE 2018–2019).'
        : 'Aucun parcours renseigné.'}
    </p>
  {:else}
    <ul class="space-y-2">
      {#each entries as entry (entry.id)}
        <li
          class="flex items-start gap-3 rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-white/5 px-4 py-3"
        >
          <div class="shrink-0 mt-0.5">
            <AssociationAvatar
              name={entry.associationName}
              logoUrl={entry.associationLogoUrl}
              size="sm"
            />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-bold text-text-main">
              {entry.roleTitle}
              <span class="font-semibold text-text-muted"> · </span>
              <a
                href="/associations/{encodeURIComponent(entry.associationSlug)}"
                class="text-cn-dark hover:underline"
              >
                {entry.associationName}
              </a>
            </p>
            {#if formatRoleHistoryPeriod(entry.startYear, entry.endYear)}
              <p class="text-xs text-text-muted mt-0.5">
                {formatRoleHistoryPeriod(entry.startYear, entry.endYear)}
              </p>
            {/if}
          </div>
          {#if editable}
            <button
              type="button"
              onclick={() => void handleDelete(entry)}
              class="shrink-0 p-2 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
              title="Supprimer"
              aria-label="Supprimer"
            >
              <Trash2 size={16} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if editable}
    {#if showForm}
      <form
        class="rounded-xl border border-cn-border bg-cn-bg/30 p-4 space-y-3"
        onsubmit={(e) => void handleSubmit(e)}
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="sm:col-span-2">
            <label for="rh-asso" class="text-xs font-semibold text-text-muted block mb-1"
              >Association</label
            >
            <select
              id="rh-asso"
              bind:value={formAssociationId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
            >
              <option value="">Choisir…</option>
              {#if assoOptions.length > 0}
                <optgroup label="Associations">
                  {#each assoOptions as a (a.id)}
                    <option value={a.id}>{a.name}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if listOptions.length > 0}
                <optgroup label="Listes">
                  {#each listOptions as a (a.id)}
                    <option value={a.id}>{listOptionLabel(a)}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
          </div>
          <div class="sm:col-span-2">
            <label for="rh-role" class="text-xs font-semibold text-text-muted block mb-1"
              >Rôle</label
            >
            <input
              id="rh-role"
              type="text"
              bind:value={formRoleTitle}
              placeholder="Président, Trésorier…"
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label for="rh-start" class="text-xs font-semibold text-text-muted block mb-1"
              >Année début</label
            >
            <input
              id="rh-start"
              type="number"
              min="1900"
              max="2100"
              bind:value={formStartYear}
              placeholder="2018"
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label for="rh-end" class="text-xs font-semibold text-text-muted block mb-1"
              >Année fin</label
            >
            <input
              id="rh-end"
              type="number"
              min="1900"
              max="2100"
              bind:value={formEndYear}
              placeholder="2019"
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
            />
          </div>
        </div>
        {#if formError}
          <p class="text-sm text-red-600">{formError}</p>
        {/if}
        <div class="flex gap-2 justify-end">
          <button
            type="button"
            onclick={() => (showForm = false)}
            class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={saving}
            class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark disabled:opacity-50"
          >
            {saving ? 'Enregistrement…' : 'Ajouter'}
          </button>
        </div>
      </form>
    {:else}
      <button
        type="button"
        onclick={() => void openForm()}
        class="inline-flex items-center gap-2 rounded-xl border border-dashed border-cn-border px-4 py-2.5 text-sm font-semibold text-text-muted hover:text-text-main hover:border-cn-yellow/50 transition-colors"
      >
        <Plus size={16} />
        Ajouter un rôle passé
      </button>
    {/if}
  {/if}
</div>
