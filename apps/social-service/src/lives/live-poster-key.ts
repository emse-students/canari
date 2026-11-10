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
import { Logger } from '@nestjs/common';
import { LIVE_KEY_HEX_RE } from './live.constants';
import { LiveKeyUnavailableError, openLiveKey, type StoredLiveKey } from './live-key-at-rest';

const logger = new Logger('LivePosterKey');

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

/**
 * A live whose stored key would not open for a LIST (the open lives' cards, and the feed rows of a
 * live replay - docs/wiki/live-replays.md), with how many list reads met it since. A list reads its
 * lives on every reader's refresh, so an unreadable key would otherwise log one ERROR per live per
 * reader per refresh: it is logged once when it starts and once when it ends (the next read that
 * opens it, or the live's purge) - an outage, not a clock.
 *
 * IN MEMORY AND PER REPLICA, not durable: each social-service replica keeps its own map, so an
 * outage is reported once PER REPLICA that met it, a restart forgets it (the next read on that
 * replica reports it again), and an entry is closed at purge only on the replica that runs the
 * purge - on another replica it stays until that replica restarts, one number per live.
 */
const posterKeyOutages = new Map<string, number>();

/**
 * The poster key of one listed live, or null when its stored key does not open - reported ONCE per
 * outage (above), so the card shows no picture rather than the list failing.
 */
export function posterKeyOf(liveId: string, stored: StoredLiveKey): string | null {
  let liveKey: string;
  try {
    liveKey = openLiveKey(liveId, stored, false);
  } catch (e) {
    if (!(e instanceof LiveKeyUnavailableError)) throw e;
    const seen = posterKeyOutages.get(liveId);
    if (seen === undefined) {
      logger.error(
        `[LIVE_KEY] ${liveId}: the key does not open (${e.reason}) - its card shows no picture until it does`
      );
    }
    posterKeyOutages.set(liveId, (seen ?? 0) + 1);
    return null;
  }
  const failed = posterKeyOutages.get(liveId);
  if (failed !== undefined) {
    posterKeyOutages.delete(liveId);
    logger.log(`[LIVE_KEY] ${liveId}: the key opens again after ${failed} list read(s)`);
  }
  return derivePosterKey(liveKey, liveId);
}

/** At the live's purge: an outage still open is closed, and said. */
export function closePosterKeyOutage(liveId: string): void {
  const failed = posterKeyOutages.get(liveId);
  if (failed === undefined) return;
  posterKeyOutages.delete(liveId);
  logger.warn(
    `[LIVE_KEY] ${liveId}: purged with its key still unreadable (${failed} list read(s))`
  );
}
