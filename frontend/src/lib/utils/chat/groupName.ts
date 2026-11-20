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

import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { Conversation } from '$lib/types';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';

/**
 * Whether two group names show the same: compared TRIMMED on both sides, the one rule every reader
 * uses. A statement's name is trimmed on read (`readDatedGroupName`) but a Welcome or an old build may
 * have stored the name with a trailing space, which must not make an honest restatement a different name.
 */
export function sameShownName(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * A name and the server time (Unix ms) of the MLS statement that set it. `statement` marks a SILENT
 * `groupNamed` statement (a creation, or the one-time restatement of a group that existed before
 * names were dated) as opposed to a `groupRenamed` frame - see {@link groupNameSupersedes} for why
 * the two are ranked.
 */
export type DatedGroupName = {
  name: string;
  at: number;
  statement?: true;
  /**
   * A statement that ANSWERS another (sealed-names.md, "the answer"): the date of the rename whose
   * name it restates, never after the answer's own server time. Ranks it above plain statements.
   */
  renameAt?: number;
  /** A rename's: the user who made it, kept beside the name (`Conversation.nameRenamedBy`). */
  by?: string;
};

/** The fields that qualify a dated name's rank on a row, persisted with `nameAt`. */
export type NameRank = Pick<Conversation, 'nameFromStatement' | 'nameRenameAt' | 'nameRenamedBy'>;

/**
 * The rank fields of `src` that hold beside its date - the ONE reading every store and row builder
 * applies, so a field persisted in one shape is read back in the same one: none without a date; a
 * statement's rank with its answer's rename date when it has one; a rename's author otherwise.
 */
export function nameRankFields(src: NameRank & { nameAt?: number }): NameRank {
  if (src.nameAt === undefined) return {};
  if (src.nameFromStatement === true) {
    return {
      nameFromStatement: true,
      ...(positiveNumber(src.nameRenameAt) ? { nameRenameAt: src.nameRenameAt } : {}),
    };
  }
  return nonEmptyString(src.nameRenamedBy) ? { nameRenamedBy: src.nameRenamedBy } : {};
}

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
  | 'after-the-push'
  | 'unbounded-rename-time';

/** The words a log line uses for each {@link GroupNameRefusal}. Dev-facing, never shown. */
export const GROUP_NAME_REFUSAL_TEXT: Record<GroupNameRefusal, string> = {
  'not-a-name': 'it carries no name',
  'empty-name': 'its name is empty once trimmed',
  'no-server-time': 'its delivery carries no server time to date it, and this clock is not one',
  'no-signed-time': 'the frame carries no signed sentAt to bound the server time by',
  'server-time-out-of-bound': `its server time lies more than ${BUNDLE_SERVER_TIME_SKEW_MS / 3_600_000} h from the frame's signed sentAt`,
  'after-the-push': "its date lies after the push's own server time",
  'unbounded-rename-time':
    "it answers a statement but carries no rename date, or one after the answer's own server time",
};

/** A statement read off the wire: taken, or refused for one named cause. */
export type GroupNameRead = { kept: DatedGroupName } | { refused: GroupNameRefusal };

/** Why a dated name was not written onto a row: neither is a failure, both are worth a line. */
export type GroupNameSkip = 'not-a-group' | 'not-newer' | 'already-dated';

/** The part of a conversation row a name statement is compared with. */
type HeldGroupName = Pick<Conversation, 'name' | 'nameAt' | 'nameFromStatement' | 'nameRenameAt'>;

/**
 * Where a dated name stands, as {@link groupNameSupersedes} orders it: its RANK (2 a rename, 1 an
 * answer restating one, 0 a plain statement) and the date it is ordered by within that rank - an
 * answer's is the rename's it restates, every other one's is its own server time.
 */
function nameStanding(
  at: number,
  statement: boolean,
  renameAt: number | undefined
): { rank: number; at: number } {
  if (!statement) return { rank: 2, at };
  return renameAt === undefined ? { rank: 0, at } : { rank: 1, at: renameAt };
}

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
 *
 * AN ANSWER RANKS BETWEEN THE TWO (#3888 re-review, A3): a statement restating a RENAME, sent by that
 * rename's author to heal a member who stated another name ({@link statementAnswerDue}). It beats
 * every plain statement whatever the dates - a plain statement only states what its device held,
 * the answer states a rename it read - and among answers the later RENAME wins, then the larger
 * name: ordered by sending time, an answer reflecting an older rename sent late put a stale name
 * back on every member a statement dated. It carries no more trust than a rename: its rename date
 * is bounded by its own server time, and any member may send a rename outright.
 */
export function groupNameSupersedes(next: DatedGroupName, held: HeldGroupName): boolean {
  if (held.nameAt === undefined) return true;
  const n = nameStanding(next.at, next.statement === true, next.renameAt);
  const h = nameStanding(held.nameAt, held.nameFromStatement === true, held.nameRenameAt);
  if (n.rank !== h.rank) return n.rank > h.rank;
  if (n.at !== h.at) return n.at > h.at;
  return next.name > held.name;
}

/**
 * `convo` named `next`: the name, its date and its rank written together, every rank field of the
 * name it replaces REMOVED first - a rename's row claiming a statement's rank would let the next
 * statement beat it, and an author kept beside another rename's name would answer for it.
 */
function namedRow(convo: Conversation, next: DatedGroupName): Conversation {
  const { nameFromStatement: _rank, nameRenameAt: _renameAt, nameRenamedBy: _by, ...rest } = convo;
  return {
    ...rest,
    name: next.name,
    nameAt: next.at,
    ...nameRankFields({
      nameAt: next.at,
      ...(next.statement ? { nameFromStatement: true as const } : {}),
      nameRenameAt: next.renameAt,
      nameRenamedBy: next.by === undefined ? undefined : canonicalUserId(next.by),
    }),
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
export function restatedGroupName(
  row: { name: string; nameAt?: number } & NameRank
): DatedGroupName | undefined {
  const read = readDatedGroupName(row.name, row.nameAt);
  if (!('kept' in read)) return undefined;
  // The RANK travels with the date: a newcomer holding a statement's name as a rename's would keep
  // it over a later statement every other member takes. An answer's rename date and a rename's
  // author travel with it too, so the newcomer orders and answers as the inviter would.
  const rank = nameRankFields(row);
  if (rank.nameFromStatement) {
    return {
      ...read.kept,
      statement: true,
      ...(rank.nameRenameAt !== undefined ? { renameAt: rank.nameRenameAt } : {}),
    };
  }
  return rank.nameRenamedBy ? { ...read.kept, by: rank.nameRenamedBy } : read.kept;
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
  const r = raw as {
    name?: unknown;
    at?: unknown;
    statement?: unknown;
    renameAt?: unknown;
    by?: unknown;
  };
  const read = readDatedGroupName(r.name, r.at);
  if ('refused' in read) return read;
  if (typeof bundleServerAt !== 'number' || !Number.isFinite(bundleServerAt)) {
    return { refused: 'no-server-time' };
  }
  if (read.kept.at > bundleServerAt) return { refused: 'after-the-push' };
  // Absent is a rename's rank: an inviter of the step-1 build dated names from renames only.
  if (r.statement !== true) {
    return nonEmptyString(r.by) ? { kept: { ...read.kept, by: r.by } } : read;
  }
  // An answer's rename date, bounded like the answer's own (never after its server time).
  if (r.renameAt !== undefined) {
    if (!positiveNumber(r.renameAt) || r.renameAt > read.kept.at) {
      return { refused: 'unbounded-rename-time' };
    }
    return { kept: { ...read.kept, statement: true, renameAt: r.renameAt } };
  }
  return { kept: { ...read.kept, statement: true } };
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
 * `by` is the frame's MLS-authenticated sender, kept beside the name (`Conversation.nameRenamedBy`).
 */
export function applyRenameFrame(
  convo: Conversation,
  newName: unknown,
  serverAt: number | undefined,
  signedSentAt: number | undefined,
  by: string
): { row: Conversation } | { refused: GroupNameRefusal } | { skipped: GroupNameSkip } {
  const read = readRenameFrame(newName, serverAt, signedSentAt);
  if ('refused' in read) return read;
  return withDatedGroupName(convo, { ...read.kept, by });
}

/**
 * Reads the `renameAt` an ANSWER carries: a positive time no later than the answer's own server time
 * - a rename the answer restates was read before the answer was sent. `null` when it is unusable.
 */
function readAnswerRenameAt(renameAt: unknown, answerAt: number): number | null {
  return positiveNumber(renameAt) && renameAt <= answerAt ? renameAt : null;
}

/**
 * What one SILENT `groupNamed` statement does to `convo` - the rename's rule at a statement's rank
 * ({@link groupNameSupersedes}): read and bounded exactly as a rename frame is, then written only when
 * it supersedes the name held. A statement draws no notice anywhere; the live handler and the replay
 * both apply this one function. `answer` is set for an ANSWER (`answers` on the frame): its
 * `renameAt` must be bounded by the answer's own server time, or the answer is refused.
 */
export function applyNameStatement(
  convo: Conversation,
  name: unknown,
  serverAt: number | undefined,
  signedSentAt: number | undefined,
  answer?: { renameAt: unknown }
): { row: Conversation } | { refused: GroupNameRefusal } | { skipped: GroupNameSkip } {
  const read = readRenameFrame(name, serverAt, signedSentAt);
  if ('refused' in read) return read;
  if (!answer) return withDatedGroupName(convo, { ...read.kept, statement: true });
  const renameAt = readAnswerRenameAt(answer.renameAt, read.kept.at);
  if (renameAt === null) return { refused: 'unbounded-rename-time' };
  return withDatedGroupName(convo, { ...read.kept, statement: true, renameAt });
}

/** The (conversation, name) pairs {@link reportOutrankedStatement} already said. */
const outrankedStatementsSaid = new Set<string>();

/**
 * Whether a statement of `statedName` lost to a name a RENAME dated on `convo` while naming the
 * group DIFFERENTLY - a split: the stating device never read that rename (outside its window, older
 * than its seat, a stale list, or crossing its statement). Said ONCE per conversation and name, at
 * INFO on the live path and the replay alike, so the rate is one count; the length is said, never
 * the text. The live path then ANSWERS it ({@link statementAnswerDue}).
 */
export function reportOutrankedStatement(
  convo: Pick<Conversation, 'id' | 'name' | 'nameAt' | 'nameFromStatement'>,
  statedName: unknown,
  where: string
): boolean {
  if (convo.nameAt === undefined || convo.nameFromStatement) return false;
  if (typeof statedName !== 'string' || sameShownName(statedName, convo.name)) return false;
  const key = `${convo.id}|${statedName.trim()}`;
  if (!outrankedStatementsSaid.has(key)) {
    outrankedStatementsSaid.add(key);
    console.info(
      `[GROUP_NAME] ${where} in ${convo.id.slice(0, 8)}… names it differently (${statedName.trim().length} chars) from the name a rename dated ${new Date(convo.nameAt).toISOString()} - the rename stands, a statement never renames`
    );
  }
  return true;
}

/** Whether `row` holds a name a RENAME by `userId` dated - the only rows that answer. */
function heldRenameIsOwn(row: Conversation, userId: string): boolean {
  return (
    row.nameAt !== undefined &&
    row.nameFromStatement !== true &&
    row.nameRenamedBy !== undefined &&
    row.nameRenamedBy === canonicalUserId(userId) &&
    row.name.trim() !== ''
  );
}

/**
 * THE HEAL OF A SPLIT A STATEMENT REVEALS (#3888 review, S1; re-review, A1-A3). A device holding a
 * RENAME-dated name that reads a plain statement of ANOTHER name knows the stating device - and every
 * member that took the statement - shows a name the group was renamed away from. It ANSWERS: one
 * silent statement of its own name, carrying the rename's date (`renameAt`), which outranks every
 * plain statement ({@link groupNameSupersedes}), so every member a statement dated converges on it.
 *
 * ONLY THE RENAME'S AUTHOR ANSWERS (`userId` is the `nameRenamedBy` of the row): every rename-dated
 * device answering cost one frame per member device for one straggler, each taking a slot in the
 * group's capped log. The author's devices are bounded by one user's, and a device that READ an
 * answer of its own name and rename date skips its own ({@link answerReadSettlesOwn}). An author no
 * longer in the group answers nothing; that residual is counted (`reportOutrankedStatement`).
 *
 * TERMINATION IS A PROOF, NOT A COUNT: an answer is never answered (`answers` set), a statement-dated
 * device never answers, and a device owes at most ONE answer at a time - recorded on the row
 * ({@link NameSync.answer}) and owed until sent, so a re-delivery adds nothing and a restart loses
 * nothing. Plain statements are finite (a creation, one restatement), so the answers are too.
 */
export function statementAnswerDue(
  convo: Conversation,
  statedName: unknown,
  statement: { id: string | undefined; isAnswer: boolean },
  userId: string
): boolean {
  if ((convo.conversationType ?? 'group') !== 'group') return false;
  if (statement.isAnswer || !statement.id) return false;
  if (!heldRenameIsOwn(convo, userId) || convo.lifecycle !== 'active') return false;
  if (typeof statedName !== 'string' || sameShownName(statedName, convo.name)) return false;
  const owed = convo.nameSync?.answer;
  // One owed answer heals every plain statement, past and future (it outranks them all): a second
  // one would only cost a slot. A settled one answered `to` already.
  return !owed || (owed.done === true && owed.to !== statement.id);
}

/**
 * `convo` once it owes an answer to `statementId` - recorded BEFORE anything is sent, and settled
 * only by a send ({@link ownAnswerOutcome}), never by being scheduled.
 */
export function withOwedAnswer(convo: Conversation, statementId: string): Conversation {
  return withNameSync(convo, { ...convo.nameSync, answer: { to: statementId } });
}

/**
 * Whether an ANSWER this device just read (another device's, of this user or not) says exactly what
 * this device's owed answer would - the same name, the same rename date - so it is SETTLED unsent:
 * the members took that one, and a second is only a slot taken in the capped log. The row with its
 * debt settled, or `null` when nothing changes.
 */
export function answerReadSettlesOwn(
  convo: Conversation,
  answer: { name: unknown; renameAt: unknown }
): Conversation | null {
  const owed = convo.nameSync?.answer;
  if (!owed || owed.done) return null;
  if (convo.nameAt === undefined || convo.nameFromStatement) return null;
  if (typeof answer.name !== 'string' || !sameShownName(answer.name, convo.name)) return null;
  if (answer.renameAt !== convo.nameAt) return null;
  return withNameSync(convo, { ...convo.nameSync, answer: { to: owed.to, done: true } });
}

/**
 * What the owed answer on `row` asks of the sender, read off the row as it stands:
 * - `resend`: a frame was minted for the name and rename the row still holds, and its send got no
 *   answer or was not made - the SAME frame, so the members take one answer however many copies;
 * - `mint`: nothing minted yet, or minted for a name the row no longer holds - a fresh frame;
 * - `void`: the row no longer holds a rename of this user's - a later rename reached everyone, and
 *   with it the members the answer was for. Settled unsent;
 * - `none`: nothing owed.
 */
export function owedAnswerDue(
  row: Conversation,
  userId: string
):
  | { due: 'resend'; frame: AnswerFrame; to: string }
  | { due: 'mint'; to: string }
  | 'void'
  | 'none' {
  const owed = row.nameSync?.answer;
  if (!owed || owed.done) return 'none';
  if (!heldRenameIsOwn(row, userId)) return 'void';
  const f = owed.frame;
  if (f && f.name === row.name && f.renameAt === row.nameAt) {
    return { due: 'resend', frame: f, to: owed.to };
  }
  return { due: 'mint', to: owed.to };
}

/**
 * The row once this device's answer `frame` to `to` came to `outcome`, re-read after the send:
 * - sent: settled (`done`), the frame dropped - the server holds it;
 * - no answer, or not made: the frame kept, re-sent as the same frame by the next sweep;
 * - refused by the receivers' bound (`clock`): the frame dropped, the debt kept - a fresh one, signed
 *   when the clock is proven, goes out instead;
 * - refused for good (`evicted`, `group-deleted`): settled, nothing a member could take.
 */
export function ownAnswerOutcome(
  current: Conversation,
  to: string,
  frame: AnswerFrame,
  outcome: NameStatementOutcome
): Conversation {
  const answer: OwedAnswer =
    'sent' in outcome
      ? { to, done: true }
      : 'kept' in outcome
        ? { to, frame }
        : outcome.refused === 'clock'
          ? { to }
          : { to, done: true };
  return withNameSync(current, { ...current.nameSync, answer });
}

/** `row` with its owed answer settled unsent (`void`, see {@link owedAnswerDue}). */
export function withAnswerSettled(row: Conversation): Conversation {
  const owed = row.nameSync?.answer;
  if (!owed) return row;
  return withNameSync(row, { ...row.nameSync, answer: { to: owed.to, done: true } });
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
  /** The answer this device owes, or last settled ({@link OwedAnswer}, {@link statementAnswerDue}). */
  answer?: OwedAnswer;
};

/**
 * One frame answering a statement: this row's name and the date of the rename that dated it here,
 * under the id and signed `sentAt` it was minted with - kept so a send with no answer is re-sent as
 * the SAME frame, and the members take one answer however many copies.
 */
export type AnswerFrame = { name: string; renameAt: number; messageId: string; sentAt: number };

/**
 * The answer this device owes to the plain statement `to` (#3888 re-review, A1) - on the row, so
 * "answered" is a fact of the store that a restart, a sign-out or a lost tab cannot drop:
 * - neither `frame` nor `done`: owed, nothing minted yet;
 * - `frame`: minted, and its send got no answer or was not made - re-sent as that frame;
 * - `done`: settled - sent, read from another device ({@link answerReadSettlesOwn}), or made void by
 *   a later rename. `to` stays, so a re-delivery of that statement is not answered again.
 * Settled by the drain that follows the statement, else by the next connection's sweep.
 */
type OwedAnswer = { to: string; frame?: AnswerFrame; done?: true };

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

function parseOwedAnswer(raw: unknown): OwedAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!nonEmptyString(r.to)) return null;
  if (r.done !== undefined && r.done !== true) return null;
  if (r.done === true) return { to: r.to, done: true };
  if (r.frame === undefined) return { to: r.to };
  const f = r.frame as Record<string, unknown> | null;
  if (
    !f ||
    typeof f !== 'object' ||
    !nonEmptyString(f.name) ||
    !positiveNumber(f.renameAt) ||
    !nonEmptyString(f.messageId) ||
    !positiveNumber(f.sentAt)
  ) {
    return null;
  }
  return {
    to: r.to,
    frame: { name: f.name, renameAt: f.renameAt, messageId: f.messageId, sentAt: f.sentAt },
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
    ...(sync.answer ? { answer: sync.answer } : {}),
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
  const answer = v.answer === undefined ? undefined : parseOwedAnswer(v.answer);
  if (
    serverCopy === null ||
    pending === null ||
    unconfirmed === null ||
    statement === null ||
    answer === null
  ) {
    console.error('[GROUP_NAME] stored nameSync holds an unreadable half - that half is dropped');
  }
  return nameSyncField({
    serverCopy: serverCopy ?? undefined,
    pending: pending ?? undefined,
    unconfirmed: unconfirmed ?? undefined,
    statement: statement ?? undefined,
    answer: answer ?? undefined,
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
  over: RenameBase,
  userId: string
): { row: Conversation } | { skipped: GroupNameSkip } {
  const sync: NameSync = serverCopyOwed ? { serverCopy: { name, from: over.name } } : {};
  if (receivedAt === null) {
    if ((current.conversationType ?? 'group') !== 'group') return { skipped: 'not-a-group' };
    const {
      nameAt: _undated,
      nameFromStatement: _rank,
      nameRenameAt: _renameAt,
      nameRenamedBy: _by,
      ...rest
    } = current;
    return { row: withNameSync({ ...rest, name }, sync) };
  }
  const outcome = withDatedGroupName(current, { name, at: receivedAt, by: userId });
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
 * - `superseded`: the row holds a later RENAME (another name, or the same name under another
 *   date) - a name a silent statement dated never counts, it is outranked - re-sending would put the
 *   older rename back on top of it, at a later server time. Not dropped: kept `unconfirmed`, since
 *   its first copy may have reached the members after that statement.
 */
export function pendingRenameVerdict(
  row: Pick<Conversation, 'name' | 'nameAt' | 'nameFromStatement'>,
  pending: PendingRename
): 'resend' | 'landed' | 'superseded' {
  // A NAME A SILENT STATEMENT DATED NEVER SUPERSEDES A RENAME: the statement only dates a name, and
  // the re-sent rename outranks it on every device (`groupNameSupersedes`). Read as superseded, a
  // member's one-time restatement of the base - the rollout itself - cancelled this device's
  // unanswered rename without a word (#3888 review, B1).
  if (row.nameAt !== undefined && row.nameFromStatement) return 'resend';
  if (sameShownName(row.name, pending.name) && row.nameAt !== undefined) return 'landed';
  if (!sameShownName(row.name, pending.over.name)) return 'superseded';
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
  rows: Iterable<RelayedRenameRow>,
  userId: string
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
    const applied = withDatedGroupName(withNameSync(convo, rest), { ...read.kept, by: userId });
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
  if (name === '' || !sameShownName(name, listedName)) return { not: 'unnamed' };
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
