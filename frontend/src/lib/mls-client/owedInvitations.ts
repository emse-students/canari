import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { accountStore } from './accountStore';
import type { CommitInvitation } from './commitSubmission';

/**
 * THE INVITATIONS A KEPT COMMIT CARRIED AND LOST - owed a re-plan, or a word to the member who made
 * them.
 *
 * ## Why a record, and why here
 *
 * A member's invitation is a gesture with no durable server row: a new person enters only by a
 * member's own Add (2026-10-23), so no sweep ever re-derives it. While its commit is KEPT (an
 * unanswered submission, `commitSubmission.ts`) the invitation lives in the commit's intent, in the
 * MLS state. The settlement that finds the commit did not land CLEARS that stage - and with it the
 * only copy of the invitation (OFF-3, 1.4.1 campaign: W5 never got a seat, and nobody was told).
 *
 * So the settlement writes the invitation HERE, synchronously, BEFORE it clears the stage, and the
 * entry leaves only once the re-plan has concluded. Every reload therefore finds one of the two:
 * - the stage, if the clear had not reached disk: it is settled again, refused again, recorded again
 *   under the same key - one entry, never two;
 * - this entry, once it had: the next connection re-plans it.
 *
 * ## Why the re-plan cannot issue the Add twice
 *
 * The re-plan reads the tree CONFIRMED at the server's epoch and offers only devices without a leaf
 * (`addDevicesRebuildingOnRace`): an Add that merged before a reload is `already-in-tree` the second
 * time, and one whose own outcome is unknown is a kept stage, settled before anything is staged on
 * top of it - and it carries the invitation in ITS intent, so its loss is recorded in turn.
 *
 * Per account, in `localStorage` like every per-account record (`accountLocalKeys.ts`): written
 * under the MLS lock with no await between it and the clear, and swept with the account.
 */

/** Why the commit did not land, which decides what is owed. */
export type LostInvitationCause =
  /** Another commit took its epoch (`epoch_mismatch`, or the log at its base): re-planned. */
  | 'race'
  /**
   * The gate refused it for any other reason - a business refusal in a 200 body (`departed`,
   * `welcome_target_not_member`, ...) or a 4xx: the same invitation would meet the same answer, so
   * it is not re-planned and the member is told.
   */
  | 'refused';

/** The one reason a lost commit is a RACE: the gate's typed refusal, never the shape of its answer. */
export const RACE_REFUSAL_REASON = 'epoch_mismatch';

/** One lost invitation, owed a re-plan (or a word) - see the module doc. */
export interface OwedInvitation {
  groupId: string;
  /** The epoch the lost commit was staged on: removals AFTER it are what the re-plan must honour. */
  baseEpoch: number;
  invitation: CommitInvitation;
  cause: LostInvitationCause;
  /** The gate's refusal reason, or a 4xx's code, as answered - what the member is told on `refused`. */
  reason?: string;
}

/**
 * What a re-plan came to, for the record:
 * - `concluded`: it ended - completed, or the member was told why not - and the entry leaves;
 * - `waiting`: it cannot run YET (the conversation is not restored or not active, another device
 *   holds the group's add lock) - the entry stays, and the event that lifts the wait drains it again.
 */
export type ReplanVerdict = 'concluded' | 'waiting';

/**
 * Re-plans one lost invitation and tells the member every ending it does not complete. MUST NOT
 * throw: a throw is a defect, and its entry is dropped like a concluded one.
 */
export type OwedInvitationReplanner = (owed: OwedInvitation) => Promise<ReplanVerdict>;

/**
 * Tells the member, by the conversation's name, that an invitation of theirs in `groupId` did not
 * land and could not even be recorded for a re-plan (`OwedInvitationNotRecordedError`).
 */
export type UnrecordedInvitationTeller = (groupId: string) => void;

/** Whether `userId` is owed a re-plan in `groupId` - the gate of an event-driven drain. */
export function owesInvitationIn(userId: string, groupId: string): boolean {
  return Object.values(readAll(userId)).some((o) => o.groupId === groupId);
}

/**
 * The key of one entry: a group, an epoch and what is owed there. A RACE and a REFUSAL at the same
 * epoch are different debts (one re-planned, one told), so they never share an entry; two gestures
 * owed the same way at the same epoch do, merged ({@link recordOwedInvitation}).
 */
function entryKey(groupId: string, baseEpoch: number, cause: LostInvitationCause): string {
  return cause === 'race' ? `${groupId}@${baseEpoch}` : `${groupId}@${baseEpoch}!${cause}`;
}

/** The stored key of the entry `owed` names, whatever key it was written under (an older build's). */
function storedKeyOf(
  all: Record<string, OwedInvitation>,
  owed: Pick<OwedInvitation, 'groupId' | 'baseEpoch' | 'cause'>
): string | undefined {
  return Object.keys(all).find((k) => {
    const o = all[k];
    return o.groupId === owed.groupId && o.baseEpoch === owed.baseEpoch && o.cause === owed.cause;
  });
}

/**
 * Two gestures owed at the same epoch, as ONE entry: every person of both, each person's roster
 * baseline kept (`rostered` names the people on the roster at their gesture, per person). A seat
 * generation dates the departures the server checks for ONE gesture: kept only when both carry the
 * same one, since an older one would date a person's earlier removal as a departure after their
 * own, later gesture.
 */
function mergeOwed(earlier: OwedInvitation, later: OwedInvitation): OwedInvitation {
  const users = [...new Set([...earlier.invitation.users, ...later.invitation.users])];
  const rostered = [
    ...new Set([...(earlier.invitation.rostered ?? []), ...(later.invitation.rostered ?? [])]),
  ];
  const seatGeneration =
    earlier.invitation.seatGeneration === later.invitation.seatGeneration
      ? earlier.invitation.seatGeneration
      : undefined;
  const reason = earlier.reason ?? later.reason;
  return {
    groupId: earlier.groupId,
    baseEpoch: earlier.baseEpoch,
    cause: earlier.cause,
    invitation: {
      users,
      ...(earlier.invitation.rostered || later.invitation.rostered ? { rostered } : {}),
      ...(seatGeneration !== undefined ? { seatGeneration } : {}),
    },
    ...(reason ? { reason } : {}),
  };
}

function isOwed(v: unknown): v is OwedInvitation {
  const o = v as Partial<OwedInvitation> | null;
  return (
    typeof o?.groupId === 'string' &&
    typeof o.baseEpoch === 'number' &&
    Array.isArray(o.invitation?.users) &&
    (o.cause === 'race' || o.cause === 'refused')
  );
}

/** The record could not be WRITTEN: nothing is owed a re-plan, so the caller tells the member. */
export class OwedInvitationNotRecordedError extends Error {
  constructor(readonly reason: string) {
    super(`the owed-invitation record could not be written: ${reason}`);
    this.name = 'OwedInvitationNotRecordedError';
  }
}

function readAll(userId: string): Record<string, OwedInvitation> {
  const s = accountStore();
  if (!s) return {};
  try {
    const raw = s.getItem(ACCOUNT_KEY.owedInvitations(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, OwedInvitation> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (isOwed(v)) out[k] = v;
      else console.error(`[INVITE_OWED] an owed invitation is unreadable (${k}) - dropped`);
    }
    return out;
  } catch (e) {
    console.error(
      `[INVITE_OWED] the owed-invitation record is UNREADABLE - nothing re-planned from it: ${String(e).slice(0, 120)}`
    );
    return {};
  }
}

/** @throws {@link OwedInvitationNotRecordedError} when the store is missing or refuses the write. */
function writeAll(userId: string, all: Record<string, OwedInvitation>): void {
  const s = accountStore();
  if (!s) throw new OwedInvitationNotRecordedError('no usable local storage');
  const key = ACCOUNT_KEY.owedInvitations(userId);
  try {
    if (Object.keys(all).length > 0) s.setItem(key, JSON.stringify(all));
    else s.removeItem(key);
  } catch (e) {
    // QuotaExceededError included.
    throw new OwedInvitationNotRecordedError(String(e).slice(0, 120));
  }
}

/**
 * Records `owed` for `userId`, synchronously - the caller clears the stage right after. The same
 * lost commit recorded twice (a reload before its clear reached disk) is ONE entry.
 *
 * AN ENTRY ALREADY OWED AT THAT EPOCH IS MERGED INTO, NEVER REPLACED ({@link mergeOwed}): an
 * invitation owed on another device's add lock and a kept commit refused at the same base are two
 * gestures, and writing the second over the first lost the first in silence. A merge of the same
 * gesture twice is the gesture, so the reload case stays one entry.
 *
 * @throws {@link OwedInvitationNotRecordedError} - the caller still clears the stage (a refused stage
 *   left in place blocks every commit of the group) and tells the member instead.
 */
export function recordOwedInvitation(userId: string, owed: OwedInvitation): void {
  const all = readAll(userId);
  const stored = storedKeyOf(all, owed);
  if (stored !== undefined) all[stored] = mergeOwed(all[stored], owed);
  else all[entryKey(owed.groupId, owed.baseEpoch, owed.cause)] = owed;
  writeAll(userId, all);
}

/** Every invitation `userId` is owed a re-plan of, oldest base first. */
export function listOwedInvitations(userId: string): OwedInvitation[] {
  return Object.values(readAll(userId)).sort((a, b) => a.baseEpoch - b.baseEpoch);
}

/**
 * The re-plan of `owed` concluded (whatever it came to): THE PEOPLE IT COVERED leave the record, and
 * the entry with them once nobody is left. A gesture merged into the entry while the re-plan ran - an
 * invitation refused by the very lock the re-plan held - is not what concluded, and stays owed for
 * the next drain. A write that fails leaves it all in place - re-planned once more, which the
 * confirmed tree answers - and says so.
 */
export function settleOwedInvitation(userId: string, owed: OwedInvitation): void {
  const all = readAll(userId);
  const stored = storedKeyOf(all, owed);
  if (stored === undefined) return;
  const covered = new Set(owed.invitation.users);
  const entry = all[stored];
  const users = entry.invitation.users.filter((u) => !covered.has(u));
  if (users.length === 0) {
    delete all[stored];
  } else {
    console.log(
      `[INVITE_OWED] ${owed.groupId.slice(0, 8)}... the re-plan at epoch ${owed.baseEpoch} concluded for ${covered.size} person(s); ${users.length} invited meanwhile stay owed`
    );
    all[stored] = {
      ...entry,
      invitation: {
        ...entry.invitation,
        users,
        ...(entry.invitation.rostered
          ? { rostered: entry.invitation.rostered.filter((u) => !covered.has(u)) }
          : {}),
      },
    };
  }
  try {
    writeAll(userId, all);
  } catch (e) {
    console.error(
      `[INVITE_OWED] ${owed.groupId.slice(0, 8)}... the concluded entry at epoch ${owed.baseEpoch} could not be removed: ${(e as Error).message}`
    );
  }
}
