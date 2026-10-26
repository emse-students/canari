import type { IMlsService } from '$lib/mls-client/IMlsService';
import {
  CommitRefusedError,
  rebuildableRefusal,
  refusedAdmits,
} from '$lib/mls-client/CommitRefusedError';
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
 * - `premise-unreadable`: the server read that would show the premise failed;
 * - `not-admitted`: the gate refused the commit whole for every person it would have admitted
 *   (`ADMIT_REFUSED`), so nobody is left to add.
 */
export type AddAbortReason =
  | 'tree-unconfirmed'
  | 'not-a-member-device'
  | 'invitation-withdrawn'
  | 'removed-meanwhile'
  | 'premise-unreadable'
  | 'not-admitted';

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
      /** The people the gate refused to admit, left out of the commit that merged. */
      notAdmitted: string[];
    }
  /**
   * Every candidate holds a leaf in the tree CONFIRMED at the server's epoch - by the commit that
   * won a race, or before: no commit.
   */
  | { kind: 'already-in-tree'; notAdmitted: string[] };

/** What a member gesture's Add rests on, and what it carries - see {@link addDevicesRebuildingOnRace}. */
export interface RacedAddOptions {
  /**
   * Re-checks, in each pass, what the gesture rests on; throws {@link AddAbortedError} when it no
   * longer holds. `refused` names the people the gate refused to admit so far: they are out of the
   * commit, so their own departure is no longer a premise of it.
   */
  confirmPremise?: (attempt: number, refused: ReadonlySet<string>) => Promise<void>;
  /**
   * The premise reads the TREE'S OWN RECORD (`removalEpochs`), so it is only an answer on a tree
   * CONFIRMED at the server's epoch: the tree is confirmed in every pass, whatever it holds, and the
   * premise is checked AFTER that confirmation. Without it a departure in a commit this device had
   * not applied yet - the very commit that won - is invisible, and the Add undoes it.
   */
  premiseReadsTree?: boolean;
  /**
   * Re-checked UNDER THE MLS LOCK right before the stage (`addMembersBulk`'s `beforeStage`): the
   * part of the premise a commit applied between the confirmation and the stage could break - a
   * Remove of the very person invited. Throws {@link AddAbortedError}; nothing is staged. `refused`
   * is the same set {@link confirmPremise} receives.
   */
  beforeStage?: (refused: ReadonlySet<string>) => Promise<void>;
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
 * **A COMMIT REFUSED WHOLE FOR THE PEOPLE IT WOULD ADMIT IS REBUILT WITHOUT THEM** (`ADMIT_REFUSED`,
 * {@link refusedAdmits}): the gate names them, nothing advanced, and the next pass offers only the
 * other candidates - the invitation it carries loses them too, so a kept commit re-planned later
 * never names them again. TERMINATION IS THE SAME KIND OF PROOF: each such pass drops at least one
 * candidate, and a refusal naming none of them leaves as thrown. None left, and the Add is
 * abandoned (`not-admitted`). The dropped people are returned (`notAdmitted`), so the caller reports
 * them not added.
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
  const { confirmPremise, premiseReadsTree = false, beforeStage, invitation } = opts;
  const refused = new Set<string>();
  let offered = candidates;
  // Counted across every rebuild, so a pass after a refusal re-checks the premise like any rebuild.
  let pass = 0;
  for (;;) {
    const pool = offered;
    const holdsAny = (leaves: readonly string[]) =>
      pool.some((d) => treeHoldsDevice(leaves, d.userId, d.deviceId));
    const carried: CommitInvitation | undefined =
      invitation && refused.size > 0
        ? {
            ...invitation,
            users: invitation.users.filter((u) => !refused.has(u)),
            ...(invitation.rostered
              ? { rostered: invitation.rostered.filter((u) => !refused.has(u)) }
              : {}),
          }
        : invitation;
    const stageCheck = beforeStage ? () => beforeStage(refused) : undefined;
    try {
      const result = await rebuildOnRace(
        mlsService,
        groupId,
        `the Add of ${pool.length} device(s)`,
        async () => {
          const attempt = pass++;
          if (!premiseReadsTree) await confirmPremise?.(attempt, refused);
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
          if (premiseReadsTree) await confirmPremise?.(attempt, refused);
          const missing = pool.filter(
            (d) => !treeHoldsDevice(reading.identities, d.userId, d.deviceId)
          );
          if (missing.length === 0) {
            log(
              `[COMMIT_RACE] ${groupId.slice(0, 8)}... all ${pool.length} device(s) already hold a leaf at the server's epoch - no Add`
            );
            return { kind: 'already-in-tree' } as const;
          }
          const bulk = await mlsService.addMembersBulk(
            groupId,
            missing,
            missing.map((d) => `${d.userId}:${d.deviceId}`),
            carried,
            stageCheck
          );
          return { kind: 'added', ...bulk } as const;
        },
        log
      );
      return { ...result, notAdmitted: [...refused] };
    } catch (e) {
      const named = refusedAdmits(e);
      if (named === null) throw e;
      const dropped = new Set(named.filter((u) => pool.some((d) => d.userId === u)));
      // A refusal naming nobody this commit offered proves nothing a rebuild could change.
      if (dropped.size === 0) throw e;
      for (const u of dropped) refused.add(u);
      offered = pool.filter((d) => !dropped.has(d.userId));
      if (offered.length === 0) {
        log(
          `[COMMIT_RACE] ${groupId.slice(0, 8)}... the gate refused to admit every person the Add offered (${[...refused].join(', ')}) - nobody added`
        );
        throw new AddAbortedError(
          groupId,
          'not-admitted',
          `the gate refused to admit ${[...refused].join(', ')}`
        );
      }
      log(
        `[COMMIT_RACE] ${groupId.slice(0, 8)}... the gate refused to admit ${[...dropped].join(', ')} - rebuilding the Add without them (${offered.length} device(s) left)`
      );
    }
  }
}
