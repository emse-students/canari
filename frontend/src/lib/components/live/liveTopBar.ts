/**
 * The ONE layout of a live screen's top bar, shared by the viewer and the broadcaster before it is
 * on air (2026-11-16); the broadcaster on air has the column variant at the end of this file.
 *
 * A wrapping flex row: the identity column has a floor, the actions are one group that never
 * shrinks, so below the floor the whole group drops to its own row instead of being drawn past the
 * edge (broadcaster, 390 pt: End unreachable) or crushing the name (viewer, 436 px). Classes, not a
 * component, because each screen keeps its own background, safe-area style and children.
 */

/** What every top bar shares: placement, padding and the top inset. */
const LIVE_TOP_BAR_BASE_CLASS =
  'absolute inset-x-0 top-0 flex items-start p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]';

/** The bar itself: wraps, so the actions can take a row of their own. */
export const LIVE_TOP_BAR_CLASS = `${LIVE_TOP_BAR_BASE_CLASS} flex-wrap gap-x-2 gap-y-1`;

/** The identity column: grows, but wraps the actions below rather than shrink under 10 rem. */
export const LIVE_TOP_IDENTITY_CLASS = 'min-w-40 flex-1 basis-40';

/** The actions: one non-shrinking group, pushed to the end of whatever row it lands on. */
export const LIVE_TOP_ACTIONS_CLASS = 'ml-auto flex shrink-0 items-center gap-2';

/**
 * The broadcaster's variant ON AIR only (owner, 2026-11-19, iPhone 12): the controls are a COLUMN on
 * the right edge, End first, like Instagram and TikTok lives. Before going live the shared wrapping
 * row above is kept (one row of at most four buttons, `ml-auto`, clear of the pre-live sheet).
 * Nothing wraps on air by construction: the bar is one non-wrapping row, the identity takes what the
 * column leaves (`min-w-0`, its text truncates) and the column is one non-shrinking track.
 */
export const LIVE_BROADCASTER_ONAIR_BAR_CLASS = `${LIVE_TOP_BAR_BASE_CLASS} gap-2`;

/** The identity column of the broadcaster on air: shrinks freely beside the control column. */
export const LIVE_BROADCASTER_ONAIR_IDENTITY_CLASS = 'min-w-0 flex-1';

/**
 * The on-air control column. The cap leaves 5.25 rem free at the bottom (6 rem minus the bar's
 * 0.75 rem top padding), plus the insets: the chat's bottom padding (0.75 rem) and its last lines,
 * and, with the studio on, the scene bar, the second right-edge column at the bottom
 * (`data-live-onair-scenes`), are what a lower control would cover on a short screen (a
 * phone turned: about 390 pt of height for six 44 pt buttons). The column scrolls inside the cap
 * instead of overflowing; `p-1` keeps the focus rings from being clipped by `overflow-y-auto`;
 * `pointer-events-auto` keeps it tappable over the picture.
 */
export const LIVE_BROADCASTER_ONAIR_ACTIONS_CLASS =
  'pointer-events-auto flex shrink-0 flex-col items-center gap-2 overflow-y-auto p-1 max-h-[calc(100dvh-var(--safe-area-inset-top,0px)-var(--safe-area-inset-bottom,0px)-var(--keyboard-occlusion-bottom,0px)-6rem)]';
