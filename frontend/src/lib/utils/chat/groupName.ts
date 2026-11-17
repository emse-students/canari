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
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';

/** A name and the server time (Unix ms) of the MLS statement that set it. */
export type DatedGroupName = { name: string; at: number };

/**
 * Why a name statement read off the wire is not taken - one value per cause, so the line that
 * reports it names the real one (a name that is empty after trimming is not "no server time").
 */
export type GroupNameRefusal =
  | 'not-a-name'
  | 'empty-name'
  | 'no-server-time'
  | 'no-signed-time'
  | 'server-time-out-of-bound'
  | 'after-the-push';

/** The words a log line uses for each {@link GroupNameRefusal}. Dev-facing, never shown. */
export const GROUP_NAME_REFUSAL_TEXT: Record<GroupNameRefusal, string> = {
  'not-a-name': 'it carries no name',
  'empty-name': 'its name is empty once trimmed',
  'no-server-time': 'its delivery carries no server time to date it, and this clock is not one',
  'no-signed-time': 'the frame carries no signed sentAt to bound the server time by',
  'server-time-out-of-bound': `its server time lies more than ${BUNDLE_SERVER_TIME_SKEW_MS / 3_600_000} h from the frame's signed sentAt`,
  'after-the-push': "its date lies after the push's own server time",
};

/** A statement read off the wire: taken, or refused for one named cause. */
export type GroupNameRead = { kept: DatedGroupName } | { refused: GroupNameRefusal };

/** Why a dated name was not written onto a row: neither is a failure, both are worth a line. */
export type GroupNameSkip = 'not-a-group' | 'not-newer' | 'already-dated';

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
 * Reads a name and the server time that dates it. Refused, by cause: a value that is not a string,
 * a name empty once trimmed, a time that is not a positive finite number.
 */
export function readDatedGroupName(name: unknown, at: unknown): GroupNameRead {
  if (typeof name !== 'string') return { refused: 'not-a-name' };
  const trimmed = name.trim();
  if (!trimmed) return { refused: 'empty-name' };
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    return { refused: 'no-server-time' };
  }
  return { kept: { name: trimmed, at } };
}

/**
 * Reads a `groupRenamed` frame: its `newName`, dated by the server's acceptance of the frame, that
 * time BOUNDED by the frame's own `sentAt` - which the author minted inside the MLS-authenticated
 * frame, so the server can neither read nor change it.
 *
 * WHY THE BOUND. The server cannot read or forge a name, but it stamps the time that orders them: a
 * hostile one stamping a frame in 2100 would lock that name in for ever, since nothing can be later.
 * A server time more than {@link BUNDLE_SERVER_TIME_SKEW_MS} from the signed `sentAt`, either way,
 * is not believed. What it can still do - order two renames sent within that window - is written on
 * docs/wiki/protocols/sealed-names.md.
 */
export function readRenameFrame(
  newName: unknown,
  serverAt: number | undefined,
  signedSentAt: number | undefined
): GroupNameRead {
  const read = readDatedGroupName(newName, serverAt);
  if ('refused' in read) return read;
  if (typeof signedSentAt !== 'number' || !Number.isFinite(signedSentAt) || signedSentAt <= 0) {
    return { refused: 'no-signed-time' };
  }
  if (Math.abs(read.kept.at - signedSentAt) > BUNDLE_SERVER_TIME_SKEW_MS) {
    return { refused: 'server-time-out-of-bound' };
  }
  return read;
}

/**
 * The row `convo` becomes once `next` is applied, or the reason it is left alone: `not-a-group` for a
 * DM or a channel (a DM's `name` is its peer's display name and a channel's is the server's, so a
 * `groupRenamed` frame inside either is refused whatever sent it), `not-newer` when the row already
 * holds a later statement - the ordinary outcome of a replay the device has already followed.
 */
export function withDatedGroupName(
  convo: Conversation,
  next: DatedGroupName
): { row: Conversation } | { skipped: GroupNameSkip } {
  if ((convo.conversationType ?? 'group') !== 'group') return { skipped: 'not-a-group' };
  if (!groupNameSupersedes(next, convo)) return { skipped: 'not-newer' };
  return { row: { ...convo, name: next.name, nameAt: next.at } };
}

/**
 * The same, for the name a JOIN PUSH restates - which is taken only onto a row no frame has dated
 * yet (`already-dated` otherwise). The inviter relays a date, it does not prove one: letting the
 * relay beat a frame this device read itself would let any inviter rename the group for the
 * newcomer, dated just under the push.
 */
export function withRestatedGroupName(
  convo: Conversation,
  next: DatedGroupName
): { row: Conversation } | { skipped: GroupNameSkip } {
  if (convo.nameAt !== undefined) return { skipped: 'already-dated' };
  return withDatedGroupName(convo, next);
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
  const read = readDatedGroupName(row.name, row.nameAt);
  return 'kept' in read ? read.kept : undefined;
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
): GroupNameRead {
  if (!raw || typeof raw !== 'object') return { refused: 'not-a-name' };
  const r = raw as { name?: unknown; at?: unknown };
  const read = readDatedGroupName(r.name, r.at);
  if ('refused' in read) return read;
  if (typeof bundleServerAt !== 'number' || !Number.isFinite(bundleServerAt)) {
    return { refused: 'no-server-time' };
  }
  if (read.kept.at > bundleServerAt) return { refused: 'after-the-push' };
  return read;
}

/** The words a log line uses for each {@link GroupNameSkip}. Dev-facing, never shown. */
export const GROUP_NAME_SKIP_TEXT: Record<GroupNameSkip, string> = {
  'not-a-group': 'the conversation is not a group, so its name is not the members to state',
  'not-newer': 'it is not newer than the name held',
  'already-dated': 'a frame this device read already dated the name, and a relay does not beat it',
};

/**
 * What one `groupRenamed` frame does to `convo` - the ONE rule the live handler and the archive
 * replay both apply, so the two cannot drift: read and bound ({@link readRenameFrame}), then written
 * only when newer ({@link withDatedGroupName}). The caller logs the refusal or the skip it is handed.
 */
export function applyRenameFrame(
  convo: Conversation,
  newName: unknown,
  serverAt: number | undefined,
  signedSentAt: number | undefined
): { row: Conversation } | { refused: GroupNameRefusal } | { skipped: GroupNameSkip } {
  const read = readRenameFrame(newName, serverAt, signedSentAt);
  if ('refused' in read) return read;
  return withDatedGroupName(convo, read.kept);
}

/**
 * What the ACTING device's own rename does to its row, re-read after the send: dated by the server
 * time its send was answered with, and written only when newer - a peer's later rename applied while
 * the send was in flight stays (`not-newer`). With no server time in the answer the row is written
 * UNDATED, honestly: keeping the previous `nameAt` beside the new name would claim a date for it
 * that belongs to another statement, and the server's list still corrects an undated name.
 */
export function ownRenameOutcome(
  current: Conversation,
  name: string,
  receivedAt: number | null
): { row: Conversation } | { skipped: GroupNameSkip } {
  if (receivedAt !== null) return withDatedGroupName(current, { name, at: receivedAt });
  if ((current.conversationType ?? 'group') !== 'group') return { skipped: 'not-a-group' };
  const { nameAt: _undated, ...rest } = current;
  return { row: { ...rest, name } };
}
