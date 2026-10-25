import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
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
  /** The gate refused the bytes themselves (a 4xx): not re-planned - the member is told. */
  | 'refused';

/** One lost invitation, owed a re-plan (or a word) - see the module doc. */
export interface OwedInvitation {
  groupId: string;
  /** The epoch the lost commit was staged on: removals AFTER it are what the re-plan must honour. */
  baseEpoch: number;
  invitation: CommitInvitation;
  cause: LostInvitationCause;
}

/**
 * Re-plans one lost invitation and tells the member every ending it does not complete. MUST NOT
 * throw: its entry is dropped once it returns, so a throw is a loss nobody hears of.
 */
export type OwedInvitationReplanner = (owed: OwedInvitation) => Promise<void>;

/** The key of one entry:a group holds one staged commit at a time, each on its own epoch. */
function entryKey(groupId: string, baseEpoch: number): string {
  return `${groupId}@${baseEpoch}`;
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

function readAll(userId: string): Record<string, OwedInvitation> {
  const raw = localStorage.getItem(ACCOUNT_KEY.owedInvitations(userId));
  if (!raw) return {};
  try {
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

function writeAll(userId: string, all: Record<string, OwedInvitation>): void {
  const key = ACCOUNT_KEY.owedInvitations(userId);
  if (Object.keys(all).length > 0) localStorage.setItem(key, JSON.stringify(all));
  else localStorage.removeItem(key);
}

/**
 * Records `owed` for `userId`, synchronously - the caller clears the stage right after. The same
 * lost commit recorded twice (a reload before its clear reached disk) is ONE entry.
 */
export function recordOwedInvitation(userId: string, owed: OwedInvitation): void {
  const all = readAll(userId);
  all[entryKey(owed.groupId, owed.baseEpoch)] = owed;
  writeAll(userId, all);
}

/** Every invitation `userId` is owed a re-plan of, oldest base first. */
export function listOwedInvitations(userId: string): OwedInvitation[] {
  return Object.values(readAll(userId)).sort((a, b) => a.baseEpoch - b.baseEpoch);
}

/** The re-plan of `owed` concluded (whatever it came to): its entry leaves the record. */
export function settleOwedInvitation(userId: string, owed: OwedInvitation): void {
  const all = readAll(userId);
  delete all[entryKey(owed.groupId, owed.baseEpoch)];
  writeAll(userId, all);
}
