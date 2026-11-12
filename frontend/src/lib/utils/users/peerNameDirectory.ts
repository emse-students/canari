import { SvelteMap } from 'svelte/reactivity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

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
 * `posts/feedStoreEpoch.ts`): `stores/user.ts` calls {@link endPeerNames} at a sign-out and a change
 * of account, and must not load the storage layer to do it. The sealed copy, its key and its read
 * and write are `peerNameStore.ts`, which fills this directory through {@link openDirectory} and
 * {@link mergeStoredNames} and learns of changes through {@link setChangeListener}.
 *
 * REACTIVE END TO END, INCLUDING WHETHER IT IS OPEN. A row drawn before the layout bound the
 * directory read "not open" from a plain `let`, which tracks nothing, so it never re-read once the
 * stored copy landed (review of #3342). The open account is a reactive cell like the names.
 *
 * ITS OWN EPOCH, NOT THE FEED'S. The sealed copy carries an epoch, ended ONLY by a sign-out or a
 * change of account ({@link endPeerNames}). Riding the feed's epoch ended it for feed reasons (an
 * audience verdict, a 403) and made this module a second writer of that epoch.
 */

/** Newest entries kept; a Map keeps insertion order, so the oldest go first. */
export const MAX_PEER_NAMES = 500;

const names = new SvelteMap<string, string>();
/** The account the directory is open for, reactive: `null` while no key is in hand. */
const openCell = new SvelteMap<'owner', string | null>();
/**
 * Names resolved BEFORE the key was in hand, for one account: fresher than any stored copy, folded
 * in when the directory opens so a launch whose session comes up after its first lookups still
 * persists them.
 */
const early = new Map<string, string>();
let earlyOwner: string | null = null;
let changeListener: (() => void) | null = null;

function openOwner(): string | null {
  return openCell.get('owner') ?? null;
}

/** The remembered name of `userId` (lower-case id) for `owner`, or null - never a placeholder. */
export function readPeerName(owner: string | null | undefined, userId: string): string | null {
  const o = owner?.trim();
  // Reads the reactive cell BEFORE deciding, so a caller drawn while closed re-runs when it opens.
  const open = openOwner();
  if (!o || open !== o) return null;
  return names.get(userId) ?? null;
}

/** Records a resolved name for `owner`. Persisted by the store once a key is in hand. */
export function notePeerName(owner: string | null | undefined, userId: string, name: string): void {
  const o = owner?.trim();
  const trimmed = name.trim();
  if (!o || !trimmed) return;
  if (openOwner() !== o) {
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

/**
 * Forgets one id for `owner`: the server answered that the account is gone, so a stored name must
 * not keep drawing it (the same fact `noteDeletedAccount` mirrors natively). Scheduled for sealing.
 */
export function forgetPeerName(owner: string | null | undefined, userId: string): void {
  const o = owner?.trim();
  if (!o) return;
  if (earlyOwner === o) early.delete(userId);
  if (openOwner() !== o) return;
  if (names.delete(userId)) changeListener?.();
}

/** Opens the directory for `owner` (empty, plus what was resolved before the key came). */
export function openDirectory(owner: string): void {
  const carried = earlyOwner === owner ? new Map(early) : new Map<string, string>();
  forgetPeerNames();
  openCell.set('owner', owner);
  for (const [id, name] of carried) names.set(id, name);
  if (carried.size > 0) changeListener?.();
}

/** Whether the directory is open for `owner`. */
export function isOpenFor(owner: string): boolean {
  return openOwner() === owner;
}

/** Folds a stored copy in; what this launch already resolved is fresher and stays. Returns how many were taken. */
export function mergeStoredNames(owner: string, stored: Readonly<Record<string, unknown>>): number {
  if (openOwner() !== owner) return 0;
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
 * Closes the in-memory directory: a locked device, or the account no longer has a key in hand. The
 * sealed copy and its epoch are left alone - the next unlock reads them again.
 */
export function forgetPeerNames(): void {
  names.clear();
  early.clear();
  earlyOwner = null;
  openCell.set('owner', null);
}

// ---------------------------------------------------------------------------------------------
// The directory's own epoch: the synchronous half of "a sign-out ends the copy".
// ---------------------------------------------------------------------------------------------

/** Every account's epoch key starts so; enumerated by {@link endPeerNames}. */
const EPOCH_PREFIX = ACCOUNT_KEY.peerNamesEpoch('');

/** The account's current epoch, or `null` (never written, or ended by a sign-out or an account change). */
export function currentPeerNamesEpoch(userId: string): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY.peerNamesEpoch(userId));
  } catch (error) {
    console.warn(`[PEER-NAMES] the epoch could not be read: ${String(error)}`);
    return null;
  }
}

/** The account's current epoch, starting one when it has none; `null` when the storage refuses. */
export function ensurePeerNamesEpoch(userId: string): string | null {
  const existing = currentPeerNamesEpoch(userId);
  if (existing) return existing;
  const epoch = crypto.randomUUID();
  try {
    localStorage.setItem(ACCOUNT_KEY.peerNamesEpoch(userId), epoch);
  } catch (error) {
    console.warn(
      `[PEER-NAMES] could not start an epoch - the directory is not stored: ${String(error)}`
    );
    return null;
  }
  return epoch;
}

const endListeners = new Set<() => void>();

/**
 * Registers a holder of in-memory account data (the device copies of the bell and the profiles) to
 * be emptied, synchronously, at the same moment the sealed names end - a sign-out or a change of
 * account. Kept here because this light module is already what `stores/user.ts` calls.
 */
export function onPeerNamesEnded(listener: () => void): void {
  endListeners.add(listener);
}

/**
 * Ends EVERY account's sealed directory and closes the memory copy, synchronously: a sign-out or a
 * change of account (`stores/user.ts`). No copy written before this call is read again; its bytes
 * go at the next read or write of the account's store. The allowlist is this module's own key
 * prefix: nothing else is touched.
 *
 * @param reason one word for the log line.
 */
export function endPeerNames(reason: string): void {
  forgetPeerNames();
  for (const listener of endListeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[PEER-NAMES] an end listener failed (${reason}): ${String(error)}`);
    }
  }
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(EPOCH_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (error) {
    console.warn(`[PEER-NAMES] could not end the epochs (${reason}): ${String(error)}`);
    return;
  }
  if (keys.length > 0) console.log(`[PEER-NAMES] ${keys.length} epoch(s) ended (${reason})`);
}
