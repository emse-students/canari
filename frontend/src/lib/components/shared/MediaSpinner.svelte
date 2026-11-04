<script lang="ts">
  /**
   * THE ONE "THE MEDIA IS ON ITS WAY" SPINNER of a full-screen media page: centred, never a target
   * (a tap on the picture still plays or pauses), named for assistive tech. Drawn by `VideoPlayer`
   * while a started video waits for data (#3015) and by `PostMedia` while the file is still being
   * downloaded, before any player exists - one visual language for both halves of one wait.
   */
  import { LoaderCircle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<div
  class="pointer-events-none absolute top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 text-white/80"
  role="status"
  aria-label={m.video_loading_label()}
  data-video-buffering
>
  <LoaderCircle size={36} strokeWidth={2} class="animate-spin motion-reduce:animate-none" />
</div>
