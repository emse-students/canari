/**
 * A group conversation's name as its MEMBERS stated it over MLS, dated by the server's acceptance of
 * the statement - the first step of taking group names off the server
 * (docs/wiki/protocols/sealed-names.md).
 *
 * WHY A DATE. A name used to reach a device by two routes that could not be ordered against each
 * other: the `groupRenamed` frame (live, or replayed from the archive) and the server's group list,
 * which `repairGroupLabel` treated as the authority. Every frame was applied as it arrived, so a
 * device that met an OLD rename after a newer one - a replay page read after the live frame, a bundle
 * after both - put the old name back, and the server list then put the new one back on the next
 * sweep. With the server's copy going away, the frames must settle it on their own, which needs an
 * order: the server's acceptance time of the frame that stated the name, the same instant every
 * member's copy of that frame carries.
 *
 * `Conversation.nameAt` holds that date beside `name`, on the row itself, so the name and the fact
 * that dates it are written by one save and can never disagree. Absent means the row's name was never
 * stated by an MLS frame this device read: it came from the server's list or from the creation, and
 * the server's list still corrects it.
 */

import type { Conversation } from '$lib/types';

/** A name and the server time (Unix ms) of the MLS statement that set it. */
export type DatedGroupName = { name: string; at: number };

/** The part of a conversation row a name statement is compared with. */
type HeldGroupName = Pick<Conversation, 'name' | 'nameAt'>;

/**
 * Does `next` supersede the name `held` carries?
 *
 * Any dated statement beats an undated name. Between two dated ones the later server time wins, and a
 * TIE is settled by the larger name, so two devices holding the same pair reach the same answer
 * whatever the order they read it in - "keep what I had" depends on arrival order and is no rule.
 */
export function groupNameSupersedes(next: DatedGroupName, held: HeldGroupName): boolean {
  if (held.nameAt === undefined) return true;
  if (next.at !== held.nameAt) return next.at > held.nameAt;
  return next.name > held.name;
}

/**
 * Reads a dated name off the wire - a `groupRenamed` frame's `newName` with its server time, or the
 * `groupName` a join push restates. `null` for anything that is not one: an empty or non-string
 * name, or a time that is not a positive finite number.
 */
export function parseDatedGroupName(name: unknown, at: unknown): DatedGroupName | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { name: trimmed, at };
}

/**
 * The row `convo` becomes once `next` is applied, or `null` when it does not supersede what the row
 * holds - the ordinary outcome of a replay the device has already followed, never a failure.
 *
 * Only a GROUP row takes one: a DM's `name` is its peer's display name and a channel's is the
 * server's, so a `groupRenamed` frame inside either is refused here, whatever sent it.
 */
export function withDatedGroupName(convo: Conversation, next: DatedGroupName): Conversation | null {
  if ((convo.conversationType ?? 'group') !== 'group') return null;
  if (!groupNameSupersedes(next, convo)) return null;
  return { ...convo, name: next.name, nameAt: next.at };
}

/**
 * What a join push restates about the group's name: the dated name the inviter holds, or nothing
 * when its name was never stated by a frame it read (the newcomer reads the server's list for that
 * one, exactly as the inviter did).
 */
export function restatedGroupName(row: {
  name: string;
  nameAt?: number;
}): DatedGroupName | undefined {
  return parseDatedGroupName(row.name, row.nameAt) ?? undefined;
}

/**
 * Takes the `groupName` a join push restates, BOUNDED by the push's own server time: the inviter
 * states a date the server gave a frame it read, so a date later than the server's acceptance of
 * the very bundle carrying it was not given by the server, and is refused. With no server time on
 * the delivery there is nothing to bound it by, and it is refused too.
 */
export function boundedRestatedGroupName(
  raw: unknown,
  bundleServerAt: number | undefined
): { kept: DatedGroupName } | { refused: string } {
  if (!raw || typeof raw !== 'object') return { refused: 'not a dated name' };
  const r = raw as { name?: unknown; at?: unknown };
  const parsed = parseDatedGroupName(r.name, r.at);
  if (!parsed) return { refused: 'not a dated name' };
  if (typeof bundleServerAt !== 'number' || !Number.isFinite(bundleServerAt)) {
    return { refused: 'the push carries no server time to bound its date by' };
  }
  if (parsed.at > bundleServerAt) {
    return { refused: `its date lies after the push's own server time (${bundleServerAt})` };
  }
  return { kept: parsed };
}
