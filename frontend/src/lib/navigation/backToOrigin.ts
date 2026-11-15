import { page } from '$app/state';
import { historyOverlayStackDepth } from '$lib/utils/historyOverlayStack';
import { Log } from '$lib/utils/Log';
import { arriveAtEntry, currentEntryKey, forgetEntry, memoryFor, memoryOf } from './historyEntry';

/**
 * BACK RETURNS TO WHERE THE READER CAME FROM (owner report, 2026-11-15: a post's association chip,
 * then the arrow, landed on the Associations list instead of the feed).
 *
 * The arrow of a page header is a link to its STRUCTURAL parent (`Associations > BDE`), which is
 * right when the reader went down the tree and wrong when a link from ELSEWHERE dropped them in the
 * middle of it. ONE rule, no case per link: every link or goto that ADDS a history entry records the
 * page it left against that entry (`historyEntry.ts`: in memory, no navigation, gone on a reload),
 * and the arrow asks {@link backDecision}: go back in history when that page is the structural
 * parent OR another top-level section (a cross-section open); otherwise follow the structural link.
 * History Back is what restores the origin page as it was.
 *
 * **A REPLACE RECORDS NOTHING AND INHERITS** (review of #3648): sign-in, an auth callback, a guard
 * redirect or an error recovery replace the entry they run on, so the page they came from is not in
 * history any more; the entry keeps whatever origin the replaced one had (none on a cold deep link),
 * and the arrow follows its structural link rather than calling `history.back()` into nothing.
 * The Android hardware back and the iOS edge swipe walk history already, so only the arrow disagreed.
 */

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
 * A page that is gone once it has done its job: a creation or edit form. A Back to it would reopen a
 * form whose submission just produced the page the reader is on (review of #3648: a list created at
 * `/associations/new` lands on `/lists/<slug>`, another section, so `from` is the filled form).
 * The origin is refused as a destination, and the arrow follows its structural link.
 */
const TRANSIENT_SEGMENTS = new Set(['create', 'new', 'edit']);

function isTransient(path: string): boolean {
  return bare(path)
    .split('/')
    .some((segment) => TRANSIENT_SEGMENTS.has(segment));
}

/**
 * Where the arrow of the page at `current` goes, given the page it was reached from (`from`, absent
 * on a cold open, a shared link, a reload or an entry a replace overwrote) and its structural parent
 * `up`. `history`: the previous entry IS a place the arrow may lead to. `up`: follow the link.
 */
export function backDecision(current: string, from: string | undefined, up: string): BackDecision {
  if (!from) return 'up';
  const fromPath = bare(from);
  if (fromPath === bare(current)) return 'up';
  if (fromPath === bare(up)) return 'history';
  if (isTransient(fromPath)) return 'up';
  return sectionOf(fromPath) !== sectionOf(current) ? 'history' : 'up';
}

/**
 * Called from `afterNavigate` for every non-shallow navigation: registers the arrival and, for a
 * link or goto that ADDED an entry, records the page it left against it. A replace inherits (and
 * drops the offset of the page it overwrote); a popstate or the first load has nothing to record.
 * It NEVER navigates.
 */
export function recordArrival(nav: {
  type: string;
  shallow?: boolean;
  from: { url: URL } | null;
  to: { url: URL } | null;
}): void {
  if (nav.shallow) return;
  const { key, replaced } = arriveAtEntry();
  if (key === undefined) return;
  if (nav.type !== 'link' && nav.type !== 'goto') return;
  if (replaced) {
    // The page it replaced is not in history: its offset must not be applied to this one.
    const memory = memoryOf(key);
    if (memory) delete memory.top;
    Log.d('backToOrigin', `entry ${key} replaced: origin kept (${memory?.from ?? 'none'})`);
    return;
  }
  // A push reuses the key of an entry it discarded: start from nothing.
  forgetEntry(key);
  if (!nav.from || !nav.to) return;
  const from = nav.from.url.pathname + nav.from.url.search;
  const to = nav.to.url.pathname + nav.to.url.search;
  if (from === to) return;
  memoryFor(key).from = from;
  Log.d('backToOrigin', `entry ${key} (${to}) arrived from ${from}`);
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
 *
 * WITH AN OVERLAY OPEN the link is left to navigate: an open sheet owns a ghost history entry
 * (`historyOverlayStack`), so `history.back()` would only close the sheet and leave the page, an
 * arrow that looks dead. The structural link is a navigation, whose `beforeNavigate` drains the stack.
 */
export function backLinkTaken(anchor: Element): boolean {
  const up = anchor.getAttribute('href') ?? '';
  const here = page.url.pathname + page.url.search;
  const from = memoryOf(currentEntryKey())?.from;
  const overlays = historyOverlayStackDepth();
  const decision = overlays > 0 ? 'up' : backDecision(here, from, up);
  Log.d(
    'backToOrigin',
    `arrow on ${here}: ${decision} (from ${from ?? 'unknown'}, up ${up}, overlays ${overlays})`
  );
  if (decision !== 'history') return false;
  history.back();
  return true;
}
