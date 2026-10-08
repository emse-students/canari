/** One step of a path: where it leads, and what it is called (already localized). */
export interface Crumb {
  label: string;
  href: string;
}

/**
 * The crumb the back arrow leads to: the one BEFORE the current page, which is the last crumb.
 * `undefined` for a path of one, where there is no level above to go up to.
 */
export function previousCrumb(crumbs: readonly Crumb[]): Crumb | undefined {
  return crumbs.length >= 2 ? crumbs[crumbs.length - 2] : undefined;
}

/**
 * How many crumbs a phone folds away: everything but the root and the last `keep - 1`: on a phone only the root and the page you are on stay, the arrow reaching the level above. The back
 * arrow already reaches the level above, so what is folded is only the middle of a long path.
 */
export function foldedCrumbCount(total: number, keep = 2): number {
  return Math.max(0, total - keep);
}

/** One row of a hub: a section the reader can go INTO. */
export interface HubRow {
  /** Stable key, also the test hook (`data-hub-row`). */
  key: string;
  href: string;
  label: string;
  icon: import('svelte').Component<{ size?: number }>;
  /** One line under the label, only where it is already known (a count, a state). */
  summary?: string;
  /** `danger` draws the row in the destructive colour. */
  tone?: 'default' | 'danger';
}
