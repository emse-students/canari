<script lang="ts">
  import { ArrowRight, CalendarClock, Search } from '@lucide/svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { controlClass } from '$lib/components/ui/controlClasses';
  import type { ListedSpace } from '$lib/bookings/api';
  import { spaceHref } from '$lib/bookings/routes';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE SPACES ONE MAY BOOK (D16, D45): a card per space, led by its poster as a banner - or by a
   * tinted box with the calendar glyph when it has none, so the cards line up - then its name, who
   * runs it, how many columns from two (D44: one says nothing), and the way in. The whole card is
   * one real link. A search narrows the list once it is long enough to need one. Banners decrypt
   * only when near the viewport (`SpacePoster cover`).
   */
  interface Props {
    spaces: ListedSpace[];
    /** Names the list for assistive technology. */
    label: string;
  }

  let { spaces, label }: Props = $props();

  /** Under this many spaces a search is more furniture than help. */
  const SEARCH_FROM = 4;

  let query = $state('');

  const shown = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return spaces;
    return spaces.filter((s) =>
      `${s.name} ${s.associationName ?? ''}`.toLocaleLowerCase().includes(q)
    );
  });

  /** The columns line: nothing for one column (D44), a count from two. */
  const columns = (s: ListedSpace) =>
    s.resourceCount > 1 ? m.bookings_tab_resources_count({ count: s.resourceCount }) : null;
</script>

<div class="space-y-3">
  {#if spaces.length >= SEARCH_FROM}
    <div class="relative">
      <Search
        size={16}
        class="text-text-muted pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="search"
        bind:value={query}
        placeholder={m.bookings_spaces_search_placeholder()}
        aria-label={m.bookings_spaces_search_placeholder()}
        class="{controlClass(false, 'compact')} pl-10"
      />
    </div>
  {/if}
  <p class="text-text-muted text-xs">{m.bookings_spaces_count({ count: shown.length })}</p>
  {#if shown.length === 0}
    <p class="text-text-muted py-4 text-center text-sm">{m.bookings_spaces_no_match()}</p>
  {:else}
    <ul aria-label={label} class="grid gap-4 sm:grid-cols-2">
      {#each shown as space (space.id)}
        <li>
          <a
            href={spaceHref(space.id)}
            data-hub-row={space.id}
            class="border-cn-border bg-cn-surface text-text-main hover:border-cn-yellow/50 block overflow-hidden rounded-2xl border shadow-sm transition-colors"
          >
            <div class="bg-cn-yellow/15 relative aspect-video w-full">
              {#if space.poster}
                <SpacePoster poster={space.poster} alt="" cover />
              {:else}
                <span
                  class="text-text-muted flex h-full w-full items-center justify-center"
                  aria-hidden="true"
                >
                  <CalendarClock size={36} />
                </span>
              {/if}
            </div>
            <div class="space-y-2 p-4">
              <p class="text-base font-bold hyphens-auto">{space.name}</p>
              <div class="flex items-center gap-2">
                {#if space.associationName}
                  <AssociationAvatar name={space.associationName} size="sm" />
                  <span class="text-text-muted min-w-0 flex-1 truncate text-sm">
                    {space.associationName}
                  </span>
                {/if}
                {#if columns(space)}
                  <span
                    class="border-cn-border text-text-muted shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                  >
                    {columns(space)}
                  </span>
                {/if}
              </div>
              <span
                class="bg-cn-yellow text-cn-ink flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold"
              >
                {m.bookings_space_open_planning()}
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
