<script lang="ts">
  import { CalendarClock, ChevronRight } from '@lucide/svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import type { ListedSpace } from '$lib/bookings/api';
  import { spaceHref } from '$lib/bookings/routes';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE LIST OF SPACES ONE MAY BOOK (D16, D45): a row is a real link, led by the space's poster as a
   * thumbnail - or by the calendar glyph in the same box when it has none, so the names line up. The
   * thumbnails decrypt only when near the viewport (`SpacePoster thumb`).
   */
  interface Props {
    spaces: ListedSpace[];
    /** Names the list for assistive technology. */
    label: string;
  }

  let { spaces, label }: Props = $props();

  /** The line under a name: who runs it, and how many columns it has. */
  const summary = (s: ListedSpace) =>
    [s.associationName, m.bookings_tab_resources_count({ count: s.resourceCount })]
      .filter(Boolean)
      .join(' \u00b7 ');
</script>

<ul
  aria-label={label}
  class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border shadow-sm"
>
  {#each spaces as space (space.id)}
    <li>
      <a
        href={spaceHref(space.id)}
        data-hub-row={space.id}
        class="text-text-main hover:bg-cn-bg flex items-center gap-3 px-4 py-3 transition-colors"
      >
        {#if space.poster}
          <SpacePoster poster={space.poster} alt="" thumb />
        {:else}
          <span
            class="border-cn-border/60 bg-cn-bg text-text-muted flex size-12 shrink-0 items-center justify-center rounded-xl border"
            aria-hidden="true"
          >
            <CalendarClock size={20} />
          </span>
        {/if}
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-bold hyphens-auto">{space.name}</span>
          {#if summary(space)}
            <span class="text-text-muted line-clamp-2 text-xs">{summary(space)}</span>
          {/if}
        </span>
        <ChevronRight size={18} class="text-text-muted shrink-0" />
      </a>
    </li>
  {/each}
</ul>
