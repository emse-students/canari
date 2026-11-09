<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { clampFraction, formatVideoTime } from '$lib/utils/videoPlayback';
  import { videoGlass } from '$lib/utils/videoGlass';
  import { Log } from '$lib/utils/Log';

  /**
   * THE PLAYHEAD - ONE RECIPE, TWO SIZES (owner, 2026-11-09).
   *
   * - `line`: the reel's (user, 2026-10-23: *"la barre de lecture est discrete et collee en bas, sans
   *   timecode"*) - 2px to see, 32px to touch, on the bottom edge; it thickens and shows its handle only
   *   while touched or focused from the keyboard.
   * - `bar`: the full-screen viewer's - a 4px track with what is buffered, inside the glass bar.
   *
   * THE PLAYED PART IS THE BRAND YELLOW in both, the one place the player spends its accent; buffered is
   * white at a third. While a finger (or the mouse) drags, a small glass bubble above the handle says
   * the time it would land on - the time only, never a frame thumbnail (owner: a second decoder costs
   * the Mi 9T, and YouTube's own press-and-slide shows the time).
   *
   * A drag is captured (`setPointerCapture`), so a finger leaving the line keeps scrubbing, and it is a
   * seek, never the viewer's swipe or the player's tap: `data-video-controls` says so to both. The
   * keyboard is the player's (`videoKeyAction`: arrows, Home, End), which a focused slider bubbles to.
   */
  interface Props {
    currentTime: number;
    duration: number;
    /** How far the buffered range under the playhead reaches, as a fraction (`bufferedFraction`). */
    buffered?: number;
    variant: 'line' | 'bar';
    /** Moves the playhead. */
    onSeek: (seconds: number) => void;
    /** A drag started or ended - the player keeps its controls up meanwhile. */
    onScrubbingChange?: (scrubbing: boolean) => void;
    class?: string;
  }

  let {
    currentTime,
    duration,
    buffered = 0,
    variant,
    onSeek,
    onScrubbingChange,
    class: klass = '',
  }: Props = $props();

  let track: HTMLDivElement | null = $state(null);
  let scrubbing = $state(false);

  const known = $derived(Number.isFinite(duration) && duration > 0);
  const played = $derived(known ? clampFraction(currentTime / duration) : 0);
  const timeText = $derived(
    m.video_time_value({
      elapsed: formatVideoTime(currentTime),
      duration: formatVideoTime(duration),
    })
  );

  function fractionAt(clientX: number): number {
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? clampFraction((clientX - rect.left) / rect.width) : 0;
  }

  function setScrubbing(next: boolean) {
    if (scrubbing === next) return;
    scrubbing = next;
    Log.d('VideoScrubber', next ? 'scrub started' : 'scrub ended');
    onScrubbingChange?.(next);
  }

  function onPointerDown(e: PointerEvent) {
    e.stopPropagation();
    if (!known) return;
    setScrubbing(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(fractionAt(e.clientX) * duration);
  }

  function onPointerMove(e: PointerEvent) {
    if (!scrubbing) return;
    onSeek(fractionAt(e.clientX) * duration);
  }

  function onPointerEnd() {
    setScrubbing(false);
  }
</script>

<div
  class="relative {klass}"
  data-video-controls
  data-video-progress={variant}
  onclick={(e) => e.stopPropagation()}
  role="presentation"
>
  {#if scrubbing}
    <!-- The time the drag would land on, above the handle; clamped inside the track's ends. -->
    <span
      class="glass-video text-2xs pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 rounded-full px-2 py-0.5 font-semibold text-white tabular-nums"
      style="left: clamp(1.5rem, {played * 100}%, calc(100% - 1.5rem))"
      data-glass={videoGlass()}
      data-video-time-bubble
    >
      {formatVideoTime(currentTime)}
    </span>
  {/if}
  <div
    bind:this={track}
    class="group/seek relative flex w-full cursor-pointer touch-none outline-none {variant ===
    'line'
      ? 'h-8 items-end'
      : 'h-11 items-center'}"
    role="slider"
    tabindex="0"
    aria-label={m.video_seek_label()}
    aria-valuemin={0}
    aria-valuemax={known ? Math.floor(duration) : 0}
    aria-valuenow={Math.floor(currentTime)}
    aria-valuetext={timeText}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerEnd}
    onpointercancel={onPointerEnd}
  >
    <div
      class="relative w-full overflow-hidden bg-white/30 drop-shadow-sm transition-[height] duration-150 motion-reduce:transition-none {variant ===
      'line'
        ? scrubbing
          ? 'h-1.5'
          : 'h-0.5 group-focus-visible/seek:h-1.5'
        : 'h-1 rounded-full'}"
      data-video-line
    >
      {#if variant === 'bar'}
        <div class="absolute inset-y-0 left-0 bg-white/35" style="width: {buffered * 100}%"></div>
      {/if}
      <div
        class="bg-cn-yellow absolute inset-y-0 left-0"
        style="width: {played * 100}%"
        data-video-played
      ></div>
    </div>
    <div
      class="bg-cn-yellow pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full shadow transition-[opacity,scale] duration-150 group-focus-visible/seek:ring-2 group-focus-visible/seek:ring-white motion-reduce:transition-none {variant ===
      'line'
        ? 'bottom-0 translate-y-1/2'
        : 'top-1/2 -translate-y-1/2'} {variant === 'bar' || scrubbing
        ? 'opacity-100'
        : 'opacity-0 group-focus-visible/seek:opacity-100'} {scrubbing ? 'scale-125' : ''}"
      style="left: {played * 100}%"
      data-video-handle
    ></div>
  </div>
</div>
