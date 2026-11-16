/**
 * The ONE layout of a live screen's top bar, shared by the viewer and the broadcaster (2026-11-16).
 *
 * A wrapping flex row: the identity column has a floor, the actions are one group that never
 * shrinks, so below the floor the whole group drops to its own row instead of being drawn past the
 * edge (broadcaster, 390 pt: End unreachable) or crushing the name (viewer, 436 px). Classes, not a
 * component, because each screen keeps its own background, safe-area style and children.
 */

/** The bar itself: wraps, so the actions can take a row of their own. */
export const LIVE_TOP_BAR_CLASS =
  'absolute inset-x-0 top-0 flex flex-wrap items-start gap-x-2 gap-y-1 p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]';

/** The identity column: grows, but wraps the actions below rather than shrink under 10 rem. */
export const LIVE_TOP_IDENTITY_CLASS = 'min-w-40 flex-1 basis-40';

/** The actions: one non-shrinking group, pushed to the end of whatever row it lands on. */
export const LIVE_TOP_ACTIONS_CLASS = 'ml-auto flex shrink-0 items-center gap-2';
