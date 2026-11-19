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

/**
 * The broadcaster's variant (owner, 2026-11-19, iPhone 12): the controls are a COLUMN on the right
 * edge, End first, like Instagram and TikTok lives. Nothing wraps at any width by construction:
 * the bar is one non-wrapping row, the identity takes what the column leaves (`min-w-0`, its text
 * truncates) and the column is one non-shrinking track.
 */
export const LIVE_BROADCASTER_BAR_CLASS =
  'absolute inset-x-0 top-0 flex items-start gap-2 p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]';

/** The identity column of the broadcaster: shrinks freely beside the control column. */
export const LIVE_BROADCASTER_IDENTITY_CLASS = 'min-w-0 flex-1';

/**
 * The control column. Short screens (a phone turned: about 390 pt of height for six 44 pt buttons)
 * must not push the lower controls under the comment bar, so the column is capped to the height
 * between the top inset and the bottom inset and scrolls inside that cap instead of overflowing;
 * `pointer-events-auto` keeps it tappable over the picture.
 */
export const LIVE_BROADCASTER_ACTIONS_CLASS =
  'pointer-events-auto flex shrink-0 flex-col items-center gap-2 overflow-y-auto max-h-[calc(100dvh-var(--safe-area-inset-top,0px)-var(--safe-area-inset-bottom,0px)-var(--keyboard-occlusion-bottom,0px)-6rem)]';
