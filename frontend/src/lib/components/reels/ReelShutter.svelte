<script lang="ts">
  /**
   * The CanaReels shutter: ONE button, a tap for a photo and a long press for a video, inside a ring
   * that fills to the 90 s cap (C4) (`reelCapture.ts` says how a press is told apart).
   *
   * It reports PRESS, RELEASE and CANCEL and decides nothing itself - the capture's reducer reads
   * them. It opts out of the tab swipe (`data-swipe-nav-ignore`), so a held take whose finger drifts
   * does not turn the page, and it captures the pointer so a finger sliding off the button still ends
   * a hold where it lifts. A long press must not raise the system's context menu, a text selection or
   * iOS's callout, so all three are switched off here.
   */
  import { m } from '$lib/paraglide/messages';

  interface Props {
    recording: boolean;
    /** How full the ring is, 0 to 1. */
    fraction: number;
    /** `m:ss` of the take, shown above the button while recording. */
    timeLabel: string;
    disabled?: boolean;
    onpress: (at: number) => void;
    onrelease: (at: number) => void;
    /** The touch was taken away (a system gesture): neither a tap nor a release. */
    oncancel: () => void;
  }

  let {
    recording,
    fraction,
    timeLabel,
    disabled = false,
    onpress,
    onrelease,
    oncancel,
  }: Props = $props();

  /** The pointer this button is following, so a second finger is not a second press. */
  let pointerId: number | null = null;

  /** The ring's circumference in the SVG's own units (r = 45). */
  const CIRCUMFERENCE = 2 * Math.PI * 45;

  function down(event: PointerEvent) {
    if (disabled || pointerId !== null) return;
    pointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
    onpress(event.timeStamp);
  }

  function up(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    onrelease(event.timeStamp);
  }

  function cancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    console.debug('[reel-shutter] pointer cancelled');
    oncancel();
  }

  /** The keyboard's press is a tap: Enter or Space down and up at once takes a photo. */
  function key(event: KeyboardEvent) {
    if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    if (event.repeat) return;
    onpress(event.timeStamp);
    onrelease(event.timeStamp);
  }
</script>

<div class="flex flex-col items-center gap-2" data-swipe-nav-ignore>
  <span
    class="rounded-full bg-black/40 px-2.5 py-0.5 text-xs font-semibold tabular-nums {recording
      ? 'visible'
      : 'invisible'}"
    aria-hidden={!recording}
  >
    {timeLabel}
  </span>
  <button
    type="button"
    class="relative h-20 w-20 touch-none rounded-full outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"
    aria-label={recording ? m.reels_shutter_stop() : m.reels_shutter_capture()}
    aria-pressed={recording}
    data-reel-shutter
    {disabled}
    onpointerdown={down}
    onpointerup={up}
    onpointercancel={cancel}
    onkeydown={key}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <svg viewBox="0 0 100 100" class="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" class="stroke-white/40" stroke-width="6" />
      <circle
        cx="50"
        cy="50"
        r="45"
        fill="none"
        class="stroke-red-500"
        stroke-width="6"
        stroke-linecap="round"
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={CIRCUMFERENCE * (1 - fraction)}
        data-reel-ring
        data-fraction={fraction.toFixed(3)}
      />
    </svg>
    <span
      class="absolute inset-3 rounded-full transition-all duration-150 {recording
        ? 'inset-6 rounded-lg bg-red-500'
        : 'bg-white'}"
    ></span>
  </button>
</div>
