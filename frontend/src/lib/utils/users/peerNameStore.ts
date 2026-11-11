import { getStorage } from '$lib/db';
import { currentFeedEpoch, ensureFeedEpoch } from '$lib/posts/feedStoreEpoch';
import type { FeedStoreAccess } from '$lib/posts/feedStore';
import {
  forgetPeerNames,
  isOpenFor,
  mergeStoredNames,
  openDirectory,
  setChangeListener,
  snapshotNames,
} from './peerNameDirectory';

/**
 * THE SEALED COPY OF THE PEER-NAME DIRECTORY, in the account's own encrypted database.
 *
 * It is ONE more slot of the store that keeps the feed's first pages (`posts/feedStore.ts`): the
 * `feedPages` object store on IndexedDB, the `feed_pages` table on SQLite, key {@link DIRECTORY_KEY},
 * sealed under the DEVICE KEY by `IStorage.saveFeedPage`. Never localStorage in clear. Reusing the
 * slot store means reusing its exits instead of enumerating new ones:
 * - sign-out and change of account end the feed EPOCH synchronously (`forgetStoredFeeds`); a copy
 *   carrying an ended epoch is deleted unread, and `stores/user.ts` also calls `forgetPeerNames` for
 *   the memory copy;
 * - a PIN change drops every stored page inside the storage hold (`dropStoredFeedPages`);
 * - `IStorage.clear()` and a revoked-device wipe empty the table or delete the database.
 * The payload repeats its owner and epoch; a copy naming another account is deleted, never read.
 *
 * THE KEY IS NOT THERE AT THE FIRST FRAME. It exists once the session is up or while the account's
 * unlock prompts nobody (`feedStoreAccess`, the feed's own gate). Until {@link bindPeerNames} gets an
 * access, nothing is read and rows show initials and the placeholder, as before this directory
 * existed; the local read that follows touches no network and fills the reactive directory, so the
 * rows already drawn update. A locked device never has a name drawn from the copy.
 */

/** The slot of the directory in the stored-pages table. */
export const DIRECTORY_KEY = 'peer-names';

/** The sealed payload; `owner` and `epoch` repeat the slot's own coordinates on purpose. */
interface StoredDirectory {
  owner: string;
  epoch: string;
  names: Record<string, string>;
}

let access: FeedStoreAccess | null = null;
let scheduled = false;
let hydrating: Promise<void> | null = null;

/** Seals the directory under the device key. Failure is logged and the next change retries. */
async function flush(): Promise<void> {
  // NEVER BEFORE THE STORED COPY IS READ: a write that raced it would replace the older names with
  // the few this launch has resolved so far.
  await hydrating;
  const target = access;
  if (!target || !isOpenFor(target.userId)) return;
  const epoch = ensureFeedEpoch(target.userId);
  if (!epoch) return;
  try {
    const payload: StoredDirectory = {
      owner: target.userId,
      epoch: epoch.epoch,
      names: snapshotNames(),
    };
    await (
      await getStorage(target.userId)
    ).saveFeedPage(DIRECTORY_KEY, payload, target.deviceKeyB64);
  } catch (error) {
    console.warn(`[PEER-NAMES] the directory could not be stored: ${String(error)}`);
  }
}

/** One write per task however many names landed in it (a microtask, never a timer). */
function scheduleWrite(): void {
  if (scheduled || !access) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void flush();
  });
}
setChangeListener(scheduleWrite);

/** Deletes the slot, logging rather than throwing: it runs on a read path. */
async function dropCopy(userId: string, why: string): Promise<void> {
  try {
    const deleted = await (await getStorage(userId)).deleteFeedPage(DIRECTORY_KEY);
    console.log(`[PEER-NAMES] ${deleted} stored directory deleted (${why})`);
  } catch (error) {
    console.warn(
      `[PEER-NAMES] the stored directory could not be deleted (${why}): ${String(error)}`
    );
  }
}

/** Opens the stored copy into the directory when it is this account's and its epoch is current. */
async function hydrate(target: FeedStoreAccess): Promise<void> {
  let opened: Partial<StoredDirectory> | null | undefined;
  try {
    opened = (await (
      await getStorage(target.userId)
    ).getFeedPage(DIRECTORY_KEY, target.deviceKeyB64)) as
      | Partial<StoredDirectory>
      | null
      | undefined;
  } catch (error) {
    // Sealed under a key this device no longer uses, or damaged: deleted, never met again.
    console.warn(`[PEER-NAMES] the stored directory cannot be opened: ${String(error)}`);
    await dropCopy(target.userId, 'unreadable');
    return;
  }
  if (!isOpenFor(target.userId) || !opened) return; // the account changed while the read waited
  if (
    opened.owner !== target.userId ||
    typeof opened.epoch !== 'string' ||
    opened.epoch !== currentFeedEpoch(target.userId) ||
    typeof opened.names !== 'object' ||
    opened.names === null
  ) {
    console.log("[PEER-NAMES] the stored directory is not this account's current one - not read");
    await dropCopy(target.userId, 'foreign, ended epoch or malformed');
    return;
  }
  const taken = mergeStoredNames(target.userId, opened.names);
  console.log(`[PEER-NAMES] ${taken} name(s) read from the device, no network`);
}

/**
 * Gives the directory the account and key it may be read and written with (the feed's gate,
 * `feedStoreAccess`), or `null` while none is in hand. Another account starts from an empty
 * directory. Idempotent for the same account.
 */
export function bindPeerNames(next: FeedStoreAccess | null): void {
  if (!next) {
    if (access) console.log('[PEER-NAMES] no key in hand - directory closed');
    access = null;
    forgetPeerNames();
    return;
  }
  const same = access?.userId === next.userId && isOpenFor(next.userId);
  access = next;
  if (same) return;
  openDirectory(next.userId);
  hydrating = hydrate(next).finally(() => {
    hydrating = null;
  });
}

/** Resolves when the read started by the last bind has finished (tests, and callers that must wait). */
export function peerNamesSettled(): Promise<void> {
  return hydrating ?? Promise.resolve();
}
