<script lang="ts">
  /**
   * THE CAMERA OVERLAY'S HANDLE (owner, 2026-11-14): an outline laid over the overlay the preview
   * shows, which the member DRAGS; let go, the overlay SNAPS to the nearest corner (`snapCorner`) -
   * only the snap reaches the picture, so the viewers never watch a drag. The arrow keys move it
   * corner to corner for a keyboard. The preview draws the composed frame with `object-fit:
   * contain`, so the handle is placed with the same fit (`frameToDisplay`), and the pointer is read
   * back onto the frame (`displayToFrame`).
   */
  import { Move } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import type { LiveStudio } from '$lib/live/liveStudio.svelte';
  import {
    cornerAfterKey,
    displayToFrame,
    frameToDisplay,
    overlayBox,
    snapCorner,
    type Size,
  } from '$lib/live/liveScenes';

  interface Props {
    studio: LiveStudio;
    /** The size the preview element is drawn at, in CSS pixels. */
    display: Size;
  }

  let { studio, display }: Props = $props();

  const box = $derived(frameToDisplay(overlayBox(studio.overlay), display));
  /** The pointer's offset from where the drag began, while one is in progress. */
  let drag = $state<{
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
  } | null>(null);

  function onpointerdown(event: PointerEvent) {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
    };
  }

  function onpointermove(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = { ...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY };
  }

  function onpointerup(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId || !box) return;
    const center = {
      x: box.x + box.width / 2 + drag.dx,
      y: box.y + box.height / 2 + drag.dy,
    };
    drag = null;
    const onFrame = displayToFrame(center, display);
    if (!onFrame) return;
    const corner = snapCorner(onFrame);
    console.debug(`[LIVE-SCREEN] overlay dropped, snapped to ${corner}`);
    studio.setOverlay({ corner });
  }

  function onkeydown(event: KeyboardEvent) {
    const corner = cornerAfterKey(studio.overlay.corner, event.key);
    if (corner === studio.overlay.corner) return;
    event.preventDefault();
    studio.setOverlay({ corner });
  }
</script>

{#if box}
  <!-- A drag surface, not a button in controls.md's sense: it has no box of its own (it IS the
       overlay's outline, sized and placed by the frame), so `ui/Button` cannot draw it. It keeps a
       button's role and keyboard path (the arrow keys) for a screen reader and a keyboard. -->
  <div
    role="button"
    tabindex="0"
    class="absolute flex cursor-grab touch-none items-center justify-center border-2 border-dashed border-white/70 text-white/0 outline-none hover:text-white/90 focus-visible:text-white/90 focus-visible:ring-2 focus-visible:ring-white active:cursor-grabbing {studio
      .overlay.shape === 'round'
      ? 'rounded-full'
      : 'rounded-lg'}"
    style="left: {box.x}px; top: {box.y}px; width: {box.width}px; height: {box.height}px; transform: translate({drag?.dx ??
      0}px, {drag?.dy ?? 0}px);"
    aria-label={m.live_scene_overlay_move_label()}
    title={m.live_scene_overlay_move_label()}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={() => (drag = null)}
    {onkeydown}
    data-no-double-tap
    data-live-overlay-handle
  >
    <Move size={22} strokeWidth={2.25} />
  </div>
{/if}
