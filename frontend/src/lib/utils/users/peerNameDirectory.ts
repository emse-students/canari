import { SvelteMap } from 'svelte/reactivity';

/**
 * The names this device resolved before, held in MEMORY and read first, so a conversation row is
 * NAMED WITHOUT A PROFILE ROUND TRIP at a cold start (slow-link chantier, 2026-11-11).
 *
 * WHY. `displayName.ts` kept its names in a module Map, empty at every launch, and the only way to
 * fill it was `GET /api/users/...`. On a 250 kbps / +800 ms link (production 1.6.10 read through a
 * throttling proxy) most 1:1 rows read "Utilisateur inconnu" for 12 s and more: no screen may wait
 * for the network to draw. This directory is the LOCAL SOURCE; the network only refreshes it.
 *
 * THIS FILE IS THE LIGHT HALF, AND HOLDS NO DATABASE IMPORT ON PURPOSE (the rule of
 * `posts/feedStoreEpoch.ts`): `stores/user.ts` calls {@link forgetPeerNames} at a sign-out and a
 * change of account, and must not load the storage layer to do it. The sealed copy, its key and its
 * read and write are `peerNameStore.ts`, which fills this directory through {@link openDirectory}
 * and {@link mergeStoredNames} and learns of changes through {@link setChangeListener}.
 *
 * Reactive on purpose: a row drawn before the stored copy was read re-reads when it lands.
 */

/** Newest entries kept; a Map keeps insertion order, so the oldest go first. */
export const MAX_PEER_NAMES = 500;

const names = new SvelteMap<string, string>();
/** The account whose names `names` holds, once opened; null while no key is in hand. */
let openFor: string | null = null;
/**
 * Names resolved BEFORE the key was in hand, for one account: fresher than any stored copy, folded
 * in when the directory opens so a launch whose session comes up after its first lookups still
 * persists them.
 */
const early = new Map<string, string>();
let earlyOwner: string | null = null;
let changeListener: (() => void) | null = null;

/** The remembered name of `userId` (lower-case id) for `owner`, or null - never a placeholder. */
export function readPeerName(owner: string | null | undefined, userId: string): string | null {
  const o = owner?.trim();
  if (!o || openFor !== o) return null;
  return names.get(userId) ?? null;
}

/** Records a resolved name for `owner`. Persisted by the store once a key is in hand. */
export function notePeerName(owner: string | null | undefined, userId: string, name: string): void {
  const o = owner?.trim();
  const trimmed = name.trim();
  if (!o || !trimmed) return;
  if (openFor !== o) {
    if (earlyOwner !== o) {
      early.clear();
      earlyOwner = o;
    }
    early.set(userId, trimmed);
    return;
  }
  if (names.get(userId) === trimmed) return;
  names.delete(userId);
  names.set(userId, trimmed);
  while (names.size > MAX_PEER_NAMES) names.delete(names.keys().next().value as string);
  changeListener?.();
}

/** Opens the directory for `owner` (empty, plus what was resolved before the key came). */
export function openDirectory(owner: string): void {
  const carried = earlyOwner === owner ? new Map(early) : new Map<string, string>();
  forgetPeerNames();
  openFor = owner;
  for (const [id, name] of carried) names.set(id, name);
  if (carried.size > 0) changeListener?.();
}

/** Whether the directory is open for `owner`. */
export function isOpenFor(owner: string): boolean {
  return openFor === owner;
}

/** Folds a stored copy in; what this launch already resolved is fresher and stays. Returns how many were taken. */
export function mergeStoredNames(owner: string, stored: Readonly<Record<string, unknown>>): number {
  if (openFor !== owner) return 0;
  let taken = 0;
  for (const [id, name] of Object.entries(stored)) {
    if (typeof name === 'string' && name.trim() && !names.has(id)) {
      names.set(id, name);
      taken += 1;
    }
  }
  return taken;
}

/** The directory as a plain object, for sealing. */
export function snapshotNames(): Record<string, string> {
  return Object.fromEntries(names);
}

/** One listener, told of every change to an open directory (the store's coalesced write). */
export function setChangeListener(listener: (() => void) | null): void {
  changeListener = listener;
}

/**
 * Forgets the in-memory directory: a sign-out, a change of account, a locked device. The sealed copy
 * is ended by the feed epoch (`forgetStoredFeeds`, called beside this) and by the storage's own
 * exits (`peerNameStore.ts`).
 */
export function forgetPeerNames(): void {
  names.clear();
  early.clear();
  earlyOwner = null;
  openFor = null;
}
