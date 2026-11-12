import { untrack } from 'svelte';
import { OverlayStack, type OverlayZ } from './overlayStack';

/**
 * The reactive face of {@link OverlayStack}: THE ONE PLACE A COMPONENT GETS ITS Z-INDEX FROM when it
 * is an overlay. No component names a rung, so no nesting needs a new one - a dialog opened from a
 * viewer, a popover from that dialog, a picker from a sheet are simply opened later.
 *
 * Usage, during component initialisation:
 *
 *   const layer = useOverlayLayer(() => open, 'Modal');
 *   <div style:z-index={layer.z}> ... <div style:z-index={layer.zAbove}> (a part over its own scrim)
 *
 * It registers BEFORE the first render of the open state (`$effect.pre`), so the first frame already
 * carries its z-index, and releases when `isOpen` goes false and when the component is destroyed
 * while open. Deterministic: order is registration order, never a timer.
 */
const stack = new OverlayStack();
/** Bumped on every change, so a reader of `placeOf` re-runs when ranks shift. */
let version = $state(0);
/** Writes are untracked: `version++` also READS, and inside an effect that would loop. */
const bump = () => untrack(() => version++);

/** A registered overlay; `z` and `zAbove` follow the open order. */
export type OverlayLayer = {
  readonly z: number | undefined;
  readonly zAbove: number | undefined;
  release(): void;
};

/** Registers an overlay now. Prefer {@link useOverlayLayer}; this is for non-component owners. */
export function registerOverlay(label: string): OverlayLayer {
  const id = stack.register(label);
  bump();
  const place = (): OverlayZ | null => {
    void version;
    return stack.placeOf(id);
  };
  return {
    get z() {
      return place()?.z;
    },
    get zAbove() {
      return place()?.zAbove;
    },
    release() {
      stack.release(id);
      bump();
    },
  };
}

/** Number of overlays open now (reactive). Exposed for tests and diagnostics. */
export function openOverlayDepth(): number {
  void version;
  return stack.depth;
}

/**
 * Keeps an overlay registered exactly while `isOpen()` is true. Call during initialisation.
 *
 * @param isOpen whether the overlay is shown (read reactively); a component mounted only while open
 *               passes `() => true`.
 * @param label  names the overlay in the log lines at register and release.
 */
export function useOverlayLayer(
  isOpen: () => boolean,
  label: string
): { readonly z: number | undefined; readonly zAbove: number | undefined } {
  let layer = $state<OverlayLayer | null>(null);
  $effect.pre(() => {
    if (!isOpen()) return;
    const mine = registerOverlay(label);
    layer = mine;
    return () => {
      mine.release();
      layer = null;
    };
  });
  return {
    get z() {
      return layer?.z;
    },
    get zAbove() {
      return layer?.zAbove;
    },
  };
}
