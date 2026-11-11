<script lang="ts">
  import { connection } from '$lib/stores/slowLink.svelte';
  import { announcementStep, type Announcement } from './connectionAnnouncement';
  import { m } from '$lib/paraglide/messages';

  /**
   * The screen-reader half of the connection ring, which says nothing to assistive tech. Mounted
   * ONCE, app-wide, from the root layout, and ALWAYS present: a live region inserted already
   * populated is often not announced, so the region stays in the DOM and only its text switches.
   * It carries the sentences the "Hors connexion" banner used to carry (what offline means, the
   * reconnection) plus the slow-link one, and says "back" once after an offline or reconnecting
   * spell - never for a slow link that clears (`announcementStep`). A healthy start says nothing.
   */
  let outage = false;
  let say = $state<Announcement>(null);
  $effect(() => {
    const step = announcementStep(outage, connection.state);
    outage = step.outage;
    say = step.say;
  });
  const text = $derived(
    say === 'offline'
      ? m.offline_banner_desc()
      : say === 'reconnecting'
        ? m.offline_banner_reconnecting()
        : say === 'slow'
          ? m.slow_indicator_label()
          : say === 'back'
            ? m.connection_back_label()
            : ''
  );
</script>

<span class="sr-only" role="status" aria-live="polite" data-testid="connection-announcer">
  {text}
</span>
