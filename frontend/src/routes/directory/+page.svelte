<script lang="ts">
  /**
   * THE MEMBER DIRECTORY, OPEN TO EVERY SIGNED-IN MEMBER (owner, 2026-11-13).
   *
   * One search field, the filters behind a "Filtres" sheet and echoed as removable chips, clean rows,
   * and before any search the reader's own class (the same query anyone may make). The server's
   * answer does not depend on who asks beyond the review-cohort rule it already applies; this page
   * only draws it (docs/wiki/profiles-and-access.md, D18).
   *
   * NO TIMER DRIVES A SEARCH: it runs on submit (Enter, the phone's search key) and when the sheet
   * applies, and a response that is not the LAST one asked for is dropped by a sequence number, so
   * the order the network answers in never decides what is shown.
   */
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Search, SlidersHorizontal, X } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import DirectoryRow from '$lib/components/directory/DirectoryRow.svelte';
  import { Log } from '$lib/utils/Log';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import { describeRefusalCode } from '$lib/utils/refusalCodes';
  import { searchDirectory, type DirectoryUserRow } from '$lib/profile/api';
  import { listAssociations, type Association } from '$lib/associations/api';
  import { currentUserId, fetchMyProfile } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import {
    CAMPUSES,
    POSTS,
    campusLabel,
    postLabel,
    type Campus,
    type Post,
  } from '$lib/profile/miconnectProfile';
  import {
    activeChips,
    emptyFilters,
    filterIssues,
    hasCriteria,
    promoOf,
    withoutFilter,
    type DirectoryFilters,
    type FilterKey,
  } from '$lib/directory/filters';

  const PAGE_SIZE = 30;
  const SUGGESTION_SIZE = 12;

  /**
   * What the last SUBMITTED search used; the chips and "load more" follow it. The search field
   * edits `queryDraft`, copied here only by a submit or the sheet's apply, so a half-typed name never
   * changes what "Voir plus" asks for.
   */
  let filters = $state<DirectoryFilters>(emptyFilters());
  let queryDraft = $state('');
  /** The sheet's working copy, committed by "Afficher les résultats". */
  let draft = $state<DirectoryFilters>(emptyFilters());
  let sheetOpen = $state(false);

  let associations = $state<Association[]>([]);
  let results = $state<DirectoryUserRow[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state('');
  /** A failed "Voir plus": its own line under the button, the list stays on screen. */
  let moreError = $state('');
  /** The last search was emptied of every criterion: say why the list went away. */
  let cleared = $state(false);
  let searched = $state(false);
  let suggestions = $state<DirectoryUserRow[]>([]);
  let seq = 0;

  const associationOptions = $derived<PickerOption[]>([
    { value: '', label: m.directory_filter_any() },
    ...associations.map((a) => ({ value: a.id, label: a.name })),
  ]);
  const campusOptions = $derived<PickerOption[]>([
    { value: '', label: m.directory_filter_any() },
    ...CAMPUSES.map((c) => ({ value: c, label: campusLabel(c) })),
  ]);
  const postOptions = $derived<PickerOption[]>([
    { value: '', label: m.directory_filter_any() },
    ...POSTS.map((p) => ({ value: p, label: postLabel(p) })),
  ]);
  const queryIssue = $derived(
    filterIssues({ ...emptyFilters(), query: queryDraft }).query === true
  );
  const draftIssues = $derived(filterIssues(draft));
  const chips = $derived(
    activeChips(filters, (id) => associations.find((a) => a.id === id)?.name ?? null)
  );

  onMount(async () => {
    const me = currentUserId();
    if (!me) {
      await goto(resolve('/login?returnTo=/directory'), { replace: true });
      return;
    }
    void loadAssociations();
    void loadSuggestions(me);
  });

  async function loadAssociations() {
    try {
      associations = await listAssociations();
    } catch (err) {
      Log.d('[directory] association list failed, the filter offers none', err);
    }
  }

  /** The reader's own class (first cursus entry, else the profile promo): a cheap, allowed query. */
  async function loadSuggestions(me: string) {
    try {
      const profile = await fetchMyProfile();
      const entry = profile.cursus?.[0];
      const promo = entry?.promo ?? profile.promo ?? undefined;
      if (promo == null) return;
      const res = await searchDirectory({
        promo,
        formation: entry?.formation,
        limit: SUGGESTION_SIZE + 1,
      });
      suggestions = res.users.filter((u) => u.id !== me).slice(0, SUGGESTION_SIZE);
      Log.d('[directory] class suggestions', { promo, n: suggestions.length });
    } catch (err) {
      Log.d('[directory] class suggestions unavailable', err);
    }
  }

  function paramsOf(f: DirectoryFilters) {
    return {
      q: f.query.trim() || undefined,
      promo: promoOf(f),
      formation: f.formation.trim() || undefined,
      campus: f.campus || undefined,
      post: f.post || undefined,
      associationId: f.associationId || undefined,
    };
  }

  /** Runs `next` as the current search, replacing the results. */
  async function runSearch(next: DirectoryFilters) {
    filters = next;
    const mine = ++seq;
    error = '';
    moreError = '';
    if (!hasCriteria(next)) {
      cleared = searched;
      searched = false;
      results = [];
      total = 0;
      loading = false;
      return;
    }
    loading = true;
    searched = true;
    cleared = false;
    try {
      const res = await searchDirectory({ ...paramsOf(next), limit: PAGE_SIZE });
      if (mine !== seq) return;
      results = res.users;
      total = res.total;
    } catch (err) {
      if (mine !== seq) return;
      Log.d('[directory] search failed', err);
      error = describeRefusalCode(refusalCode(err)) ?? m.directory_search_error_fallback();
      results = [];
      total = 0;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore || loading) return;
    const mine = seq;
    loadingMore = true;
    moreError = '';
    try {
      const res = await searchDirectory({
        ...paramsOf(filters),
        limit: PAGE_SIZE,
        offset: results.length,
      });
      if (mine !== seq) return;
      const known = new Set(results.map((u) => u.id));
      results = [...results, ...res.users.filter((u) => !known.has(u.id))];
      total = res.total;
    } catch (err) {
      Log.d('[directory] load more failed', err);
      moreError = describeRefusalCode(refusalCode(err)) ?? m.directory_more_error();
    } finally {
      loadingMore = false;
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    if (queryIssue) return;
    void runSearch({ ...filters, query: queryDraft });
  }

  function openSheet() {
    draft = { ...filters };
    sheetOpen = true;
  }

  function applySheet() {
    if (Object.keys(draftIssues).length > 0 || queryIssue) return;
    sheetOpen = false;
    void runSearch({ ...draft, query: queryDraft });
  }

  function removeChip(key: FilterKey) {
    void runSearch(withoutFilter(filters, key));
  }
</script>

<PageContainer>
  <PageHeader title={m.directory_heading()} subtitle={m.directory_subtitle()} />

  <div class="space-y-4">
    <form class="flex items-center gap-2" role="search" onsubmit={submit}>
      <div class="relative min-w-0 flex-1">
        <Search
          size={18}
          class="text-text-muted pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2"
        />
        <Input
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          aria-label={m.directory_search_aria()}
          placeholder={m.directory_name_placeholder()}
          invalid={queryIssue}
          bind:value={queryDraft}
          class="[&_input]:pl-10"
        />
      </div>
      <Button
        icon
        variant="secondary"
        aria-label={m.directory_filters_btn()}
        onclick={openSheet}
        data-directory-filters
      >
        <SlidersHorizontal size={18} />
      </Button>
    </form>

    {#if queryIssue}
      <p class="text-red-err text-xs" role="alert">{m.directory_issue_query()}</p>
    {/if}

    {#if chips.length > 0}
      <ul class="flex flex-wrap gap-2" aria-label={m.directory_filters_title()}>
        {#each chips as chip (chip.key)}
          <li>
            <button
              type="button"
              class="tap-target bg-cn-surface-alt text-text-main inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold"
              aria-label={m.directory_chip_remove({ label: chip.label })}
              data-directory-chip={chip.key}
              onclick={() => removeChip(chip.key)}
            >
              {chip.label}
              <X size={14} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if error}
      <p class="text-red-err text-sm" role="alert">{error}</p>
    {:else if loading}
      <ul class="space-y-1" aria-busy="true" aria-label={m.directory_loading_label()}>
        {#each [0, 1, 2, 3, 4] as i (i)}
          <li class="flex items-center gap-3 px-2 py-2.5" data-directory-skeleton>
            <div class="bg-cn-surface-alt h-12 w-12 shrink-0 animate-pulse rounded-full"></div>
            <div class="flex-1 space-y-2">
              <div class="bg-cn-surface-alt h-3.5 w-1/3 animate-pulse rounded-full"></div>
              <div class="bg-cn-surface-alt h-3 w-1/2 animate-pulse rounded-full"></div>
            </div>
          </li>
        {/each}
      </ul>
    {:else if searched}
      <p class="text-text-muted text-xs">
        {total !== 1
          ? m.directory_results_count_many({ count: total })
          : m.directory_results_count_one({ count: total })}
      </p>
      {#if results.length === 0}
        <div class="text-text-muted px-4 py-12 text-center text-sm">
          {m.directory_empty_result()}
        </div>
      {:else}
        <ul class="space-y-0.5">
          {#each results as user (user.id)}
            <DirectoryRow {user} />
          {/each}
        </ul>
        {#if total > results.length}
          <div class="flex justify-center pt-2">
            <Button variant="secondary" loading={loadingMore} onclick={() => void loadMore()}>
              {m.directory_load_more()}
            </Button>
          </div>
          {#if moreError}
            <p class="text-red-err pt-2 text-center text-xs" role="alert">{moreError}</p>
          {/if}
        {/if}
      {/if}
    {:else if suggestions.length > 0}
      {#if cleared}
        <p class="text-text-muted px-2 text-xs" data-directory-cleared>{m.directory_cleared()}</p>
      {/if}
      <section aria-labelledby="dir-suggest">
        <h2 id="dir-suggest" class="text-text-muted mb-1 px-2 text-xs font-semibold">
          {m.directory_suggest_heading()}
        </h2>
        <ul class="space-y-0.5">
          {#each suggestions as user (user.id)}
            <DirectoryRow {user} />
          {/each}
        </ul>
      </section>
    {:else}
      <p
        class="text-text-muted px-4 py-12 text-center text-sm"
        data-directory-cleared={cleared || undefined}
      >
        {cleared ? m.directory_cleared() : m.directory_hint()}
      </p>
    {/if}
  </div>
</PageContainer>

<Modal
  open={sheetOpen}
  title={m.directory_filters_title()}
  onClose={() => (sheetOpen = false)}
  footerEdge
>
  <div class="space-y-4" data-directory-sheet>
    <div class="grid grid-cols-2 gap-3">
      <Input
        type="number"
        min="1816"
        label={m.directory_label_promo()}
        placeholder={m.directory_promo_placeholder()}
        error={draftIssues.promo ? m.directory_issue_promo() : undefined}
        bind:value={draft.promo as string | number}
      />
      <Input
        type="text"
        label={m.directory_label_formation()}
        placeholder={m.directory_formation_placeholder()}
        error={draftIssues.formation ? m.directory_issue_formation() : undefined}
        bind:value={draft.formation}
      />
    </div>
    <div>
      <span class="text-text-muted mb-1 block text-xs font-semibold"
        >{m.directory_label_association()}</span
      >
      <Picker
        value={draft.associationId}
        options={associationOptions}
        label={m.directory_label_association()}
        triggerClass="border-cn-border text-text-main flex w-full items-center justify-between gap-2 rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-left text-sm"
        onValueChange={(v) => (draft.associationId = v)}
      />
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <span class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.directory_label_campus()}</span
        >
        <Picker
          value={draft.campus}
          options={campusOptions}
          label={m.directory_label_campus()}
          triggerClass="border-cn-border text-text-main flex w-full items-center justify-between gap-2 rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-left text-sm"
          onValueChange={(v) => (draft.campus = v as Campus | '')}
        />
      </div>
      <div>
        <span class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.directory_label_post()}</span
        >
        <Picker
          value={draft.post}
          options={postOptions}
          label={m.directory_label_post()}
          triggerClass="border-cn-border text-text-main flex w-full items-center justify-between gap-2 rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-left text-sm"
          onValueChange={(v) => (draft.post = v as Post | '')}
        />
      </div>
    </div>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (draft = { ...emptyFilters(), query: filters.query })}>
      {m.directory_filters_reset()}
    </Button>
    <Button
      variant="primary"
      disabled={Object.keys(draftIssues).length > 0 || queryIssue}
      onclick={applySheet}>{m.directory_filters_apply()}</Button
    >
  {/snippet}
</Modal>
