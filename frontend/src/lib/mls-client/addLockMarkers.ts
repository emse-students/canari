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
 *
 * ONE MARKER PER ACQUISITION, NOT PER GROUP: an owed release that goes unanswered is PUT BACK, and a
 * concurrent acquire may have marked its own token meanwhile. With one slot per group the later
 * write erased the other, and that acquisition's lost release then waited out the whole TTL. Every
 * write here adds or removes its own token and never replaces another.
 */

/** One acquisition: its token, absent when the server returned none. */
export interface AddLockMarker {
  token?: string;
}

/**
 * One group's markers as stored. Reads the list this module writes, and the single
 * `{token?}` object a build before the list wrote - a device updated with a marker pending keeps it.
 */
function parseGroup(v: unknown): AddLockMarker[] {
  const entries = Array.isArray(v) ? v : [v];
  const out: AddLockMarker[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const token = (entry as { token?: unknown }).token;
    out.push(typeof token === 'string' ? { token } : {});
  }
  return out;
}

function readAll(userId: string): Record<string, AddLockMarker[]> {
  const s = accountStore();
  if (!s) return {};
  try {
    const raw = s.getItem(ACCOUNT_KEY.addLockMarkers(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, AddLockMarker[]> = {};
    for (const [groupId, v] of Object.entries(parsed ?? {})) {
      const markers = parseGroup(v);
      if (markers.length > 0) out[groupId] = markers;
    }
    return out;
  } catch (e) {
    console.error(
      `[ADD_LOCK] the add-lock markers are UNREADABLE - a lock left behind waits for its expiry: ${String(e).slice(0, 120)}`
    );
    return {};
  }
}

function writeAll(userId: string, all: Record<string, AddLockMarker[]>): void {
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

/**
 * Records an acquisition of `groupId` whose release is not answered yet - a new one, or an owed one
 * put back. Adds its token beside the group's others, once; never replaces another's.
 */
export function markAddLock(userId: string, groupId: string, token: string | undefined): void {
  const all = readAll(userId);
  const markers = all[groupId] ?? [];
  if (markers.some((m) => m.token === token)) return;
  all[groupId] = [...markers, token ? { token } : {}];
  writeAll(userId, all);
}

/**
 * CLAIMS every marker of `groupId` - removed in the same synchronous call that reads them, so two
 * acquires racing in one page never both send a release. The claimant puts back each one whose
 * release goes unanswered ({@link markAddLock}).
 */
export function claimAddLockMarkers(userId: string, groupId: string): AddLockMarker[] {
  const all = readAll(userId);
  const markers = all[groupId];
  if (!markers) return [];
  delete all[groupId];
  writeAll(userId, all);
  return markers;
}

/** The release of the acquisition `token` names was answered: its marker leaves - and only its own. */
export function clearAddLockMarker(
  userId: string,
  groupId: string,
  token: string | undefined
): void {
  const all = readAll(userId);
  const markers = all[groupId];
  if (!markers?.some((m) => m.token === token)) return;
  const rest = markers.filter((m) => m.token !== token);
  if (rest.length > 0) all[groupId] = rest;
  else delete all[groupId];
  writeAll(userId, all);
}
