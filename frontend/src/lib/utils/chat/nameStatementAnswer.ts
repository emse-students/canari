import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { sendNameStatement } from './groupActions';
import { statementAnswerDue, withNameSync } from './groupName';

/**
 * ANSWERS a silent statement that named the group differently from the name a RENAME dated here
 * (`statementAnswerDue`, groupName.ts; sealed-names.md, "the answer"): one silent statement of this
 * row's name, marked as answering `statementId`, so every device holding a statement-dated name
 * converges on it - a stale list or a missed rename no longer freezes a split.
 *
 * ONCE PER STATEMENT, BY STORED STATE: the statement's id is written on the row (`nameSync.answered`)
 * and saved BEFORE anything is sent, so a re-delivery after a restart answers nothing. The send is
 * CHAINED on the group being drained (`whenGroupDrained`), never awaited here: the caller is a frame
 * of that group, and awaiting would wait on itself. At send time the row is read again - a rename
 * read meanwhile is what goes out, and a row no longer rename-dated sends nothing.
 *
 * @returns whether an answer was scheduled.
 */
export async function answerOutrankedStatement(params: {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  convoKey: string;
  statedName: unknown;
  statement: { id: string | undefined; isAnswer: boolean };
  save: (key: string) => Promise<void>;
  log: (msg: string) => void;
}): Promise<boolean> {
  const { mlsService, conversations, convoKey, statement, log } = params;
  const convo = conversations.get(convoKey);
  if (!convo || !statementAnswerDue(convo, params.statedName, statement)) return false;
  const short = `${convo.id.slice(0, 8)}…`;
  conversations.set(convoKey, withNameSync(convo, { ...convo.nameSync, answered: statement.id }));
  await params.save(convoKey).catch((e: unknown) => {
    console.error(
      `[GROUP_NAME] answer to statement ${statement.id!.slice(0, 8)} in ${short} recorded but not saved - a re-delivery after a restart may answer it again: ${String(e).slice(0, 120)}`
    );
  });
  log(
    `[GROUP_NAME] statement ${statement.id!.slice(0, 8)} in ${short} names another name than the rename held here - answered with this row's name once the group is drained`
  );
  mlsService
    .whenGroupDrained(convo.id)
    .then(async () => {
      const now = conversations.get(convoKey);
      if (!now || now.nameAt === undefined || now.nameFromStatement || now.name.trim() === '') {
        log(
          `[GROUP_NAME] answer to statement ${statement.id!.slice(0, 8)} in ${short} not sent - the row no longer holds a rename-dated name`
        );
        return;
      }
      const outcome = await sendNameStatement({
        mlsService,
        groupId: now.id,
        userId: params.userId,
        deviceKeyB64: params.deviceKeyB64,
        minted: { name: now.name, messageId: crypto.randomUUID(), sentAt: Date.now() },
        answers: statement.id,
      });
      // The row is rename-dated: its own answer, a statement, never changes it - nothing to write.
      if (!('sent' in outcome)) {
        console.warn(
          `[GROUP_NAME] answer to statement ${statement.id!.slice(0, 8)} in ${short} not delivered (${Object.values(outcome)[0]}) - the split it answers stays until a later statement or rename`
        );
      }
    })
    .catch((e: unknown) => {
      console.warn(
        `[GROUP_NAME] answer to statement ${statement.id!.slice(0, 8)} in ${short} abandoned - the group never drained here: ${String(e).slice(0, 120)}`
      );
    });
  return true;
}
