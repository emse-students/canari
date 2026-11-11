import { Log } from '$lib/utils/Log';

/**
 * The names this device resolved before, kept across launches so a conversation row is NAMED ON THE
 * FIRST FRAME of a cold start instead of after a profile round trip (slow-link chantier, 2026-11-11).
 *
 * WHY. `displayName.ts` keeps its names in a module Map, empty at every launch, and the only way to
 * fill it was `GET /api/users/...`. On a 250 kbps / +800 ms link (production 1.6.10 read through a
 * throttling proxy) most 1:1 rows read "Utilisateur inconnu" with initials for 12 s and more: no
 * screen may wait for the network to draw. This directory is the LOCAL SOURCE, read first and
 * synchronously; the network only refreshes it.
 *
 * WHAT IT IS NOT. It never decides a name is current: the cache and the profile fetch stay
 * authoritative, and a refreshed name overwrites the stored one. It holds only what a public
 * profile already shows (the formatted name), keyed by user id, for ONE account: the blob carries
 * its owner, and another account reading it gets nothing (and replaces it on its first write).
 * Written when a name CHANGES, coalesced into one write per task (a microtask, never a timer).
 */

const STORAGE_KEY = 'canari.peerNames.v1';
/** Newest entries kept; a Map keeps insertion order, so the oldest go first. */
export const MAX_PEER_NAMES = 500;

interface Blob {
  owner: string;
  names: Record<string, string>;
}

let loadedFor: string | null = null;
let names = new Map<string, string>();
let scheduled = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function ensureLoaded(owner: string): void {
  if (loadedFor === owner) return;
  loadedFor = owner;
  names = new Map();
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return;
    const blob = JSON.parse(raw) as Blob;
    if (blob.owner !== owner) return;
    for (const [id, name] of Object.entries(blob.names ?? {})) {
      if (typeof name === 'string' && name.trim()) names.set(id, name);
    }
  } catch (e) {
    // A swallowed branch logs: an unreadable blob is dropped and rebuilt by the next resolutions.
    Log.d(`peerNameDirectory: unreadable blob dropped (${String(e)})`);
  }
}

/** The stored name of `userId` (lower-case id) for `owner`, or null - never a placeholder. */
export function readPeerName(owner: string | null | undefined, userId: string): string | null {
  const o = owner?.trim().toLowerCase();
  if (!o) return null;
  ensureLoaded(o);
  return names.get(userId) ?? null;
}

/** Records a resolved name for `owner` and schedules the coalesced write. */
export function notePeerName(owner: string | null | undefined, userId: string, name: string): void {
  const o = owner?.trim().toLowerCase();
  const trimmed = name.trim();
  if (!o || !trimmed) return;
  ensureLoaded(o);
  if (names.get(userId) === trimmed) return;
  names.delete(userId);
  names.set(userId, trimmed);
  while (names.size > MAX_PEER_NAMES) names.delete(names.keys().next().value as string);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const store = storage();
    if (!store || !loadedFor) return;
    try {
      const blob: Blob = { owner: loadedFor, names: Object.fromEntries(names) };
      store.setItem(STORAGE_KEY, JSON.stringify(blob));
    } catch (e) {
      Log.d(`peerNameDirectory: write failed (${String(e)})`);
    }
  });
}

/** Forgets everything stored (sign-out, tests). */
export function clearPeerNames(): void {
  names = new Map();
  loadedFor = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch (e) {
    Log.d(`peerNameDirectory: clear failed (${String(e)})`);
  }
}
