<script lang="ts">
  import { Search, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { fetchGifPage, KLIPY_KEY, type GifResult } from '$lib/utils/chat/gifSearch';
  import { columnsFor, layoutMasonry, nearEnd, visibleTiles } from '$lib/utils/chat/gifMasonry';

  /**
   * THE GIF SEARCH AND ITS GRID - one component for the phone's keyboard-sized panel
   * (`ComposerGifPanel`) and the desktop dialog (`GifPickerModal`), so the two cannot drift.
   *
   * Every tile is laid out from the size the provider DECLARED, before its picture loads
   * (`gifMasonry.ts`): the grid never reflows as GIFs arrive, and each tile shows a flat surface tone
   * until its own GIF covers it. Only the tiles near the scrolled window are mounted; the next page is
   * asked for when the reader nears the end.
   *
   * The placeholder is the surface tone, deliberately: the shared MediaFrame primitive
   * (`docs/wiki/frontend/media-frame.md`) is not merged yet, and a tile's box is ALREADY final here -
   * what MediaFrame would add is its placeholder painting, a swap this component is shaped for.
   */
  interface Props {
    /** Whether the grid is on screen: it loads only then, and starts again from trending each time. */
    active: boolean;
    /** A GIF was tapped. */
    onPick: (gif: GifResult) => void;
    /** The search field gained or lost focus (the phone panel lifts itself above the keyboard). */
    onSearchFocusChange?: (focused: boolean) => void;
    /** Extra trailing control in the search row (the phone panel's "back to the keyboard"). */
    trailing?: import('svelte').Snippet;
  }

  let { active, onPick, onSearchFocusChange, trailing }: Props = $props();

  const GAP = 6;
  const OVERSCAN = 400;
  const LOAD_AHEAD = 600;
  /** Debounce of a typed search - a request per word, not per key. A UX pacing, not a correctness rule. */
  const SEARCH_DEBOUNCE_MS = 350;

  let query = $state('');
  let results = $state<GifResult[]>([]);
  let page = $state(0);
  let hasNext = $state(false);
  let loading = $state(false);
  let failed = $state(false);
  let scroller = $state<HTMLElement | null>(null);
  let width = $state(0);
  let viewport = $state(0);
  let scrollTop = $state(0);
  let generation = 0;
  let inFlight: AbortController | null = null;

  const columns = $derived(columnsFor(width));
  const layout = $derived(
    layoutMasonry(
      results.map((g) => g.preview),
      width,
      columns,
      GAP
    )
  );
  const shown = $derived(visibleTiles(layout.tiles, scrollTop, viewport, OVERSCAN));

  async function load(q: string, nextPage: number) {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const mine = nextPage === 1 ? ++generation : generation;
    loading = true;
    failed = false;
    try {
      const result = await fetchGifPage(q, nextPage, controller.signal);
      if (mine !== generation) return;
      results = nextPage === 1 ? result.gifs : [...results, ...result.gifs];
      page = nextPage;
      hasNext = result.hasNext;
    } catch (error) {
      if (controller.signal.aborted || mine !== generation) return;
      console.warn(`[GifGrid] page ${nextPage} failed: ${String(error)}`);
      failed = true;
      if (nextPage === 1) results = [];
    } finally {
      if (inFlight === controller) {
        inFlight = null;
        loading = false;
      }
    }
  }

  // A new search (or the grid opening) starts again at page 1 of that search.
  $effect(() => {
    if (!active || !KLIPY_KEY) return;
    const q = query;
    const timer = setTimeout(
      () => {
        scroller?.scrollTo({ top: 0 });
        scrollTop = 0;
        void load(q, 1);
      },
      q.trim() ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => clearTimeout(timer);
  });

  // The next page, when the reader nears the end - or when the first page does not fill the view.
  $effect(() => {
    if (!active || loading || failed || !hasNext) return;
    if (nearEnd(scrollTop, viewport, layout.height, LOAD_AHEAD)) {
      Log.d('GifGrid', `near the end, page ${page + 1}`);
      void load(query, page + 1);
    }
  });

  // Closing the grid drops what it held: the next opening starts from trending, at the top.
  $effect(() => {
    if (active) return;
    inFlight?.abort();
    query = '';
    results = [];
    page = 0;
    hasNext = false;
  });

  $effect(() => {
    const el = scroller;
    if (!el) return;
    const measure = () => {
      width = el.clientWidth;
      viewport = el.clientHeight;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex items-center gap-2 px-3 pt-2 pb-2">
    <div class="relative flex-1">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        bind:value={query}
        type="search"
        enterkeyhint="search"
        placeholder={m.chat_gif_search_placeholder()}
        aria-label={m.chat_gif_search_label()}
        onfocus={() => onSearchFocusChange?.(true)}
        onblur={() => onSearchFocusChange?.(false)}
        onkeydown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent py-2 pr-9 pl-9 text-sm focus:ring-2 focus:outline-none"
      />
      {#if query}
        <button
          type="button"
          onclick={() => (query = '')}
          aria-label={m.chat_gif_clear_search_label()}
          class="ui-icon-button ui-icon-button--sm text-text-muted absolute top-1/2 right-1 -translate-y-1/2 rounded-full"
        >
          <X size={16} />
        </button>
      {/if}
    </div>
    {@render trailing?.()}
  </div>

  <div
    bind:this={scroller}
    onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop)}
    class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2"
    data-testid="gif-grid-scroller"
  >
    {#if !KLIPY_KEY}
      <p class="text-text-muted py-10 text-center text-sm">{m.chat_gif_not_configured()}</p>
    {:else if failed && results.length === 0}
      <p class="py-10 text-center text-sm text-red-500">{m.chat_gif_load_error()}</p>
    {:else if !loading && results.length === 0 && page > 0}
      <p class="text-text-muted py-10 text-center text-sm">{m.chat_no_gif_found()}</p>
    {:else}
      <div class="relative" style="height: {layout.height}px">
        {#each shown as tile (results[tile.index].id)}
          {@const gif = results[tile.index]}
          <button
            type="button"
            onclick={() => onPick(gif)}
            class="focus-visible:ring-cn-yellow absolute overflow-hidden rounded-lg bg-black/5 outline-none focus-visible:ring-2 active:opacity-80 dark:bg-white/10"
            style="left: {tile.x}px; top: {tile.y}px; width: {tile.width}px; height: {tile.height}px"
            aria-label={m.chat_send_gif_action_label()}
          >
            <img
              src={gif.preview.url}
              alt=""
              width={gif.preview.width}
              height={gif.preview.height}
              decoding="async"
              class="h-full w-full object-cover"
            />
          </button>
        {/each}
      </div>
      {#if loading && results.length === 0}
        <div class="flex justify-center py-10">
          <div
            class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
          ></div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Attribution "Powered by KLIPY" required by the KLIPY API terms. -->
  <div class="text-text-muted text-2xs px-3 py-1 text-center">Powered by KLIPY</div>
</div>
