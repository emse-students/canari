<script lang="ts">
  /**
   * The red "LIVE" pill, on the feed card and over the viewer. Its dot pulses only for a reader who
   * did not ask for reduced motion.
   */
  import { m } from '$lib/paraglide/messages';
</script>

<span
  class="bg-red-err text-2xs inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-bold tracking-wide text-white"
  data-live-badge
>
  <span class="size-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true"></span>
  {m.live_badge()}
</span>
