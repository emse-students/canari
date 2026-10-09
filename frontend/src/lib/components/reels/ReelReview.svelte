<script lang="ts">
  /**
   * A finished take, looped full-bleed before it goes anywhere (CanaReels R3): discard it and film
   * again, edit it, remove its sound, or go on to publish it.
   *
   * IT IS NOT A PLAYER (user, 2026-10-09): the media fills the screen under `object-cover` (no black
   * bars) and loops; there is no seek bar, no timecode and no sound button at the bottom. The pencil,
   * the sound button and the cross sit at the TOP; "Next" floats at the bottom edge over the media,
   * which is safe now that no control of the media lives there.
   *
   * THE SOUND BUTTON REMOVES THE AUDIO TRACK FROM WHAT IS PUBLISHED (`clip.soundRemoved`, read by
   * `publishReel`), not a listening toggle: while it is on the preview is silent, so what is heard
   * is what is published.
   */
  import { onDestroy } from 'svelte';
  import { ArrowRight, Pencil, Volume2, VolumeX, X } from '@lucide/svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    ondiscard: () => void;
    onedit?: () => void;
    /** The member removed (true) or restored (false) the sound: the clip carries it from here. */
    onsoundchange?: (removed: boolean) => void;
    /** On to the publish step. */
    onnext: () => void;
  }

  let { clip, ondiscard, onedit, onsoundchange, onnext }: Props = $props();

  const isImage = $derived(clip.blob.type.startsWith('image/'));
  const soundRemoved = $derived(clip.soundRemoved === true);

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

  function toggleSound() {
    const next = !soundRemoved;
    console.debug(`[reel-review] sound ${next ? 'removed' : 'kept'}`);
    onsoundchange?.(next);
  }

  // THE RING KEEPS A BUTTON VISIBLE OVER A BRIGHT FRAME: a translucent black disc alone vanishes on
  // a light scene (the pencil read as losing its left third on the Mi 9T, 2026-10-06).
  const roundButton =
    'ui-icon-button rounded-full bg-black/40 ring-1 ring-white/30 outline-none hover:bg-black/60 focus-visible:ring-2 focus-visible:ring-amber-500';
</script>

<div class="absolute inset-0 z-10 bg-black text-white" data-reel-review>
  <!-- FULL-BLEED, NEVER A PLAYER (user, 2026-10-09: black bars): the take fills the screen under
       `object-cover` and loops; the capture is already cropped to the preview box, so nothing
       meaningful is cut. No seek bar, no timecode, no second sound button. -->
  {#if isImage}
    <img {src} alt="" class="absolute inset-0 h-full w-full object-cover" data-reel-media />
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      {src}
      autoplay
      loop
      playsinline
      muted={soundRemoved}
      poster={TRANSPARENT_VIDEO_POSTER}
      class="absolute inset-0 h-full w-full object-cover"
      data-reel-media
    ></video>
  {/if}

  <div
    class="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-start gap-2 p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
  >
    <div class="pointer-events-auto flex items-center gap-2">
      <button
        type="button"
        class={roundButton}
        aria-label={m.reels_review_edit()}
        title={m.reels_review_edit()}
        onclick={() => onedit?.()}
      >
        <Pencil size={22} strokeWidth={2.5} />
      </button>
      {#if !isImage}
        <button
          type="button"
          class="{roundButton} {soundRemoved ? 'text-cn-yellow' : ''}"
          aria-label={soundRemoved ? m.reels_review_sound_restore() : m.reels_review_sound_remove()}
          title={soundRemoved ? m.reels_review_sound_restore() : m.reels_review_sound_remove()}
          aria-pressed={soundRemoved}
          onclick={toggleSound}
          data-reel-sound
        >
          {#if soundRemoved}
            <VolumeX size={22} strokeWidth={2.5} />
          {:else}
            <Volume2 size={22} strokeWidth={2.5} />
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class={roundButton}
        aria-label={m.reels_review_discard()}
        title={m.reels_review_discard()}
        onclick={ondiscard}
      >
        <X size={24} strokeWidth={2.5} />
      </button>
    </div>
    {#if soundRemoved}
      <p
        role="status"
        class="text-2xs rounded-full bg-black/50 px-3 py-1 font-semibold"
        data-reel-sound-removed
      >
        {m.reels_review_sound_removed()}
      </p>
    {/if}
  </div>

  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end px-4 pt-3 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)]"
    data-reel-review-bar
  >
    <button
      type="button"
      class="text-cn-ink pointer-events-auto inline-flex items-center gap-2 rounded-full bg-amber-500 px-5 py-3 text-sm font-bold outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-white"
      onclick={onnext}
      data-reel-next
    >
      {m.reels_review_next()}
      <ArrowRight size={18} strokeWidth={2.5} />
    </button>
  </div>
</div>
