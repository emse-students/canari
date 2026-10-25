import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { OwedInvitation, OwedInvitationReplanner } from '$lib/mls-client/owedInvitations';
import type { Conversation } from '$lib/types';
import { findConversationKeyByGroupId } from './conversations';
import type { LostInvitationOutcome } from './groupCreation';
import { holdsGroupState } from './groupUsability';

/** What {@link makeLostInvitationReplanner} reads and calls - bound by `useConversations`. */
export interface LostInvitationReplannerDeps {
  conversations: Map<string, Conversation>;
  mlsService: Pick<IMlsService, 'getLocalGroups'>;
  /** `replanLostInvitation`, bound to the session's deps. */
  replan: (owed: OwedInvitation, conversation: Conversation) => Promise<LostInvitationOutcome>;
  /** `reportLostInvitation`: tells the member every ending that is not a completion. */
  report: (outcome: LostInvitationOutcome, conversationName: string) => void;
  /** Rereads the member list once the invitation completed. */
  afterCompleted: (conversation: Conversation) => Promise<void>;
}

/**
 * The re-planner the MLS service drains lost invitations through (`setOwedInvitationReplanner`),
 * registered only once the conversations are RESTORED - before that, every row would read absent.
 *
 * WHAT IT ANSWERS IS WHAT HAPPENS TO THE ENTRY (`ReplanVerdict`), so an ending is never silent:
 * - the conversation's row is found by its group (`findConversationKeyByGroupId`: a legacy direct row
 *   is keyed otherwise);
 * - `pending`, or no row while the group is held: the conversation is not usable YET - `waiting`,
 *   drained again when it becomes available (its row registered, its Welcome processed);
 * - no row and no group: the member left it themselves (a deletion is their gesture; a retirement
 *   keeps a `removed` row) - nothing can be added, and nothing is owed a word: `concluded`, logged;
 * - `removed`: the member is told the conversation is gone - `concluded`;
 * - `active`: re-planned; `waiting` only when another device holds the add lock, every other ending
 *   is told by `report` and `concluded`. A throw is told as a failure.
 */
export function makeLostInvitationReplanner(
  deps: LostInvitationReplannerDeps
): OwedInvitationReplanner {
  return async (owed) => {
    const short = owed.groupId.slice(0, 8);
    const key = findConversationKeyByGroupId(deps.conversations, owed.groupId);
    const convo = key === undefined ? undefined : deps.conversations.get(key);
    if (!convo) {
      if (holdsGroupState(deps.mlsService, owed.groupId)) {
        console.log(
          `[INVITE_OWED] ${short}... no row yet for the conversation of the lost invitation - kept, re-planned once it is available`
        );
        return 'waiting';
      }
      console.warn(
        `[INVITE_OWED] ${short}... neither a row nor the group is held any more (left on this device) - the lost invitation is dropped`
      );
      return 'concluded';
    }
    if (convo.lifecycle === 'pending') {
      console.log(
        `[INVITE_OWED] ${short}... the conversation of the lost invitation is pending - kept, re-planned once it is active`
      );
      return 'waiting';
    }
    if (convo.lifecycle === 'removed') {
      deps.report({ kind: 'conversation-gone' }, convo.name);
      return 'concluded';
    }
    try {
      const outcome = await deps.replan(owed, convo);
      if (outcome.kind === 'waiting') {
        console.log(
          `[INVITE_OWED] ${short}... another device holds the add lock - the lost invitation is kept for the next drain`
        );
        return 'waiting';
      }
      deps.report(outcome, convo.name);
      if (outcome.kind === 'completed') {
        await deps
          .afterCompleted(convo)
          .catch((e: unknown) =>
            console.warn(
              `[INVITE_OWED] ${short}... member list not reread after the re-plan: ${String(e).slice(0, 120)}`
            )
          );
      }
    } catch (e) {
      console.error(`[INVITE_OWED] ${short}... the re-plan threw - the member is told:`, e);
      deps.report({ kind: 'not-completed', reason: 'failed' }, convo.name);
    }
    return 'concluded';
  };
}
