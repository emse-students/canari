/**
 * WHICH MESSAGES THIS ACCOUNT HAS ALREADY BEEN NOTIFIED OF ON THIS DEVICE - by message id, durably.
 *
 * A message reaches this app more than once by design: the server keeps a row queued until this
 * device acknowledges it, a push decrypted by the iOS notification extension acknowledges nothing,
 * and a cold start or a resume pulls the row again over the socket. Each of those deliveries looks
 * like an arrival to `notifyInbound`, which used to raise a banner for it - a second banner for a
 * message the extension had already presented (iPhone 12, `1.5.4-alpha.1`, 2026-11-01: "K2 group
 * killed 0724" twice, and "T1 group bg tap" again after the tap that opened it).
 *
 * THE QUESTION IS "HAVE I ANNOUNCED THIS MESSAGE", AND ONLY MEMBERSHIP ANSWERS IT. Not a watermark:
 * `sentAt` is the sender's clock, and nothing orders the senders of a group. Not the shade either:
 * a tapped or swiped notification is gone from `getDeliveredNotifications`, which is exactly when a
 * redelivery happens. Not a clock: a redelivery can come a second or a week later.
 *
 * TWO WRITERS, ONE SET. The app records every message it raises a banner for, and the push cache's
 * ids are recorded when the app takes it (`consumeFcmCache`) - each entry is a message the extension
 * decrypted for a banner. What the extension wrote and the app has not taken yet is read straight
 * from the cache at decision time (`pushCacheMessageIds`), so neither ordering can let one through.
 *
 * Bounded to the {@link NOTIFIED_MESSAGES_CAP} most recent ids: a redelivery concerns a message
 * still queued for this device, which is recent by construction.
 */

import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** How many ids are kept - far above any backlog a notification could still be owed for. */
export const NOTIFIED_MESSAGES_CAP = 2000;

/** The recorded ids of `userId`, oldest first; empty when nothing is stored or storage refuses. */
function readNotified(userId: string): string[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.notifiedMessages(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch (e) {
    // EVERY SWALLOWED BRANCH LOGS: an unreadable record is a record that suppresses nothing, which
    // is the next duplicate banner - said where it starts.
    console.warn('[NOTIF] the notified-messages record is unreadable - nothing is suppressed:', e);
    return [];
  }
}

/** The ids in `ids` this account has NOT been notified of yet on this device, in their order. */
export function unnotifiedOf(userId: string, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const known = new Set(readNotified(userId));
  return ids.filter((id) => id && !known.has(id));
}

/**
 * Records `ids` as notified. Called BEFORE the banner is raised, in the same tick as the
 * {@link unnotifiedOf} that cleared them, so two decisions about one message cannot both pass.
 */
export function recordNotified(userId: string, ids: readonly string[]): void {
  const fresh = ids.filter(Boolean);
  if (fresh.length === 0) return;
  const kept = readNotified(userId);
  const known = new Set(kept);
  for (const id of fresh) {
    if (known.has(id)) continue;
    known.add(id);
    kept.push(id);
  }
  const bounded = kept.length > NOTIFIED_MESSAGES_CAP ? kept.slice(-NOTIFIED_MESSAGES_CAP) : kept;
  try {
    localStorage.setItem(ACCOUNT_KEY.notifiedMessages(userId), JSON.stringify(bounded));
  } catch (e) {
    console.warn(`[NOTIF] ${fresh.length} notified message id(s) not recorded:`, e);
  }
}
