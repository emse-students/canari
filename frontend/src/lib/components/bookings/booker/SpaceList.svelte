<script lang="ts">
  import { CalendarClock, ChevronRight, Search } from '@lucide/svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import { controlClass } from '$lib/components/ui/controlClasses';
  import type { ListedSpace } from '$lib/bookings/api';
  import { resourcesLabel } from '$lib/bookings/bookingRow';
  import { spaceHref } from '$lib/bookings/routes';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE SPACES ONE MAY BOOK (D16, D45): ONE card of divider-separated rows, as the mockup draws it.
   * Each row is a 48px tile - the poster when the space has one (decrypted only when near the
   * viewport, `SpacePoster cover`), the calendar glyph in the same box otherwise - then the name and
   * a muted "association - N resources" line (one column says nothing, D44), then a chevron. The
   * whole row is one real link. A search narrows the list once it is long enough to need one.
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

  /** The muted line under the name: who runs it, and how many columns from two. */
  const subline = (s: ListedSpace) =>
    [s.associationName, resourcesLabel(s.resourceCount)].filter(Boolean).join(' · ');
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
  {#if shown.length === 0}
    <p class="text-text-muted py-4 text-center text-sm">{m.bookings_spaces_no_match()}</p>
  {:else}
    <ul
      aria-label={label}
      class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border shadow-sm"
    >
      {#each shown as space (space.id)}
        <li>
          <a
            href={spaceHref(space.id)}
            data-hub-row={space.id}
            class="text-text-main hover:bg-cn-border/20 flex items-center gap-3 p-4 transition-colors"
          >
            <div
              class="bg-cn-yellow/15 text-text-muted relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl"
            >
              {#if space.poster}
                <SpacePoster poster={space.poster} alt="" cover />
              {:else}
                <CalendarClock size={22} aria-hidden="true" />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-base font-semibold">{space.name}</p>
              {#if subline(space)}
                <p class="text-text-muted truncate text-sm">{subline(space)}</p>
              {/if}
            </div>
            <ChevronRight size={18} class="text-text-muted shrink-0" aria-hidden="true" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
