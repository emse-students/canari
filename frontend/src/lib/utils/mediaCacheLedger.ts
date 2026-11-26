/**
 * THE LEDGER OF THE MEDIA CACHE: what each cached ciphertext weighs, when it was last used and when
 * the server last confirmed holding it - the facts `mediaCacheCap.ts` needs to keep the cache under
 * its cap without ever evicting a sole copy.
 *
 * WHERE IT LIVES. In a second Cache Storage bucket, {@link LEDGER_CACHE_NAME}: one body-less
 * response per cached object, under the SAME key as the ciphertext, the three facts in its headers.
 * Cache Storage keeps no per-entry time, size or recency, so something has to; a bucket beside the
 * ciphertext needs no database to open, enumerate in a wipe or migrate, and it is cleared by the
 * same gesture (`clearMediaCache`). It is device-wide, like the cache it describes.
 *
 * ONE COPY IN MEMORY, LOADED ONCE. Enforcement runs after every download, and reading a thousand
 * headers each time would be the cost the cap exists to avoid; the map is read from the bucket the
 * first time it is asked and kept. Another tab's later writes are not seen by this one, which is
 * safe in both directions: a confirmation only ever moves forward (a stale record reads as LESS
 * confirmed, so it is kept), and deleting a copy another tab already deleted is a no-op.
 *
 * A COPY WITH NO RECORD IS A SOLE COPY. A ciphertext an older build wrote has no record, and a
 * record can be lost with a crash between the two writes. `reconcileLedger` gives such a copy a
 * record with `confirmedAt` 0, which `planEviction` never evicts, until a cache hit's acknowledged
 * touch confirms it. The cost of the weight (one body read) is paid once per copy, never again.
 *
 * THE RECENCY WRITE IS PER DAY, like the touch report (`mediaTouch.ts`): a hit refreshes the
 * in-memory time at once and the stored one at most once per calendar day, so scrolling through
 * pictures writes to the cache by DAYS, not by renders. After a reload the order is therefore
 * exact to the day, which is all an LRU over weeks needs.
 */
import { appendLog } from './sessionLog';
import { planEviction, readMediaCacheCap, type LedgerRecord } from './mediaCacheCap';

/** The ciphertext bucket; `deviceStorage.ts` measures and clears it, `mediaBlobCache.ts` fills it. */
export const CIPHER_CACHE_NAME = 'canari-media-ciphertext-v1';
/** The ledger bucket beside it. */
export const LEDGER_CACHE_NAME = 'canari-media-ledger-v1';

const H_BYTES = 'x-canari-bytes';
const H_USED = 'x-canari-used';
const H_CONFIRMED = 'x-canari-confirmed';
/** The window the server named, in ms; `none` = no sweep takes the object; absent = none named. */
const H_WINDOW = 'x-canari-window';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The key a ciphertext is cached under; the ledger uses the same one. */
export function cipherCacheKey(baseUrl: string, mediaId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/__cached__/media/${encodeURIComponent(mediaId)}`;
}

/**
 * The form a cache reports a key in: `Cache.keys()` answers absolute URLs, so the ledger's map is
 * keyed by those, and a key given relative to the page is resolved the same way before it is used.
 */
function absoluteKey(key: string): string {
  return new URL(key, globalThis.location?.href ?? 'http://localhost/').href;
}

let loaded: Promise<Map<string, LedgerRecord>> | null = null;
/** What the ledger bucket holds, so a hit's recency is persisted once per day, not per render. */
const persistedUsed = new Map<string, number>();
let enforcing: Promise<void> | null = null;
let enforceAgain = false;

function toResponse(record: LedgerRecord): Response {
  return new Response(null, {
    headers: {
      [H_BYTES]: String(record.bytes),
      [H_USED]: String(record.lastUsed),
      [H_CONFIRMED]: String(record.confirmedAt),
      ...(record.holdWindowMs === undefined
        ? {}
        : { [H_WINDOW]: record.holdWindowMs === null ? 'none' : String(record.holdWindowMs) }),
    },
  });
}

function fromResponse(res: Response): LedgerRecord | null {
  const bytes = Number(res.headers.get(H_BYTES));
  const lastUsed = Number(res.headers.get(H_USED));
  const confirmedAt = Number(res.headers.get(H_CONFIRMED));
  if (![bytes, lastUsed, confirmedAt].every(Number.isFinite)) return null;
  const window = res.headers.get(H_WINDOW);
  if (window === null) return { bytes, lastUsed, confirmedAt };
  if (window === 'none') return { bytes, lastUsed, confirmedAt, holdWindowMs: null };
  const holdWindowMs = Number(window);
  // An unreadable window is the same as none named: the constant holds, the safe direction.
  return Number.isFinite(holdWindowMs)
    ? { bytes, lastUsed, confirmedAt, holdWindowMs }
    : { bytes, lastUsed, confirmedAt };
}

/** Writes one record to the bucket; a failure is said and costs only that record's persistence. */
async function persist(key: string, record: LedgerRecord): Promise<void> {
  try {
    const cache = await caches.open(LEDGER_CACHE_NAME);
    await cache.put(key, toResponse(record));
    persistedUsed.set(key, record.lastUsed);
  } catch (err) {
    appendLog(`[MEDIA_CAP] ledger record not written: ${String(err)}`);
  }
}

/** The in-memory ledger, read from the bucket the first time. */
async function ledger(): Promise<Map<string, LedgerRecord>> {
  loaded ??= (async () => {
    const map = new Map<string, LedgerRecord>();
    try {
      const cache = await caches.open(LEDGER_CACHE_NAME);
      for (const request of await cache.keys()) {
        const res = await cache.match(request);
        const record = res ? fromResponse(res) : null;
        if (record) {
          map.set(request.url, record);
          persistedUsed.set(request.url, record.lastUsed);
        }
      }
    } catch (err) {
      appendLog(`[MEDIA_CAP] ledger not readable: ${String(err)}`);
    }
    return map;
  })();
  return loaded;
}

/**
 * Gives every ciphertext that has no record one with `confirmedAt` 0 (a sole copy until confirmed),
 * weighing it from its Content-Length or, failing that, its body. Drops a record whose ciphertext
 * is gone, so the total never counts bytes the cache no longer holds.
 */
async function reconcileLedger(records: Map<string, LedgerRecord>): Promise<void> {
  const cipher = await caches.open(CIPHER_CACHE_NAME);
  const present = new Set<string>();
  for (const request of await cipher.keys()) {
    present.add(request.url);
    if (records.has(request.url)) continue;
    const res = await cipher.match(request);
    if (!res) continue;
    const declared = Number(res.headers.get('content-length'));
    const bytes = declared > 0 ? declared : (await res.blob()).size;
    const record = { bytes, lastUsed: 0, confirmedAt: 0 };
    records.set(request.url, record);
    await persist(request.url, record);
  }
  const ledgerCache = await caches.open(LEDGER_CACHE_NAME);
  for (const key of records.keys()) {
    if (present.has(key)) continue;
    records.delete(key);
    persistedUsed.delete(key);
    await ledgerCache.delete(key);
  }
}

/** A ciphertext was written by a download: the server just served it, so it is confirmed. */
export async function recordCipherWritten(
  key: string,
  bytes: number,
  now = Date.now()
): Promise<void> {
  const record = { bytes, lastUsed: now, confirmedAt: now };
  (await ledger()).set(absoluteKey(key), record);
  await persist(key, record);
  void enforceMediaCacheCap();
}

/** A cached ciphertext was read: refreshes its recency, in memory at once, stored once a day. */
export async function recordCipherUsed(key: string, now = Date.now()): Promise<void> {
  const id = absoluteKey(key);
  const record = (await ledger()).get(id);
  if (!record) return;
  record.lastUsed = now;
  if (now - (persistedUsed.get(id) ?? 0) >= DAY_MS) await persist(id, record);
}

/**
 * The server acknowledged a touch for these objects (`mediaTouch.ts`): it holds them, so their
 * copies are evictable for the window it named for each (`windows`: ms, or `null` for an object no
 * sweep takes), or for `SERVER_HOLD_WINDOW_MS` when it named none (`windows` `null`: an older
 * server). An object with no record is skipped: it is not in the cache, or is reconciled before the
 * next enforcement.
 *
 * AN ID A SERVER THAT NAMES WINDOWS LEAVES OUT IS ONE IT HOLDS NOTHING FOR (unknown, purged): its copy
 * may be the only one left, so it is NOT confirmed - its confirmation is withdrawn, which makes it a
 * sole copy the cap never evicts (charter principle 2). An older server cannot say so, and every id
 * it acknowledged is confirmed as before.
 */
export async function recordServerConfirmed(
  baseUrl: string,
  mediaIds: readonly string[],
  windows: Readonly<Record<string, number | null>> | null = null,
  now = Date.now()
): Promise<void> {
  if (typeof caches === 'undefined') return;
  const records = await ledger();
  let notHeld = 0;
  for (const mediaId of mediaIds) {
    const key = absoluteKey(cipherCacheKey(baseUrl, mediaId));
    const record = records.get(key);
    if (!record) continue;
    if (windows === null) {
      record.confirmedAt = now;
      delete record.holdWindowMs;
    } else if (Object.hasOwn(windows, mediaId)) {
      record.confirmedAt = now;
      record.holdWindowMs = windows[mediaId];
    } else {
      notHeld++;
      record.confirmedAt = 0;
      delete record.holdWindowMs;
    }
    await persist(key, record);
  }
  if (notHeld > 0) {
    appendLog(
      `[MEDIA_CAP] ${notHeld} cached cop(ies) the server no longer holds - kept as sole copies, never evicted`
    );
  }
}

/** A ciphertext was deleted from the cache for another reason: its record goes with it. */
export async function forgetCipher(key: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  const id = absoluteKey(key);
  (await ledger()).delete(id);
  persistedUsed.delete(id);
  try {
    await (await caches.open(LEDGER_CACHE_NAME)).delete(id);
  } catch (err) {
    appendLog(`[MEDIA_CAP] ledger record not dropped: ${String(err)}`);
  }
}

/**
 * Brings the cache under the member's cap, now. COALESCED: a call while one runs asks for one more
 * pass after it, so a burst of downloads costs two passes at most and none runs beside another.
 * Never throws: an eviction that fails leaves the cache as it was, said once in the log.
 */
export function enforceMediaCacheCap(now = Date.now()): Promise<void> {
  if (typeof caches === 'undefined') return Promise.resolve();
  if (enforcing) {
    enforceAgain = true;
    return enforcing;
  }
  enforcing = (async () => {
    try {
      do {
        enforceAgain = false;
        await enforceOnce(now);
      } while (enforceAgain);
    } catch (err) {
      appendLog(`[MEDIA_CAP] enforcement failed: ${String(err)}`);
    } finally {
      enforcing = null;
    }
  })();
  return enforcing;
}

async function enforceOnce(now: number): Promise<void> {
  const cap = readMediaCacheCap();
  if (cap === null) return;
  const records = await ledger();
  await reconcileLedger(records);
  const plan = planEviction(records, cap, now);
  if (plan.evict.length === 0) {
    if (plan.overCapBytes > 0) {
      appendLog(
        `[MEDIA_CAP] ${plan.overCapBytes} bytes over the cap, ${plan.keptSole} copies kept as possibly sole`
      );
    }
    return;
  }
  const cipher = await caches.open(CIPHER_CACHE_NAME);
  for (const key of plan.evict) {
    await cipher.delete(key);
    await forgetCipher(key);
  }
  appendLog(
    `[MEDIA_CAP] ${plan.evict.length} cached media evicted (LRU), ${plan.keptSole} kept as possibly sole, ${plan.overCapBytes} bytes still over the cap`
  );
}

/** Forgets the in-memory ledger, after a wipe emptied the buckets (and between tests). */
export function dropMediaCacheLedgerMemory(): void {
  loaded = null;
  persistedUsed.clear();
  enforcing = null;
  enforceAgain = false;
}
