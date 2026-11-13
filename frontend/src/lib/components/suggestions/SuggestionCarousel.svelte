<script lang="ts">
  /**
   * A ROW OF FOLLOW SUGGESTIONS (engagement WP-6): the one component behind the feed carousel, the
   * empty Pour toi, the onboarding banner and "Suivez aussi...". It draws the cards still drawn
   * (`cardDrawn`: not dismissed, not followed) and nothing at all once no card is left OPEN - every
   * one followed, requested or dismissed (the design's "hidden once every card is followed or
   * dismissed").
   */
  import { flip } from 'svelte/animate';
  import { scale } from 'svelte/transition';
  import SuggestionCard from './SuggestionCard.svelte';
  import {
    cardDrawn,
    cardOpen,
    dismissSuggestion,
    type SuggestionCard as Card,
  } from '$lib/follows/suggestions.svelte';

  interface Props {
    cards: Card[];
    title: string;
    /** One line under the title (the onboarding banner's invitation). */
    hint?: string;
    /** Which surface draws it, for tests and readings. */
    surface: 'banner' | 'page' | 'inline' | 'also';
  }

  let { cards, title, hint, surface }: Props = $props();

  /** A duration, or none for a reader who asked for reduced motion. */
  function motionMs(ms: number): number {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
  }

  const drawn = $derived(cards.filter(cardDrawn));

  /**
   * THE ROW DOES NOT CHANGE UNDER A FINGER (owner, iPhone, 2026-11-11: "very weird and not smooth",
   * and the suggestion that it should slide first and add after). While a touch is down or a scroll
   * is still running, the list is FROZEN at what it showed when the gesture began; a card that
   * leaves (a follow the server answered) or one that slides in (the next suggestion) lands the
   * moment the row is idle, with its usual animation. The proof of idle is an event, never a clock:
   * `touchend`/`touchcancel` (a pointer event is cancelled when a scroll takes the touch, so it
   * cannot say it) and, where the engine has it, `scrollend` for the momentum after the release.
   * A tap on the X or on Suivre is a touch that has ended by the time its click lands, so those
   * still act at once.
   */
  let touching = false;
  let scrolling = false;
  let frozen = $state<Card[] | null>(null);
  const shown = $derived(frozen ?? drawn);
  const open = $derived(frozen ? frozen.length > 0 : drawn.some(cardOpen));

  function holdRow(): void {
    if (!frozen) {
      frozen = drawn;
      console.debug(`[suggestions] ${surface}: row held while a gesture runs (${drawn.length})`);
    }
  }

  function releaseRow(): void {
    if (touching || scrolling || !frozen) return;
    const held = frozen;
    frozen = null;
    console.debug(
      `[suggestions] ${surface}: row idle, list lands (${held.length} -> ${drawn.length})`
    );
  }

  /** Listeners are passive and bound once: nothing here may cost the scroller a main-thread wait. */
  function trackGesture(row: HTMLElement) {
    const hasScrollEnd = 'onscrollend' in window;
    const down = () => {
      touching = true;
      holdRow();
    };
    const up = () => {
      touching = false;
      // Without `scrollend` the touch is the only proof there is; with it, a scroll still running
      // after the release keeps the hold until it ends.
      releaseRow();
    };
    const scroll = () => {
      if (scrolling) return;
      scrolling = true;
      holdRow();
    };
    const scrollEnd = () => {
      scrolling = false;
      releaseRow();
    };
    row.addEventListener('touchstart', down, { passive: true });
    row.addEventListener('touchend', up, { passive: true });
    row.addEventListener('touchcancel', up, { passive: true });
    if (hasScrollEnd) {
      row.addEventListener('scroll', scroll, { passive: true });
      row.addEventListener('scrollend', scrollEnd, { passive: true });
    }
    return {
      destroy() {
        row.removeEventListener('touchstart', down);
        row.removeEventListener('touchend', up);
        row.removeEventListener('touchcancel', up);
        row.removeEventListener('scroll', scroll);
        row.removeEventListener('scrollend', scrollEnd);
      },
    };
  }
</script>

{#if open}
  <section
    class="border-cn-border bg-cn-surface/60 rounded-2xl border py-3"
    data-suggestions={surface}
    aria-label={title}
  >
    <div class="px-4">
      <h2 class="text-text-main text-sm font-bold">{title}</h2>
      {#if hint}
        <p class="text-text-muted text-xs">{hint}</p>
      {/if}
    </div>
    <!-- FREE SCROLL, ONE AXIS: no snap (a proximity snap re-settles a 160px card grid after every
         momentum and WebKit re-snaps when a card leaves - the jump the owner felt), and
         `overflow-y-hidden` so the row is not a two-axis scroller that wobbles on a diagonal drag.
         `overscroll-x-contain` keeps the end of the row from chaining to the page. -->
    <ul
      class="mt-2 flex gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 pb-1"
      use:trackGesture
    >
      {#each shown as card (`${card.kind}:${card.id}`)}
        <!-- THE LEAVING CARD SHRINKS AWAY AND THE NEXT ONES SLIDE INTO ITS PLACE (owner, 2026-11-10); no motion for a reader who asked for none. -->
        <li
          class="shrink-0"
          animate:flip={{ duration: motionMs(250) }}
          out:scale={{ duration: motionMs(200), start: 0.85 }}
        >
          <SuggestionCard {card} onDismiss={(c) => void dismissSuggestion(c.kind, c.id)} />
        </li>
      {/each}
    </ul>
  </section>
{/if}
