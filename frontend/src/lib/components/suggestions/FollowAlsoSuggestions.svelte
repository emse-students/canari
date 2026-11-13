<script lang="ts">
  /**
   * "SUIVEZ AUSSI..." (engagement WP-6, decision 3, L15): right after the reader follows or asks to
   * follow someone, the READER's own suggestions minus that account - never the followed account's
   * follows, which a request to a private account must not reveal. People only, at most
   * {@link FOLLOW_ALSO_MAX}; nothing at all when the read fails or comes back empty.
   */
  import SuggestionCarousel from './SuggestionCarousel.svelte';
  import { getFollowSuggestions } from '$lib/follows/api';
  import {
    FOLLOW_ALSO_MAX,
    interleaveCards,
    type SuggestionCard,
  } from '$lib/follows/suggestions.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The account just followed. */
    exclude: string;
  }

  let { exclude }: Props = $props();

  let cards = $state<SuggestionCard[]>([]);

  $effect(() => {
    const target = exclude;
    let cancelled = false;
    cards = [];
    getFollowSuggestions({ limit: FOLLOW_ALSO_MAX, exclude: target })
      .then((data) => {
        if (!cancelled) cards = interleaveCards({ people: data.people, entities: [] });
      })
      .catch((e: unknown) => console.warn('[suggestions] follow-also read failed', e));
    return () => {
      cancelled = true;
    };
  });
</script>

<SuggestionCarousel {cards} title={m.suggestions_also_title()} surface="also" />
