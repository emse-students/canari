import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { accountStore } from './accountStore';

/**
 * THE ADD LOCKS THIS DEVICE TOOK AND HAS NOT HAD A RELEASE ANSWERED FOR - durable, per group.
 *
 * The server's add lock (`apps/chat-delivery-service/src/utils/add-lock.ts`, `SET NX EX`) refuses
 * even its own holder, for its whole TTL. A release that never reached it - lost with the
 * connection, or never sent because the page died mid-Add - leaves this device refused by ITSELF,
 * and an expiry is not an event anything wakes on. So every acquisition is written here at once,
 * with its token, and leaves only when a release is ANSWERED: whatever page acquires next finds the
 * marker and sends that release first. A reload is then the same case as a lost release on a live
 * page.
 *
 * The token makes the late release harmless: it deletes the acquisition it names, never one taken
 * since (by this page, or by the Android background service of the same device). A server that
 * predates the token returns none, and the marker then holds none - its release is the legacy
 * owner-only one.
 */

/** One acquisition: its token, absent when the server returned none. */
export interface AddLockMarker {
  token?: string;
}

function readAll(userId: string): Record<string, AddLockMarker> {
  const s = accountStore();
  if (!s) return {};
  try {
    const raw = s.getItem(ACCOUNT_KEY.addLockMarkers(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, AddLockMarker> = {};
    for (const [groupId, v] of Object.entries(parsed ?? {})) {
      const token = (v as { token?: unknown } | null)?.token;
      out[groupId] = typeof token === 'string' ? { token } : {};
    }
    return out;
  } catch (e) {
    console.error(
      `[ADD_LOCK] the add-lock markers are UNREADABLE - a lock left behind waits for its expiry: ${String(e).slice(0, 120)}`
    );
    return {};
  }
}

function writeAll(userId: string, all: Record<string, AddLockMarker>): void {
  const s = accountStore();
  if (!s) return;
  const key = ACCOUNT_KEY.addLockMarkers(userId);
  try {
    if (Object.keys(all).length > 0) s.setItem(key, JSON.stringify(all));
    else s.removeItem(key);
  } catch (e) {
    console.error(
      `[ADD_LOCK] the add-lock markers could not be written - a lock left behind waits for its expiry: ${String(e).slice(0, 120)}`
    );
  }
}

/** Records the acquisition this device just made on `groupId` (replacing any older marker). */
export function markAddLock(userId: string, groupId: string, token: string | undefined): void {
  const all = readAll(userId);
  all[groupId] = token ? { token } : {};
  writeAll(userId, all);
}

/**
 * CLAIMS the marker of `groupId` - removed in the same synchronous call that reads it, so two
 * acquires racing in one page never both send its release. The claimant puts it back
 * ({@link markAddLock}) when that release goes unanswered.
 */
export function claimAddLockMarker(userId: string, groupId: string): AddLockMarker | null {
  const all = readAll(userId);
  const marker = all[groupId];
  if (!marker) return null;
  delete all[groupId];
  writeAll(userId, all);
  return marker;
}

/** The release of the acquisition `token` names was answered: its marker leaves - and only its own. */
export function clearAddLockMarker(
  userId: string,
  groupId: string,
  token: string | undefined
): void {
  const all = readAll(userId);
  if (!all[groupId] || all[groupId].token !== token) return;
  delete all[groupId];
  writeAll(userId, all);
}
