<script lang="ts">
  /**
   * THE FEED'S SUGGESTIONS (engagement WP-6, decisions 3 and 7) at the place the feed hands it:
   * `banner` (the reader follows almost nobody, L12), `page` (an empty Pour toi) or `inline`
   * (once, after the third post). The place is decided by `feedSuggestionPlacement`; this component
   * only draws the shared cards with that place's words.
   */
  import SuggestionCarousel from './SuggestionCarousel.svelte';
  import { feedSuggestionCards, type SuggestionPlacement } from '$lib/follows/suggestions.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    placement: SuggestionPlacement;
  }

  let { placement }: Props = $props();

  const cards = $derived(feedSuggestionCards());
  const title = $derived(
    placement === 'banner' ? m.suggestions_onboarding_title() : m.suggestions_title()
  );
  const hint = $derived(
    placement === 'banner'
      ? m.suggestions_onboarding_hint()
      : placement === 'page'
        ? m.suggestions_empty_foryou_hint()
        : undefined
  );
</script>

<SuggestionCarousel {cards} {title} {hint} surface={placement} />
