/**
 * WHICH LOCAL MESSAGE INDEX IS OPEN IN THIS REALM, in a module with no import of its own - so the
 * sign-out (`stores/auth.ts`) can drop it without pulling the envelope, the store and the search
 * into its own import graph.
 */

/** What the registry needs of an index: to forget everything, and to say how much it held. */
export interface DiscardableIndex {
  readonly size: number;
  readonly isDiscarded: boolean;
  discard(): void;
}

let current: DiscardableIndex | null = null;

/** The open index, when one is open and not discarded. */
export function openIndex(): DiscardableIndex | null {
  return current && !current.isDiscarded ? current : null;
}

/** Records `index` as the realm's open one. */
export function registerIndex(index: DiscardableIndex): void {
  current = index;
}

/**
 * Drops the index and every decrypted word it held: when the search closes, and at every sign-out
 * (`clearAuth`), so the next account on this device never searches the last one's messages.
 * Returns whether one was held.
 */
export function discardLocalMessageIndex(reason: string): boolean {
  if (!current) return false;
  const held = current.size;
  current.discard();
  current = null;
  console.debug(`[SEARCH] local index discarded (${reason}): ${held} message(s) forgotten`);
  return true;
}
