import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';

/**
 * THE NEW-MAIL WATCHER'S HIGH-WATER MARK - WHAT MAKES "ALREADY NOTIFIED" A DURABLE FACT
 * (docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * Zimbra hands item ids out in increasing order within a mailbox, so "the highest inbox id this
 * device has already considered" answers "is this message new to me" for every message at once,
 * across restarts, without a list and without a clock. It is written per Canari account and names
 * the mailbox it was taken in: a cursor of another address is not this mailbox's and is ignored.
 *
 * What it holds is an address and a number - never a subject, a sender or a fragment. It is one of
 * the D8 keys (`mailLocalData.ts`), so a closed mailbox erases it with the rest.
 */

/** The cursor of one mailbox. */
export interface MailWatchCursor {
  /** The mailbox it was taken in (lower case). */
  account: string;
  /** The highest inbox item id already considered: nothing at or below it is ever notified. */
  highest: number;
}

const VERSION = 1;

/**
 * The cursor of `userId` for `account`, or `null` when there is none for that mailbox (never taken,
 * taken in another mailbox, or unreadable - each said in the log, and each means "take a baseline").
 */
export function readMailWatchCursor(
  userId: string,
  account: string,
  store: Storage = localStorage
): MailWatchCursor | null {
  const raw = store.getItem(ACCOUNT_KEY.mailWatchCursor(userId));
  if (raw === null) {
    Log.d('MAIL-WATCH', 'no cursor yet - a baseline will be taken');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    Log.w(
      'MAIL-WATCH',
      `ERROR: the cursor is not JSON (${raw.length} chars) - a baseline will be taken`
    );
    return null;
  }
  const entry = parsed as { v?: unknown; account?: unknown; highest?: unknown };
  if (
    entry?.v !== VERSION ||
    typeof entry.account !== 'string' ||
    typeof entry.highest !== 'number' ||
    !Number.isSafeInteger(entry.highest) ||
    entry.highest < 0
  ) {
    Log.w('MAIL-WATCH', 'ERROR: the cursor has an unknown shape - a baseline will be taken');
    return null;
  }
  if (entry.account !== account.toLowerCase()) {
    Log.i('MAIL-WATCH', 'the cursor was taken in another mailbox - a baseline will be taken');
    return null;
  }
  return { account: entry.account, highest: entry.highest };
}

/** Writes `cursor` for `userId`. Throws only what the storage throws (a full or blocked store). */
export function writeMailWatchCursor(
  userId: string,
  cursor: MailWatchCursor,
  store: Storage = localStorage
): void {
  store.setItem(
    ACCOUNT_KEY.mailWatchCursor(userId),
    JSON.stringify({ v: VERSION, account: cursor.account.toLowerCase(), highest: cursor.highest })
  );
}

/**
 * A Zimbra item id as the number the cursor compares, or `null` for an id that is not a plain
 * non-negative integer (an item of ANOTHER mailbox shared into this one is `accountId:id`): such an
 * item is never in this account's own inbox numbering, so it is neither new nor old to the cursor.
 */
export function itemNumber(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}
