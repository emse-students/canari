import { untrack } from 'svelte';
import { Log } from './Log';
import { gatePlace, OverlayStack, type GateName, type OverlayZ } from './overlayStack';

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

/**
 * Registers a pinned gate: its place is FIXED by the allowlist, and nothing in the normal stack can
 * pass it. Not part of the open order, so it never shifts the ranks of the overlays beneath.
 */
export function registerGate(gate: GateName, label: string): OverlayLayer {
  const place = gatePlace(gate);
  Log.d('overlayStack', `register gate ${gate} (${label}), z ${place.z}`);
  return {
    z: place.z,
    zAbove: place.zAbove,
    release() {
      Log.d('overlayStack', `release gate ${gate} (${label})`);
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
 * @param gate   reads a name from the pinned allowlist (`GATES_TOP_FIRST`): the overlay then takes that
 *               gate's FIXED place above the whole normal stack instead of its open order.
 */
export function useOverlayLayer(
  isOpen: () => boolean,
  label: string,
  gate?: () => GateName | undefined
): { readonly z: number | undefined; readonly zAbove: number | undefined } {
  let layer = $state<OverlayLayer | null>(null);
  // WHAT AN OUTROING NODE KEEPS: a surface with a `transition:` stays in the DOM after `isOpen()` went
  // false, and dropping its z-index at that moment would paint it under whatever it covered for the
  // length of the outro. The last place is held (frozen) once released; it is overwritten at the next
  // open and is never read by a node that is not rendered.
  let frozen: { z: number | undefined; zAbove: number | undefined } | null = null;
  // READ ONCE AS A BOOLEAN: an `isOpen` that reads other signals (a dropdown's `shown && results > 0`)
  // would otherwise re-run the effect on every change while still true, release and register again,
  // and the overlay would jump above one opened after it. A derived only notifies on a change of ITS
  // value.
  const shown = $derived(isOpen());
  $effect.pre(() => {
    if (!shown) return;
    const gateName = gate?.();
    const mine = gateName ? registerGate(gateName, label) : registerOverlay(label);
    layer = mine;
    return () => {
      frozen = { z: mine.z, zAbove: mine.zAbove };
      mine.release();
      layer = null;
    };
  });
  return {
    get z() {
      return layer ? layer.z : frozen?.z;
    },
    get zAbove() {
      return layer ? layer.zAbove : frozen?.zAbove;
    },
  };
}
