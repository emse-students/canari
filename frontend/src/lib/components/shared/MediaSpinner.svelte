<script lang="ts">
  /**
   * THE ONE "THE MEDIA IS ON ITS WAY" SPINNER of a full-screen media page: centred, never a target
   * (a tap on the picture still plays or pauses), named for assistive tech. Drawn by `VideoPlayer`
   * while a started video waits for data (#3015) and by `PostMedia` while the file is still being
   * downloaded, before any player exists - one visual language for both halves of one wait.
   *
   * With a `percent`, it is a stream HOLDING on a link slower than the video (`segmentedMediaStream`):
   * the wait is deliberate and has an end, so it says how much is in and that the video then plays
   * without stopping - a load that reads as progress, never as a broken video.
   */
  import { LoaderCircle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    /**
     * Whether the spinner is a live region. False for a slide drawn ahead of the reader (a
     * preloading neighbour): it is the same picture, but only the page on screen may announce.
     */
    live?: boolean;
    /** How much of a held load is in, 0-100; absent for an ordinary wait. */
    percent?: number;
    /** "Lire quand meme" under a held load: the reader takes the stalls. Absent, no button. */
    onPlayAnyway?: () => void;
  }

  let { live = true, percent, onPlayAnyway }: Props = $props();

  /** The button's tap is its own: neither the player's tap (sound) nor its hold (pause) sees it. */
  function playAnyway(e: MouseEvent) {
    e.stopPropagation();
    onPlayAnyway?.();
  }

  const label = $derived(
    percent === undefined ? m.video_loading_label() : m.video_buffering_progress({ percent })
  );
</script>

<div
  class="pointer-events-none absolute top-1/2 left-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-white/80"
  role={live ? 'status' : undefined}
  aria-label={live ? label : undefined}
  aria-hidden={live ? undefined : 'true'}
  data-video-buffering
>
  <LoaderCircle size={36} strokeWidth={2} class="animate-spin motion-reduce:animate-none" />
  {#if percent !== undefined}
    <span
      class="rounded-full bg-black/60 px-3 py-1 text-xs font-semibold whitespace-nowrap text-white"
      aria-hidden="true"
      data-video-hold-progress
    >
      {label}
    </span>
    {#if onPlayAnyway}
      <!-- The overlay lets taps through to the picture; only this button takes them. -->
      <div
        class="pointer-events-auto"
        role="presentation"
        onpointerdown={(e) => e.stopPropagation()}
        data-video-play-anyway
      >
        <Button variant="secondary" size="default" class="min-h-11" onclick={playAnyway}>
          {m.video_play_anyway()}
        </Button>
      </div>
    {/if}
  {/if}
</div>
