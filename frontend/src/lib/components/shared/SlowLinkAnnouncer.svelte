<script lang="ts">
  import { slowLink } from '$lib/stores/slowLink.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The screen-reader half of the slow-link hint: the visible half is the ring around the header
   * avatar, which says nothing to assistive tech. Mounted ONCE, app-wide, from the root layout, and
   * ALWAYS present: a live region inserted already populated is often not announced, so the region
   * stays in the DOM and only its text switches. The text is set on the transition into slow and
   * cleared on the way out, so a flap announces once per entry, never on every render.
   */
</script>

<span class="sr-only" role="status" aria-live="polite" data-testid="slow-link-indicator">
  {slowLink.active ? m.slow_indicator_label() : ''}
</span>
