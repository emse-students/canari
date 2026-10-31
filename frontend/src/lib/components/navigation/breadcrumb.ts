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

/** What every hub row carries, whatever selecting it does. */
interface HubRowBase {
  /** Stable key, also the test hook (`data-hub-row`). */
  key: string;
  label: string;
  /** One line under the label, only where it is already known (a count, a state). */
  summary?: string;
  /** `danger` draws the row in the destructive colour. */
  tone?: 'default' | 'danger';
  /** A count already held by a store (never fetched for the row); drawn as a pill when above 0. */
  badge?: number;
  /** The localized name of `badge` for assistive technology; required for the pill to be read. */
  badgeLabel?: string;
}

/** A row's glyph: a Lucide component. */
export type HubIcon = import('svelte').Component<{ size?: number }>;

/** An organisation's logo as a row's lead; the row's `icon` is what draws when it has none. */
export interface HubLogo {
  /** The association id: seeds the placeholder colour. */
  id: string;
  name: string;
  logoUrl: string | null;
}

/**
 * What leads a row: a glyph (an organisation row may carry its `logo`, drawn instead of the glyph
 * when it has a logo URL), or - for the reader's own identity row - their avatar. Never both.
 */
type HubRowLead =
  | { icon: HubIcon; logo?: HubLogo; avatarUserId?: never }
  | { avatarUserId: string; icon?: never; logo?: never };

/**
 * One row of a hub: a section the reader can go INTO (`href`, a real link), or - for the one
 * gesture that is not a place, signing out - an ACTION (`onSelect`, a button). Never both.
 */
export type HubRow =
  | HubLinkRow
  | (HubRowBase &
      HubRowLead & {
        onSelect: () => void;
        /** The action is running: the button is disabled and `aria-busy`, so a second tap is inert. */
        busy?: boolean;
        href?: never;
      });

/** A hub row that is a place: what every area hub but the dashboard's sign-out is made of. */
export type HubLinkRow = HubRowBase & HubRowLead & { href: string; onSelect?: never };
