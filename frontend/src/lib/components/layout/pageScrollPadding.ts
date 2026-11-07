/**
 * The bottom padding of the shell's scroll wrapper (`.page-scroll-wrap`): the room the web bottom
 * navigation covers, and ONLY when the page has that navigation.
 *
 * WHY IT IS CONDITIONAL. A `position: sticky; bottom: 0` element stops at the scroll container's
 * PADDING edge, not at the visible bottom. The padding was reserved on every page, so on the
 * pages with no app chrome (the guest form `/f/:id`, login, legal) the order bar rested one
 * `--bottom-nav-reserve` above the bottom of the screen with the page scrolling visibly under it
 * (measured 2026-11-07 on dev 1.6.6-alpha.4: iPhone 12 Safari, the bar at 65-80 % of the height).
 * The padding must follow the same rule as the navigation's own mount (`isLoginPage` in
 * `routes/+layout.svelte`); on `md` and above the navigation is hidden, so no padding either way.
 *
 * @param hasBottomNav whether the page renders the app chrome (and so the bottom navigation).
 */
export function pageScrollPaddingClass(hasBottomNav: boolean): string {
  return hasBottomNav ? 'pb-(--bottom-nav-reserve) md:pb-0' : '';
}
