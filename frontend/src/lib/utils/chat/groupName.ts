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

/**
 * A name and the server time (Unix ms) of the MLS statement that set it. `statement` marks a SILENT
 * `groupNamed` statement (a creation, or the one-time restatement of a group that existed before
 * names were dated) as opposed to a `groupRenamed` frame - see {@link groupNameSupersedes} for why
 * the two are ranked.
 */
export type DatedGroupName = { name: string; at: number; statement?: true };

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
type HeldGroupName = Pick<Conversation, 'name' | 'nameAt' | 'nameFromStatement'>;

/**
 * Does `next` supersede the name `held` carries?
 *
 * Any dated statement beats an undated name. A RENAME BEATS A SILENT STATEMENT whatever their dates
 * (`groupNamed`, step 2 of sealed-names.md): a statement dates a name, it never renames. A device
 * restating the name it holds cannot know a member renamed the group a second before its own frame
 * was accepted - ordered by date alone, that restatement put the old name back over a real rename,
 * for every member and with no notice to say so. Between two statements of the same rank the later
 * server time wins, and a TIE is settled by the larger name, so two devices holding the same pair
 * reach the same answer whatever the order they read it in - "keep what I had" depends on arrival
 * order and is no rule. The rank makes it a total order still, so the answer stays order-independent.
 */
export function groupNameSupersedes(next: DatedGroupName, held: HeldGroupName): boolean {
  if (held.nameAt === undefined) return true;
  const nextIsRename = next.statement !== true;
  const heldIsRename = held.nameFromStatement !== true;
  if (nextIsRename !== heldIsRename) return nextIsRename;
  if (next.at !== held.nameAt) return next.at > held.nameAt;
  return next.name > held.name;
}

/**
 * `convo` named `next`: the name, its date and its rank written together, the rank REMOVED when the
 * statement is a rename - a rename's row claiming a statement's rank would let the next statement
 * beat it.
 */
function namedRow(convo: Conversation, next: DatedGroupName): Conversation {
  const { nameFromStatement: _rank, ...rest } = convo;
  return {
    ...rest,
    name: next.name,
    nameAt: next.at,
    ...(next.statement ? { nameFromStatement: true as const } : {}),
  };
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
  const row = namedRow(convo, next);
  // A STATEMENT DATING THE VERY NAME A PENDING RENAME WAS MADE OVER dates that rename's base in the
  // same write. The row showed the name undated when this device renamed (the server's list, or an
  // own rename that got no server time), and every path that dates a row comes here: a replayed or
  // live frame that set it, a join push restating it. Without this the sweep read the row as moved
  // on (`pendingRenameVerdict` compares the date too, which is what keeps A -> B -> A from
  // re-sending), and a rename the person was told is on its way was never sent. Only a statement
  // PROVABLY from before the rename dates the base - stamped no later than a server time this
  // device had seen when it minted the frame, server time against server time. A later one
  // restating the same name is a later statement, which the rename must not be re-sent over; one
  // stamped in between cannot be told apart, and is read as later (sealed-names.md).
  const pending = convo.nameSync?.pending;
  if (
    pending &&
    convo.nameAt === undefined &&
    pending.over.at === undefined &&
    pending.over.name === next.name &&
    pending.serverSeenAt !== undefined &&
    next.at <= pending.serverSeenAt
  ) {
    return {
      row: withNameSync(row, {
        ...convo.nameSync,
        pending: { ...pending, over: { name: next.name, at: next.at } },
      }),
    };
  }
  return { row };
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
  nameFromStatement?: true;
}): DatedGroupName | undefined {
  const read = readDatedGroupName(row.name, row.nameAt);
  if (!('kept' in read)) return undefined;
  // The RANK travels with the date: a newcomer holding a statement's name as a rename's would keep
  // it over a later statement every other member takes.
  return row.nameFromStatement ? { ...read.kept, statement: true } : read.kept;
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
  const r = raw as { name?: unknown; at?: unknown; statement?: unknown };
  const read = readDatedGroupName(r.name, r.at);
  if ('refused' in read) return read;
  if (typeof bundleServerAt !== 'number' || !Number.isFinite(bundleServerAt)) {
    return { refused: 'no-server-time' };
  }
  if (read.kept.at > bundleServerAt) return { refused: 'after-the-push' };
  // Absent is a rename's rank: an inviter of the step-1 build dated names from renames only.
  return r.statement === true ? { kept: { ...read.kept, statement: true } } : read;
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
 * What one SILENT `groupNamed` statement does to `convo` - the rename's rule at a statement's rank
 * ({@link groupNameSupersedes}): read and bounded exactly as a rename frame is, then written only when
 * it supersedes the name held. A statement draws no notice anywhere; the live handler and the replay
 * both apply this one function.
 */
export function applyNameStatement(
  convo: Conversation,
  name: unknown,
  serverAt: number | undefined,
  signedSentAt: number | undefined
): { row: Conversation } | { refused: GroupNameRefusal } | { skipped: GroupNameSkip } {
  const read = readRenameFrame(name, serverAt, signedSentAt);
  if ('refused' in read) return read;
  return withDatedGroupName(convo, { ...read.kept, statement: true });
}

/** The (conversation, name) pairs {@link reportOutrankedStatement} already said. */
const outrankedStatementsSaid = new Set<string>();

/**
 * Says, ONCE per conversation and name, that a silent statement named the group differently from a
 * name a RENAME dated here, and lost to it by rank. Not a fault: the stating device never read that
 * rename (outside its window, older than its seat, or crossing its statement). But that device shows
 * another name than this one until the next rename, so the rate is counted before anything else is
 * built for it. The length is said, never the text.
 */
export function reportOutrankedStatement(
  convo: Pick<Conversation, 'id' | 'name' | 'nameAt' | 'nameFromStatement'>,
  statedName: unknown,
  where: string,
  log: (msg: string) => void
): void {
  if (convo.nameAt === undefined || convo.nameFromStatement) return;
  if (typeof statedName !== 'string' || statedName.trim() === convo.name) return;
  const key = `${convo.id}|${statedName.trim()}`;
  if (outrankedStatementsSaid.has(key)) return;
  outrankedStatementsSaid.add(key);
  log(
    `[GROUP_NAME] ${where} in ${convo.id.slice(0, 8)}… names it differently (${statedName.trim().length} chars) from the name a rename dated ${new Date(convo.nameAt).toISOString()} - the rename stands, a statement never renames`
  );
}

/**
 * The name - and its date, when a frame dated it - a row held when this device renamed the group
 * over it. What the rename's unfinished business is compared with before it is acted on: a row that
 * no longer holds it has moved on, and what was owed for the older statement is dropped.
 */
export type RenameBase = { name: string; at?: number };

/**
 * The server's copy of a name the members already hold, not written at the rename. `from` is the
 * name the row held before the rename - the name this device believes the server held - and the copy
 * is written only while the server still holds it (a compare-and-set, `settleNameSync`): a server
 * that names something else was written by a later rename, and an owed copy never goes over it.
 */
export type OwedServerCopy = { name: string; from: string };

/**
 * A `groupRenamed` frame whose send got NO ANSWER: the server may or may not hold it, so its fate is
 * unknown and it is neither a rename nor a failure. Kept with the id and the `sentAt` it was minted
 * with, so the re-send is the SAME frame - the receivers draw one notice under one id, and a member
 * that already took it takes the same name again. `over` is the row the rename was made over.
 */
export type PendingRename = {
  name: string;
  messageId: string;
  sentAt: number;
  over: RenameBase;
  /**
   * The newest instant THE SERVER had stated to this account when the frame was minted
   * (`serverTimeSeen`, serverClock.ts) - absent when it had stated none. A server time no later than
   * the frame's own acceptance, so a statement the server stamped at or before it provably came
   * BEFORE the rename: what dates an undated base (`withDatedGroupName`) server time to server time,
   * never against this device's clock.
   */
  serverSeenAt?: number;
};

/**
 * What this device still owes, or still does not know, about a rename it made - on the row
 * (`Conversation.nameSync`), settled by the next connection's sweep or by a relayed copy of its
 * notice, never on a clock:
 * - `serverCopy`: the server's copy of a name the members hold, not written yet;
 * - `pending`: a frame whose send got no answer, to be re-sent as the same frame;
 * - `unconfirmed`: a frame this device will NOT re-send (a later name superseded it, the receivers'
 *   bound has passed, a re-send was refused) and whose first copy may still have reached every
 *   member. It acts only when a member relays that copy's notice under its id
 *   ({@link ownRenameFromRelay}): this device then takes the name at the time the members hold it.
 */
export type NameSync = {
  serverCopy?: OwedServerCopy;
  pending?: PendingRename;
  unconfirmed?: PendingRename;
  statement?: OwnNameStatement;
};

/**
 * A silent `groupNamed` statement THIS device minted for a row no frame had dated - at creation, or
 * as the one-time restatement of a group that existed before names were dated (sealed-names.md,
 * step 2). On the row, so "once" is a fact of the store, never of a clock or a session:
 * - without `answered`: its send got NO ANSWER, so whether the members hold it is unknown. The next
 *   connection's sweep re-sends the SAME frame (its id and signed `sentAt`) while the row still shows
 *   `name` undated - one statement, however many copies;
 * - `answered`: the server took it but named no time to date this device's row by. The members hold
 *   it dated; this device keeps the name undated, and never states it again.
 * A statement that DID date the row needs no record: the date on the row is the proof.
 */
export type OwnNameStatement = {
  name: string;
  messageId: string;
  sentAt: number;
  answered?: true;
};

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const positiveNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

function parseRenameBase(raw: unknown): RenameBase | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  if (r.at !== undefined && !positiveNumber(r.at)) return null;
  return r.at === undefined ? { name: r.name } : { name: r.name, at: r.at };
}

function parseOwedServerCopy(raw: unknown): OwedServerCopy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return nonEmptyString(r.name) && typeof r.from === 'string'
    ? { name: r.name, from: r.from }
    : null;
}

function parsePendingRename(raw: unknown): PendingRename | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const over = parseRenameBase(r.over);
  if (
    !nonEmptyString(r.name) ||
    !nonEmptyString(r.messageId) ||
    !positiveNumber(r.sentAt) ||
    !over
  ) {
    return null;
  }
  if (r.serverSeenAt !== undefined && !positiveNumber(r.serverSeenAt)) return null;
  return {
    name: r.name,
    messageId: r.messageId,
    sentAt: r.sentAt,
    over,
    ...(r.serverSeenAt !== undefined ? { serverSeenAt: r.serverSeenAt } : {}),
  };
}

function parseOwnNameStatement(raw: unknown): OwnNameStatement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!nonEmptyString(r.name) || !nonEmptyString(r.messageId) || !positiveNumber(r.sentAt)) {
    return null;
  }
  if (r.answered !== undefined && r.answered !== true) return null;
  return {
    name: r.name,
    messageId: r.messageId,
    sentAt: r.sentAt,
    ...(r.answered === true ? { answered: true as const } : {}),
  };
}

/**
 * `row` with its `nameSync` replaced by `sync`, the field REMOVED when nothing is owed - an empty
 * record on a row would be a "something is owed" that names nothing.
 */
export function withNameSync<T extends { nameSync?: NameSync }>(row: T, sync: NameSync): T {
  const { nameSync: _previous, ...rest } = row;
  const kept: NameSync = {
    ...(sync.serverCopy ? { serverCopy: sync.serverCopy } : {}),
    ...(sync.pending ? { pending: sync.pending } : {}),
    ...(sync.unconfirmed ? { unconfirmed: sync.unconfirmed } : {}),
    ...(sync.statement ? { statement: sync.statement } : {}),
  };
  return (Object.keys(kept).length ? { ...rest, nameSync: kept } : rest) as T;
}

/** `{ nameSync }` when something is owed, `{}` otherwise - spread into a row being built. */
export function nameSyncField(sync: NameSync | undefined): { nameSync?: NameSync } {
  return withNameSync({}, sync ?? {});
}

/**
 * Reads a stored {@link NameSync} - the JSON text of the SQLite column, or the object IndexedDB
 * keeps. `undefined` for nothing owed (NULL, absent, an empty record). A value that does not parse
 * is reported, never silent: it is a write this build did not make, and reads as nothing owed.
 */
export function parseNameSync(raw: unknown): NameSync | undefined {
  if (raw === null || raw === undefined) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      console.error('[GROUP_NAME] stored nameSync is not JSON - read as nothing owed');
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') {
    console.error('[GROUP_NAME] stored nameSync is not a record - read as nothing owed');
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const serverCopy = v.serverCopy === undefined ? undefined : parseOwedServerCopy(v.serverCopy);
  const pending = v.pending === undefined ? undefined : parsePendingRename(v.pending);
  const unconfirmed = v.unconfirmed === undefined ? undefined : parsePendingRename(v.unconfirmed);
  const statement = v.statement === undefined ? undefined : parseOwnNameStatement(v.statement);
  if (serverCopy === null || pending === null || unconfirmed === null || statement === null) {
    console.error('[GROUP_NAME] stored nameSync holds an unreadable half - that half is dropped');
  }
  return nameSyncField({
    serverCopy: serverCopy ?? undefined,
    pending: pending ?? undefined,
    unconfirmed: unconfirmed ?? undefined,
    statement: statement ?? undefined,
  }).nameSync;
}

/**
 * What the ACTING device's own rename does to its row, re-read after the send: dated by the server
 * time its send was answered with, and written only when newer - a peer's later rename applied while
 * the send was in flight stays (`not-newer`). With no server time in the answer the row is written
 * UNDATED, honestly: keeping the previous `nameAt` beside the new name would claim a date for it
 * that belongs to another statement.
 *
 * `serverCopyOwed` says the members have the name but the server's copy was not written: the row
 * then owes it ({@link OwedServerCopy}, keyed by the NAME and the server name it goes over, so an
 * undated row owes it too), and the sweep that would otherwise relabel an undated row from the
 * server's list writes the copy first (`settleNameSync`). The rename supersedes whatever an older
 * one owed - a frame still pending included: the members now hold a later statement.
 */
export function ownRenameOutcome(
  current: Conversation,
  name: string,
  receivedAt: number | null,
  serverCopyOwed: boolean,
  over: RenameBase
): { row: Conversation } | { skipped: GroupNameSkip } {
  const sync: NameSync = serverCopyOwed ? { serverCopy: { name, from: over.name } } : {};
  if (receivedAt === null) {
    if ((current.conversationType ?? 'group') !== 'group') return { skipped: 'not-a-group' };
    const { nameAt: _undated, nameFromStatement: _rank, ...rest } = current;
    return { row: withNameSync({ ...rest, name }, sync) };
  }
  const outcome = withDatedGroupName(current, { name, at: receivedAt });
  if (!('row' in outcome)) return outcome;
  return { row: withNameSync(outcome.row, sync) };
}

/**
 * What a rename whose frame got NO ANSWER does to the row: the name it shows stays (the members may
 * not have the new one, and claiming it would be a guess), and the frame is recorded as pending, to
 * be re-sent under its own id by the next connection's sweep. An older rename's owed server copy
 * stays beside it. A frame ALREADY pending is not re-sent any more - the newer rename replaces it -
 * but its first copy may have landed, so it moves to `unconfirmed`, where a member's relayed copy can
 * still settle it; overwriting it lost its id, and with it the only heal.
 */
export function pendingRenameOutcome(
  current: Conversation,
  pending: PendingRename
): { row: Conversation } | { skipped: GroupNameSkip } {
  if ((current.conversationType ?? 'group') !== 'group') return { skipped: 'not-a-group' };
  const displaced = current.nameSync?.pending;
  return {
    row: withNameSync(current, {
      ...current.nameSync,
      ...(displaced ? { unconfirmed: displaced } : {}),
      pending,
    }),
  };
}

/**
 * What the sweep does with a pending rename before re-sending it, read off the row as it stands:
 * - `resend`: the row still holds the statement the rename was made over - the same name AND the
 *   same date. A date is compared too: the members renaming Old -> B -> Old leave the row showing
 *   "Old" again, under a later date, and re-sending then put the older rename over their later
 *   statement for everyone. A statement from before the rename dating an undated base (a replayed
 *   frame, a join push) dates `over` in the same write (`withDatedGroupName`);
 * - `landed`: the row holds the pending name, dated - its own frame came back to it, so it reached
 *   the server and only the server's copy is still owed;
 * - `superseded`: the row holds a later statement (another name, or the same name under another
 *   date) - re-sending would put the
 *   older rename back on top of it, at a later server time. Not dropped: kept `unconfirmed`, since
 *   its first copy may have reached the members after that statement.
 */
export function pendingRenameVerdict(
  row: Pick<Conversation, 'name' | 'nameAt'>,
  pending: PendingRename
): 'resend' | 'landed' | 'superseded' {
  if (row.name === pending.name && row.nameAt !== undefined) return 'landed';
  if (row.name !== pending.over.name) return 'superseded';
  return row.nameAt === pending.over.at ? 'resend' : 'superseded';
}

/**
 * `sync` with `frame` moved out of `pending` into `unconfirmed`: this device stops re-sending it and
 * waits for a relayed copy of its notice ({@link ownRenameFromRelay}) to tell whether it landed.
 */
export function unconfirmedFrom(sync: NameSync | undefined, frame: PendingRename): NameSync {
  return { ...sync, pending: undefined, unconfirmed: frame };
}

/** A row a history bundle relays, as {@link ownRenameFromRelay} reads it. */
export type RelayedRenameRow = {
  id: string;
  /** The relayed server time, already vetted against the bundle's own. */
  serverTimestamp?: number;
  /** The name its notice says the group was renamed to, when it is a rename notice. */
  renamedTo?: string;
};

/**
 * THE HEAL OF A RENAME WHOSE FATE THIS DEVICE NEVER LEARNT. A member's device holds the notice of
 * every rename frame it took, under the id the sender minted; the sending device, whose send got no
 * answer, holds no row under that id - so the history reconciliation's digest diff relays that row
 * to it. A relayed row under the id of this device's own `pending` or `unconfirmed` frame is the
 * proof the frame landed, and its server time is the one every member dated the name by. The name
 * is then applied by the ordinary rule ({@link withDatedGroupName}): a later statement this device
 * holds still wins, an earlier one loses - exactly what each member computed.
 *
 * The server time is the relayer's word, bounded by the `sentAt` THIS device minted - the same
 * bound every receiver applied to the server's stamp ({@link readRenameFrame}), so a relayer gets
 * no power over the order a server does not already have. A row naming another name under that id
 * is refused (the frame said `name`, every member's notice says it too).
 *
 * @returns null when no relayed row is one of this device's own frames.
 */
export function ownRenameFromRelay(
  convo: Conversation,
  rows: Iterable<RelayedRenameRow>
):
  | { row: Conversation; outcome: 'applied' | 'older'; frame: PendingRename }
  | { refused: 'other-name' | GroupNameRefusal; frame: PendingRename }
  | null {
  const sync = convo.nameSync;
  const own = [sync?.pending, sync?.unconfirmed].filter((f): f is PendingRename => !!f);
  if (own.length === 0) return null;
  for (const relayed of rows) {
    const frame = own.find((f) => f.messageId === relayed.id);
    if (!frame) continue;
    if (relayed.renamedTo !== frame.name) return { refused: 'other-name', frame };
    const read = readRenameFrame(frame.name, relayed.serverTimestamp, frame.sentAt);
    if ('refused' in read) return { refused: read.refused, frame };
    const rest: NameSync = {
      ...sync,
      pending: sync?.pending?.messageId === frame.messageId ? undefined : sync?.pending,
      unconfirmed: sync?.unconfirmed?.messageId === frame.messageId ? undefined : sync?.unconfirmed,
    };
    const applied = withDatedGroupName(withNameSync(convo, rest), read.kept);
    if (!('row' in applied)) return { row: withNameSync(convo, rest), outcome: 'older', frame };
    return {
      row: withNameSync(applied.row, {
        ...rest,
        serverCopy: { name: frame.name, from: frame.over.name },
      }),
      outcome: 'applied',
      frame,
    };
  }
  return null;
}

/**
 * Whether the connection sweep states this row's name (`stateGroupNameOnce`), and why not when it
 * does not - every `not` is the ordinary state of some row on every sweep, so none is a line:
 * - `mint`: a group row no frame has dated, named exactly as the server's list names it, with no
 *   rename of this device's own still owed: a fresh statement;
 * - `resend`: the same, holding a statement of this name whose send got no answer - the same frame;
 * - `dated`: a frame already dated the name - THE durable "once": that date is on the row;
 * - `answered`: the server took this device's statement of this name, with no time to date it by;
 * - `unnamed`: the row's name is empty, or not the one the list holds - a raw id, a placeholder.
 *   Only a name the row and the server's list AGREE on is restated: a statement makes its name the
 *   members' word, and a guess must never become it;
 * - `rename-owed`: a rename of this device's own is pending or owes its server copy. Its settlement
 *   compares the row's date with the one it was made over (`pendingRenameVerdict`), and a statement
 *   dating the row would read as a later name and stop the re-send. An `unconfirmed` frame does not
 *   block: if it landed, its relayed copy is a rename and outranks the statement.
 */
export type NameStatementDue =
  | { due: 'mint' }
  | { due: 'resend'; statement: OwnNameStatement }
  | { not: 'not-a-group' | 'not-active' | 'dated' | 'answered' | 'unnamed' | 'rename-owed' };

/** The verdict {@link NameStatementDue} describes, read off the row and the name the list holds. */
export function nameStatementDue(row: Conversation, listedName: string): NameStatementDue {
  if ((row.conversationType ?? 'group') !== 'group') return { not: 'not-a-group' };
  if (row.lifecycle !== 'active') return { not: 'not-active' };
  if (row.nameAt !== undefined) return { not: 'dated' };
  const name = row.name.trim();
  if (name === '' || name !== listedName.trim() || name !== row.name) return { not: 'unnamed' };
  const sync = row.nameSync;
  if (sync?.pending || sync?.serverCopy) return { not: 'rename-owed' };
  const own = sync?.statement;
  if (own && own.name === name) {
    return own.answered ? { not: 'answered' } : { due: 'resend', statement: own };
  }
  return { due: 'mint' };
}

/**
 * What the send of one `groupNamed` statement came to, typed at the throw so nothing reads an error
 * message (`sendNameStatement`, groupActions.ts):
 * - `sent`: the server answered it, `receivedAt` its acceptance time (`null`: the answer named none);
 * - `kept`: no answer (`unanswered`: the fate is unknown, the members may hold it), or a send that was
 *   not made (`not-sent`: a handover refused before it ran, a status that is no verdict on it);
 * - `refused`: an answer that ends it - this device is out (`evicted`), the group is gone
 *   (`group-deleted`), or the receivers' bound refuses its server time (`clock`).
 */
export type NameStatementOutcome =
  | { sent: { receivedAt: number | null } }
  | { kept: 'unanswered' | 'not-sent' }
  | { refused: 'evicted' | 'group-deleted' | 'clock' };

/**
 * The row once this device's own statement `minted` came to `outcome`, re-read after the send:
 * - answered with a time: the name dated at a statement's rank, by the ordinary rule - a rename or a
 *   later statement applied meanwhile stays - and the record dropped, the date being the proof;
 * - answered with none: recorded `answered`, so it is never stated again from this device;
 * - unanswered: recorded, re-sent as the same frame by the next sweep;
 * - refused: the record dropped - nothing a member holds names it, and a later sweep may state the
 *   name afresh (a clock the next sweep proves sound, a group this device is still in).
 * `null` when the row is left as it was (`not-sent`: nothing was posted, any older record stands).
 */
export function ownNameStatementOutcome(
  current: Conversation,
  minted: Omit<OwnNameStatement, 'answered'>,
  outcome: NameStatementOutcome
): Conversation | null {
  const rest: NameSync = { ...current.nameSync, statement: undefined };
  if ('kept' in outcome) {
    return outcome.kept === 'unanswered'
      ? withNameSync(current, { ...rest, statement: minted })
      : null;
  }
  if ('refused' in outcome) return withNameSync(current, rest);
  if (outcome.sent.receivedAt === null) {
    return withNameSync(current, { ...rest, statement: { ...minted, answered: true } });
  }
  const dated = withDatedGroupName(current, {
    name: minted.name,
    at: outcome.sent.receivedAt,
    statement: true,
  });
  return withNameSync('row' in dated ? dated.row : current, rest);
}

/** The conversations a rename frame without a signed `sentAt` was already reported for. */
const legacyRenameReported = new Set<string>();

/**
 * Says why a rename frame was refused - the ONE line the live handler and the archive replay share.
 * A frame from a build before `sentAt` existed (`no-signed-time`) is an expected LEGACY state,
 * refused all the same since nothing bounds its server time, and said ONCE per conversation at INFO:
 * a line repeated on every frame or replay page is a line its reader learns to skip. Every other
 * refusal is a frame that should not exist, and is said every time, as an error.
 *
 * @param where who read it, for the line: "rename by abcd1234" or "replayed rename".
 */
export function reportRenameRefusal(
  conversationId: string,
  refusal: GroupNameRefusal,
  where: string
): void {
  if (refusal === 'no-signed-time') {
    if (legacyRenameReported.has(conversationId)) return;
    legacyRenameReported.add(conversationId);
    console.info(
      `[GROUP_NAME] ${where} in ${conversationId.slice(0, 8)}… predates the signed sentAt - not applied (said once per conversation)`
    );
    return;
  }
  console.error(
    `[GROUP_NAME] ${where} in ${conversationId.slice(0, 8)}… NOT applied: ${GROUP_NAME_REFUSAL_TEXT[refusal]}`
  );
}

/**
 * A rename the SENDER's own check refused: the frame left, but its server time and the `sentAt` this
 * device signed lie further apart than {@link readRenameFrame} believes - so every receiver refuses it
 * too, and the sender must not write the name its members will never hold. Classified here, at the
 * throw, so the screen tells a wrong clock from a lost network without reading a message.
 */
export class GroupRenameRefusedError extends Error {
  constructor(readonly refusal: GroupNameRefusal) {
    super(`groupRenamed refused by its own sender: ${GROUP_NAME_REFUSAL_TEXT[refusal]}`);
    this.name = 'GroupRenameRefusedError';
  }
}
