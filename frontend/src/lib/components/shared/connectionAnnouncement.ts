import type { ConnectionState } from '$lib/stores/slowLink.svelte';

/** What the live region says: one sentence per kind, `null` for silence. */
export type Announcement = 'offline' | 'reconnecting' | 'slow' | 'back' | null;

/**
 * One step of the announcer. `outage` remembers that the link went OFFLINE or RECONNECTING since the
 * last "back": ONLY those two make "connection restored" worth saying. A slow link that clears is a
 * silent change (the ring is amber no more) - saying "restored" for every slow flap would be the
 * verbose, useless noise the ring replaced the banner to avoid (review of #3342).
 *
 * Pure so the rule is a test; `ConnectionAnnouncer.svelte` keeps the two values.
 */
export function announcementStep(
  outage: boolean,
  state: ConnectionState | null
): { outage: boolean; say: Announcement } {
  switch (state) {
    case 'offline':
      return { outage: true, say: 'offline' };
    case 'reconnecting':
      return { outage: true, say: 'reconnecting' };
    case 'slow':
      return { outage, say: 'slow' };
    case 'connected':
      return outage ? { outage: false, say: 'back' } : { outage: false, say: null };
    default:
      return { outage: false, say: null };
  }
}
