import type { IMlsService } from '$lib/mls-client/IMlsService';
import { CommitRefusedError, rebuildableRefusal } from '$lib/mls-client/CommitRefusedError';
import type { CommitInvitation } from '$lib/mls-client/commitSubmission';
import { treeHoldsDevice } from '$lib/mls-client/leafIdentity';
import type { SkippedDevice } from '$lib/mls-client/skippedKeyPackage';
import { readConfirmedTree } from './confirmedTree';

/**
 * Why an Add was abandoned BEFORE anything was staged - the gesture's premise no longer held, or
 * could not be shown to hold:
 * - `tree-unconfirmed`: the tree the Add would be filtered on could not be confirmed at the server's
 *   epoch ({@link readConfirmedTree}), so which devices it lacks is unknown;
 * - `not-a-member-device`: an automatic Add's user holds no leaf in the confirmed tree any more - a
 *   Remove took them out, and bringing a person back is a member's gesture;
 * - `invitation-withdrawn`: the pending row the automatic Add answers is gone from the server - a
 *   removal deleted it;
 * - `removed-meanwhile`: a person on the roster when a member's invitation began is off it now - a
 *   concurrent Remove of the same person, which the invitation must not undo;
 * - `premise-unreadable`: the server read that would show the premise failed.
 */
export type AddAbortReason =
  | 'tree-unconfirmed'
  | 'not-a-member-device'
  | 'invitation-withdrawn'
  | 'removed-meanwhile'
  | 'premise-unreadable';

/**
 * An Add abandoned before its stage (see {@link AddAbortReason}): no commit, nothing registered. A
 * TYPE, so every caller classifies it without reading a message.
 */
export class AddAbortedError extends Error {
  constructor(
    readonly groupId: string,
    readonly why: AddAbortReason,
    detail: string
  ) {
    super(
      `The Add in ${groupId.slice(0, 8)}... was abandoned before its stage (${why}): ${detail}`
    );
    this.name = 'AddAbortedError';
  }
}

/**
 * Runs `attempt` - one commit of a member's gesture, built on the tree it reads itself - and runs it
 * AGAIN for as long as the gate refuses it for a reason {@link rebuildableRefusal} proves progress
 * on: the refusal's catch-up moved the local epoch (a foreign commit was consumed), or an overtaken
 * seat claim (an eviction landed). TERMINATION IS THAT PROOF, NEVER A COUNT OR A CLOCK: each pass
 * consumes one real commit of somebody else's. Every other failure leaves as thrown, so the caller
 * classifies it by type - a race refusal that moved nothing is `isCommitRaceRefusal`.
 *
 * THE COMMIT THAT WON MAY HAVE CHANGED THE GESTURE'S PREMISE - a Remove of the very person being
 * added - so `attempt` receives its index and re-checks what it rests on in EVERY pass, throwing
 * {@link AddAbortedError} rather than staging on a premise that no longer holds.
 *
 * THE ONE LOOP EVERY GESTURE SHARES (Add, Remove, the pending-invitation sweep): a lost race used to
 * end three different ways depending on who lost it (CC-1, CC-2, CC-4 of the 1.4.1 campaign).
 *
 * @param what - names the gesture in the log line.
 */
export async function rebuildOnRace<T>(
  mlsService: Pick<IMlsService, 'getEpoch'>,
  groupId: string,
  what: string,
  attempt: (index: number) => Promise<T>,
  log: (msg: string) => void = (msg) => console.log(msg)
): Promise<T> {
  for (let index = 0; ; index++) {
    try {
      return await attempt(index);
    } catch (e) {
      // Only a refusal of the gate can prove progress; anything else leaves as thrown.
      if (!(e instanceof CommitRefusedError)) throw e;
      const caughtUpTo = mlsService.getEpoch(groupId);
      const why = rebuildableRefusal(e, caughtUpTo);
      if (why === null) throw e;
      log(
        `[COMMIT_RACE] ${groupId.slice(0, 8)}... ${what} was refused (${why}, now epoch ${caughtUpTo}) - rebuilding on the tree that won`
      );
    }
  }
}

/** One device a bulk Add offers, as `addMembersBulk` takes it. */
export interface AddCandidate {
  keyPackage: Uint8Array;
  deviceId: string;
  userId: string;
}

/** What {@link addDevicesRebuildingOnRace} did. */
export type RacedAddResult =
  /** The Add commit MERGED: every field is `addMembersBulk`'s, for the devices the tree lacked. */
  | {
      kind: 'added';
      welcome?: Uint8Array;
      ratchetTree?: Uint8Array;
      addedDeviceIds: string[];
      skipped: SkippedDevice[];
    }
  /**
   * Every candidate holds a leaf in the tree CONFIRMED at the server's epoch - by the commit that
   * won a race, or before: no commit.
   */
  | { kind: 'already-in-tree' };

/** What a member gesture's Add rests on, and what it carries - see {@link addDevicesRebuildingOnRace}. */
export interface RacedAddOptions {
  /**
   * Re-checks, in each pass, what the gesture rests on; throws {@link AddAbortedError} when it no
   * longer holds.
   */
  confirmPremise?: (attempt: number) => Promise<void>;
  /**
   * The premise reads the TREE'S OWN RECORD (`removalEpochs`), so it is only an answer on a tree
   * CONFIRMED at the server's epoch: the tree is confirmed in every pass, whatever it holds, and the
   * premise is checked AFTER that confirmation. Without it a departure in a commit this device had
   * not applied yet - the very commit that won - is invisible, and the Add undoes it.
   */
  premiseReadsTree?: boolean;
  /**
   * A member's invitation only: carried into each commit's intent, so a commit that is kept and then
   * does not land is re-planned rather than lost (`owedInvitations.ts`).
   */
  invitation?: CommitInvitation;
}

/**
 * The bulk Add every member gesture makes (an invitation, a 1:1 creation, a group's own devices),
 * rebuilt on a lost race by {@link rebuildOnRace}. Each pass re-checks the caller's premise
 * (`confirmPremise`), reads the tree and offers only the candidates without a leaf, so a winner that
 * admitted one of them (its own external join, another member's Add) is never added twice. Every
 * candidate is excluded from the commit's fan-out - an added device gets the Welcome, a skipped one
 * is not in the group - exactly as each caller did.
 *
 * **A CANDIDATE IS DROPPED ONLY ON A TREE CONFIRMED CURRENT** ({@link readConfirmedTree}, the helper
 * a Remove's "out" reads too, under the MLS lock): a tree behind a Remove still shows the removed
 * device, and filtering on it would skip an Add that is owed - or answer `already-in-tree` for
 * people nobody added. A tree holding none of the candidates needs no confirmation - the gate decides
 * the commit built on it - unless the premise reads the tree's own record (`premiseReadsTree`). One
 * that cannot be confirmed aborts ({@link AddAbortedError} `tree-unconfirmed`), never "added".
 *
 * @param actingUserId - this device's user, for the catch-up that confirms the tree.
 * @throws {@link AddAbortedError} before any stage; otherwise what the last attempt threw when it
 *   proves no progress - a race refusal that moved nothing included (`isCommitRaceRefusal`).
 */
export async function addDevicesRebuildingOnRace(
  mlsService: IMlsService,
  groupId: string,
  actingUserId: string,
  candidates: AddCandidate[],
  log: (msg: string) => void,
  opts: RacedAddOptions = {}
): Promise<RacedAddResult> {
  const { confirmPremise, premiseReadsTree = false, invitation } = opts;
  const holdsAny = (leaves: readonly string[]) =>
    candidates.some((d) => treeHoldsDevice(leaves, d.userId, d.deviceId));
  return rebuildOnRace(
    mlsService,
    groupId,
    `the Add of ${candidates.length} device(s)`,
    async (attempt) => {
      if (!premiseReadsTree) await confirmPremise?.(attempt);
      const reading = await readConfirmedTree(
        mlsService,
        groupId,
        actingUserId,
        '[COMMIT_RACE]',
        (leaves) => !premiseReadsTree && !holdsAny(leaves)
      );
      if (reading.status === 'unconfirmed') {
        throw new AddAbortedError(
          groupId,
          'tree-unconfirmed',
          'which candidates already hold a leaf is unknown'
        );
      }
      if (premiseReadsTree) await confirmPremise?.(attempt);
      const missing = candidates.filter(
        (d) => !treeHoldsDevice(reading.identities, d.userId, d.deviceId)
      );
      if (missing.length === 0) {
        log(
          `[COMMIT_RACE] ${groupId.slice(0, 8)}... all ${candidates.length} device(s) already hold a leaf at the server's epoch - no Add`
        );
        return { kind: 'already-in-tree' } as const;
      }
      const bulk = await mlsService.addMembersBulk(
        groupId,
        missing,
        missing.map((d) => `${d.userId}:${d.deviceId}`),
        invitation
      );
      return { kind: 'added', ...bulk } as const;
    },
    log
  );
}
