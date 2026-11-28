import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/**
 * THE NEW-MAIL WATCHER'S HIGH-WATER MARK - WHAT MAKES "ALREADY NOTIFIED" A DURABLE FACT
 * (docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * Zimbra hands item ids out in increasing order within a mailbox, so "the highest inbox id this
 * device has already considered" answers "is this message new to me" for every message at once,
 * across restarts, without a list and without a clock. It is written per Canari account and names
 * the mailbox it was taken in: a cursor of another address is not this mailbox's and is ignored.
 *
 * What it holds is an address and a number - never a subject, a sender or a fragment.
 *
 * WHERE IT IS KEPT ({@link platformCursorStore}): in the apps, a FILE in the app's data directory
 * (`mail_watch.rs`), which the system does not evict and which the native side can read; on the web,
 * `localStorage` (one of the D8 keys, `mailLocalData.ts`) - durable as far as the browser keeps a
 * site's storage, which a user or a storage-pressure eviction may clear (the next run then takes a
 * baseline: nothing is notified twice, the mail of the gap is not announced). It is erased by D8, by
 * the switch turned off (`mailWatchSwitch.svelte.ts`) and by the account's local wipe.
 */

/** The cursor of one mailbox. */
export interface MailWatchCursor {
  /** The mailbox it was taken in (lower case). */
  account: string;
  /** The highest inbox item id already considered: nothing at or below it is ever notified. */
  highest: number;
}

/** Where the cursor's text is kept. Every method logs its own failure; `read` and `erase` never throw. */
export interface MailCursorStore {
  read(userId: string): Promise<string | null>;
  /** Resolves `true` when the text is durably written, `false` (logged) when it is not. */
  write(userId: string, raw: string): Promise<boolean>;
  erase(userId: string): Promise<void>;
}

/** The web's store: `localStorage` under `ACCOUNT_KEY.mailWatchCursor`. */
export function webCursorStore(store: Storage = localStorage): MailCursorStore {
  return {
    async read(userId) {
      try {
        return store.getItem(ACCOUNT_KEY.mailWatchCursor(userId));
      } catch (err) {
        Log.w('MAIL-WATCH', `ERROR: the cursor could not be read (${String(err)})`);
        return null;
      }
    },
    async write(userId, raw) {
      try {
        store.setItem(ACCOUNT_KEY.mailWatchCursor(userId), raw);
        return true;
      } catch (err) {
        Log.w('MAIL-WATCH', `ERROR: the cursor could not be written (${String(err)})`);
        return false;
      }
    },
    async erase(userId) {
      try {
        store.removeItem(ACCOUNT_KEY.mailWatchCursor(userId));
      } catch (err) {
        Log.w('MAIL-WATCH', `ERROR: the cursor could not be erased (${String(err)})`);
      }
    },
  };
}

/** The apps' store: one file per account in the app's data directory (`mail_watch.rs`). */
export const nativeCursorStore: MailCursorStore = {
  async read(userId) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string | null>('mail_watch_cursor_read', { userId });
    } catch (err) {
      Log.w('MAIL-WATCH', `ERROR: the native cursor could not be read (${String(err)})`);
      return null;
    }
  },
  async write(userId, raw) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('mail_watch_cursor_write', { userId, value: raw });
      return true;
    } catch (err) {
      Log.w('MAIL-WATCH', `ERROR: the native cursor could not be written (${String(err)})`);
      return false;
    }
  },
  async erase(userId) {
    await forgetNativeMailWatch(userId);
  },
};

/** The store of this platform: the native file in the apps, `localStorage` on the web. */
export function platformCursorStore(): MailCursorStore {
  return isTauriRuntime() ? nativeCursorStore : webCursorStore();
}

/**
 * Erases what the native side keeps for `userId`'s mail watch (the cursor file) - D8, the switch
 * turned off and the account's local wipe all go through here. A no-op on the web. Never throws.
 */
export async function forgetNativeMailWatch(userId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('mail_watch_forget', { userId });
    Log.i('MAIL-WATCH', 'the native mail watch state was erased');
  } catch (err) {
    Log.w('MAIL-WATCH', `ERROR: the native mail watch state was not erased (${String(err)})`);
  }
}

const VERSION = 1;

/**
 * The cursor of `userId` for `account`, or `null` when there is none for that mailbox (never taken,
 * taken in another mailbox, or unreadable - each said in the log, and each means "take a baseline").
 */
export async function readMailWatchCursor(
  userId: string,
  account: string,
  store: MailCursorStore
): Promise<MailWatchCursor | null> {
  const raw = await store.read(userId);
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

/** Writes `cursor` for `userId`. `false` (logged by the store) when it was not durably written. */
export function writeMailWatchCursor(
  userId: string,
  cursor: MailWatchCursor,
  store: MailCursorStore
): Promise<boolean> {
  return store.write(
    userId,
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
