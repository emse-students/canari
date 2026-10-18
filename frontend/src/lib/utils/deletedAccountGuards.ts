import { resumePendingDeletedAccountWipes } from '$lib/utils/accountLocalWipe';

/**
 * AN ACCOUNT DELETED IN ONE TAB MUST STOP EVERY OTHER TAB SIGNED IN AS IT.
 *
 * A second tab still signed in as the deleted account keeps its connections to `CanariDB_<id>` open
 * - which DEFERS the deleting tab's `deleteDatabase` - and keeps writing, which would recreate what
 * the wipe removed. So the deleting tab announces the deletion on this channel, and every tab showing
 * that account ends its session, closes its stores and goes to `/login`. A tab signed in as anyone
 * else ignores it.
 */
const CHANNEL = 'canari-account-deleted';

/** The one message the channel carries. */
export interface AccountDeletedNotice {
  type: 'account_deleted';
  userId: string;
}

/** Tells the other tabs of this origin that `userId` was deleted. A tab hears nothing it posts. */
export function announceAccountDeleted(userId: string): void {
  if (typeof BroadcastChannel === 'undefined') {
    console.warn(
      '[DEL-LOCAL] no BroadcastChannel here - another tab signed in as the deleted account is not told'
    );
    return;
  }
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: 'account_deleted', userId } satisfies AccountDeletedNotice);
  channel.close();
  console.log(`[DEL-LOCAL] deletion of ${userId.slice(0, 8)} announced to the other tabs`);
}

/** What a tab does when it hears of a deletion. Injected so the guard is testable without a session. */
export interface DeletedElsewhereHandlers {
  /** The account this tab is signed in as, or `null`. */
  currentUserId: () => string | null;
  /** Ends this tab's session for `userId`: clear the credentials, close its stores, go to `/login`. */
  endSession: (userId: string) => Promise<void>;
}

/**
 * Reacts to one notice: ends this tab's session only when it is signed in as the deleted account.
 * Exported for the test; {@link listenForAccountDeletedElsewhere} is what the app calls.
 */
export async function onAccountDeletedElsewhere(
  notice: unknown,
  handlers: DeletedElsewhereHandlers
): Promise<boolean> {
  const n = notice as Partial<AccountDeletedNotice> | null;
  if (n?.type !== 'account_deleted' || typeof n.userId !== 'string') {
    console.warn('[DEL-LOCAL] ignoring a malformed account-deleted notice');
    return false;
  }
  if (handlers.currentUserId() !== n.userId) {
    console.log(
      `[DEL-LOCAL] another tab deleted ${n.userId.slice(0, 8)} - this tab is another account, nothing to do`
    );
    return false;
  }
  console.warn(
    `[DEL-LOCAL] another tab deleted ${n.userId.slice(0, 8)}, the account this tab is signed in as - ending this session`
  );
  try {
    await handlers.endSession(n.userId);
  } catch (e) {
    console.error('[DEL-LOCAL] this tab could not end the deleted account session:', e);
  }
  return true;
}

/** Subscribes this tab to deletions announced by the others. Returns the unsubscribe. */
export function listenForAccountDeletedElsewhere(handlers: DeletedElsewhereHandlers): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[DEL-LOCAL] no BroadcastChannel here - a deletion in another tab is not heard');
    return () => {};
  }
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (ev: MessageEvent<unknown>) =>
    void onAccountDeletedElsewhere(ev.data, handlers);
  return () => channel.close();
}

/**
 * At start-up: finishes any wipe a previous run owed, then listens for deletions in other tabs.
 *
 * @param savedUserId the account this install is signed in as, never wiped by the resume
 */
export function startDeletedAccountGuards(
  savedUserId: string | null,
  handlers: DeletedElsewhereHandlers
): () => void {
  void resumePendingDeletedAccountWipes(savedUserId).catch((e: unknown) =>
    console.error('[DEL-LOCAL] resuming the owed wipes failed:', e)
  );
  return listenForAccountDeletedElsewhere(handlers);
}
