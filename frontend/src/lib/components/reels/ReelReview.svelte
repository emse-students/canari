<script lang="ts">
  /**
   * A finished take, played back full screen and looping before it goes anywhere (CanaReels R3):
   * discard it and film again, edit it, remove its sound, or go on to publish it.
   *
   * LAYOUT IS ONE COLUMN, never layers: the take and its player fill the area above, and "Next"
   * has a bar of its own beneath it. When "Next" floated over the take it sat on the player's
   * seek bar and sound button (user, 2026-10-05, on the phone), which became unusable. The bar
   * owns the home-indicator inset, so the player does not add a second one (`safeBottom` off).
   *
   * THE SOUND BUTTON REMOVES THE AUDIO TRACK FROM WHAT IS PUBLISHED (`clip.soundRemoved`, read by
   * `publishReel`), it is not the player's listening toggle. While it is on, the preview is silent
   * (`soundScope="silent"`) and the player's own sound button is disabled: what is heard is what
   * is published.
   */
  import { onDestroy } from 'svelte';
  import { ArrowRight, Pencil, Volume2, VolumeX, X } from '@lucide/svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
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

  const roundButton =
    'ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500';
</script>

<div class="absolute inset-0 z-10 flex flex-col bg-black text-white" data-reel-review>
  <div class="relative min-h-0 flex-1">
    {#if isImage}
      <img {src} alt="" class="h-full w-full object-contain" />
    {:else}
      <VideoPlayer
        {src}
        autoplay
        loop
        safeBottom={false}
        soundScope={soundRemoved ? 'silent' : 'app'}
        class="h-full w-full"
        videoClass="h-full w-full object-contain"
      />
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
            aria-label={soundRemoved
              ? m.reels_review_sound_restore()
              : m.reels_review_sound_remove()}
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
  </div>

  <div
    class="flex shrink-0 justify-end px-4 pt-3 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)]"
    data-reel-review-bar
  >
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
