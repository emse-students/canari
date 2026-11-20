import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import type { Conversation } from '$lib/types';
import { BUNDLE_SERVER_TIME_SKEW_MS } from './messageTime';
import { renameAuthorFromNotices } from './visibleNotices';
import { answerReadSettlesOwn, statementAnswerDue, withOwedAnswer } from './groupName';
import { newSweepClock, settleOwedAnswer, type AnswerSender } from './serverGroupConversation';

/**
 * ANSWERS a plain statement that named the group differently from the name a RENAME BY THIS USER
 * dated here (`statementAnswerDue`, groupName.ts; sealed-names.md, "the answer"): one silent
 * statement of this row's name and that rename's date, which outranks every plain statement, so
 * every member a statement dated converges on it.
 *
 * OWED, NEVER SCHEDULED (#3888 re-review, A1): the debt is written on the row (`NameSync.answer`) and
 * saved before anything is sent, and only a send settles it. The send runs once the group is drained
 * (`settleOwedAnswer`, chained on `whenGroupDrained` - the caller is a frame of that group, and
 * awaiting the drain here would wait on itself); a restart, a sign-out or a lost tab before then
 * leaves the debt on the row, and the next connection's sweep sends it.
 *
 * @returns whether an answer is now owed.
 */
export async function answerOutrankedStatement(params: {
  mlsService: IMlsService;
  userId: string;
  send: AnswerSender;
  conversations: Map<string, Conversation>;
  convoKey: string;
  statedName: unknown;
  statement: { id: string | undefined; isAnswer: boolean };
  save: (key: string) => Promise<void>;
  log: (msg: string) => void;
}): Promise<boolean> {
  const { mlsService, userId, conversations, convoKey, statement, log } = params;
  const convo = conversations.get(convoKey);
  if (!convo || !statement.id || !statementAnswerDue(convo, params.statedName, statement, userId)) {
    return false;
  }
  const short = `${convo.id.slice(0, 8)}…`;
  const id = statement.id.slice(0, 8);
  conversations.set(convoKey, withOwedAnswer(convo, statement.id));
  await params.save(convoKey).catch((e: unknown) => {
    console.error(
      `[GROUP_NAME] answer to statement ${id} in ${short} owed but not saved - a restart before it is sent loses it: ${String(e).slice(0, 120)}`
    );
  });
  log(
    `[GROUP_NAME] statement ${id} in ${short} names another name than this user's rename held here - an answer is owed, sent once the group is drained`
  );
  void settleOwedAnswer(convoKey, convo.id, {
    send: params.send,
    clock: newSweepClock(),
    mlsService,
    userId,
    conversations,
    saveConversation: params.save,
    log,
  }).catch((e: unknown) => {
    console.warn(
      `[GROUP_NAME] answer to statement ${id} in ${short} not sent now - it stays owed, and the next sweep sends it: ${String(e).slice(0, 120)}`
    );
  });
  return true;
}

/**
 * THE READ-SIDE DEDUPE (#3888 re-review, A2): an answer just read that says exactly what this
 * device's owed answer would (`answerReadSettlesOwn`) settles it unsent. Another device of the same
 * user answered first; a second copy only takes a slot in the group's capped log.
 *
 * @returns whether the owed answer was settled.
 */
export async function settleOwedAnswerByRead(params: {
  conversations: Map<string, Conversation>;
  convoKey: string;
  answer: { id: string | undefined; name: unknown; renameAt: unknown };
  save: (key: string) => Promise<void>;
  log: (msg: string) => void;
}): Promise<boolean> {
  const { conversations, convoKey, answer } = params;
  const convo = conversations.get(convoKey);
  const settled = convo ? answerReadSettlesOwn(convo, answer) : null;
  if (!convo || !settled) return false;
  conversations.set(convoKey, settled);
  await params.save(convoKey).catch((e: unknown) => {
    console.error(
      `[GROUP_NAME] owed answer in ${convo.id.slice(0, 8)}… settled by a copy read, but not saved - the next sweep sends it anyway: ${String(e).slice(0, 120)}`
    );
  });
  params.log(
    `[GROUP_NAME] owed answer in ${convo.id.slice(0, 8)}… settled unsent - answer ${(answer.id ?? '').slice(0, 8)} read from another device says the same`
  );
  return true;
}

/** The renames (conversation, `nameAt`) whose notice was searched for an author and not found. */
const authorsSearchedInVain = new Set<string>();

/**
 * BACKFILLS THE RENAME'S AUTHOR on a row dated before it was stored beside the name (#3888
 * re-review): without it, nobody answers for that rename - and every group dated by step 1 is such a
 * row, which is the very split the answer exists to heal. Read from this device's own notice of that
 * rename (`renameAuthorFromNotices`: the same name, dated at the same server time), decrypted from
 * the window that can hold it and no wider - a notice row is dated by its frame's `sentAt`, which
 * lies within {@link BUNDLE_SERVER_TIME_SKEW_MS} of the server time either way, so a conversation of
 * any size costs the same two days. A search that finds nothing is noted for the session, per rename,
 * and not repeated. Run where it matters, before an outranked
 * statement is weighed: the notice rows are sealed under the device key, which a store migration
 * does not hold. Once found it is stored, so it is read once. Where no notice says it, the field stays
 * empty and the line says so: that rename's split stays until the next rename.
 *
 * @returns whether the row now names its rename's author.
 */
export async function backfillRenameAuthor(params: {
  storage: IStorage;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  convoKey: string;
  save: (key: string) => Promise<void>;
  log: (msg: string) => void;
}): Promise<boolean> {
  const { conversations, convoKey } = params;
  const convo = conversations.get(convoKey);
  if (!convo || convo.nameAt === undefined || convo.nameFromStatement) return false;
  if (convo.nameRenamedBy !== undefined) return true;
  const short = `${convo.id.slice(0, 8)}…`;
  const at = convo.nameAt;
  // Searched once per rename: a later statement does not decrypt the same window again for nothing.
  const searched = `${convo.id}|${at}`;
  if (authorsSearchedInVain.has(searched)) return false;
  let rows: Awaited<ReturnType<IStorage['getMessagesSince']>>;
  try {
    rows = await params.storage.getMessagesSince(
      convo.id,
      at - BUNDLE_SERVER_TIME_SKEW_MS,
      params.deviceKeyB64,
      at + BUNDLE_SERVER_TIME_SKEW_MS
    );
  } catch (e) {
    console.warn(
      `[GROUP_NAME] rename author of ${short} not backfilled - its notices could not be read: ${String(e).slice(0, 120)}`
    );
    return false;
  }
  const author = renameAuthorFromNotices(rows, convo.name, at);
  if (!author) {
    authorsSearchedInVain.add(searched);
    console.info(
      `[GROUP_NAME] rename author of ${short} unknown - no stored notice names the rename that dated it (${convo.name.length} chars at ${new Date(at).toISOString()}); nobody here answers for it`
    );
    return false;
  }
  // Re-read after the decrypt: only the row still holding that very rename takes its author.
  const now = conversations.get(convoKey);
  if (!now || now.name !== convo.name || now.nameAt !== at || now.nameFromStatement) return false;
  conversations.set(convoKey, { ...now, nameRenamedBy: canonicalUserId(author) });
  await params.save(convoKey).catch((e: unknown) => {
    console.error(
      `[GROUP_NAME] rename author of ${short} backfilled but not saved - read again next time: ${String(e).slice(0, 120)}`
    );
  });
  params.log(`[GROUP_NAME] rename author of ${short} backfilled from its stored notice`);
  return true;
}
