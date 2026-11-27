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
   *
   * THE HELD FINGER ALSO ZOOMS (user, 2026-10-22): its vertical travel since the press is reported
   * (`onmove`, positive UP), and the capture screen turns it into a zoom while a take is filmed
   * (`cameraZoom.ts`). The button is `touch-none` and holds the pointer, so the slide neither
   * scrolls nor reaches the page's own gestures.
   *
   * SLIDE LEFT TO LOCK (owner, 2026-11-27): while a take is held, a padlock appears LEFT of the
   * button. Lifting the finger while it is over the padlock reports `onlock` INSTEAD of a release, the
   * take carries on hands-free, and the button then shows stop: one tap on it reports `onstop`. Sliding
   * back off the padlock before lifting locks nothing. The decision is read at the lift, from the
   * pointer and the padlock's rectangle (`overPadlock`); no timer is involved. ONLY THE FINGER THAT
   * STARTED THE TAKE CAN LOCK IT: a press that lands while a take already runs (a volume-key take) is
   * recorded at `down` (`lockable`), is offered no padlock and never locks. While that finger travels
   * left toward the padlock (past `AIM_FREEZE_PX`) its vertical slide stops zooming, so aiming does not
   * change the zoom; once locked the zoom stays where it was (no finger, no slide). The padlock shows
   * only while recording, when the gallery slot to its left is empty, so the two never overlap.
   * The lock is announced to a screen reader through a polite live line.
   */
  import { Lock } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { overPadlock } from '$lib/reels/reelCapture';

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
    /** The held finger moved: its travel since the press, in CSS px, positive UP. */
    onmove?: (upPx: number) => void;
    /** The take is locked (hands-free): the button is a stop. */
    locked?: boolean;
    /** The finger was lifted over the padlock: keep recording. */
    onlock?: () => void;
    /** A tap on the stop button of a locked take. */
    onstop?: () => void;
  }

  let {
    recording,
    fraction,
    timeLabel,
    disabled = false,
    onpress,
    onrelease,
    oncancel,
    onmove,
    locked = false,
    onlock,
    onstop,
  }: Props = $props();

  /** The pointer this button is following, so a second finger is not a second press. */
  let pointerId: number | null = null;
  /** Where the followed pointer came down, for the slide's travel. */
  let pressY = 0;
  /** The followed press is a tap on the STOP of a locked take, not a new press. */
  let stopTap = false;
  /** A finger is down on the button (the padlock is offered while it is). */
  let holding = $state(false);
  /** The held finger is over the padlock now. */
  let overLock = $state(false);
  let padlockEl: HTMLElement | undefined = $state();
  /** Margin around the padlock, in CSS px, so a thumb need not land on its exact pixels. */
  const PADLOCK_SLOP_PX = 12;
  /** Leftward travel after which the held finger is aiming at the padlock and stops zooming. */
  const AIM_FREEZE_PX = 24;
  /** Where the followed pointer came down, horizontally. */
  let pressX = 0;
  /** The followed press began with no take running: only such a finger may lock one. */
  let lockable = $state(false);

  /** Forgets the followed pointer: nothing of a gesture may outlive its pointer. */
  function resetGesture() {
    pointerId = null;
    stopTap = false;
    holding = false;
    overLock = false;
    lockable = false;
  }

  // A disabled button gets no pointerup (the take is finishing, the cap or a camera error raced a
  // stop tap): the gesture it was following is over, so the shutter can never stay dead.
  $effect(() => {
    if (disabled && pointerId !== null) {
      console.debug('[reel-shutter] disabled under a followed pointer: gesture reset');
      resetGesture();
    }
  });

  function padlockHit(event: PointerEvent): boolean {
    if (!padlockEl) return false;
    return overPadlock(
      event.clientX,
      event.clientY,
      padlockEl.getBoundingClientRect(),
      PADLOCK_SLOP_PX
    );
  }

  /** The ring's circumference in the SVG's own units (r = 45). */
  const CIRCUMFERENCE = 2 * Math.PI * 45;

  function down(event: PointerEvent) {
    if (disabled || pointerId !== null || event.button > 0) return;
    pointerId = event.pointerId;
    pressX = event.clientX;
    pressY = event.clientY;
    stopTap = locked;
    holding = !locked;
    overLock = false;
    lockable = !recording && !locked;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
    if (stopTap) return;
    onpress(event.timeStamp);
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId || stopTap) return;
    if (recording && lockable) overLock = padlockHit(event);
    // Aiming at the padlock (left of the button) is not a zoom.
    if (pressX - event.clientX > AIM_FREEZE_PX && lockable) return;
    onmove?.(pressY - event.clientY);
  }

  function up(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (stopTap) {
      stopTap = false;
      console.debug('[reel-shutter] tap on stop of a locked take');
      onstop?.();
      return;
    }
    const lock = recording && lockable && padlockHit(event);
    holding = false;
    overLock = false;
    lockable = false;
    if (lock) {
      console.debug('[reel-shutter] lifted over the padlock: the take is locked');
      onlock?.();
      return;
    }
    onrelease(event.timeStamp);
  }

  function cancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    holding = false;
    overLock = false;
    lockable = false;
    pointerId = null;
    if (stopTap) {
      // The system took a would-be stop tap: the take stays locked, nothing was decided.
      stopTap = false;
      return;
    }
    console.debug('[reel-shutter] pointer cancelled');
    oncancel();
  }

  /**
   * The captured pointer was released by the engine without an up or a cancel (a stop tap racing the
   * cap, the element torn down under the finger): the gesture is over. A hold is ended like a
   * cancelled touch; a would-be stop tap decides nothing.
   */
  function lostCapture(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const wasStopTap = stopTap;
    console.warn('[reel-shutter] pointer capture lost with no up: gesture reset');
    resetGesture();
    if (!wasStopTap) oncancel();
  }

  /** The keyboard's press is a tap: Enter or Space down and up at once takes a photo. */
  function key(event: KeyboardEvent) {
    if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    if (event.repeat) return;
    if (locked) {
      onstop?.();
      return;
    }
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
  <span class="sr-only" aria-live="polite" data-reel-lock-live>
    {locked ? m.reels_shutter_locked() : ''}
  </span>
  <div class="relative">
    {#if holding && lockable && recording && !locked}
      <span
        bind:this={padlockEl}
        role="img"
        aria-label={m.reels_shutter_lock()}
        class="absolute top-1/2 right-full mr-6 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-white transition-colors duration-150 {overLock
          ? 'bg-accent'
          : 'bg-black/40'}"
        data-reel-padlock
        data-engaged={overLock}
      >
        <Lock size={22} strokeWidth={2.5} />
      </span>
    {/if}
    <button
      type="button"
      class="focus-visible:ring-accent-icon relative h-20 w-20 touch-none rounded-full outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 disabled:opacity-40"
      aria-label={recording ? m.reels_shutter_stop() : m.reels_shutter_capture()}
      aria-pressed={recording}
      data-reel-shutter
      {disabled}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={cancel}
      onlostpointercapture={lostCapture}
      onkeydown={key}
      oncontextmenu={(e) => e.preventDefault()}
    >
      <svg
        viewBox="0 0 100 100"
        class="absolute inset-0 h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="45" fill="none" class="stroke-white/40" stroke-width="6" />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          class="stroke-accent-icon"
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
          ? 'bg-accent inset-6 rounded-lg'
          : 'bg-white'}"
      ></span>
    </button>
  </div>
</div>
