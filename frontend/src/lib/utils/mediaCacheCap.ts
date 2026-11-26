/**
 * THE MEDIA CACHE'S CAP: the choices, the member's pick, and the ORDER of eviction.
 *
 * `canari-media-ciphertext-v1` grew without bound. Owner decision of 2026-11-22
 * (docs/wiki/decisions/owner-decisions-of-2026-11-22.md, items 8 and 9): a default of 500 MB, the
 * member choosing 250 MB, 1 GB or unlimited. Eviction is LRU and NEVER takes a sole copy
 * (charter principle 2, docs/principes.md: the essential is never lost; principle 1: your messages
 * are yours). This file is the PURE half - what to evict, given what the ledger holds - so the
 * order and the sole-copy rule are pinned by a test without a Cache API.
 *
 * WHAT A SOLE COPY IS, ON A DEVICE THAT CANNOT ASK. The server deletes an `ephemeral` object once
 * it has been idle for the window the admin set when it was uploaded (90 days by default, 1-3650
 * allowed), and there is NO server re-touch before an eviction (owner). So the device asks only
 * what it already KNOWS: when the server last CONFIRMED holding the object - the download that
 * wrote the copy, or the acknowledged touch a cache hit reports (`mediaTouch.ts`). A copy confirmed
 * within {@link SERVER_HOLD_WINDOW_MS} is one the server still holds for certain, so evicting it
 * costs a re-download and nothing else. Every other copy - confirmed longer ago, or never (a copy
 * an older build wrote, or one whose ledger record was lost) - may be the ONLY one left, and stays,
 * whatever the cap says: a cache above its cap is a smaller harm than a lost photograph. The window
 * is a declared constant, deliberately well under the 90-day default, and an admin who shortens the
 * retention below it makes the guess wrong in the unsafe direction - which is why the server
 * naming the window in its touch answer is the open follow-up (backlog entry
 * "the-touch-answer-names-the-servers-idle-window").
 */

/** The choices the member is offered, in bytes; `null` is "unlimited". */
export const MEDIA_CACHE_CAP_CHOICES: readonly (number | null)[] = [
  250 * 1024 * 1024,
  500 * 1024 * 1024,
  1024 * 1024 * 1024,
  null,
];

/** What a member who never chose gets (owner, 2026-11-22). */
export const DEFAULT_MEDIA_CACHE_CAP_BYTES = 500 * 1024 * 1024;

/**
 * How long a server confirmation keeps a copy EVICTABLE: inside it, the server still holds the
 * object for sure. 30 days, a third of the default idle window (see the module comment).
 */
export const SERVER_HOLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the member's pick lives: per device, not per account, like the cache itself. */
const STORAGE_KEY = 'canari-media-cache-cap';
const UNLIMITED = 'unlimited';

/** What the ledger knows of one cached ciphertext. Times are epoch milliseconds. */
export interface LedgerRecord {
  /** The ciphertext's size. */
  bytes: number;
  /** The last time the copy was read or written on this device (LRU order). */
  lastUsed: number;
  /** The last time the server confirmed holding the object; 0 = never. */
  confirmedAt: number;
}

/** What {@link planEviction} decided. */
export interface EvictionPlan {
  /** The cache keys to delete, least recently used first. */
  evict: string[];
  /** Bytes the ledger counts before the plan. */
  totalBytes: number;
  /** Copies that stay although the cap would have them go: sole, or not confirmed. */
  keptSole: number;
  /** Bytes still over the cap after the plan, because only sole copies are left to evict. */
  overCapBytes: number;
}

/**
 * The member's cap in bytes, `null` for unlimited, the default when nothing valid is stored. A
 * stored value that is not one of the offered choices is ignored (said), never trusted.
 */
export function readMediaCacheCap(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_MEDIA_CACHE_CAP_BYTES;
    if (raw === UNLIMITED) return null;
    const bytes = Number(raw);
    if (MEDIA_CACHE_CAP_CHOICES.includes(bytes)) return bytes;
    console.warn(`[mediaCacheCap] stored cap ${raw} is not an offered choice - default used`);
  } catch (err) {
    // Storage unavailable: the default holds for this page, and nothing is lost by it.
    console.debug('[mediaCacheCap] cap not readable, default used', err);
  }
  return DEFAULT_MEDIA_CACHE_CAP_BYTES;
}

/** Stores the member's pick. A storage that refuses is said and leaves the previous pick in force. */
export function writeMediaCacheCap(cap: number | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, cap === null ? UNLIMITED : String(cap));
    console.debug(`[mediaCacheCap] cap set to ${cap === null ? UNLIMITED : `${cap} bytes`}`);
  } catch (err) {
    console.warn('[mediaCacheCap] the cap could not be stored', err);
  }
}

/**
 * Which copies to delete so the cache fits `capBytes`: least recently used first, among the copies
 * the server confirmed within {@link SERVER_HOLD_WINDOW_MS} of `now`, and nothing else. A cache
 * whose only candidates are exhausted stays over the cap and says so in `overCapBytes`. `capBytes`
 * `null` plans nothing.
 */
export function planEviction(
  records: ReadonlyMap<string, LedgerRecord>,
  capBytes: number | null,
  now: number
): EvictionPlan {
  let totalBytes = 0;
  for (const record of records.values()) totalBytes += record.bytes;
  const plan: EvictionPlan = { evict: [], totalBytes, keptSole: 0, overCapBytes: 0 };
  if (capBytes === null || totalBytes <= capBytes) return plan;

  const candidates: [string, LedgerRecord][] = [];
  for (const entry of records) {
    if (now - entry[1].confirmedAt < SERVER_HOLD_WINDOW_MS && entry[1].confirmedAt > 0) {
      candidates.push(entry);
    } else {
      plan.keptSole += 1;
    }
  }
  candidates.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  let remaining = totalBytes;
  for (const [key, record] of candidates) {
    if (remaining <= capBytes) break;
    plan.evict.push(key);
    remaining -= record.bytes;
  }
  plan.overCapBytes = Math.max(0, remaining - capBytes);
  return plan;
}
