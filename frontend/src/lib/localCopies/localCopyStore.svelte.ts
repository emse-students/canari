import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getStorage } from '$lib/db';
import { FeedPageUnreadableError } from '$lib/db/types';
import type { FeedStoreAccess } from '$lib/posts/feedStore';
import { currentPeerNamesEpoch, ensurePeerNamesEpoch } from '$lib/utils/users/peerNameDirectory';

/**
 * THE DEVICE'S LOCAL COPIES OF SCREENS THAT HAD NONE (slow-link chantier, gap 2, 2026-11-11): the
 * notification list and the profiles already opened. Each is ONE slot of the account's sealed
 * `feed_pages` store - the table the feed's first pages and the peer-name directory already share -
 * sealed under the DEVICE KEY by `IStorage.saveFeedPage`. Never localStorage in clear.
 *
 * WHY. On a weak link a screen with no copy waits for an answer, while with no network at all it
 * draws from local state at once: the app was worse on a bad link than on none. A screen with a copy
 * paints it first (0 round trips) and revalidates behind it.
 *
 * THE LIFETIME IS THE PEER-NAME DIRECTORY'S, ON PURPOSE: the same epoch (`peerNameDirectory.ts`),
 * started with the first write and ended ONLY by a sign-out or a change of account (`stores/user.ts`
 * -> `endPeerNames`). A copy carrying an ended epoch, another account or another slot is deleted
 * unread. It is NOT the feed's epoch, so an audience verdict does not cost these copies; but a feed
 * refusal's `deleteFeedPages()` empties the shared table, and a copy lost that way is rewritten by
 * the next answer. A PIN change drops every stored page (`dropStoredFeedPages`); a store holding its
 * list in memory seals it again when {@link bindLocalCopies} hands it the new key.
 *
 * THE KEY IS NOT THERE AT THE FIRST FRAME. {@link bindLocalCopies} gets the feed's own gate
 * (`feedStoreAccess`): the account on screen, its device key, an unlocked session. Until then
 * nothing is read or written and {@link localCopiesOpenFor} reads `null` - reactively, so a screen
 * drawn before the bind re-reads when it opens. A locked device never has a copy drawn.
 */

/** What a slot's sealed envelope repeats of its own coordinates. */
interface Envelope {
  owner: string;
  epoch: string;
  slot: string;
  body: unknown;
}

/** The slot of the notification list. */
export const BELL_SLOT = 'copy:bell';
/** The slot of the profiles already opened. */
export const PROFILES_SLOT = 'copy:profiles';

let access: FeedStoreAccess | null = null;
/** The account the copies are open for, reactive (a plain `let` tracks nothing). */
const openCell = new SvelteMap<'owner', string | null>();
type Opener = (access: FeedStoreAccess) => void;
const openers = new SvelteSet<Opener>();

/** The account whose copies may be read and written now, or `null` while no key is in hand. */
export function localCopiesOpenFor(): string | null {
  return openCell.get('owner') ?? null;
}

/** The access in hand. */
export function localCopiesAccess(): FeedStoreAccess | null {
  return access;
}

/**
 * Registers a store to be told whenever copies open for an account or its key changes: it reads its
 * slot (or seals what it holds in memory). Called at once when copies are already open.
 */
export function onLocalCopiesOpen(opener: Opener): () => void {
  openers.add(opener);
  if (access) opener(access);
  return () => openers.delete(opener);
}

/**
 * Gives the copies the account and key they may be read and written with, or `null` while none is
 * in hand (a locked device, a sign-out). Idempotent for an unchanged access.
 */
export function bindLocalCopies(next: FeedStoreAccess | null): void {
  if (!next) {
    if (access) console.log('[LOCAL-COPIES] no key in hand - copies closed');
    access = null;
    openCell.set('owner', null);
    return;
  }
  if (access && access.userId === next.userId && access.deviceKeyB64 === next.deviceKeyB64) return;
  access = next;
  openCell.set('owner', next.userId);
  for (const opener of openers) {
    try {
      opener(next);
    } catch (error) {
      console.warn(`[LOCAL-COPIES] a store failed to open: ${String(error)}`);
    }
  }
}

async function dropSlot(userId: string, slot: string, why: string): Promise<void> {
  try {
    const deleted = await (await getStorage(userId)).deleteFeedPage(slot);
    console.log(`[LOCAL-COPIES] ${deleted} ${slot} copy deleted (${why})`);
  } catch (error) {
    console.warn(`[LOCAL-COPIES] ${slot} could not be deleted (${why}): ${String(error)}`);
  }
}

/**
 * The body of `slot` for `target`'s account, or `null`: nothing stored, not this account's current
 * one (deleted), unreadable (deleted), or the store failed (kept, logged - it says nothing about the
 * row). `parse` narrows the body to what the caller draws; a body it refuses is deleted.
 */
export async function readLocalCopy<T>(
  target: FeedStoreAccess,
  slot: string,
  parse: (body: unknown) => T | null
): Promise<T | null> {
  let opened: unknown;
  try {
    opened = await (await getStorage(target.userId)).getFeedPage(slot, target.deviceKeyB64);
  } catch (error) {
    if (error instanceof FeedPageUnreadableError) {
      console.warn(`[LOCAL-COPIES] ${slot} cannot be opened: ${String(error)}`);
      await dropSlot(target.userId, slot, 'unreadable');
    } else {
      console.warn(`[LOCAL-COPIES] ${slot} could not be read: ${String(error)}`);
    }
    return null;
  }
  if (opened === null || opened === undefined) return null;
  // The account may have changed while the read waited.
  if (localCopiesOpenFor() !== target.userId) return null;
  const env = opened as Partial<Envelope>;
  if (
    typeof env !== 'object' ||
    env.owner !== target.userId ||
    env.slot !== slot ||
    typeof env.epoch !== 'string' ||
    env.epoch !== currentPeerNamesEpoch(target.userId)
  ) {
    console.log(`[LOCAL-COPIES] ${slot} is not this account's current copy - deleted unread`);
    await dropSlot(target.userId, slot, 'foreign or ended epoch');
    return null;
  }
  const body = parse(env.body);
  if (body === null) {
    console.warn(`[LOCAL-COPIES] ${slot} does not have the shape this build wrote - deleted`);
    await dropSlot(target.userId, slot, 'malformed');
    return null;
  }
  return body;
}

/**
 * Seals `body` as `slot`, replacing the previous one, for the account copies are open for. Nothing
 * when no key is in hand (the next answer writes). The key is read at the LAST moment and the write
 * abandoned if the access changed meanwhile. Logged, never thrown: it runs behind an answer.
 */
export async function writeLocalCopy(slot: string, body: unknown): Promise<void> {
  const target = access;
  if (!target) return;
  const epoch = ensurePeerNamesEpoch(target.userId);
  if (!epoch) return;
  try {
    const storage = await getStorage(target.userId);
    if (access !== target) return;
    const envelope: Envelope = { owner: target.userId, epoch, slot, body };
    await storage.saveFeedPage(slot, envelope, target.deviceKeyB64);
  } catch (error) {
    console.warn(`[LOCAL-COPIES] ${slot} could not be stored: ${String(error)}`);
  }
}
