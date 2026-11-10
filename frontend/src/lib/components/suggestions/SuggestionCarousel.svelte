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
  const open = $derived(drawn.some(cardOpen));
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
    <ul class="mt-2 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1">
      {#each drawn as card (`${card.kind}:${card.id}`)}
        <!-- THE LEAVING CARD SHRINKS AWAY AND THE NEXT ONES SLIDE INTO ITS PLACE (owner, 2026-11-10); no motion for a reader who asked for none. -->
        <li
          class="shrink-0 snap-start"
          animate:flip={{ duration: motionMs(250) }}
          out:scale={{ duration: motionMs(200), start: 0.85 }}
        >
          <SuggestionCard {card} onDismiss={(c) => void dismissSuggestion(c.kind, c.id)} />
        </li>
      {/each}
    </ul>
  </section>
{/if}
