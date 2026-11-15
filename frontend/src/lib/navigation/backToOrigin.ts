import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { internalPath } from '$lib/utils/internalPath';
import { page } from '$app/state';
import { Log } from '$lib/utils/Log';

/**
 * BACK RETURNS TO WHERE THE READER CAME FROM (owner report, 2026-11-15: a post's association chip,
 * then the arrow, landed on the Associations list instead of the feed).
 *
 * The arrow of a page header is a link to its STRUCTURAL parent (`Associations > BDE`), which is
 * right when the reader went down the tree and wrong when a link from ELSEWHERE dropped them in the
 * middle of it. ONE rule, no case per link: every in-app navigation writes the page it left into the
 * new history entry's own state (`page.state.from`, a shallow replacing `goto`, so it
 * survives Back, Forward and a reload and belongs to the ENTRY, never to a global), and the arrow
 * asks {@link backDecision}: go back in history when that page is the structural parent OR another
 * top-level section (a cross-section open); otherwise follow the structural link. History Back is
 * what restores the origin page as it was. The Android hardware back and the iOS edge swipe walk
 * history already, so only the arrow ever disagreed.
 */

/** What a history entry remembers: the path (with query) of the page the reader left to reach it. */
export interface ArrivalState {
  from?: string;
}

/** The top-level section of a path: its first segment (`/posts/3` -> `posts`, `/` -> ``). */
export function sectionOf(path: string): string {
  return path.split(/[?#]/)[0].split('/').filter(Boolean)[0] ?? '';
}

/** A path without its query and fragment, trailing slash dropped, for comparing two places. */
function bare(path: string): string {
  const p = path.split(/[?#]/)[0];
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export type BackDecision = 'history' | 'up';

/**
 * Where the arrow of the page at `current` goes, given the page it was reached from (`from`, absent
 * on a cold open, a shared link or a reload of a pre-state entry) and its structural parent `up`.
 * `history`: the previous entry IS a place the arrow may lead to. `up`: follow the link.
 */
export function backDecision(current: string, from: string | undefined, up: string): BackDecision {
  if (!from) return 'up';
  const fromPath = bare(from);
  if (fromPath === bare(current)) return 'up';
  if (fromPath === bare(up)) return 'history';
  return sectionOf(fromPath) !== sectionOf(current) ? 'history' : 'up';
}

/**
 * Called from `afterNavigate`: stamps the entry just reached with the page it was reached from.
 * A shallow `goto` (a tab or query change on the same page) and a popstate (the entry already holds
 * its state) are left alone; a navigation to the page itself has no origin worth a Back.
 */
export function recordArrival(nav: {
  type: string;
  shallow?: boolean;
  from: { url: URL } | null;
  to: { url: URL } | null;
}): void {
  if (nav.shallow || (nav.type !== 'link' && nav.type !== 'goto')) return;
  if (!nav.from || !nav.to) return;
  const from = nav.from.url.pathname + nav.from.url.search;
  const to = nav.to.url.pathname + nav.to.url.search;
  if (from === to) return;
  const state: ArrivalState = { from };
  Log.d('backToOrigin', `entry ${to} arrived from ${from}`);
  goto(resolve(internalPath(to)), {
    shallow: true,
    replace: true,
    state: { ...page.state, ...state },
  }).catch((error) => Log.w('backToOrigin', `could not stamp ${to}: ${String(error)}`));
}

/** Marks the anchor of a page's Back arrow, whose `href` is the structural parent. */
export const BACK_LINK_ATTRIBUTE = 'data-back-link';

/**
 * Answers a click on a Back arrow (an anchor carrying {@link BACK_LINK_ATTRIBUTE}): when
 * {@link backDecision} says `history`, it walks history and returns true - the caller then cancels the
 * click. False leaves the structural link to navigate.
 *
 * IT RUNS FROM `handleAppLinkClick` (`utils/openExternal.ts`), NOT FROM AN `onclick` ON THE ANCHOR: that
 * document-level capture listener already intercepts every in-app link, calls `preventDefault` and
 * `stopPropagation` and navigates itself, so a handler bound on the anchor never runs (read in a
 * browser, 2026-11-15: a first version bound there did nothing). It is the ONE place a link click is
 * decided, which is where a link that is not a plain link has to be decided too. The `href` stays for
 * assistive technology; a modified or non-primary click never reaches here.
 */
export function backLinkTaken(anchor: Element): boolean {
  const up = anchor.getAttribute('href') ?? '';
  const here = page.url.pathname + page.url.search;
  const from = (page.state as ArrivalState).from;
  const decision = backDecision(here, from, up);
  Log.d('backToOrigin', `arrow on ${here}: ${decision} (from ${from ?? 'unknown'}, up ${up})`);
  if (decision !== 'history') return false;
  history.back();
  return true;
}
