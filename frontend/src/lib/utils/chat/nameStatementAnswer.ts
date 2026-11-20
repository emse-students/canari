import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
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
