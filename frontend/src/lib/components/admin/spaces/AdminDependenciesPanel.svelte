<script lang="ts">
  import { untrack } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import { listDependencies, setDependency, type DependencyEntity } from '$lib/associations/api';
  import {
    dependencyRefusalMessage,
    groupDependencies,
    labelCandidates,
    mismatchText,
    parentCandidates,
  } from '$lib/associations/dependencies';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import Button from '$lib/components/ui/Button.svelte';
  import { ChevronDown, GitFork, TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE DEPENDENCIES PANEL (reform 2.7, WP-D1): each BDE with the entities that depend on it, then
   * the institutions, the unattached and the orphaned apart, each mismatch of 2.5 shown beside its
   * entity. A platform admin changes a parent and a list's display label here, and only here; the
   * server journals each change and refuses what the two-level rule forbids with a typed code.
   */
  interface Props {
    /** Bumped by the page when a governor changes, so the panel reads the axis again. */
    revision?: number;
  }

  let { revision = 0 }: Props = $props();

  let entities = $state<DependencyEntity[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** The entity whose row is open for editing, and its draft. */
  let editing = $state<string | null>(null);
  let draftParent = $state('');
  let draftLabel = $state('');
  let saving = $state(false);

  const tree = $derived(groupDependencies(entities));
  const byId = $derived(new Map(entities.map((e) => [e.id, e])));

  const parentOptions = $derived<PickerOption[]>([
    { value: '', label: m.admin_dependencies_parent_none() },
    ...parentCandidates(entities).map((e) => ({ value: e.id, label: e.name })),
  ]);
  const labelOptions = $derived<PickerOption[]>([
    { value: '', label: m.admin_dependencies_label_none() },
    ...labelCandidates(entities).map((e) => ({ value: e.id, label: e.name })),
  ]);

  async function load() {
    Log.d('admin.dependencies.load');
    loading = true;
    try {
      entities = await listDependencies();
      error = null;
    } catch (e) {
      Log.d('admin.dependencies.load failed', e);
      error = m.admin_dependencies_load_error();
    } finally {
      loading = false;
    }
  }

  function open(entity: DependencyEntity) {
    editing = entity.id;
    draftParent = entity.parentAssociationId ?? '';
    draftLabel = entity.displayParentAssociationId ?? '';
    error = null;
  }

  /** Writes the draft, then reads the whole axis back: a parent change moves mismatches elsewhere. */
  async function save(entity: DependencyEntity) {
    saving = true;
    error = null;
    const parent = draftParent || null;
    const label = entity.type === 'list' ? draftLabel || null : undefined;
    Log.d(
      `admin.dependencies.save ${entity.id}: parent ${parent ?? 'none'}, label ${label ?? '-'}`
    );
    try {
      await setDependency(entity.id, parent, label);
      editing = null;
      await load();
    } catch (e) {
      Log.d('admin.dependencies.save failed', e);
      error = dependencyRefusalMessage(e) ?? m.admin_dependencies_save_error();
    } finally {
      saving = false;
    }
  }

  function kindLabel(entity: DependencyEntity): string {
    if (entity.type === 'list') return m.admin_dependencies_kind_list();
    if (entity.type === 'institution') return m.admin_dependencies_kind_institution();
    return m.admin_dependencies_kind_association();
  }

  // Read on mount, and again each time the page bumps `revision`: a governor designated on the
  // grid changes who is a BDE.
  $effect(() => {
    void revision;
    untrack(() => void load());
  });
</script>

{#snippet row(entity: DependencyEntity, editable: boolean)}
  {@const label = entity.displayParentAssociationId
    ? byId.get(entity.displayParentAssociationId)
    : undefined}
  <li class="py-2" data-dependency-row={entity.id}>
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-text-main text-sm font-medium" class:opacity-60={entity.archived}>
        {entity.name}
      </span>
      <span class="text-text-muted text-xs">{kindLabel(entity)}</span>
      {#if label}
        <span class="text-text-muted text-xs">
          {m.admin_dependencies_shown_under({ name: label.name })}
        </span>
      {/if}
      {#if editable && editing !== entity.id}
        <button
          type="button"
          class="text-cn-dark ml-auto text-xs font-semibold underline-offset-2 hover:underline"
          onclick={() => open(entity)}
        >
          {m.admin_dependencies_change()}
        </button>
      {/if}
    </div>
    {#each entity.mismatches as mismatch (mismatch)}
      <p class="text-amber-warn mt-1 flex items-center gap-1.5 text-xs" data-mismatch={mismatch}>
        <TriangleAlert size={12} />
        {mismatchText(mismatch)}
      </p>
    {/each}
    {#if editing === entity.id}
      <div class="mt-2 flex flex-wrap items-end gap-3" data-dependency-editor>
        <div class="w-56">
          <Picker
            id="dependency-parent-{entity.id}"
            value={draftParent}
            options={parentOptions}
            label={m.admin_dependencies_parent_label()}
            variant="field"
            density="default"
            onValueChange={(v) => (draftParent = v)}
          />
        </div>
        {#if entity.type === 'list'}
          <div class="w-56">
            <Picker
              id="dependency-label-{entity.id}"
              value={draftLabel}
              options={labelOptions}
              label={m.admin_dependencies_label_label()}
              variant="field"
              density="default"
              onValueChange={(v) => (draftLabel = v)}
            />
          </div>
        {/if}
        <Button loading={saving} disabled={saving} onclick={() => save(entity)}>
          {m.common_save_button()}
        </Button>
        <Button variant="outline" disabled={saving} onclick={() => (editing = null)}>
          {m.common_cancel_button()}
        </Button>
      </div>
    {/if}
  </li>
{/snippet}

{#snippet group(title: string, rows: DependencyEntity[], editable: boolean)}
  {#if rows.length > 0}
    <div>
      <h4 class="text-text-muted text-xs font-semibold tracking-wide uppercase">
        {title} ({rows.length})
      </h4>
      <ul class="divide-cn-border/70 divide-y">
        {#each rows as entity (entity.id)}
          {@render row(entity, editable)}
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<details class="group/deps space-y-3" data-dependencies-panel>
  <summary
    class="text-text-main flex cursor-pointer list-none items-center gap-2 text-base font-bold select-none"
  >
    <ChevronDown
      size={18}
      class="text-text-muted transition-transform group-not-open/deps:-rotate-90"
    />
    <GitFork size={16} />
    {m.admin_dependencies_title()}
  </summary>
  <p class="text-text-muted text-xs">{m.admin_dependencies_legend()}</p>

  {#if error}
    <p class="text-sm text-red-500" role="alert">{error}</p>
  {/if}

  {#if loading}
    <p class="text-text-muted text-sm">{m.admin_dependencies_loading()}</p>
  {:else}
    <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface) p-4">
      {#each tree.families as family (family.bde.id)}
        <section data-family={family.bde.id}>
          <h3 class="text-text-main text-sm font-bold">
            {family.bde.name}
            <span class="text-text-muted text-xs font-normal">
              {m.admin_dependencies_children({ count: family.children.length })}
            </span>
          </h3>
          {#if family.children.length > 0}
            <ul class="divide-cn-border/70 border-cn-border ml-3 divide-y border-l pl-3">
              {#each family.children as child (child.id)}
                {@render row(child, true)}
              {/each}
            </ul>
          {/if}
        </section>
      {:else}
        <p class="text-text-muted text-sm">{m.admin_dependencies_no_bde()}</p>
      {/each}
      {@render group(m.admin_dependencies_orphaned(), tree.orphaned, true)}
      {@render group(m.admin_dependencies_unattached(), tree.unattached, true)}
      {@render group(m.admin_dependencies_institutions(), tree.institutions, false)}
    </div>
  {/if}
</details>
