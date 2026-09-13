/**
 * Eviction policy: what the client does once a Remove commit naming this device has been applied.
 *
 * The rule is that the REMOVE COMMIT IS AUTHORITATIVE. It is a signed, ordered statement by a
 * member with the right to make it, and it is the same statement every other member applies - so
 * there is nothing to confirm, nothing to retry and nothing to repair. The conversation is retired
 * exactly as a peer-side deletion retires it, and `requestReAdd` is reserved for what it was
 * written for: a group this device believes it is IN but cannot use (an epoch fork, a lost
 * Welcome). Eviction is not a broken state, it is a correct one we are not part of.
 *
 * The fact is read from OpenMLS (`isGroupActive`), never mirrored into a flag of our own: the group
 * state is already durable, and a second copy can only ever be wrong in the direction that matters
 * - saying we are still a member of a group we were removed from.
 *
 * ## The fact is learnt in five places and RECORDED in one
 *
 * A client can find out it is no longer a member six different ways, at five sites: a Remove commit
 * it applies, the exclusion its author announces, an inbound frame refused as `evicted`, a
 * membership check made before a send or a selection, a send the server refuses, and the delivery
 * service answering `NotAGroupMemberError`. Each of those is a different EVIDENCE, and that is the
 * only thing they legitimately differ in. What is OWED once the fact is known is the same every
 * time, and it was written out by hand at every site until it stopped agreeing with itself:
 *
 * | Site | Retired the row | Posted the notice |
 * | --- | --- | --- |
 * | a Remove commit applied, and an inbound frame refused as evicted | yes | no |
 * | the exclusion announced by its author (`memberRemoved`) | yes | yes |
 * | a send refused, before or by the server (the outbox) | yes | no |
 * | a membership check on selection, and the server's own refusal | **no** | yes |
 *
 * The last row is the defect, and it is the one the user meets: `verifyCurrentUserMembership`
 * learnt the eviction from the authoritative local state, posted a notice, cached "not a member"
 * for thirty seconds - and wrote NOTHING down. A reload brought the conversation back as `active`,
 * the roster request went back to the members-only endpoint, and the fact had to be re-learnt on
 * the next selection, for ever. {@link recordEviction} is the single disposition; the evidence
 * travels as data, and it is the only thing a caller decides.
 *
 * DROPPING THE MLS STATE IS NOT PART OF IT, and deliberately so. That is its own operation with its
 * own single implementation (`dropGroupState`), and an evicted group's state is not worthless: it
 * is what still opens the frames of the epochs this device WAS a member for, and it is what makes a
 * later frame classify as `evicted` at all rather than falling through to the out-of-sync policy.
 * The row is what refuses the send, the roster, the re-add and the welcome_request - so the two
 * axes are separate, and `memberRemoved` is simply a site that legitimately does both.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import { m } from '$lib/paraglide/messages';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { findConversationKeyByGroupId, retireConversation } from '$lib/utils/chat/conversations';

/**
 * How this device found out, and the ONLY thing the five learning sites legitimately differ in.
 *
 * It is not decoration. Two of these six mean the fact was learnt by FAILING - the Remove commit
 * that stated it never reached this device, so a message was written, encrypted and refused to
 * find out what a frame already knew. That is the one thing a reader of the log needs to be able
 * to tell apart, and until this table existed two sites said so in prose and four said nothing.
 */
export type EvictionEvidence =
  /** A Remove commit naming this device merged, and the membership read right after it says so. */
  | 'remove-commit'
  /** The member who made the removal announced it (`memberRemoved` naming us). */
  | 'system-event'
  /** An inbound frame for the group was refused as `evicted` - in flight, or routed by a stale registry. */
  | 'inbound-frame'
  /** A membership check - before a send, or on selecting the conversation - answered `false`. */
  | 'membership-check'
  /** A send was refused as `evicted` AFTER a membership check answered yes. A miss. */
  | 'outbound-refusal'
  /** The delivery service refused this device as a non-member. A miss. */
  | 'server-refusal';

/**
 * What each evidence says in the log, and whether reaching it means the fact was learnt by failing.
 *
 * The shape of the line is the classification: a `missed` evidence never produces
 * `[EVICT] Removed from ...`, so no rule written for the healthy path can swallow it, and the
 * campaign's watcher leaves it unexplained - which is what it is.
 */
const EVICTION_EVIDENCE: Record<EvictionEvidence, { what: string; missed: boolean }> = {
  'remove-commit': { what: 'by a Remove commit', missed: false },
  'system-event': { what: 'by an exclusion its author announced', missed: false },
  'inbound-frame': {
    what: 'by a Remove commit a frame for the group arrived after',
    missed: false,
  },
  'membership-check': { what: 'by a Remove commit this device had already applied', missed: false },
  'outbound-refusal': { what: 'a send was refused as evicted', missed: true },
  'server-refusal': {
    what: 'the delivery service refused this device as a non-member',
    missed: true,
  },
};

/** What {@link recordEviction} needs. `groupId` and not a key: four of the five sites hold nothing else. */
export interface RecordEvictionDeps {
  conversations: Map<string, Conversation>;
  /** The MLS group id. The row is found by it. */
  groupId: string;
  /** How this device found out - see {@link EvictionEvidence}. */
  evidence: EvictionEvidence;
  log: (message: string) => void;
  saveConversation?: (key: string) => Promise<void>;
  /**
   * Posts the one-time removal notice.
   *
   * Optional because a caller may have no chat surface at all, never because the notice is. A site
   * that omits it leaves the user with the banner and no line in the thread, which is exactly the
   * disagreement this function exists to end - so every site that can supply it, does.
   */
  addMessageToChat?: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
}

/**
 * Records that this device is no longer a member of a group - the ONE disposition, whatever the
 * evidence.
 *
 * Three things, in this order, and all three are owed every time:
 *
 *   1. **the row is retired**, which is the durable statement. `lifecycle: 'removed'` is read by
 *      the send gate, the roster loader, the frame buffer, the re-add guards and the UI banner, so
 *      recording the eviction anywhere else - or only in memory - leaves every one of them wrong.
 *   2. **the notice is posted once**, so the user is told rather than left with a conversation that
 *      silently refuses to send. Deduplicated on the message itself, because the same eviction is
 *      legitimately learnt twice (a commit and then the announcement behind it).
 *   3. **one line naming the evidence**, and accusing when the evidence is a miss.
 *
 * Idempotent: a replayed commit, or a second evidence for the same removal, changes nothing and
 * says so. Returns whether THIS call performed the transition.
 */
export async function recordEviction(deps: RecordEvictionDeps): Promise<boolean> {
  const { conversations, groupId, evidence, log, saveConversation, addMessageToChat } = deps;
  const short = groupId.slice(0, 8);
  const { what, missed } = EVICTION_EVIDENCE[evidence];

  const key = findConversationKeyByGroupId(conversations, groupId);
  if (!key) {
    // Not silent, and not an error either: a distribution group and a group whose row was already
    // purged both reach here. Nothing is recorded about them, so there is nothing to retire.
    log(`[EVICT] ${short}… - removed (${what}), but no conversation row carries this group`);
    return false;
  }

  // Read BEFORE the retire, which rewrites the row: the notice is deduplicated on the thread's own
  // contents, the only place the first evidence left a trace the second can see.
  const notice = m.chat_system_removed_from_group();
  const alreadyNoticed =
    conversations.get(key)?.messages.some((msg) => msg.isSystem && msg.content === notice) ?? false;

  const retired = await retireConversation({ conversations, key, groupId, saveConversation });

  if (!alreadyNoticed) {
    // Best-effort, and after the retire: the banner is the durable half and must not be held up by
    // a message write. A swallowed branch logs.
    await addMessageToChat?.('system', notice, key, { isSystem: true }).catch((e: unknown) =>
      log(
        `[EVICT] ${short}… - removal notice not posted: ${e instanceof Error ? e.message : String(e)}`
      )
    );
  }

  if (missed) {
    // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU. The Remove commit states this before
    // anything is sent; reaching here means it never arrived, and the line has to accuse so the
    // path stays a signal rather than becoming the way eviction is normally discovered.
    log(
      `[EVICT] ${short}… - ${what}, so this device learnt its removal by FAILING: the Remove commit never reached it`
    );
  } else {
    log(
      retired
        ? `[EVICT] Removed from ${short}… ${what} - conversation retired`
        : `[EVICT] Removed from ${short}… - already retired, nothing to do`
    );
  }
  return retired;
}

/** Everything {@link retireIfEvicted} needs, kept to the narrowest set both call sites can supply. */
export interface EvictionCheckDeps extends Omit<RecordEvictionDeps, 'groupId' | 'evidence'> {
  mlsService: Pick<IMlsService, 'isGroupActive'>;
  groupId: string;
  /**
   * How this device came to be asking.
   *
   * Narrowed to the three evidences a LOCAL READ can establish: the two misses already carry the
   * server's own word, so a caller holding one has nothing left to ask OpenMLS, and `system-event`
   * is the removal's author stating it. Passing one of those here would re-read a fact already in
   * hand and answer `false` on a group this device does not hold.
   */
  evidence: Extract<EvictionEvidence, 'remove-commit' | 'inbound-frame' | 'membership-check'>;
}

/**
 * Reads this device's membership of `groupId` from OpenMLS - the authoritative fact.
 *
 * THREE ANSWERS, NOT TWO, and the third is the point. `true` we are a member, `false` a Remove
 * commit named us, `null` the local state could not say - a group this device does not hold throws
 * here, and collapsing that into `false` would retire conversations it had merely not loaded yet.
 * Every caller must decide what to do about `null` for itself; none of them may treat it as a "no".
 *
 * This is the fact `verifyCurrentUserMembership` consults before it asks the delivery service, and
 * the reason it can: the answer is local, durable and free, and the server's own membership
 * endpoint is members-only - so on the one question that matters it is certain to refuse.
 *
 * The swallowed branch logs, and names its caller through `context`: it is the branch that would
 * hide an eviction, so a run must be able to see which decision it was about to inform.
 */
export async function readLocalMembership(deps: {
  mlsService: Pick<IMlsService, 'isGroupActive'>;
  groupId: string;
  /** What was about to be decided, spliced into the log line ("after a commit"). */
  context: string;
  log: (message: string) => void;
}): Promise<boolean | null> {
  const { mlsService, groupId, context, log } = deps;
  try {
    return await mlsService.isGroupActive(groupId);
  } catch (e) {
    log(`[EVICT] Membership of ${groupId.slice(0, 8)}… could not be read ${context}: ${String(e)}`);
    return null;
  }
}

/**
 * Retires the conversation if this device is no longer a member of the group.
 *
 * Returns true when this call performed the transition, false when the device is still a member,
 * the conversation was already retired, or membership could not be read. Idempotent: the retire
 * itself is a no-op on a conversation already in `removed`, so a replayed commit costs one query.
 *
 * A failure to READ membership is deliberately not treated as an eviction. The two are opposite
 * facts and only one of them retires a conversation; an unheld group throws here, and answering
 * "evicted" to that would retire conversations this device simply had not loaded yet.
 */
export async function retireIfEvicted(deps: EvictionCheckDeps): Promise<boolean> {
  const { mlsService, groupId, evidence, log, ...rest } = deps;
  // `null` is NOT an eviction: a membership query is not the point of the path this runs on, and the
  // send-path backstop in the outbox is what would find a missed eviction, one refused message
  // later. `readLocalMembership` owns the log for that branch.
  const active = await readLocalMembership({ mlsService, groupId, context: 'after a commit', log });
  if (active !== false) return false;

  return recordEviction({ ...rest, groupId, evidence, log });
}

/**
 * Whether the row itself already records that this device is OUT of the group - so the delivery
 * service must not be asked anything that only a member may ask.
 *
 * WHY A SECOND READER OF THE SAME FACT. `readLocalMembership` answers the question for a caller
 * that can afford an async round-trip into OpenMLS and that has something to do with all three of
 * its answers. The roster loader has neither: it runs on every conversation SELECTION, it wants one
 * cheap yes/no, and the only thing it can do with "no" is show no roster. `lifecycle === 'removed'`
 * is that yes/no, it is durable, it is already in the row the caller is holding, and it is written
 * in exactly one place (`retireConversation`) from the Remove commit that is authoritative.
 *
 * IT EXISTS BECAUSE THE GUARD WAS PUT ON ONE OF TWO DOORS. On 2026-08-23 the membership check
 * stopped asking `GET /api/mls/groups/:id/members` on a device holding a Remove commit, because
 * that endpoint is members-only BY DESIGN and could only refuse. `loadGroupMembers` reaches the
 * same endpoint, is fired by the same two selection paths one line above that check, and had no
 * guard of any kind - so a removed device selecting its retired conversation still logged the same
 * 403, and GRP-3 still recorded it on 2026-08-24. Fixing a call site is not fixing a seam.
 *
 * IT COVERS A DEPARTURE THIS DEVICE CHOSE, and only because the departure states the fact before
 * it acts. A leave and a delete are not learnt from a commit - the device decides - and they used
 * to record that decision LAST, after the server call and the WASM forget, which left a window in
 * which the row still read as live while the membership behind it was already gone. `$effect`s over
 * the conversations map fire inside that window, so the same 403 came back a third time (GRP-6,
 * 2026-08-24). `exitGroupAndCleanup` now retires first and purges last; this predicate did not have
 * to widen, and a third call-site guard was not what was missing.
 *
 * A retired conversation has no roster this device is entitled to know, so `false` here is the
 * ANSWER and not a fallback: the absence is what the UI should render.
 *
 * `undefined` - a group id naming no row - is deliberately not "lost". Nothing is recorded about
 * it, and suppressing a request on the strength of a missing row would hide a real lookup bug.
 */
export function membershipIsDurablyLost(
  convo: Pick<Conversation, 'lifecycle'> | undefined
): boolean {
  return convo?.lifecycle === 'removed';
}
