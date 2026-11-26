<script lang="ts">
  /**
   * THE ONE SEARCH OF THE APP (owner, 2026-11-26): a single bar on the home page, results grouped by
   * section like LinkedIn's - the top 3 of each with "Tout afficher", a chip per section, and inside
   * Posts the person and association filters of 1.8.2. Where each section answers from, and why a
   * message never leaves the device, is on `docs/wiki/frontend/universal-search.md`.
   *
   * The search's state lives while the bar is in use: it is built on the first focus, and dropped -
   * the decrypted message index with it - when the reader closes the search.
   *
   * KEYBOARD. Enter asks every section at once; Escape clears the words, then closes; the down arrow
   * leaves the field for the first result and the arrows walk the results (`rovingTarget`); "/" or
   * Ctrl/Cmd+K reaches the field from anywhere on the page (desktop).
   */
  import { onDestroy, type Snippet, type Component } from 'svelte';
  import {
    Building2,
    CalendarDays,
    ClipboardList,
    MessageCircle,
    Newspaper,
    Search,
    Settings,
    Users,
    UsersRound,
    X,
  } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import PostSearchFilters from '$lib/components/posts/PostSearchFilters.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import SearchHitRow from './SearchHitRow.svelte';
  import { rovingTarget } from '$lib/components/ui/rovingFocus';
  import { createUniversalSearch, type UniversalSearch } from '$lib/search/universalSearch.svelte';
  import { wireUniversalSearch, type UniversalSearchWiring } from '$lib/search/wiring';
  import { SEARCH_SECTIONS, type SearchSectionId, type SearchSource } from '$lib/search/types';
  import type { PostEntity } from '$lib/posts/api';
  import type { AssociationCalendarFeedEvent } from '$lib/associations/api';

  interface Props {
    /** Whether the bar is shown on a phone (always from `md` up); the magnifier opens it. */
    open: boolean;
    /** The bar's words, given by the page when it arrives with `?q=`. */
    initialQuery?: string;
    /** Whether a search replaces the feed now. */
    active?: boolean;
    /** The phone's close, and Escape on an empty field. */
    onClose: () => void;
    /** Draws one post exactly as the feed does; `onRemoved` drops it from the answer. */
    post: Snippet<[PostEntity, () => void]>;
    /** Builds the sections' sources; the real ones unless a test hands its own. */
    wire?: typeof wireUniversalSearch;
  }

  let {
    open,
    initialQuery = '',
    active = $bindable(false),
    onClose,
    post,
    wire = wireUniversalSearch,
  }: Props = $props();

  const INPUT_ID = 'universal-search-input';

  const ICONS: Record<SearchSectionId, Component<{ size?: number }>> = {
    people: Users,
    discussions: MessageCircle,
    communities: UsersRound,
    associations: Building2,
    posts: Newspaper,
    events: CalendarDays,
    forms: ClipboardList,
    settings: Settings,
  };

  const TITLES: Record<SearchSectionId, () => string> = {
    people: m.search_section_people,
    discussions: m.search_section_discussions,
    communities: m.search_section_communities,
    associations: m.search_section_associations,
    posts: m.search_section_posts,
    events: m.search_section_events,
    forms: m.search_section_forms,
    settings: m.search_section_settings,
  };

  const SOURCE_LINES: Record<SearchSource, () => string> = {
    device: m.search_source_device,
    list: m.search_source_list,
    server: m.search_source_server,
  };

  let search = $state<UniversalSearch | null>(null);
  let wiring: UniversalSearchWiring | null = null;
  let words = $state('');
  let openEvent = $state<AssociationCalendarFeedEvent | null>(null);
  let resultsEl = $state<HTMLElement | null>(null);

  /** Builds the search on first use: nothing is read before the reader reaches the bar. */
  function ensureSearch(): UniversalSearch {
    if (search) return search;
    Log.d('SEARCH', 'the search opens: its sections are wired');
    wiring = wire({
      onStoreChanged: () => search?.rerunDiscussions(),
      onOpenEvent: (event) => (openEvent = event),
    });
    search = createUniversalSearch({ providers: wiring.providers, posts: wiring.posts });
    return search;
  }

  /** Drops the search and everything it read - the message index first. */
  function closeSearch() {
    Log.d('SEARCH', 'the search closes: what it read is dropped');
    search?.dispose();
    wiring?.close();
    search = null;
    wiring = null;
    words = '';
    onClose();
  }

  onDestroy(() => {
    search?.dispose();
    wiring?.close();
  });

  $effect(() => {
    active = search?.active ?? false;
  });

  // `?q=` (the site's declared search URL) arrives once, as a command the page already stripped.
  $effect(() => {
    if (!initialQuery) return;
    words = initialQuery;
    const s = ensureSearch();
    s.setQuery(initialQuery);
    s.submit();
  });

  // The phone's magnifier opens the bar: the field takes the focus, which is the gesture's purpose.
  $effect(() => {
    if (open) queueMicrotask(() => document.getElementById(INPUT_ID)?.focus());
  });

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    words = e.currentTarget.value;
    ensureSearch().setQuery(words);
  }

  function hitElements(): HTMLElement[] {
    return resultsEl ? [...resultsEl.querySelectorAll<HTMLElement>('[data-search-hit]')] : [];
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      ensureSearch().submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (words) {
        words = '';
        search?.setQuery('');
      } else closeSearch();
    } else if (e.key === 'ArrowDown') {
      const first = hitElements()[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onResultsKeydown(e: KeyboardEvent) {
    const hits = hitElements();
    const index = hits.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      document.getElementById(INPUT_ID)?.focus();
      return;
    }
    if (e.key === 'ArrowUp' && index === 0) {
      e.preventDefault();
      document.getElementById(INPUT_ID)?.focus();
      return;
    }
    const next = rovingTarget(e.key, index, hits.length);
    if (next < 0 || e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    e.preventDefault();
    hits[next].focus();
  }

  /** "/" or Ctrl/Cmd+K reaches the bar, unless the reader is typing somewhere else. */
  function onWindowKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const shortcut = (e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing);
    if (!shortcut) return;
    const field = document.getElementById(INPUT_ID);
    if (!field || field.offsetParent === null) return;
    e.preventDefault();
    field.focus();
  }

  /** The sections drawn now: the chip's alone, else each one that has or may have something. */
  const shownSections = $derived.by(() => {
    const s = search;
    if (!s) return [];
    if (s.focus) return [s.focus];
    return SEARCH_SECTIONS.filter((id) => {
      const state = id === 'posts' ? s.posts : s.sections[id];
      return state.status === 'loading' || state.status === 'failed' || state.hits.length > 0;
    });
  });

  /** Every section asked has answered, and none found anything. */
  const nothingFound = $derived.by(() => {
    const s = search;
    if (!s || !s.active || s.focus) return false;
    const asked = SEARCH_SECTIONS.map((id) => (id === 'posts' ? s.posts : s.sections[id])).filter(
      (state) => state.status !== 'idle'
    );
    return asked.length > 0 && asked.every((st) => st.status === 'done' && st.hits.length === 0);
  });

  function stateOf(id: SearchSectionId) {
    const s = search!;
    return id === 'posts' ? s.posts : s.sections[id];
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div id="posts-search" class="mb-5 {open || active ? '' : 'hidden md:block'}" role="search">
  <div class="relative">
    <Search
      size={16}
      class="text-text-muted pointer-events-none absolute top-1/2 left-3.5 z-10 -translate-y-1/2"
    />
    <Input
      id={INPUT_ID}
      type="search"
      enterkeyhint="search"
      autocomplete="off"
      aria-label={m.search_label()}
      aria-controls="universal-search-results"
      placeholder={m.search_placeholder()}
      value={words}
      oninput={onInput}
      onkeydown={onFieldKeydown}
      onfocus={() => ensureSearch()}
      class="ui-search-own-clear [&_input]:pr-10 [&_input]:pl-10"
    />
    {#if words || open || active}
      <Button
        variant="bare"
        class="tap-target text-text-muted hover:text-text-main absolute top-1/2 right-3 -translate-y-1/2"
        aria-label={m.search_close_aria()}
        onclick={closeSearch}
      >
        <X size={16} />
      </Button>
    {/if}
  </div>

  {#if search && search.active}
    <div
      class="mt-3 flex gap-2 overflow-x-auto pb-1"
      role="group"
      aria-label={m.search_chips_label()}
      data-search-chips
    >
      <Button
        size="compact"
        variant={search.focus === null ? 'primary' : 'secondary'}
        class="shrink-0 rounded-full"
        aria-pressed={search.focus === null}
        onclick={() => search?.setFocus(null)}>{m.search_chip_all()}</Button
      >
      {#each SEARCH_SECTIONS as id (id)}
        <Button
          size="compact"
          variant={search.focus === id ? 'primary' : 'secondary'}
          class="shrink-0 rounded-full"
          aria-pressed={search.focus === id}
          data-search-chip={id}
          onclick={() => search?.setFocus(id)}>{TITLES[id]()}</Button
        >
      {/each}
    </div>
  {:else if search && words.trim().length > 0}
    <p class="text-text-muted mt-2 px-1 text-xs">{m.search_type_more()}</p>
  {/if}
</div>

{#if search && search.active}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    id="universal-search-results"
    bind:this={resultsEl}
    aria-label={m.search_results_label()}
    aria-live="polite"
    aria-busy={shownSections.some((id) => stateOf(id).status === 'loading')}
    class="space-y-4"
    onkeydown={onResultsKeydown}
  >
    {#if nothingFound}
      <p class="text-text-muted py-12 text-center text-sm">
        {m.search_no_results({ query: search.query.trim() })}
      </p>
    {/if}
    {#each shownSections as id (id)}
      {@const state = stateOf(id)}
      {@const Icon = ICONS[id]}
      <section
        aria-labelledby="search-section-{id}"
        class="bg-cn-surface rounded-2xl p-3"
        data-search-section={id}
      >
        <header class="mb-1 flex items-baseline justify-between gap-2 px-2">
          <h2 id="search-section-{id}" class="text-text-main shrink-0 text-base font-bold">
            {TITLES[id]()}
          </h2>
          <p
            class="text-text-muted min-w-0 text-right text-xs"
            data-search-source={search.sourceOf(id)}
          >
            {SOURCE_LINES[search.sourceOf(id)]()}
          </p>
        </header>

        {#if id === 'posts' && search.focus === 'posts'}
          <div class="px-2 pb-2">
            <PostSearchFilters
              author={search.author}
              association={search.association}
              onAuthor={(pick) => search?.setAuthor(pick)}
              onAssociation={(pick) => search?.setAssociation(pick)}
            />
          </div>
        {/if}

        {#if state.status === 'loading' && state.hits.length === 0}
          <ul class="space-y-1" aria-hidden="true" data-search-skeleton>
            {#each [0, 1] as i (i)}
              <li class="flex items-center gap-3 px-2 py-2">
                <div class="bg-cn-surface-alt h-10 w-10 shrink-0 animate-pulse rounded-full"></div>
                <div class="bg-cn-surface-alt h-3.5 w-1/2 animate-pulse rounded-full"></div>
              </li>
            {/each}
          </ul>
        {:else if state.status === 'failed'}
          <p class="text-red-err px-2 py-2 text-sm" role="alert">{m.search_section_failed()}</p>
        {:else if state.hits.length === 0}
          <p class="text-text-muted px-2 py-2 text-sm">{m.search_section_empty()}</p>
        {:else if id === 'posts'}
          <div class="space-y-5">
            {#each search.posts.hits as p (p.id)}
              {@render post(p, () => search?.removePost(p.id))}
            {/each}
          </div>
        {:else}
          <ul class="space-y-0.5">
            {#each search.sections[id].hits as hit (hit.key)}
              <SearchHitRow {hit} icon={Icon} />
            {/each}
          </ul>
        {/if}

        {#if search.focus === null && (state.total > state.hits.length || (id === 'posts' && state.hits.length >= state.limit))}
          <div class="mt-1 px-2">
            <Button
              variant="link"
              size="compact"
              data-search-show-all={id}
              onclick={() => search?.setFocus(id)}
            >
              {id === 'posts'
                ? m.search_show_all()
                : m.search_show_all_count({ count: state.total })}
            </Button>
          </div>
        {:else if search.focus === id && (state.total > state.hits.length || (id === 'posts' && state.hits.length >= state.limit))}
          <div class="mt-1 px-2">
            <Button variant="secondary" size="compact" onclick={() => search?.showMore(id)}>
              {m.search_show_more()}
            </Button>
          </div>
        {/if}
        {#if id === 'people' && search.focus === 'people'}
          <div class="mt-1 px-2">
            <Button
              variant="link"
              size="compact"
              href={resolve(`/directory?q=${encodeURIComponent(search.query.trim())}`)}
            >
              {m.search_directory_refine()}
            </Button>
          </div>
        {/if}
      </section>
    {/each}
  </section>
{/if}

<CalendarEventDetailModal
  open={openEvent !== null}
  event={openEvent}
  onClose={() => (openEvent = null)}
/>
