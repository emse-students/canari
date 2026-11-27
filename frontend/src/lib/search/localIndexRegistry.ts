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
/** The account whose messages {@link current} holds. */
let currentOwner: string | null = null;

/**
 * `owner`'s open index, when one is open and not discarded. One held for another account is
 * discarded here, never handed over.
 */
export function openIndex(owner: string): DiscardableIndex | null {
  if (current && currentOwner !== owner)
    discardLocalMessageIndex('another account opened the search');
  return current && !current.isDiscarded ? current : null;
}

/** Records `index`, holding `owner`'s messages, as the realm's open one. */
export function registerIndex(index: DiscardableIndex, owner: string): void {
  if (current && current !== index) current.discard();
  current = index;
  currentOwner = owner;
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
  currentOwner = null;
  console.debug(`[SEARCH] local index discarded (${reason}): ${held} message(s) forgotten`);
  return true;
}
