<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    listAllAudiences,
    listAssociations,
    listSpaces,
    setSpaceBde,
    setAssociationAudiences,
    SocialApiError,
    type Association,
    type AudienceRule,
    type SpaceRow,
  } from '$lib/associations/api';
  import {
    ALL_CELLS,
    campusCells,
    cellOf,
    coverage,
    reachedCells,
    toggleGroup,
    toRules,
    type Cell,
    type Coverage,
  } from '$lib/associations/audienceRules';
  import { CAMPUSES, FORMATIONS, campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { Check, ChevronDown, Layers, Minus, Star } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let spaces = $state<SpaceRow[]>([]);
  let associations = $state<Association[]>([]);
  /** The stored rules of each association, by id. */
  let rulesById = $state<Record<string, AudienceRule[]>>({});
  /** The cell being persisted, so a second click cannot race the first. */
  let busy = $state<string | null>(null);

  /** One collapsible grid per kind of entity, each sorted by name; `type` is the API discriminator. */
  const sections = $derived.by(() => {
    const sorted = [...associations].sort((a, b) => a.name.localeCompare(b.name));
    const of = (type: Association['type']) => sorted.filter((a) => a.type === type);
    return [
      {
        type: 'association',
        title: m.admin_spaces_section_associations(),
        rows: of('association'),
      },
      { type: 'list', title: m.admin_spaces_section_lists(), rows: of('list') },
      {
        type: 'institution',
        title: m.admin_spaces_section_institutions(),
        rows: of('institution'),
      },
    ];
  });

  /** The pairs an association reaches, read back from its stored rules. */
  function reachOf(association: Association): Set<Cell> {
    return reachedCells(rulesById[association.id] ?? []);
  }

  function spaceOf(cell: Cell): SpaceRow | undefined {
    return spaces.find((s) => cellOf(s.formation, s.campus) === cell);
  }

  /** Reads the rules of every association, in one call. */
  async function loadRules() {
    const byId: Record<string, AudienceRule[]> = {};
    for (const r of await listAllAudiences()) {
      (byId[r.associationId] ??= []).push({ formation: r.formation, campus: r.campus });
    }
    rulesById = byId;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      [spaces, associations] = await Promise.all([listSpaces(), listAssociations()]);
      await loadRules();
    } catch (e) {
      Log.d('admin.spaces.load failed', e);
      error = m.admin_spaces_load_error();
    } finally {
      loading = false;
    }
  }

  /**
   * Saves the pairs an association reaches, in the smallest equivalent rule set. None is allowed
   * (it then reaches nobody); the server puts back the pairs it governs as BDE, and what it answers
   * is what the grid shows.
   */
  async function saveReach(association: Association, cells: Set<Cell>, cellKey: string) {
    busy = cellKey;
    error = null;
    try {
      rulesById[association.id] = await setAssociationAudiences(association.id, toRules(cells));
      return true;
    } catch (e) {
      Log.d('admin.spaces.saveReach failed', e);
      error = m.admin_audiences_save_error();
      return false;
    } finally {
      busy = null;
    }
  }

  /** A parent checkbox: reaches every pair of the group, or clears the group when all are in. */
  function toggleReachGroup(association: Association, group: readonly Cell[], cellKey: string) {
    return saveReach(association, toggleGroup(reachOf(association), group), cellKey);
  }

  /** The sentence for a refused BDE designation, chosen by the HTTP status (never by the message). */
  function bdeRefusal(e: unknown): string {
    if (e instanceof SocialApiError) {
      if (e.status === 400) return m.admin_spaces_bde_not_association();
      if (e.status === 404) return m.admin_spaces_bde_missing();
    }
    return m.admin_spaces_bde_error();
  }

  /**
   * Makes an association the BDE of a pair, or clears it when it already is. A BDE always reaches
   * what it governs: the server adds that reach with the designation, so the rules are read back.
   */
  async function toggleBde(space: SpaceRow, association: Association) {
    const cellKey = `${association.id}:${cellOf(space.formation, space.campus)}`;
    busy = cellKey;
    error = null;
    try {
      await setSpaceBde(space.id, space.bde?.id === association.id ? null : association.id);
      await loadRules();
    } catch (e) {
      Log.d('admin.spaces.setBde failed', e);
      error = bdeRefusal(e);
    } finally {
      busy = null;
    }
    // The grid shows what the server kept, not what was clicked.
    spaces = await listSpaces().catch(() => spaces);
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto(resolve('/admin'), { replaceState: true });
      return;
    }
    void load();
  });

  const cellButton =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-50';

  /** The classes of a check box: filled when all are in, outlined when only some are. */
  function boxClass(state: Coverage): string {
    if (state === 'all') return 'border-cn-yellow bg-cn-yellow/20 text-cn-dark';
    if (state === 'some') return 'border-cn-yellow/60 text-cn-dark';
    return 'border-cn-border text-transparent hover:text-text-muted';
  }
</script>

<div class="space-y-6">
  <header class="flex items-start gap-3">
    <span
      class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
    >
      <Layers size={20} />
    </span>
    <div>
      <h2 class="text-text-main text-lg font-bold">{m.admin_spaces_title()}</h2>
      <p class="text-text-muted mt-0.5 text-sm">{m.admin_spaces_subtitle()}</p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    <p class="text-text-muted text-xs">{m.admin_spaces_legend()}</p>

    {#snippet grid(title: string, rows: Association[])}
      <div class="border-cn-border overflow-x-auto rounded-2xl border bg-(--cn-surface)">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="border-cn-border border-b">
              <th rowspan="2" class="text-text-muted px-4 py-3 text-left text-xs font-semibold">
                {title}
              </th>
              <th rowspan="2" class="text-text-muted px-2 py-3 text-center text-xs font-semibold">
                {m.admin_spaces_col_all()}
              </th>
              {#each CAMPUSES as campus (campus)}
                <th
                  colspan={FORMATIONS.length + 1}
                  class="text-text-main border-cn-border border-l px-2 pt-3 pb-1 text-center text-xs font-bold"
                >
                  {campusLabel(campus)}
                </th>
              {/each}
            </tr>
            <tr class="border-cn-border border-b">
              {#each CAMPUSES as campus (campus)}
                <th
                  class="text-text-muted border-cn-border border-l px-1.5 pb-3 text-center text-xs font-semibold"
                >
                  {m.admin_spaces_col_campus()}
                </th>
                {#each FORMATIONS as formation (formation)}
                  <th class="text-text-muted px-1.5 pb-3 text-center text-xs font-semibold">
                    {formationLabel(formation)}
                  </th>
                {/each}
              {/each}
            </tr>
          </thead>
          <tbody class="divide-cn-border/70 divide-y">
            {#each rows as association (association.id)}
              {@const reached = reachOf(association)}
              {@const everyone = coverage(ALL_CELLS, reached)}
              <tr>
                <th class="text-text-main min-w-48 px-4 py-2 text-left text-sm font-medium">
                  <span class="flex items-center gap-2.5">
                    <AssociationAvatar
                      name={association.name}
                      logoUrl={association.logoUrl}
                      size="sm"
                    />
                    <span>{association.name}</span>
                  </span>
                </th>
                <td class="px-1.5 py-2 text-center">
                  <button
                    type="button"
                    disabled={busy === `${association.id}:all`}
                    aria-pressed={everyone === 'all'}
                    aria-label={m.admin_spaces_everyone_aria({ association: association.name })}
                    onclick={() =>
                      toggleReachGroup(association, ALL_CELLS, `${association.id}:all`)}
                    class="{cellButton} {boxClass(everyone)}"
                  >
                    {#if everyone === 'some'}<Minus size={14} />{:else}<Check size={14} />{/if}
                  </button>
                </td>
                {#each CAMPUSES as campus (campus)}
                  {@const group = campusCells(campus)}
                  {@const state = coverage(group, reached)}
                  <td class="border-cn-border border-l px-1.5 py-2 text-center">
                    <button
                      type="button"
                      disabled={busy === `${association.id}:${campus}`}
                      aria-pressed={state === 'all'}
                      aria-label={m.admin_spaces_campus_aria({
                        association: association.name,
                        campus: campusLabel(campus),
                      })}
                      onclick={() =>
                        toggleReachGroup(association, group, `${association.id}:${campus}`)}
                      class="{cellButton} {boxClass(state)}"
                    >
                      {#if state === 'some'}<Minus size={14} />{:else}<Check size={14} />{/if}
                    </button>
                  </td>
                  {#each FORMATIONS as formation (formation)}
                    {@const cell = cellOf(formation, campus)}
                    {@const space = spaceOf(cell)}
                    {@const cellKey = `${association.id}:${cell}`}
                    {@const label = `${formationLabel(formation)} · ${campusLabel(campus)}`}
                    {@const isBde = space?.bde?.id === association.id}
                    <td class="px-1.5 py-2 text-center">
                      <div class="group relative inline-flex">
                        <!-- A BDE reaches the pair it governs: the box stays ticked until the star goes. -->
                        <button
                          type="button"
                          disabled={busy === cellKey}
                          aria-pressed={reached.has(cell)}
                          aria-disabled={isBde}
                          aria-label={m.admin_spaces_reach_aria({
                            association: association.name,
                            space: label,
                          })}
                          onclick={() => {
                            if (!isBde) void toggleReachGroup(association, [cell], cellKey);
                          }}
                          class="{cellButton} {isBde ? 'cursor-default' : ''} {boxClass(
                            reached.has(cell) ? 'all' : 'none'
                          )}"
                        >
                          <Check size={14} />
                        </button>
                        {#if association.type === 'association' && space}
                          <button
                            type="button"
                            disabled={busy === cellKey}
                            aria-pressed={isBde}
                            aria-label={m.admin_spaces_bde_aria({
                              association: association.name,
                              space: label,
                            })}
                            onclick={() => toggleBde(space, association)}
                            class="absolute -top-1.5 -right-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border transition-opacity disabled:opacity-50 {isBde
                              ? 'border-cn-yellow bg-cn-yellow text-cn-ink'
                              : 'border-cn-border text-text-muted bg-(--cn-surface) opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
                          >
                            <Star size={10} />
                          </button>
                        {/if}
                      </div>
                    </td>
                  {/each}
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/snippet}

    {#each sections as section (section.type)}
      <details open class="group/section space-y-3" data-section={section.type}>
        <summary
          class="text-text-main flex cursor-pointer list-none items-center gap-2 text-base font-bold select-none"
        >
          <ChevronDown
            size={18}
            class="text-text-muted transition-transform group-not-open/section:-rotate-90"
          />
          {section.title}
          <span class="bg-cn-yellow/20 text-cn-dark rounded-full px-2 py-0.5 text-xs font-semibold">
            {section.rows.length}
          </span>
        </summary>
        {#if section.rows.length === 0}
          <p class="text-text-muted text-sm">{m.admin_spaces_section_empty()}</p>
        {:else}
          {@render grid(section.title, section.rows)}
        {/if}
      </details>
    {/each}
  {/if}
</div>
