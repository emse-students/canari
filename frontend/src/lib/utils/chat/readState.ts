import type { ChatMessage, ReadWatermarks } from '$lib/types';
import { messageTime } from './messageOrder';

/**
 * Read state as a watermark: one monotone instant per participant, meaning *this user has read
 * every message up to and including this point*. Merged as `max`, which makes it a CRDT - order of
 * arrival cannot change the result, and seeing the same value twice changes nothing.
 *
 * It replaces the per-message `readBy` array, and the reasons are structural rather than
 * cosmetic:
 *
 * - **it does not depend on which messages a device holds.** A `readBy` entry can only exist on a
 *   device that has the message, so a history catch-up delivering an older message marked it
 *   unread - the receipt for it had been sent long ago and was nowhere to be found. A watermark
 *   already covers messages the device has not seen yet;
 * - **it is one value per participant instead of one array per message**, so recording that a
 *   thousand messages were read is one write, not a thousand;
 * - **it survives a reinstall through the shared log**, because the whole read state of a
 *   conversation is a handful of numbers small enough to travel with every reconciliation.
 *
 * The instant compared against is the message's own client timestamp - `messageTime`, the PRIMARY
 * key display order uses. Not `serverTimestamp`, which is only a tie-break: a watermark ordered
 * differently from the list it describes would leave a message marked read while the one visibly
 * above it stayed unread.
 */

/** The instant a watermark is compared against. Kept in one place so it cannot drift from the sort. */
export function readOrderKey(msg: Pick<ChatMessage, 'timestamp'>): number {
  return messageTime(msg as ChatMessage);
}

/** This user's watermark, or 0 - which reads as "has read nothing", the correct default. */
export function watermarkFor(watermarks: ReadWatermarks | undefined, userNorm: string): number {
  return watermarks?.[userNorm.toLowerCase()] ?? 0;
}

/**
 * Advances one participant's watermark.
 *
 * @returns The new map, or `null` when `at` is not ahead of what is already held - the caller
 *          skips its write and its re-render on that answer, which is what keeps a receipt
 *          arriving twice from costing anything.
 */
export function mergeReadWatermark(
  watermarks: ReadWatermarks | undefined,
  userId: string,
  at: number
): ReadWatermarks | null {
  if (!userId || !Number.isFinite(at) || at <= 0) return null;
  const userNorm = userId.toLowerCase();
  const current = watermarks?.[userNorm] ?? 0;
  if (at <= current) return null;
  return { ...watermarks, [userNorm]: at };
}

/** Merges a whole map - a bundle's read state - participant by participant, `max` each. */
export function mergeReadWatermarks(
  watermarks: ReadWatermarks | undefined,
  incoming: ReadWatermarks | undefined
): ReadWatermarks | null {
  if (!incoming) return null;
  let next = watermarks;
  let changed = false;
  for (const [userId, at] of Object.entries(incoming)) {
    const merged = mergeReadWatermark(next, userId, at);
    if (merged) {
      next = merged;
      changed = true;
    }
  }
  return changed ? (next ?? null) : null;
}

/**
 * Reads a watermark map out of untrusted input - a peer's bundle, a replayed frame, a stored
 * column - keeping only the entries that are a user id and a usable instant.
 *
 * One place, because the same map arrives from three sources and a merge of `max` has no way to
 * take a bad value back: a single `Infinity` would mark every message of the conversation read for
 * that participant, for ever.
 *
 * @param raw A JSON string, an already-parsed object, or anything at all.
 */
export function parseReadWatermarks(raw: unknown): ReadWatermarks | undefined {
  let source = raw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const clean: ReadWatermarks = {};
  for (const [userId, at] of Object.entries(source as Record<string, unknown>)) {
    if (!userId || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    const userNorm = userId.toLowerCase();
    clean[userNorm] = Math.max(clean[userNorm] ?? 0, Math.floor(at));
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** Whether `userNorm` has read `msg`. */
export function hasRead(
  watermarks: ReadWatermarks | undefined,
  userNorm: string,
  msg: Pick<ChatMessage, 'timestamp'>
): boolean {
  return watermarkFor(watermarks, userNorm) >= readOrderKey(msg);
}

/**
 * Everyone who has read `msg`, the author excluded - reading one's own message means nothing, and
 * the sender is the one asking who else has.
 *
 * Derived, never stored: the alternative is a second copy of the same fact on every message, and a
 * second copy is a thing that can disagree.
 */
export function readersOf(
  msg: Pick<ChatMessage, 'timestamp' | 'senderId'>,
  watermarks: ReadWatermarks | undefined
): string[] {
  if (!watermarks) return [];
  const key = readOrderKey(msg);
  const authorNorm = msg.senderId.toLowerCase();
  return Object.entries(watermarks)
    .filter(([userNorm, at]) => userNorm !== authorNorm && at >= key)
    .map(([userNorm]) => userNorm)
    .sort();
}

/**
 * Whether `msg` should still raise the unread badge for the user whose watermark is `watermark`.
 *
 * Own and system messages never count. Both recompute sites used to infer "unseen" from "arrived
 * just now", which is only a proxy and broke on a history bundle: those messages are new to THIS
 * device yet were already read on another one.
 */
export function isUnreadForUser(
  msg: Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp'>,
  watermark: number
): boolean {
  if (msg.isOwn || msg.isSystem || msg.senderId === 'system') return false;
  return readOrderKey(msg) > watermark;
}

/** Counts the messages of `msgs` that still read as unread at `watermark`. */
export function countUnreadForUser(
  msgs: Array<Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp'>>,
  watermark: number
): number {
  return msgs.reduce((total, msg) => total + (isUnreadForUser(msg, watermark) ? 1 : 0), 0);
}

/**
 * The watermark that marking `msgs` read would produce: the latest instant among the messages this
 * user could have read, never below what they already hold.
 *
 * Taken from the messages themselves rather than from the clock, so the value compares correctly
 * against the population it will be compared against - a device whose clock runs fast would
 * otherwise mark unread messages read, permanently and unfixably, the merge being `max`.
 */
export function watermarkAfterReading(
  msgs: Array<Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp'>>,
  current: number
): number {
  let highest = current;
  for (const msg of msgs) {
    if (msg.isSystem || msg.senderId === 'system') continue;
    const key = readOrderKey(msg);
    if (key > highest) highest = key;
  }
  return highest;
}
