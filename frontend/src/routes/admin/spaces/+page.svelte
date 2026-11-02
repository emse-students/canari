<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { showToast } from '$lib/stores/toast.svelte';
  import { internalPath } from '$lib/utils/internalPath';
  import {
    getAssociationAudiences,
    listAdminCatalogue,
    listSpaces,
    setSpaceBde,
    setAssociationAudiences,
    SocialApiError,
    type AdminCatalogueRow,
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
  import { editSectionHref, entityBase } from '$lib/associations/editSections';
  import { publicSectionHref } from '$lib/associations/publicSections';
  import { CAMPUSES, FORMATIONS, campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import AdminEntityCreateForm from '$lib/components/admin/spaces/AdminEntityCreateForm.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import Button from '$lib/components/ui/Button.svelte';
  import { Check, ChevronDown, Layers, Minus, Plus, Search, Star, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  type Kind = Association['type'];
  type KindFilter = Kind | 'all';

  /** One section's keyset pages: the rows fetched so far and the cursor of the next page. */
  interface SectionState {
    rows: AdminCatalogueRow[];
    next: string | null;
    loading: boolean;
  }

  const KINDS: readonly Kind[] = ['association', 'list', 'institution'];
  /** How long the search box must rest before the catalogue is asked again. */
  const SEARCH_PAUSE_MS = 300;

  let loading = $state(true);
  let error = $state<string | null>(null);
  let spaces = $state<SpaceRow[]>([]);
  let query = $state('');
  let kindFilter = $state<KindFilter>('all');
  let creating = $state(false);
  let pages = $state<Record<Kind, SectionState>>({
    association: { rows: [], next: null, loading: false },
    list: { rows: [], next: null, loading: false },
    institution: { rows: [], next: null, loading: false },
  });
  /** The stored rules of each listed entity, by id - read with its page, replaced on every write. */
  let rulesById = $state<Record<string, AudienceRule[]>>({});
  /** The cell being persisted, so a second click cannot race the first. */
  let busy = $state<string | null>(null);
  /** Numbers each catalogue reload when SENT: an answer older than the one on screen is dropped. */
  let loadSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const sectionTitles = $derived<Record<Kind, string>>({
    association: m.admin_spaces_section_associations(),
    list: m.admin_spaces_section_lists(),
    institution: m.admin_spaces_section_institutions(),
  });

  const filterOptions = $derived<PickerOption[]>([
    { value: 'all', label: m.admin_entity_filter_all() },
    { value: 'association', label: m.admin_spaces_section_associations() },
    { value: 'list', label: m.admin_spaces_section_lists() },
    { value: 'institution', label: m.admin_spaces_section_institutions() },
  ]);

  /** The kinds the filter shows, in their fixed order. */
  const visibleKinds = $derived<Kind[]>(
    kindFilter === 'all' ? [...KINDS] : KINDS.filter((k) => k === kindFilter)
  );

  /** The pairs an association reaches, read back from its stored rules. */
  function reachOf(association: Association): Set<Cell> {
    return reachedCells(rulesById[association.id] ?? []);
  }

  function spaceOf(cell: Cell): SpaceRow | undefined {
    return spaces.find((s) => cellOf(s.formation, s.campus) === cell);
  }

  /** Keeps the rules a page carried, so the grid draws each row from what the server stored. */
  function holdRules(rows: AdminCatalogueRow[]) {
    for (const row of rows) rulesById[row.id] = row.audiences;
  }

  /** Reads the first page of every visible kind for the current search, from scratch. */
  async function reloadCatalogue() {
    const seq = ++loadSeq;
    const kinds = visibleKinds;
    for (const kind of kinds) pages[kind].loading = true;
    try {
      const answers = await Promise.all(
        kinds.map((kind) => listAdminCatalogue(kind, { q: query }))
      );
      if (seq !== loadSeq) return;
      kinds.forEach((kind, i) => {
        holdRules(answers[i].rows);
        pages[kind] = { rows: answers[i].rows, next: answers[i].next, loading: false };
      });
      error = null;
    } catch (e) {
      if (seq !== loadSeq) return;
      Log.d('admin.spaces.catalogue failed', e);
      error = m.admin_spaces_load_error();
      for (const kind of kinds) pages[kind].loading = false;
    }
  }

  /** Appends the next page of one kind. */
  async function loadMore(kind: Kind) {
    const cursor = pages[kind].next;
    if (!cursor || pages[kind].loading) return;
    const seq = loadSeq;
    pages[kind].loading = true;
    try {
      const page = await listAdminCatalogue(kind, { q: query, after: cursor });
      // A search typed meanwhile restarted the list: this page belongs to the previous one.
      if (seq !== loadSeq) return;
      holdRules(page.rows);
      pages[kind] = { rows: [...pages[kind].rows, ...page.rows], next: page.next, loading: false };
    } catch (e) {
      Log.d('admin.spaces.loadMore failed', e);
      error = m.admin_spaces_load_error();
      pages[kind].loading = false;
    }
  }

  function onSearchInput(value: string) {
    query = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void reloadCatalogue(), SEARCH_PAUSE_MS);
  }

  function clearSearch() {
    clearTimeout(searchTimer);
    query = '';
    void reloadCatalogue();
  }

  function onFilterChange(value: string) {
    kindFilter = value as KindFilter;
    void reloadCatalogue();
  }

  async function load() {
    loading = true;
    error = null;
    try {
      spaces = await listSpaces();
      await reloadCatalogue();
    } catch (e) {
      Log.d('admin.spaces.load failed', e);
      error = m.admin_spaces_load_error();
    } finally {
      loading = false;
    }
  }

  /** A created entity: announced, then the catalogue is read again so its row appears. */
  function onCreated(created: Association) {
    creating = false;
    showToast(m.admin_entity_created({ name: created.name }), 'info');
    void reloadCatalogue();
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
   * what it governs: the server adds that reach with the designation, so ITS rules are read back.
   */
  async function toggleBde(space: SpaceRow, association: Association) {
    const cellKey = `${association.id}:${cellOf(space.formation, space.campus)}`;
    busy = cellKey;
    error = null;
    try {
      await setSpaceBde(space.id, space.bde?.id === association.id ? null : association.id);
      rulesById[association.id] = await getAssociationAudiences(association.id);
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
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    void load();
  });

  onDestroy(() => clearTimeout(searchTimer));

  const cellButton =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-50';
  const rowLink = 'text-cn-dark text-xs font-semibold underline-offset-2 hover:underline';

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
    <div class="min-w-0 flex-1">
      <h2 class="text-text-main text-lg font-bold">{m.admin_spaces_title()}</h2>
      <p class="text-text-muted mt-0.5 text-sm">{m.admin_spaces_subtitle()}</p>
    </div>
    <Button
      variant={creating ? 'outline' : 'primary'}
      aria-expanded={creating}
      onclick={() => (creating = !creating)}
    >
      {#if creating}<X size={16} />{:else}<Plus size={16} />{/if}
      {creating ? m.common_cancel_button() : m.admin_entity_create_open()}
    </Button>
  </header>

  {#if creating}
    <AdminEntityCreateForm {onCreated} />
  {/if}

  <div class="flex flex-wrap items-center gap-3" data-admin-toolbar>
    <label class="relative min-w-0 flex-1">
      <span class="sr-only">{m.admin_entity_search_label()}</span>
      <Search
        size={16}
        class="text-text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
      />
      <input
        type="search"
        value={query}
        oninput={(e) => onSearchInput(e.currentTarget.value)}
        placeholder={m.admin_entity_search_placeholder()}
        class="border-cn-border text-text-main w-full rounded-lg border bg-(--cn-surface) py-2 pr-9 pl-9 text-sm"
      />
      {#if query}
        <button
          type="button"
          onclick={clearSearch}
          aria-label={m.admin_entity_search_clear()}
          class="text-text-muted absolute top-1/2 right-2 -translate-y-1/2"
        >
          <X size={16} />
        </button>
      {/if}
    </label>
    <div class="w-48">
      <Picker
        id="admin-spaces-kind"
        value={kindFilter}
        options={filterOptions}
        label={m.admin_entity_filter_label()}
        variant="field"
        density="default"
        onValueChange={onFilterChange}
      />
    </div>
  </div>

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
                      id={association.id}
                      name={association.name}
                      logoUrl={association.logoUrl}
                      size="sm"
                    />
                    <span class="min-w-0">
                      <span class="block">{association.name}</span>
                      <span class="text-text-muted block text-xs font-normal">
                        {m.asso_edit_hub_members_summary({ count: association.memberCount ?? 0 })}
                      </span>
                      <span class="mt-0.5 flex gap-3" data-row-links>
                        <a
                          class={rowLink}
                          href={resolve(
                            internalPath(
                              publicSectionHref(entityBase(association.type), association.slug)
                            )
                          )}
                        >
                          {m.admin_entity_link_public()}
                        </a>
                        <a
                          class={rowLink}
                          href={resolve(
                            internalPath(
                              editSectionHref(association.slug, null, entityBase(association.type))
                            )
                          )}
                        >
                          {m.admin_entity_link_manage()}
                        </a>
                      </span>
                    </span>
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

    {#each visibleKinds as kind (kind)}
      {@const section = pages[kind]}
      <details open class="group/section space-y-3" data-section={kind}>
        <summary
          class="text-text-main flex cursor-pointer list-none items-center gap-2 text-base font-bold select-none"
        >
          <ChevronDown
            size={18}
            class="text-text-muted transition-transform group-not-open/section:-rotate-90"
          />
          {sectionTitles[kind]}
          <span class="bg-cn-yellow/20 text-cn-dark rounded-full px-2 py-0.5 text-xs font-semibold">
            {section.next ? `${section.rows.length}+` : section.rows.length}
          </span>
        </summary>
        {#if section.rows.length === 0 && !section.loading}
          <p class="text-text-muted text-sm">
            {query ? m.admin_entity_search_empty() : m.admin_spaces_section_empty()}
          </p>
        {:else}
          {@render grid(sectionTitles[kind], section.rows)}
        {/if}
        {#if section.next}
          <Button
            variant="outline"
            loading={section.loading}
            disabled={section.loading}
            onclick={() => loadMore(kind)}
          >
            {m.admin_entity_load_more()}
          </Button>
        {/if}
      </details>
    {/each}
  {/if}
</div>
