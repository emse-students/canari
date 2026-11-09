<script lang="ts">
  import { untrack } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import { listDependencies, setDependency, type DependencyEntity } from '$lib/associations/api';
  import {
    dependencyRefusalMessage,
    groupDependencies,
    type BdeFamily,
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

  /** Per BDE: the list is narrowed to the entities whose audience reaches outside its spaces. */
  let onlyMismatched = $state<Record<string, boolean>>({});

  const reachesOutside = (e: DependencyEntity) => e.mismatches.includes('reaches_outside_parent');
  const outsideCount = (family: BdeFamily) => family.children.filter(reachesOutside).length;
  /** The filter only applies while a flagged child remains: with none left no control exists to undo it. */
  const visibleChildren = (family: BdeFamily) =>
    onlyMismatched[family.bde.id] && outsideCount(family) > 0
      ? family.children.filter(reachesOutside)
      : family.children;

  /** A BDE's children split into associations and lists, empty blocks dropped. */
  function subgroups(
    rows: DependencyEntity[]
  ): { key: 'association' | 'list'; title: string; rows: DependencyEntity[] }[] {
    return [
      {
        key: 'association' as const,
        title: m.admin_dependencies_group_associations(),
        rows: rows.filter((r) => r.type !== 'list'),
      },
      {
        key: 'list' as const,
        title: m.admin_dependencies_group_lists(),
        rows: rows.filter((r) => r.type === 'list'),
      },
    ].filter((g) => g.rows.length > 0);
  }

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
      // A filter whose flagged children are all gone must not outlive its toggle.
      for (const family of groupDependencies(entities).families) {
        if (onlyMismatched[family.bde.id] && outsideCount(family) === 0) {
          onlyMismatched[family.bde.id] = false;
        }
      }
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
  <li class="py-1.5" data-dependency-row={entity.id} data-archived={entity.archived || undefined}>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
      <span
        class="text-text-main min-w-0 truncate text-sm font-medium"
        class:opacity-60={entity.archived}
        title={entity.name}
      >
        {entity.name}
      </span>
      <span
        class="border-cn-border text-text-muted shrink-0 rounded-full border px-2 text-xs"
        data-kind={entity.type}
      >
        {kindLabel(entity)}
      </span>
      {#if entity.archived}
        <span class="text-text-muted shrink-0 text-xs italic" data-archived-hint>
          {m.admin_dependencies_archived()}
        </span>
      {/if}
      {#if label}
        <span
          class="text-text-muted min-w-0 truncate text-xs"
          title={m.admin_dependencies_shown_under({ name: label.name })}
        >
          {m.admin_dependencies_shown_under({ name: label.name })}
        </span>
      {/if}
      {#each entity.mismatches as mismatch (mismatch)}
        <span
          class="text-amber-warn shrink-0"
          role="img"
          title={mismatchText(mismatch)}
          aria-label={mismatchText(mismatch)}
          data-mismatch={mismatch}
        >
          <TriangleAlert size={14} />
        </span>
      {/each}
      {#if editable && editing !== entity.id}
        <Button variant="ghost" size="compact" class="ml-auto" onclick={() => open(entity)}>
          {m.admin_dependencies_change()}
        </Button>
      {/if}
    </div>
    {#each entity.mismatches.filter((x) => x !== 'reaches_outside_parent') as mismatch (mismatch)}
      <p class="text-amber-warn mt-0.5 text-xs" data-mismatch-text={mismatch}>
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
        <Button variant="secondary" disabled={saving} onclick={() => (editing = null)}>
          {m.common_cancel_button()}
        </Button>
      </div>
    {/if}
  </li>
{/snippet}

{#snippet familyChildren(rows: DependencyEntity[])}
  {#each subgroups(rows) as sub (sub.key)}
    <div class="border-cn-border mt-1 ml-3 border-l pl-3" data-subgroup={sub.key}>
      <h4 class="text-text-muted text-xs font-semibold tracking-wide uppercase">
        {sub.title} ({sub.rows.length})
      </h4>
      <ul class="divide-cn-border/70 divide-y">
        {#each sub.rows as child (child.id)}
          {@render row(child, true)}
        {/each}
      </ul>
    </div>
  {/each}
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
          <h3 class="font-display text-text-main text-sm font-bold">
            {family.bde.name}
            <span class="text-text-muted text-xs font-normal">
              {m.admin_dependencies_children({ count: family.children.length })}
            </span>
          </h3>
          {#if outsideCount(family) > 0}
            <p
              class="text-amber-warn mt-1 flex flex-wrap items-center gap-2 text-xs"
              data-mismatch-summary={family.bde.id}
            >
              <TriangleAlert size={14} />
              {m.admin_dependencies_mismatch_summary({ count: outsideCount(family) })}
              <Button
                variant="ghost"
                size="compact"
                data-mismatch-filter={family.bde.id}
                onclick={() => (onlyMismatched[family.bde.id] = !onlyMismatched[family.bde.id])}
              >
                {onlyMismatched[family.bde.id]
                  ? m.admin_dependencies_mismatch_show_all()
                  : m.admin_dependencies_mismatch_show_only()}
              </Button>
            </p>
          {/if}
          {@render familyChildren(visibleChildren(family))}
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
