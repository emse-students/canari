<script lang="ts">
  /**
   * A finished take, played back full screen and looping before it goes anywhere (CanaReels R3):
   * discard it and film again, or go on to publish it.
   *
   * The player is the app's own (`VideoPlayer`), with the app's one sound answer, so the take sounds
   * the way the member left every other video.
   */
  import { onDestroy } from 'svelte';
  import { ArrowRight, X } from '@lucide/svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    ondiscard: () => void;
    /** On to the publish step. */
    onnext: () => void;
  }

  let { clip, ondiscard, onnext }: Props = $props();

  // One URL per clip, revoked with it: the take is tens of megabytes.
  const src = $derived(URL.createObjectURL(clip.blob));
  let previous: string | null = null;
  $effect(() => {
    if (previous && previous !== src) URL.revokeObjectURL(previous);
    previous = src;
  });
  onDestroy(() => {
    if (previous) URL.revokeObjectURL(previous);
  });
</script>

<div class="absolute inset-0 z-10 bg-black text-white" data-reel-review>
  <VideoPlayer
    {src}
    autoplay
    loop
    class="h-full w-full"
    videoClass="h-full w-full object-contain"
  />

  <div class="absolute inset-x-0 top-0 flex items-start justify-between p-3">
    <button
      type="button"
      class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={m.reels_review_discard()}
      title={m.reels_review_discard()}
      onclick={ondiscard}
    >
      <X size={24} strokeWidth={2.5} />
    </button>
  </div>

  <div class="absolute right-0 bottom-0 p-4 pb-[calc(var(--safe-area-inset-bottom,0px)+1.5rem)]">
    <button
      type="button"
      class="text-cn-ink inline-flex items-center gap-2 rounded-full bg-amber-500 px-5 py-3 text-sm font-bold outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-white"
      onclick={onnext}
      data-reel-next
    >
      {m.reels_review_next()}
      <ArrowRight size={18} strokeWidth={2.5} />
    </button>
  </div>
</div>
