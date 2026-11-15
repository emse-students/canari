import { Log } from '$lib/utils/Log';

/**
 * WHAT THE APP REMEMBERS PER HISTORY ENTRY, WITHOUT NAVIGATING TO REMEMBER IT.
 *
 * Two features need a memory that belongs to ONE entry of the history, not to an address: the page a
 * Back arrow may return to (`backToOrigin.ts`) and the offset a page is reopened at
 * (`scrollMemory.ts`). Two `/posts` entries are two places; the same address visited twice is not
 * one. The key is SvelteKit's own `navigationIndex`, which it writes into `history.state` for every
 * entry (a push is +1, a REPLACE keeps it, a Back or Forward restores the entry's own).
 *
 * The first version stamped the origin through a shallow replacing `goto` (`page.state`). That is a
 * second navigation: it bumps SvelteKit's navigation token, so a mount-time redirect or a tap that
 * landed inside it was ABORTED ("navigation aborted"), and `beforeNavigate` / `onNavigate`
 * subscribers re-ran on every arrival. Nothing here navigates: it is a module `Map`, written from
 * `afterNavigate`, so it lives as long as the document - a reload starts with an empty one, and the
 * arrow then simply follows its structural link.
 */

/** SvelteKit's `HISTORY_METADATA_KEY` (`runtime/client/constants.js`, not public): pinned by a test. */
export const HISTORY_METADATA_KEY = 'sveltekit:metadata';

/** What one entry carries. */
export interface EntryMemory {
  /** The page (path and query) the reader left to reach this entry by a link or a goto. */
  from?: string;
  /** SvelteKit's route id of that page, which decides whether it may be a destination. */
  fromRouteId?: string;
  /** The offset of the page scroller when the entry was last left. */
  top?: number;
}

const MAX_ENTRIES = 200;
const entries = new Map<number, EntryMemory>();
let current: number | undefined;

/** The entry key SvelteKit wrote into a `history.state`, if any. */
export function entryKeyOf(state: unknown): number | undefined {
  const meta = (state as Record<string, { navigationIndex?: unknown } | undefined> | null)?.[
    HISTORY_METADATA_KEY
  ];
  return typeof meta?.navigationIndex === 'number' ? meta.navigationIndex : undefined;
}

/** The entry the reader is on, as of the last arrival. */
export function currentEntryKey(): number | undefined {
  return current;
}

/** What an entry holds (a copy-free read; callers never keep it). */
export function memoryOf(key: number | undefined): EntryMemory | undefined {
  return key === undefined ? undefined : entries.get(key);
}

/** The writable memory of an entry, created on first use and bounded. */
export function memoryFor(key: number): EntryMemory {
  let m = entries.get(key);
  if (!m) {
    m = {};
    entries.set(key, m);
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as number);
  }
  return m;
}

/** Drops an entry's memory: a push reuses the key of a discarded forward entry. */
export function forgetEntry(key: number): void {
  entries.delete(key);
}

/**
 * Registers an arrival and says whether the entry was REPLACED: the key is unchanged since the last
 * arrival, so this navigation overwrote the entry it left rather than adding one after it.
 */
export function arriveAtEntry(state: unknown = history.state): {
  key: number | undefined;
  replaced: boolean;
} {
  const key = entryKeyOf(state);
  const replaced = key !== undefined && key === current;
  if (key === undefined) Log.d('historyEntry', 'arrival without a SvelteKit entry key');
  current = key;
  return { key, replaced };
}

/** Test seam: forgets everything, as a fresh document would. */
export function resetEntryMemory(): void {
  entries.clear();
  current = undefined;
}
