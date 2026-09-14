/**
 * Where a portalled node was written, kept so that "inside" can still mean what the author meant.
 *
 * A portal moves a node out of its subtree to escape a containing block or an `overflow` clip. That
 * is a PAINTING decision, and it silently becomes a LOGIC decision for anything reasoning about
 * containment - `node.contains()`, `event.composedPath()`, an outside-click guard. The node is still
 * logically part of the component that wrote it; only its parent changed.
 *
 * So the move records where it came from. The origin is not a prop a call site must remember to
 * pass - it is read from the DOM at the instant of the move, which is the one moment both positions
 * are known, and a call site that forgets it cannot exist.
 */
const portalOrigins = new WeakMap<HTMLElement, HTMLElement>();

/**
 * The element a portalled node was written inside, following the chain through nested portals.
 *
 * Returns `null` for a node that was never portalled. A portal whose origin is itself inside another
 * portalled node resolves to the outermost logical position, so nesting does not break containment.
 */
export function portalOrigin(node: HTMLElement): HTMLElement | null {
  let origin = portalOrigins.get(node) ?? null;
  const seen = new Set<HTMLElement>();
  while (origin) {
    if (seen.has(origin)) return origin;
    seen.add(origin);
    const next = portalOrigins.get(origin);
    if (!next) return origin;
    origin = next;
  }
  return null;
}

/**
 * Is `candidate` inside `container`, counting the portals that moved parts of it away?
 *
 * This is `container.contains(candidate)` for everything still in place, plus the logical position
 * of anything portalled out. Use it wherever a DOM containment test decides BEHAVIOUR rather than
 * layout - an outside-click guard being the case that made this necessary.
 */
export function containsThroughPortals(container: HTMLElement, candidate: HTMLElement): boolean {
  if (container.contains(candidate)) return true;
  for (let node: HTMLElement | null = candidate; node;) {
    const origin = portalOrigin(node);
    if (!origin) break;
    if (container.contains(origin)) return true;
    node = origin;
  }
  return false;
}

/**
 * Svelte action that moves the attached DOM node into `target` (defaults to `document.body`),
 * enabling CSS-stacking-context escapes for modals and tooltips.
 *
 * The node's original parent is remembered - see {@link containsThroughPortals} for why, and
 * `docs/wiki/frontend/architecture.md` for the defect that made it necessary.
 */
export function portal(node: HTMLElement, target: HTMLElement = document.body) {
  const origin = node.parentElement;
  if (origin) {
    portalOrigins.set(node, origin);
  }
  target.appendChild(node);

  return {
    destroy() {
      portalOrigins.delete(node);
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
}
