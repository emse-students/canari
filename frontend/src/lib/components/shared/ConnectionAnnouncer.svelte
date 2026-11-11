<script lang="ts">
  import { connection } from '$lib/stores/slowLink.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The screen-reader half of the connection ring, which says nothing to assistive tech. Mounted
   * ONCE, app-wide, from the root layout, and ALWAYS present: a live region inserted already
   * populated is often not announced, so the region stays in the DOM and only its text switches.
   * It carries the sentences the "Hors connexion" banner used to carry (what offline means, the
   * reconnection) plus the slow-link one, and says "back" once when a degraded phase ends. A healthy
   * start announces nothing.
   */
  let degradedSeen = $state(false);
  const phase = $derived(connection.state);
  $effect(() => {
    if (phase === 'slow' || phase === 'offline' || phase === 'reconnecting') degradedSeen = true;
    else if (phase === null) degradedSeen = false;
  });
  const text = $derived.by(() => {
    if (phase === 'offline') return m.offline_banner_desc();
    if (phase === 'reconnecting') return m.offline_banner_reconnecting();
    if (phase === 'slow') return m.slow_indicator_label();
    if (phase === 'connected' && degradedSeen) return m.connection_back_label();
    return '';
  });
</script>

<span class="sr-only" role="status" aria-live="polite" data-testid="connection-announcer">
  {text}
</span>
