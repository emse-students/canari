import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * The two boundaries of history reconciliation, and the range they leave between them.
 *
 * They answer different questions and only one of them is shared:
 *
 * - **the conversation floor** - *"the history of this conversation begins here"*. Shared by every
 *   member, monotone, merged as `max` so two devices converge without coordinating. It is what would
 *   make pruning safe, and it may never sit below what some member can still supply, or the system
 *   promises a completeness nobody can honour;
 * - **the device window** - *"what this device intends to retain"*. Local, fixed per platform, never
 *   a user-visible setting: it is a completeness contract between devices rather than a preference,
 *   and a user lowering it would silently reduce what their other devices can be told.
 *
 * A device is complete when it holds everything that exists in
 * `[ max(floor, windowStart), now ]`, so the comparison is always scoped to the ASKING device's
 * window. The phone is never shrunk by the browser; the browser is never force-fed by the phone.
 *
 * **Nothing moves the floor today.** It ships worth zero and only the merge rule is implemented -
 * with the most retentive platform at five years, no member prunes for five years, so there is
 * nothing to move it *to*. It exists from the start because adding a converged field later would
 * cost a second forced update, and no compatibility layer is kept.
 *
 * @see docs/wiki/protocols/history-reconciliation.md#two-boundaries-not-one
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a browser retains: 90 days, about a semester.
 *
 * Long enough that reaching below the window (scrollback) is rare rather than routine, short enough
 * that a browser profile does not accumulate years of a phone's history.
 */
export const WEB_DEVICE_WINDOW_MS = 90 * DAY_MS;

/**
 * What a phone or a desktop retains: 5 years - longer than the longest tenure anyone has here, so
 * no user meets that bound while they are still a member.
 *
 * Bounded rather than literally infinite for two reasons, neither of them rendering cost (history
 * loads in pages behind a cursor, so the window never reaches the renderer): an unbounded window
 * gives the floor nothing to move for, ever, and it makes the state key's domain unbounded too.
 */
export const NATIVE_DEVICE_WINDOW_MS = 5 * 365 * DAY_MS;

/**
 * This device's retention window, decided by the platform alone.
 *
 * `isTauriRuntime()` is the split that matters here: mobile and desktop share the same answer, so
 * the finer-grained OS detection buys nothing.
 */
export function deviceWindowMs(): number {
  return isTauriRuntime() ? NATIVE_DEVICE_WINDOW_MS : WEB_DEVICE_WINDOW_MS;
}

/**
 * The instant this device's window opens, QUANTISED DOWN to a whole day.
 *
 * The quantisation is not cosmetic and not an optimisation - it is what makes the boundary an
 * agreement rather than a reading of two clocks. Unrounded, the window slides continuously: two
 * devices deriving it a second apart draw two different lines, so a comparison of what each holds
 * over "its window" can never come out equal, and any value computed over the window (the state key)
 * is stale the instant after it is computed. Rounded to the day, every device that connects on the
 * same day asks from the same instant, so the comparison has a chance of matching and a cached
 * answer has a chance of being reused.
 *
 * It rounds DOWN, which asks for slightly more than the window strictly allows - up to one extra
 * day. That is the safe direction and the same one every other boundary here takes: over-asking
 * costs bandwidth, under-asking loses messages.
 *
 * Two devices connecting either side of midnight still disagree, and that is not a defect: they
 * exchange a digest that agrees on nothing cheaper, which is what the digest is for.
 */
export function deviceWindowStart(now: number = Date.now()): number {
  return Math.floor((now - deviceWindowMs()) / DAY_MS) * DAY_MS;
}

/**
 * Reads a conversation floor out of untrusted input - a peer's bundle, a replayed frame, a stored
 * column - and returns `undefined` for anything that is not a usable instant.
 *
 * One place, because a `max` merge has no way to take a bad value back: a floor in the future would
 * put the whole conversation below the floor, on every device, permanently. It is therefore clamped
 * to `now` - a member may declare that history begins at some past instant, never that it begins
 * after the messages it is already holding.
 */
export function parseHistoryFloor(raw: unknown, now: number = Date.now()): number | undefined {
  const at = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return Math.min(Math.floor(at), now);
}

/**
 * Advances a conversation floor. The merge is `max`, which is what makes it converge whatever order
 * the exchanges happen in.
 *
 * @returns The new floor, or `null` when `incoming` is not ahead of what is already held - the
 *          caller skips its write on that answer, so a floor restated by every bundle chunk costs
 *          nothing.
 */
export function mergeHistoryFloor(
  current: number | undefined,
  incoming: unknown,
  now: number = Date.now()
): number | null {
  const parsed = parseHistoryFloor(incoming, now);
  if (parsed === undefined) return null;
  if (parsed <= (current ?? 0)) return null;
  return parsed;
}

/**
 * The instant from which this device claims to be complete for a conversation: the later of the
 * shared floor and its own window.
 *
 * This is the value that travels as `since` on everything this device ASKS, and the one an answering
 * device clips its answer to. It is stated explicitly rather than recomputed on the other side
 * because the window slides: two devices computing `now - 90 days` a second apart get two different
 * answers, and a boundary that disagrees by a second is a message neither side believes it owes.
 */
export function historyRangeStart(floor: number | undefined, now: number = Date.now()): number {
  return Math.max(parseHistoryFloor(floor, now) ?? 0, deviceWindowStart(now));
}

/**
 * Reads the window a peer stated on an ask, or `null` when it stated none.
 *
 * **Every ask carries its own `since`**, and every sender types it as required:
 * {@link historyRangeStart} feeds `history_state` and `history_digest`, while `history_pull` and
 * `history_range` take it in their request objects. A frame arriving without one is therefore
 * MALFORMED, not old - the clients that could not state it are locked out by `minClientVersion`,
 * which blocks the MLS unlock outright, so such a peer cannot put a group frame on the wire at all.
 *
 * **Returning `null` rather than 0 is the whole point.** `0` is a legitimate window meaning "from
 * the beginning", so mapping absence onto it made the two indistinguishable: a malformed frame was
 * answered in full, for ever, and nothing ever said so. The caller decides what to do with `null` -
 * every one of them declines the frame and logs it.
 */
export function parseHistorySince(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

/**
 * Whether a message belongs to the range opening at `since`. The boundary is included.
 *
 * A message whose timestamp is unusable is kept: the range exists to bound what is sent, and a
 * value that cannot be compared is not evidence that the message is old.
 */
export function isWithinHistoryRange(timestamp: number, since: number): boolean {
  return Number.isFinite(timestamp) ? timestamp >= since : true;
}
