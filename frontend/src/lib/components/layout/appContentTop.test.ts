/**
 * A BANNER MOVED THE BRAND BAR AND FOUR FLOATING CARDS NEVER HEARD ABOUT IT.
 *
 * The shell has two coordinate systems for "where the content starts". The brand bar sits in a flex
 * column, so anything rendered above it pushes it down. Every floating card - the navigation rail,
 * its hover scrim, the two right-hand drawers, a side panel - is `position: fixed` against the
 * WINDOW, and each of them carried its own hand-written copy of the same sum:
 *
 * ```css
 * top: calc(env(safe-area-inset-top) + var(--app-top-bar-height) + 0.75rem);
 * ```
 *
 * Five copies, all of them true only while nothing was ever rendered above the bar. Measured
 * locally on 2026-09-22 with a second tab of one account open, which is what raises the
 * "messagerie chiffree active dans un autre onglet" banner:
 *
 * | Element | Before | After |
 * | --- | --- | --- |
 * | banner, left gap / right gap | 108px / 12px | 12px / 12px |
 * | brand bar | y = 50, its subtitle clipped by the rail | y = 66, whole |
 * | rail card | y = 84, i.e. 31px INSIDE the bar | y = 150, clear of it |
 *
 * The left gap was the second half of the same mistake: that banner and the offline one were
 * rendered inside the CONTENT column, which reserves the rail's 6rem gutter, under a comment
 * claiming they were "pleine largeur ... jamais dans la rangee sidebar".
 *
 * ## What this gate asserts
 *
 * 1. `--app-top-bar-height` is read by exactly two things: the bar's own height, and the definition
 *    of `--app-content-top`. A sixth card positioning itself against the bar by hand is the defect
 *    coming back, and it reads as correct CSS in review.
 * 2. `--app-banner-height` is published from the layout, so `--app-content-top` is a measurement
 *    rather than its 0px default.
 * 3. Every window-scale banner is rendered ABOVE the shell row - therefore above both the rail and
 *    the bar - and not inside the content column.
 * 4. The banner inset is square (user, 2026-09-22: "si il y a des marges elles doivent etre egales
 *    de tous les cotes").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { withoutComments } from '../../styles/markupSources';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const APP_CSS = read('../../../app.css');
const LAYOUT = read('../../../routes/+layout.svelte');
const BANNER = read('../shared/Banner.svelte');
const SIDEBAR = read('../navigation/AppSidebar.svelte');
const NAVBAR = read('../navigation/Navbar.svelte');

/** Everything that announces an app-wide fact, in the order the shell column renders them. */
const WINDOW_SCALE_BANNERS = [
  'EnvironmentBanner',
  'MaintenanceAdminBanner',
  'MlsFatalErrorBanner',
  'TabFollowerBanner',
  'OfflineBanner',
];

describe('--app-content-top - the one answer to "where does the content start"', () => {
  it('is the only thing in app.css that adds the bar height to an offset', () => {
    const css = withoutComments(APP_CSS);
    const readers = css.split('var(--app-top-bar-height)').length - 1;
    // Exactly one: the `--app-content-top` definition. The `--app-top-bar-height: 4.5rem`
    // declaration itself is not a `var()` read.
    expect(readers).toBe(1);
    expect(css).toContain('--app-content-top: calc(');
    expect(css).toContain('var(--app-banner-height)');
  });

  it('is what every floating card positions against', () => {
    const css = withoutComments(APP_CSS);
    for (const rule of ['.app-nav-rail', '.side-panel', '.app-drawer-panel']) {
      // EVERY block for the rule, not the first: the rule is declared once per breakpoint band,
      // and it was a stale SECOND copy that made the rail's geometry ambiguous to begin with.
      const blocks = css
        .split(`${rule} {`)
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf('}')));
      expect(blocks.length, rule).toBeGreaterThan(0);
      const placing = blocks.filter((b) => /(?:^|[\r\n])\s*(?:top|margin):/.test(b));
      expect(placing.length, `${rule} places itself somewhere`).toBeGreaterThan(0);
      // AT LEAST ONE, not all: below 768px each of these is a full-bleed drawer at `top: 0`, and
      // there is no brand bar above it to hang from. The guarantee that no block ever goes back to
      // spelling the sum by hand is the assertion above, which counts the readers of
      // `--app-top-bar-height` across the whole file.
      expect(
        placing.some((block) => block.includes('var(--app-content-top)')),
        `${rule} hangs below the bar somewhere`
      ).toBe(true);
    }
    // The rail's hover scrim is a class in the markup rather than a rule in app.css.
    expect(SIDEBAR).toContain('top-(--app-content-top)');
    // The bar is the one element allowed to read its own height.
    expect(NAVBAR).toContain('h-(--app-top-bar-height)');
  });

  it('is fed by a measurement, not by its default', () => {
    expect(LAYOUT).toContain('new ResizeObserver(publish)');
    expect(LAYOUT).toContain("'--app-banner-height',");
    expect(LAYOUT).toContain('bind:this={bannerColumn}');
  });
});

describe('the window-scale banners sit above the shell row', () => {
  it('renders every one of them before the row that holds the rail', () => {
    const column = LAYOUT.indexOf('bind:this={bannerColumn}');
    const row = LAYOUT.indexOf('<AppSidebar');
    expect(column).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(column);
    for (const banner of WINDOW_SCALE_BANNERS) {
      const tag = `<${banner} />`;
      expect(LAYOUT.split(tag).length - 1, `${banner} is rendered once`).toBe(1);
      const at = LAYOUT.indexOf(tag);
      expect(at, `${banner} is inside the banner column`).toBeGreaterThan(column);
      expect(at, `${banner} is above the shell row`).toBeLessThan(row);
    }
  });

  it('insets the banner equally on all four sides', () => {
    const root = BANNER.slice(BANNER.indexOf('<div\n'));
    const classes = root.slice(root.indexOf('class="'), root.indexOf('role='));
    expect(classes).toContain('m-3 ');
    // A per-side margin is how the 108/12 asymmetry was written in the first place.
    expect(classes).not.toMatch(/\bm[xytblr]-\d/);
  });
});
