<script lang="ts">
  import { slowLink } from '$lib/stores/slowLink.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The screen-reader half of the slow-link hint: the visible half is the ring around the header
   * avatar, which says nothing to assistive tech. A polite live region, present only while the
   * link is slow, carrying the existing explanatory sentence.
   */
</script>

{#if slowLink.active}
  <span class="sr-only" role="status" aria-live="polite" data-testid="slow-link-indicator">
    {m.slow_indicator_label()}
  </span>
{/if}
