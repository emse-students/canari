import { recordArrival } from './backToOrigin';
import { currentEntryKey } from './historyEntry';
import { cancelRestore, rememberLeaving, restoreOnReturn } from './scrollMemory';

/**
 * THE TWO LAYOUT HOOKS OF THE HISTORY MEMORY, as functions so a test can drive them with a sequence
 * of navigations (`routes/+layout.svelte` calls these and nothing else of it).
 *
 * Both are skipped for a SHALLOW navigation of ANY type: a tab or query change, or a Back that
 * crosses one, is not a page the memory is about.
 */

/** The navigation fields the hooks read (SvelteKit's `Navigation`). */
export interface MemoryNavigation {
  type: string;
  shallow?: boolean;
  from: { url: URL; route?: { id: string | null } } | null;
  to: { url: URL } | null;
}

/** `beforeNavigate`: the entry being left keeps its offset, and any restore still waiting ends. */
export function onLeavingEntry(
  nav: MemoryNavigation,
  scrollTop: number,
  scroller?: HTMLElement | null
): void {
  if (nav.shallow) return;
  cancelRestore();
  // The tracked key, not `history.state`: on a popstate the browser has already switched it.
  rememberLeaving(currentEntryKey(), scrollTop, scroller);
}

/** `afterNavigate`: registers the arrival, then reopens the page where it was left on a Back or Forward. */
export function onArrivedAtEntry(nav: MemoryNavigation, scroller: HTMLElement | null): void {
  if (nav.shallow) return;
  recordArrival(nav);
  if (nav.type === 'popstate') restoreOnReturn(currentEntryKey(), scroller);
}
