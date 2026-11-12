/**
 * THE OVERLAY STACK: WHAT IS ON TOP IS WHAT OPENED LAST, AND NOTHING ELSE DECIDES IT.
 *
 * Every overlay (dialog, sheet, popover, viewer, drawer) used to sit on a fixed rung of `app.css`'s
 * ladder, and "what a dialog opens must clear it" was enforced by naming one more rung and one more
 * context reader for every nesting (a dialog in a viewer, a popover in that dialog, a picker in a
 * sheet). The rule the person sees is simpler than any ladder: the surface they opened last is the
 * one in front. So an overlay REGISTERS when it opens and is given its depth from its place in
 * the open order; it RELEASES when it closes or is destroyed, and the ones above it close ranks.
 *
 * This file is the pure, framework-free half: an ordered list of live entries and the arithmetic
 * from a rank to a z-index. The reactive half (`overlayLayer.svelte.ts`) is what components use.
 *
 * Layers that are not overlays stay on the ladder in `app.css` - navigation, the banner column, the
 * toast, the call, tooltips - and the stack's whole range sits BETWEEN the banner and the toast, so a
 * toast still answers whatever was done in the topmost overlay.
 */
import { Log } from './Log';

/** The z-index of the bottom-most overlay: above the banner column (120) and the navigation. */
export const OVERLAY_Z_BASE = 200;
/** One past the last z-index an overlay may take: the toast (`--z-toast`, 310) stays above. */
export const OVERLAY_Z_LIMIT = 310;
/**
 * Each overlay owns TWO consecutive z-indexes: its own, and the one above for a part that must
 * clear it while living in the same stacking context (a drawer's panel over its own scrim).
 */
export const OVERLAY_Z_STRIDE = 2;
/** How many overlays fit before the range is full; far beyond any real nesting. */
export const OVERLAY_CAPACITY = Math.floor((OVERLAY_Z_LIMIT - OVERLAY_Z_BASE) / OVERLAY_Z_STRIDE);

/** An overlay's place: its z-index and the one just above it. */
export type OverlayZ = { z: number; zAbove: number };

/** The ordered set of live overlays, oldest first. */
export class OverlayStack {
  private readonly live: { id: number; label: string }[] = [];
  private nextId = 1;

  /** Adds an overlay on top of every one open now and returns its id. */
  register(label: string): number {
    const id = this.nextId++;
    this.live.push({ id, label });
    Log.d('overlayStack', `register ${label}#${id}, depth ${this.live.length}`);
    if (this.live.length > OVERLAY_CAPACITY) {
      // Reaching this means something opens overlays without ever closing them: accuse, do not hide.
      Log.w(
        'overlayStack',
        `depth ${this.live.length} exceeds the ${OVERLAY_CAPACITY} the z range holds - an overlay is leaking`
      );
    }
    return id;
  }

  /** Removes an overlay wherever it is in the order; the ones above it close ranks. Idempotent. */
  release(id: number): void {
    const at = this.live.findIndex((entry) => entry.id === id);
    if (at < 0) return;
    const [entry] = this.live.splice(at, 1);
    Log.d('overlayStack', `release ${entry.label}#${id}, depth ${this.live.length}`);
  }

  /** How many overlays are open. */
  get depth(): number {
    return this.live.length;
  }

  /** The place of a live overlay, or null once it is released. */
  placeOf(id: number): OverlayZ | null {
    const rank = this.live.findIndex((entry) => entry.id === id);
    if (rank < 0) return null;
    // Past the capacity the overlay shares the last slot rather than climb over the toast; the
    // warning at `register` is what says so.
    const slot = Math.min(rank, OVERLAY_CAPACITY - 1);
    const z = OVERLAY_Z_BASE + slot * OVERLAY_Z_STRIDE;
    return { z, zAbove: z + 1 };
  }
}
