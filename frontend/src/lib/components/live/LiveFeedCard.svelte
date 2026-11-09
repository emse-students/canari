<script lang="ts">
  /**
   * THE LIVE CARD AT THE TOP OF THE FEED (decision L5, D4; reshaped by the owner on 2026-11-07):
   * ONE open live is a LARGE card - its preview still, the EN DIRECT badge, the viewer count, the
   * title and who broadcasts; SEVERAL are a horizontal carousel of the same cards. A live with no
   * title reads "X est en live". A tap opens the viewer.
   *
   * It asks `GET /api/lives` (no seat taken) whenever `refreshKey` changes - the feed bumps it when
   * it asks for its own first page - AND, while the card is on screen in a visible page, every
   * `previewPeriodMs` the server's limits name - the SAME period the broadcaster sends a preview on,
   * so each read can name a new still and none is read twice - so the preview and the count move.
   * Each answered list drops the kept stills of the lives it no longer names. That period is a
   * cost knob only: were it wrong, the picture would be staler or the list read more often; nothing
   * is decided from it, and no request is in flight twice (the next read is scheduled when the last
   * one answered). Off screen, in a hidden page, or with nothing on air, no timer runs.
   */
  import { onDestroy } from 'svelte';
  import { Radio } from '@lucide/svelte';
  import LiveIdentity from './LiveIdentity.svelte';
  import LivePosterImage from './LivePosterImage.svelte';
  import LiveViewerCount from './LiveViewerCount.svelte';
  import { fetchLiveLimits } from '$lib/live/api';
  import { loadOpenLivesForFeed } from '$lib/live/openLives';
  import { forgetLivePostersExcept, type loadLivePoster } from '$lib/live/livePosterView';
  import type { LiveListItem } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Bumped by the feed each time it asks for its first page. */
    refreshKey: number;
    /** The reader, whose own live is not listed. */
    viewerId: string | null;
    /** Opens the viewer on that live. */
    onOpen: (live: LiveListItem) => void;
    /** The list loader; the server's unless a test hands its own. */
    load?: typeof loadOpenLivesForFeed;
    /** The limits loader (read once, for `previewPeriodMs`); the server's unless a test hands its own. */
    fetchLimits?: typeof fetchLiveLimits;
    /** Reports whether the card intersects the viewport; an IntersectionObserver unless a test hands its own. */
    watchOnScreen?: (el: HTMLElement, report: (onScreen: boolean) => void) => () => void;
    /** The preview loader, handed to each image; the real one unless a test hands its own. */
    loadPoster?: typeof loadLivePoster;
  }

  let {
    refreshKey,
    viewerId,
    onOpen,
    load = loadOpenLivesForFeed,
    fetchLimits = fetchLiveLimits,
    watchOnScreen = observeOnScreen,
    loadPoster,
  }: Props = $props();

  let lives = $state<LiveListItem[]>([]);
  const names: Record<string, string> = $state({});
  let section = $state<HTMLElement | null>(null);
  let onScreen = $state(false);
  let pageVisible = $state(
    typeof document === 'undefined' || document.visibilityState === 'visible'
  );
  let refreshMs = $state<number | null>(null);
  let limitsAsked = false;
  let generation = 0;

  /** The default watcher: an IntersectionObserver on the card. None in this engine is a signal. */
  function observeOnScreen(el: HTMLElement, report: (onScreen: boolean) => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      console.warn(
        '[LIVE] feed card: no IntersectionObserver - the card refreshes with the feed only'
      );
      return () => {};
    }
    const io = new IntersectionObserver((entries) => report(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }

  /** One read of the list; an older read answering after a newer one is dropped. */
  async function refresh(why: string): Promise<void> {
    const mine = ++generation;
    console.debug(`[LIVE] feed card: reading the list (${why})`);
    const outcome = await load(viewerId);
    if (mine !== generation) return;
    if (outcome.kind === 'answered') {
      lives = outcome.lives;
      forgetLivePostersExcept(outcome.lives.map((l) => l.id));
    } else if (outcome.kind === 'hidden') lives = [];
  }

  $effect(() => {
    void refreshKey;
    void viewerId;
    void refresh('feed refresh');
    return () => {
      generation++;
    };
  });

  // The limits are read once, and only once a live is on air: a reader with none pays nothing.
  $effect(() => {
    if (lives.length === 0 || limitsAsked) return;
    limitsAsked = true;
    void fetchLimits().then(
      (limits) => {
        refreshMs = limits.previewPeriodMs ?? null;
        console.debug(`[LIVE] feed card: on-screen refresh every ${refreshMs ?? '-'} ms`);
      },
      (e) =>
        console.warn(`[LIVE] feed card: no limits (${String(e)}) - it refreshes with the feed only`)
    );
  });

  $effect(() => {
    if (!section) return;
    return watchOnScreen(section, (v) => (onScreen = v));
  });

  $effect(() => {
    const onVisibility = () => (pageVisible = document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // The on-screen refresh: one timer, armed only while all four hold, re-armed after each answer.
  $effect(() => {
    const period = refreshMs;
    if (!period || !onScreen || !pageVisible || lives.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => {
        void refresh('on screen').finally(() => {
          if (!stopped) arm();
        });
      }, period);
    };
    arm();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  onDestroy(() => {
    generation++;
  });

  function label(live: LiveListItem): string {
    const name = names[live.id] ?? '';
    return live.title
      ? m.live_card_is_live_titled({ name, title: live.title })
      : m.live_card_is_live({ name });
  }

  function ageText(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds < 60
      ? m.live_card_preview_age_seconds({ seconds })
      : m.live_card_preview_age_minutes({ minutes: Math.floor(seconds / 60) });
  }
</script>

{#snippet card(live: LiveListItem, large: boolean)}
  <button
    type="button"
    class="bg-cn-scrim relative block w-full touch-manipulation overflow-hidden rounded-2xl text-left text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {large
      ? 'aspect-[4/5]'
      : 'aspect-[3/4]'}"
    aria-label={label(live)}
    onclick={() => onOpen(live)}
    data-live-open={live.id}
    data-live-card-size={large ? 'large' : 'compact'}
  >
    <span class="absolute inset-0">
      <LivePosterImage
        {live}
        alt={m.live_card_preview_alt({ name: names[live.id] ?? '' })}
        load={loadPoster}
      />
    </span>
    <span class="absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
      <span
        class="bg-red-err text-2xs inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-bold"
        data-live-badge
      >
        <span class="size-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true"
        ></span>
        {m.live_card_badge()}
      </span>
      <LiveViewerCount count={live.viewers ?? null} />
    </span>
    <span
      class="from-cn-scrim/90 absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t to-transparent p-3 pt-8"
    >
      <span
        class={large ? 'text-base font-bold' : 'line-clamp-2 text-sm font-bold'}
        data-live-card-title
      >
        {live.title ?? m.live_card_is_live({ name: names[live.id] ?? '' })}
      </span>
      <span class="min-w-0">
        <LiveIdentity {live} size="sm" onName={(n) => (names[live.id] = n)} />
      </span>
      {#if large && live.poster}
        <span class="text-2xs text-white/70" data-live-poster-age>{ageText(live.poster.ageMs)}</span
        >
      {/if}
    </span>
  </button>
{/snippet}

{#if lives.length > 0}
  <section
    bind:this={section}
    class="mb-5"
    aria-labelledby="live-feed-card-title"
    data-live-feed-card
    data-live-feed-layout={lives.length === 1 ? 'large' : 'carousel'}
  >
    <h2
      id="live-feed-card-title"
      class="text-text-main mb-2 flex items-center gap-2 text-sm font-bold"
    >
      <Radio size={16} class="text-red-err" aria-hidden="true" />
      {m.live_card_title()}
    </h2>
    {#if lives.length === 1}
      {@render card(lives[0], true)}
    {:else}
      <ul
        class="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1"
        aria-label={m.live_card_carousel_label()}
        data-live-carousel
      >
        {#each lives as live (live.id)}
          <li class="w-40 shrink-0 snap-start">
            {@render card(live, false)}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
