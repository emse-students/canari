<script lang="ts">
  /**
   * AN HONEST EMPTY CANAREELS VIEW: this tab has no live reel yet, and the one place a reel is made
   * is one tap away - the camera (`CAMERA_PLACE`), which the feed otherwise reaches only by a swipe.
   */
  import { Camera, Clapperboard } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import { CAMERA_PLACE } from '$lib/navigation/places';
  import { m } from '$lib/paraglide/messages';
</script>

<div
  class="border-cn-border bg-cn-surface rounded-3xl border border-dashed px-6 py-16 text-center"
  data-reels-empty
>
  <Clapperboard size={48} class="text-text-muted mx-auto mb-3 opacity-40" />
  <h3 class="text-text-main mb-1 text-lg font-bold">{m.posts_reels_empty_title()}</h3>
  <p class="text-text-muted mb-4 text-sm">{m.posts_reels_empty_hint()}</p>
  <a
    href={resolve(CAMERA_PLACE.href)}
    class="tap-target inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-700 dark:text-amber-400"
  >
    <Camera size={16} />
    {m.posts_reels_empty_camera()}
  </a>
</div>
