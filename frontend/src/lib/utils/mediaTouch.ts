/**
 * Reports a media cache HIT to the server, so the 30-day retention clock measures use.
 *
 * WHY THIS EXISTS
 * ---------------
 * The server deletes an encrypted media object 30 days after `lastAccessAt`, which it refreshes
 * on every download. That reads as "30 days since anyone last looked at it" and it was not: this
 * client caches the ciphertext locally and indefinitely (`canari-media-ciphertext-v1`), so once a
 * device holds an object it never asks the server for it again. A photograph opened daily by
 * everyone in a conversation therefore left exactly the same server-side trace as one nobody ever
 * opened twice - the initial download - and both were deleted on the same day.
 *
 * So the cache hit is the missing signal, and reporting it is what makes the clock honest.
 *
 * WHAT KEEPS IT CHEAP, AND WHY IT IS NOT A TIMER PROBLEM
 * ------------------------------------------------------
 * A naive report per hit is one request per rendered image per view - cost proportional to
 * SCROLLING, which is the wrong axis entirely. Two rules bound it instead, and both are about
 * information rather than pacing:
 *
 *  1. The server clock has 30-day granularity, so a second report for the same object on the same
 *     day carries no information. One report per object per CALENDAR DAY, remembered durably, so a
 *     reload does not re-report either.
 *  2. Reports are merged into one request. The debounce below schedules no traffic of its own - it
 *     only groups traffic already committed to - and it has no retry ladder: a failed flush simply
 *     leaves the ids unmarked, so the next view of that media reports it again.
 *
 * The day marker is written only AFTER the server has acknowledged. Marking on enqueue would make
 * a single failed request cost the object a whole day of clock, and the failure mode of this
 * feature must always be "the media expires as it would have before", never "the media expires
 * sooner".
 */
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';

/** Where the per-day dedup marker lives. Not sensitive: opaque ids and a date. */
const STORAGE_KEY = 'canari-media-touched';
/** Merge window. Only ever groups reports; never schedules one on its own. */
const FLUSH_DELAY_MS = 2_000;
/** Flush immediately at this size rather than waiting out the window. */
const MAX_BATCH = 200;

interface TouchedToday {
  day: string;
  ids: string[];
}

/** Local calendar day, which is the granularity the dedup needs - not an instant. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The set of ids already reported today, self-pruning: a new day replaces the record rather than
 * appending to it, so this can never grow past "media viewed today on this device".
 */
function readTouched(): TouchedToday {
  const empty = { day: today(), ids: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<TouchedToday>;
    if (parsed.day !== empty.day || !Array.isArray(parsed.ids)) return empty;
    return { day: empty.day, ids: parsed.ids.filter((id): id is string => typeof id === 'string') };
  } catch {
    // A corrupt or unavailable store must not break rendering: the worst outcome of returning
    // "nothing reported yet" is one redundant request.
    return empty;
  }
}

function writeTouched(record: TouchedToday): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked (private mode). The report still happened; only the dedup is lost,
    // which costs one extra request per view and nothing else.
  }
}

/** Ids waiting to be reported, and the base URL they belong to. */
const pending = new Map<string, string>();
/** Ids reported (or being reported) in this page's lifetime, so a re-render cannot re-enqueue. */
const seenThisSession = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;

  // One request per base URL: the ids are only meaningful to the service that stores them.
  const byBase = new Map<string, string[]>();
  for (const [mediaId, baseUrl] of pending) {
    const list = byBase.get(baseUrl) ?? [];
    list.push(mediaId);
    byBase.set(baseUrl, list);
  }
  pending.clear();

  const { getToken } = await import('$lib/stores/auth');

  for (const [baseUrl, mediaIds] of byBase) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/media/touch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify({ mediaIds }),
      });
      if (!res.ok) {
        // Not marked as reported, so the next view tries again. Logged because a persistent
        // failure here is invisible otherwise - it does not break anything the user can see, it
        // only quietly restores the old, wrong retention behaviour.
        appendLog(`[MEDIA_TOUCH] ${mediaIds.length} id(s) rejected: ${res.status}`);
        for (const id of mediaIds) seenThisSession.delete(id);
        continue;
      }
      const record = readTouched();
      writeTouched({ day: record.day, ids: [...new Set([...record.ids, ...mediaIds])] });
      appendLog(`[MEDIA_TOUCH] ${mediaIds.length} cached media reported as used`);
    } catch (e) {
      appendLog(`[MEDIA_TOUCH] report failed: ${e instanceof Error ? e.message : String(e)}`);
      for (const id of mediaIds) seenThisSession.delete(id);
    }
  }
}

/**
 * Notes that `mediaId` was served from the local ciphertext cache, so the server's retention clock
 * can be told the object is still in use. Cheap and idempotent: at most one network report per
 * object per calendar day, batched.
 *
 * Deliberately fire-and-forget - nothing rendering an image should ever wait on it.
 */
export function noteMediaCacheHit(mediaId: string, baseUrl: string): void {
  if (typeof localStorage === 'undefined') return;
  if (seenThisSession.has(mediaId)) return;
  if (readTouched().ids.includes(mediaId)) {
    seenThisSession.add(mediaId);
    return;
  }

  seenThisSession.add(mediaId);
  pending.set(mediaId, baseUrl);

  if (pending.size >= MAX_BATCH) {
    void flush();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }
}

/** Test seam: drops every in-memory marker so each case starts from a known state. */
export function resetMediaTouchStateForTests(): void {
  pending.clear();
  seenThisSession.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
