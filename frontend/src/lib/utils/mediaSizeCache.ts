/**
 * The size this device MEASURED for a medium whose message never declared one - and only that.
 *
 * A message sent before the sender wrote `width` / `height` (every chat video and GIF file before
 * 2026-10-02, every GIF link) gives `MediaFrame` nothing to reserve, so its frame opens at a
 * fallback ratio and takes the real one the first time the bytes are drawn: ONE shift. Filing that
 * measurement here is what makes it the only one - the next render of the row, in this session or
 * after a restart, opens at the measured size. A message that declared its size never reaches this
 * module; the declaration wins (`resolveMediaSize`).
 *
 * PERSISTED IN `localStorage`, KEYED BY A HASH. The key of a GIF link is its URL, which is message
 * content; storing it readable would put what a conversation said outside the encrypted store. A
 * 53-bit hash answers "have I measured this one" without saying which one it was. The value is two
 * integers. Bounded at {@link MAX_ENTRIES}, oldest first out: a forgotten entry costs one shift.
 * [media-frame](../../../../docs/wiki/frontend/media-frame.md#5-old-messages-honestly)
 */
import { Log } from '$lib/utils/Log';
import { validMediaSize, type MediaSize } from '$lib/utils/mediaFrame';

const STORAGE_KEY = 'canari_media_sizes_v1';
/** About 30 KB at most; far more old media than a device scrolls past between two app updates. */
export const MAX_ENTRIES = 2000;

/** In insertion order, which is the eviction order. Loaded once, lazily. */
let entries: Map<string, [number, number]> | null = null;

/** cyrb53: a fast, well-mixed 53-bit string hash. Not a secret - an unreadable name. */
export function hashMediaKey(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function load(): Map<string, [number, number]> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return entries;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      Log.d('mediaSizeCache', `stored value is not a list - starting empty`);
      return entries;
    }
    for (const row of parsed) {
      if (
        Array.isArray(row) &&
        typeof row[0] === 'string' &&
        validMediaSize(row[1], row[2]) !== null
      ) {
        entries.set(row[0], [row[1], row[2]]);
      }
    }
  } catch (e) {
    // A private window, a blocked storage or a corrupt value: every old medium shifts once more.
    Log.d('mediaSizeCache', `could not read the stored sizes - starting empty: ${String(e)}`);
  }
  return entries;
}

function save(map: Map<string, [number, number]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map].map(([k, [w, h]]) => [k, w, h])));
  } catch (e) {
    Log.d('mediaSizeCache', `could not store the sizes - kept for this session only: ${String(e)}`);
  }
}

/** The size measured earlier for this key, or `null` if this device never drew it. */
export function measuredMediaSize(key: string | undefined): MediaSize | null {
  if (!key) return null;
  const hit = load().get(hashMediaKey(key));
  return hit ? { width: hit[0], height: hit[1] } : null;
}

/**
 * Files the natural size of a medium that has just been drawn. A size already filed, or an
 * unusable one, writes nothing.
 */
export function recordMeasuredMediaSize(key: string, width: number, height: number): void {
  const size = validMediaSize(width, height);
  if (!size) {
    Log.d('mediaSizeCache', `refused an unusable measurement ${width}x${height}`);
    return;
  }
  const map = load();
  const id = hashMediaKey(key);
  const known = map.get(id);
  if (known && known[0] === size.width && known[1] === size.height) return;
  map.delete(id);
  map.set(id, [size.width, size.height]);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  Log.d('mediaSizeCache', `measured an undeclared medium at ${size.width}x${size.height}`);
  save(map);
}

/** Tests only: forget the in-memory copy so the next read goes back to storage. */
export function resetMediaSizeCacheForTests(): void {
  entries = null;
}
