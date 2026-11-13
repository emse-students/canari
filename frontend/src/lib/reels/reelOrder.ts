import { settings } from '$lib/stores/settingsStore.svelte';
import { Log } from '$lib/utils/Log';

/**
 * THE ORDER OF THE CANAREELS STREAM ("Nos principes", owner 2026-11-10, principle 3: a chronological
 * view must always exist). `ranked` is Pour toi's freshness-and-popularity score (`ranked=true`, the
 * server's snapshot); `recent` is newest first with no ranking at all - the same server list asked
 * without `ranked`, which the server already serves that way.
 */
export const REEL_ORDERS = ['ranked', 'recent'] as const;

/** One of {@link REEL_ORDERS}. */
export type ReelOrder = (typeof REEL_ORDERS)[number];

/** The order of a reader who never chose: Pour toi, as the stream opened before the choice existed. */
export const DEFAULT_REEL_ORDER: ReelOrder = 'ranked';

/** Narrows an untrusted string (`localStorage`) to an order, or null when it names none. */
export function parseReelOrder(value: string | null | undefined): ReelOrder | null {
  return REEL_ORDERS.includes(value as ReelOrder) ? (value as ReelOrder) : null;
}

/** The order last chosen on this device, or the default - remembered like the feed's tab. */
export function preferredReelOrder(): ReelOrder {
  return parseReelOrder(settings.reelsOrder) ?? DEFAULT_REEL_ORDER;
}

/** Remembers `order` as this device's choice. */
export function rememberReelOrder(order: ReelOrder): void {
  Log.d('REELS', `order chosen: ${order}`);
  settings.setReelsOrder(order);
}
