/**
 * THE PREVIEW IMAGE'S OWN KEY (review of #3135): `GET /api/lives` serves, without a seat, the key
 * that opens a live's preview still - and it must never be a key that opens the segments or the
 * chat. So the preview is sealed under a key DERIVED from the live key, one way:
 *
 *   posterKey = HKDF-SHA256(ikm = liveKey (32 bytes), salt = liveId (16 raw uuid bytes),
 *                           info = "canari-live-poster-v1", 32 bytes)
 *
 * Knowing `posterKey` gives nothing about `liveKey` (HKDF is one-way), so the seated
 * `GET /api/lives/:id` stays the ONLY place the live key leaves the server. The broadcaster derives
 * the same key with WebCrypto (`frontend/src/lib/live/livePosterCrypto.ts`); the two are pinned to
 * one test vector on both sides.
 *
 * NEVER LOGS either key.
 */
import { hkdfSync } from 'node:crypto';
import { LIVE_KEY_HEX_RE } from './live.constants';

/** The HKDF `info` label of the preview key, version 1. */
export const LIVE_POSTER_KEY_INFO = 'canari-live-poster-v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The preview key of a live, as 64 lower-case hex, from its 64-hex live key. */
export function derivePosterKey(liveKeyHex: string, liveId: string): string {
  if (!LIVE_KEY_HEX_RE.test(liveKeyHex)) throw new RangeError('live key must be 64 hex characters');
  if (!UUID_RE.test(liveId)) throw new RangeError('live id must be a uuid');
  const salt = Buffer.from(liveId.replace(/-/g, ''), 'hex');
  const derived = hkdfSync(
    'sha256',
    Buffer.from(liveKeyHex, 'hex'),
    salt,
    Buffer.from(LIVE_POSTER_KEY_INFO, 'utf8'),
    32
  );
  return Buffer.from(derived).toString('hex');
}
