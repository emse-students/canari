import { untrack } from 'svelte';
import { Log } from '$lib/utils/Log';

/**
 * WHERE THE CONTROLS A HELP CAN POINT AT ARE - registered by the controls themselves.
 *
 * A control marks itself with `use:guideAnchor={'nav.chat'}`. The action runs when the control
 * MOUNTS and its cleanup when it unmounts, so the registry is, at every moment, the list of what is
 * really in the document - never a selector searched for later and never a guess. That is what
 * lets the engine decide a missing target WITHOUT A TIMEOUT: once the route has settled
 * (`afterNavigate`, after which every component of the page and the layout has mounted and run its
 * actions), an anchor that is not here is not drawn by this layout (docs/wiki/frontend/guided-help.md).
 *
 * SEVERAL SOURCES MAY CLAIM ONE ID, AND THAT IS THE POINT. The phone's bottom bar and the desktop
 * sidebar both mark `nav.chat`, and both are mounted on every width - one of them is `display: none`
 * by a breakpoint. The id resolves to the source that is RENDERED (it has a box), which is the one
 * the reader sees. A step names the control; the layout decides which copy of it exists.
 *
 * A REGION is a source with no element: the iOS app's native tab bar is drawn above the WebView, so
 * its tabs are not page elements at all, and it registers the band it covers instead.
 */

/** A rectangle in viewport coordinates, as `getBoundingClientRect` gives it. */
export interface GuideRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type AnchorSource =
  | { readonly kind: 'element'; readonly node: HTMLElement }
  | { readonly kind: 'region'; readonly rect: () => GuideRect | null };

/** What an anchor id resolves to: where it is now, and the element when it is one. */
export interface ResolvedAnchor {
  readonly rect: () => GuideRect | null;
  readonly element: HTMLElement | null;
}

// Not reactive collections ON PURPOSE: a reader reacts to `version`, bumped once per change, so a
// registration that touches the map and a set notifies once and never mid-update.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- `version` is the signal
const sources = new Map<string, Set<AnchorSource>>();
/** Bumped on every registration change, so a reader can react to the registry ($state). */
let version = $state(0);

/**
 * Bumps `version` WITHOUT reading it in the caller's reactive context: registrations run inside an
 * action or an effect, and a tracked read-then-write of `version` there would re-run that effect on
 * its own write, forever (effect_update_depth_exceeded).
 */
function bump(): void {
  untrack(() => version++);
}

function add(id: string, source: AnchorSource): () => void {
  let set = sources.get(id);
  if (!set) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- `version` is the signal
    set = new Set();
    sources.set(id, set);
  }
  set.add(source);
  bump();
  return () => {
    const current = sources.get(id);
    if (!current?.delete(source)) return;
    if (current.size === 0) sources.delete(id);
    bump();
  };
}

/**
 * Svelte action: this element IS the control the anchor id names. The id may change (an `{#each}`
 * row keyed elsewhere); the registration follows it.
 */
export function guideAnchor(node: HTMLElement, id: string) {
  let release = add(id, { kind: 'element', node });
  node.setAttribute('data-guide-anchor', id);
  return {
    update(next: string) {
      if (next === id) return;
      release();
      id = next;
      release = add(id, { kind: 'element', node });
      node.setAttribute('data-guide-anchor', id);
    },
    destroy() {
      release();
      node.removeAttribute('data-guide-anchor');
    },
  };
}

/**
 * Registers a region - a target that is not a page element (the native tab bar). `rect` answers
 * `null` while the region is not on screen. Returns the release.
 */
export function registerGuideRegion(id: string, rect: () => GuideRect | null): () => void {
  Log.d('guide', `region registered for ${id}`);
  return add(id, { kind: 'region', rect });
}

/** Whether an element is drawn: a `display: none` ancestor leaves it without a single box. */
function isRendered(node: HTMLElement): boolean {
  return node.isConnected && node.getClientRects().length > 0;
}

function hasArea(rect: GuideRect | null): rect is GuideRect {
  return rect !== null && rect.width > 0 && rect.height > 0;
}

/**
 * The source of `id` the reader can see now, or `null` when none is. An element wins over a region,
 * since it is the exact control rather than the band around it.
 */
export function resolveGuideAnchor(id: string): ResolvedAnchor | null {
  const set = sources.get(id);
  if (!set) return null;
  for (const source of set) {
    if (source.kind === 'element' && isRendered(source.node)) {
      const node = source.node;
      return {
        element: node,
        rect: () => (isRendered(node) ? node.getBoundingClientRect() : null),
      };
    }
  }
  for (const source of set) {
    if (source.kind === 'region' && hasArea(source.rect())) {
      return { element: null, rect: source.rect };
    }
  }
  return null;
}

/** A number that changes whenever an anchor registers or leaves - read it to react to the registry. */
export function guideAnchorsVersion(): number {
  return version;
}
