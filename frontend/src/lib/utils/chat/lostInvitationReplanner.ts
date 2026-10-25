import type { IMlsService } from '$lib/mls-client/IMlsService';
import type {
  OwedInvitation,
  OwedInvitationReplanner,
  UnrecordedInvitationTeller,
} from '$lib/mls-client/owedInvitations';
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
  /**
   * Whether the session that registered this re-planner is still the one signed in. Read after the
   * re-plan, before anything is said: a sign-out during it must not tell the leaving account's
   * conversation over the login page or the next account - the entry is kept for that account.
   */
  isCurrent: () => boolean;
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
 * - `active`: re-planned; `waiting` when the add lock was refused or the tree could not be
 *   confirmed (nothing staged, an event lifts it), every other ending is told by `report` and
 *   `concluded`. A throw is told as a failure;
 * - a session that ended during the re-plan tells nothing and keeps the entry (`isCurrent`).
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
    const ended = () => {
      if (deps.isCurrent()) return false;
      console.log(
        `[INVITE_OWED] ${short}... the session ended during the re-plan - nothing told, the entry is kept for its account`
      );
      return true;
    };
    try {
      const outcome = await deps.replan(owed, convo);
      if (outcome.kind === 'waiting') {
        console.log(
          outcome.on === 'add-lock'
            ? `[INVITE_OWED] ${short}... the group's add lock was refused (held by another device, or a lock of this device the server has not let go) - kept, re-planned at the group's next commit or the next connection`
            : `[INVITE_OWED] ${short}... the tree could not be confirmed at the server's epoch - kept, re-planned at the group's next commit or the next connection`
        );
        return 'waiting';
      }
      if (ended()) return 'waiting';
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
      console.error(`[INVITE_OWED] ${short}... the re-plan threw:`, e);
      if (ended()) return 'waiting';
      deps.report({ kind: 'not-completed', reason: 'failed' }, convo.name);
    }
    return 'concluded';
  };
}

/**
 * Tells the member, BY THE CONVERSATION'S NAME, of an invitation whose loss could not even be
 * recorded (`OwedInvitationNotRecordedError`): the same sentence as a re-plan that could not
 * complete, since a new invitation can. A conversation this device holds no row for has no name to
 * say it with, and is logged.
 */
export function makeUnrecordedInvitationTeller(
  deps: Pick<LostInvitationReplannerDeps, 'conversations' | 'report'>
): UnrecordedInvitationTeller {
  return (groupId) => {
    const key = findConversationKeyByGroupId(deps.conversations, groupId);
    const convo = key === undefined ? undefined : deps.conversations.get(key);
    if (!convo) {
      console.warn(
        `[INVITE_OWED] ${groupId.slice(0, 8)}... an unrecorded lost invitation has no conversation row to be told in`
      );
      return;
    }
    deps.report({ kind: 'not-completed', reason: 'failed' }, convo.name);
  };
}
