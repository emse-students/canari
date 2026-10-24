import type { LiveManifest } from './types';

/**
 * THE VIEWER COUNT A SCREEN MAY SHOW, read from a manifest (docs/wiki/frontend/modules/live.md,
 * "The viewer count"): a whole number of accounts watching, or `null` for "show nothing".
 *
 * `null` comes from the server itself (the broadcaster's count did not answer) or from an answer
 * this client cannot read - absent (a server older than the field, during a deploy) or not a
 * non-negative integer. Never a guess: a wrong number is worse than none. A value that is present
 * but unreadable is a broken contract, so it is logged; an absent one is a version skew and is not.
 */
export function liveViewerCount(manifest: Pick<LiveManifest, 'liveId' | 'viewers'>): number | null {
  const v: unknown = manifest.viewers;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  console.warn(`[LIVE] ${manifest.liveId}: unreadable viewer count ${JSON.stringify(v)}`);
  return null;
}
