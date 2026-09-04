import type { IMlsService } from '$lib/mls-client/IMlsService';
import { republishBaseIfStale } from '$lib/utils/chat/staleBase';
import {
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import { ChannelApiError, type ChannelService } from '$lib/services/ChannelService';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import { requestCommunityHistory } from './repair';
import { reconcileDistributionGroupRoster } from './rosterReconcile';
import { isGraineReady, requireGraineRuntime } from './runtime';

/**
 * Joining a Graine key-distribution group, on first use - a community's, or a private salon's.
 *
 * WHY THIS SITS BETWEEN THE TWO SERVICES. The group id and its published base come from
 * social-service, which is the only service holding the roster and therefore the only one that may
 * hand out a GroupInfo - the GroupInfo being the capability to enter the group and read every seed
 * on it. Everything after that is MLS. Neither layer should learn to speak the other's language, so
 * the seam is here: one function, called wherever a community or a private salon is loaded.
 *
 * Protocol and the reasoning behind the split: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Ensures this device is in `scope`'s key-distribution group, joining or creating it.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT. Nothing here is derived from a "done" flag: the answer comes from
 * state that already exists, on BOTH sides - the group this device holds, and the delivery rows the
 * group holds for it. One of those alone is not membership. A device can hold the MLS group and be
 * routed nothing (it was evicted while offline), and a device routed something may not hold the
 * group yet (a fresh install). Only the pair says whether a join is owed - see the comment on the
 * comparison below, and `WP-REGRANT-1` in `docs/wiki/backlog.md` for what believing one of them
 * cost.
 *
 * ONE FUNCTION FOR BOTH SCOPES, because it is one mechanism: a private salon's group differs only
 * in whose roster it carries, and a second copy of this would be a second place for the join, the
 * reconciliation and the history request to drift apart.
 *
 * ONE EXECUTION PER SCOPE AT A TIME, and that is not an optimisation - see {@link inFlight}.
 *
 * @returns true when the device holds the group afterwards. False is a REPORTED failure, not a
 *   silent one: every branch that returns it has logged which of the causes it was.
 */
export function ensureDistributionGroupFor(
  mlsService: IMlsService,
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  // THE CALLERS OVERLAP, AND THE OVERLAP IS THE DEFECT - so it is deleted here rather than repaired
  // downstream. Three call sites reach this for one salon (creating it, loading the workspace that
  // now lists it, joining it in-session) and two of them fire on ONE gesture: creating a private
  // salon initialises its MLS state, and the workspace refetch that puts the salon in the sidebar
  // walks every private channel and enters its group.
  //
  // Measured on production 2026-08-21, W1 creating a salon during COMM-22, one second apart:
  //
  //   11:41:58  created                published=false devices=0
  //   11:41:59  read                   published=false devices=0
  //   11:41:59  group-info epoch=0 stored=true
  //   11:41:59  group-info epoch=0 stored=true     <- the same base published twice
  //   11:42:01  read                   published=true  devices=1
  //
  // Both calls read a group with no roster row, both created and published epoch 0, and the second
  // one then found a group held locally that the server named no row for - which is the signature of
  // an eviction - so it took the repair branch, FORGOT the tree it had just built and external-joined
  // again, costing an extra epoch and leaving its first leaf behind. The repair was right about what
  // it saw; what it saw was the other call's half-finished work.
  //
  // Sharing the promise is the whole fix: every caller wants the same postcondition ("this device is
  // in this scope's group"), so the second one wants the first one's answer, not a second attempt at
  // it. Keyed on the scope, which is the durable identity of the thing being joined - not on a flag
  // saying it was done once, which would be a second bookkeeping layer able to lag the tree. The
  // entry is removed in `finally`, so nothing survives the call and a later join is unaffected.
  const key = scopeLabel(scope);
  const running = inFlight.get(key);
  if (running) {
    log(`[GRAINE] ${key}: a join is already in flight for this scope - awaiting it`);
    return running;
  }
  const attempt = joinDistributionGroup(mlsService, channelService, scope, log).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, attempt);
  return attempt;
}

/**
 * Joins in progress, by scope label.
 *
 * Module-level and deliberately so: the callers that overlap are in different composables and can
 * share nothing else. It holds a promise only for the duration of one call - `finally` deletes the
 * entry - so it is not state about the session and logging out leaves nothing behind.
 */
const inFlight = new Map<string, Promise<boolean>>();

/** {@link ensureDistributionGroupFor} without the in-flight sharing. Never called directly. */
async function joinDistributionGroup(
  mlsService: IMlsService,
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void
): Promise<boolean> {
  // WHAT THIS DEVICE HOLDS, BEFORE ASKING. Only used to decide what a FAILED read may conclude; the
  // membership decision below is taken against the group the SERVER names, not this one.
  const known = mlsService.distributionGroupFor(scope);
  const heldLocally = !!known && mlsService.getLocalGroups().includes(known);

  let ref: {
    groupId: string;
    groupInfo: string | null;
    baseEpoch: number | null;
    activeEpoch: number;
    memberDevices?: string[];
  };
  try {
    ref = await channelService.getDistributionGroup(scope);
  } catch (e) {
    // AN ANSWER IS CLASSIFIED, A NON-ANSWER DEFERS TO WHAT THE DEVICE HOLDS - and the order used to
    // be the other way round, which is the whole defect. Every refusal of this read reached the
    // `heldLocally` branch first, so a 403 - this route ANSWERING - was reported as "could not
    // re-read ... keeping the one this device holds", the sentence written for a lost packet. The
    // status has been on `ChannelApiError` since it was introduced; nothing here read it.
    //
    // So the three cases are separated BEFORE anything is concluded from local state, and only the
    // one that says nothing about entitlement is allowed to fall back on it.
    const refusal = e instanceof ChannelApiError ? e : null;

    // A SCOPE WITH NO GROUP AT ALL is a server-side gap somebody has to fix, and no amount of local
    // state makes it carry seeds.
    if (
      refusal &&
      (refusal.code === 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP' ||
        refusal.code === 'CHANNEL_HAS_NO_DISTRIBUTION_GROUP')
    ) {
      log(`[GRAINE] ${scopeLabel(scope)} has NO distribution group - it cannot carry seeds`);
      return false;
    }

    // 403 IS THIS ROUTE ANSWERING THE QUESTION THE JOIN IS ASKING. It authorizes on membership of
    // the scope - the fact only social-service holds, and the reason the GroupInfo is served from
    // here rather than from chat-delivery - so it says this user may not read this scope's seeds.
    // No retry improves that, and neither the roster reconciliation nor the history request below
    // has anything to do on a scope we have just been refused.
    //
    // AT A LEVEL THAT ACCUSES, because reaching it means two server routes disagree: the walk that
    // gets here skips a salon whose channel DTO carries `viewerHasAccess === false`, so a refusal
    // on THIS route contradicts the DTO that selected the salon in the first place. Its rate is
    // what says whether that disagreement is a race on a fresh grant or a durable inconsistency.
    //
    // WHAT IT DELIBERATELY DOES NOT DO IS DROP THE TREE. Dropping key material on one answer is a
    // destructive repair and needs its own evidence; it is also unnecessary here, since the revoke
    // that produces a 403 deletes the delivery rows, so an unentitled device is handed nothing to
    // hold the group for. A later re-grant is picked up by the ordinary read, which stops failing.
    if (refusal?.status === 403) {
      log(
        `[GRAINE] ${scopeLabel(scope)}: this user is NOT entitled to its distribution group (403) - no join is owed and no retry can help, but the channel that selected this scope said the access was there`
      );
      return false;
    }

    // A HELD GROUP SURVIVES A FAILED READ, and only from here down is the read actually failed. This
    // fetch used to happen only when the group was NOT held, so transport could never break a
    // healthy load; now that the answer above depends on it, a fetch that threw for a reason that
    // says nothing about membership must leave that path exactly as it was - the same rule the
    // roster reconciliation already obeys.
    if (heldLocally) {
      log(
        `[GRAINE] could not re-read the distribution group of ${scopeLabel(scope)} (${e instanceof Error ? e.message : String(e)}) - keeping the one this device holds`
      );
      await reconcileRoster(channelService, scope, log);
      await askForHistory(scope, log);
      return true;
    }
    log(
      `[GRAINE] could not read the distribution group of ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }

  // THE PAIR IS RECORDED THE MOMENT IT IS LEARNED, on every branch below.
  //
  // `ensureDistributionGroup` used to be the only thing that registered it, and it is reached only
  // when a join is owed - so a device that held the group but whose registration did not name it
  // returned true from here with `distributionGroupFor(scope)` still null. Everything keyed by
  // SCOPE then behaved as though the group were absent: measured 2026-08-21, both clients logging
  // `no distribution group held for <community|salon> - roster not reconciled` for every community
  // and every salon they were in, on every load. Registering is idempotent and costs nothing.
  mlsService.registerDistributionGroup(scope, ref.groupId);

  // WHAT THIS DEVICE HOLDS, AGAINST WHAT THE GROUP WOULD ACTUALLY DELIVER TO IT.
  //
  // Holding the group is this device's MEMORY of having joined, and it is not evidence of
  // membership: a revoke deletes the delivery rows at once while the MLS removal is committed later
  // by a remaining member, so the commit is published to a group the leaver is already unrouted
  // from and the leaver never receives it. Its local group then says "member" for ever. Re-granted,
  // it took the early return below, reconciled, asked for history, and NEVER re-joined - so nothing
  // put its rows back and it read nothing from that salon again. Measured on production 2026-08-21:
  // three minutes after a re-grant, epoch unchanged, zero rows, every message `no seed for session`.
  //
  // BOTH SIDES OF THE COMPARISON ARE NAMED BY THE SERVER'S OWN ANSWER, and the first attempt at this
  // fix was not: it asked `distributionGroupFor(scope)`, a SECOND bookkeeping layer that can lag
  // behind the tree this device actually holds, and `ensureDistributionGroup` early-returns on the
  // GROUP ID - so a device whose registration did not name the group skipped the check AND skipped
  // the join, which is the bug wearing the fix's clothes. `ref.groupId` is the one name both the
  // server and the MLS layer agree on.
  const holdsTheGroup = mlsService.getLocalGroups().includes(ref.groupId);
  const roster = ref.memberDevices;
  const rosterOmitsThisDevice = Array.isArray(roster) && !roster.includes(mlsService.getDeviceId());

  // AN UNPUBLISHED GROUP HAS NO ROSTER TO DISAGREE WITH, and reading one as an eviction is how a
  // race got a repair. `groupInfo` and `baseEpoch` are null together and only together, and they
  // mean "the row exists but no client has initialised the MLS group yet" - so the delivery rows
  // are not written yet either, and an empty roster is the state BEFORE an answer rather than a
  // negative one. Measured on production 2026-08-25: `published=false devices=0` 74 times in one
  // COMM run, and the salon COMM-22 repaired had been created by that same run minutes earlier.
  //
  // The server derives its own `published=` from exactly this field, so the discriminator was
  // already here; the predicate simply did not carry it to where the decision is taken.
  const published = ref.groupInfo !== null;
  const serverForgotThisDevice = published && rosterOmitsThisDevice;

  if (holdsTheGroup && !Array.isArray(roster)) {
    // NOT A NEGATIVE ANSWER, AND NOT A SILENT ONE EITHER. `undefined` means the question was never
    // put - an older delivery service, or a read that did not name the reader - so behaviour is
    // unchanged, and this line is what separates "the roster agreed" from "nobody asked".
    log(
      `[GRAINE] ${scopeLabel(scope)}: the server named no devices for this user - the group this device holds cannot be checked against the delivery roster`
    );
  }

  if (holdsTheGroup && !published && rosterOmitsThisDevice) {
    // THE BRANCH THAT USED TO BE A DESTRUCTIVE REPAIR, so it is not allowed to become silence. This
    // is the old heal's condition minus publication: without this line, "the roster agreed" and
    // "the roster could not answer yet" reach a run log looking identical.
    log(
      `[GRAINE] ${scopeLabel(scope)}: the distribution group is not published yet, so its ${roster?.length ?? 0}-device roster is not an eviction - keeping the group this device holds`
    );
  }

  if (holdsTheGroup && !serverForgotThisDevice) {
    // Already in the group - but not necessarily holding anything. A device that joined while its
    // answerer was offline would never ask again if the ask lived only on the joining branch, and
    // the request is exactly what decides whether it is needed.
    await republishStaleBase(mlsService, ref, scope, log);
    await reconcileRoster(channelService, scope, log);
    await askForHistory(scope, log);
    return true;
  }

  let staleForgotten = false;
  if (holdsTheGroup) {
    // AT A LEVEL THAT ACCUSES. Reaching this means the two sides had drifted apart and a member was
    // sitting in a salon receiving nothing; the re-join below repairs it, and this line is the only
    // record that it was ever broken. Its RATE is what says whether the drift is rare or routine.
    //
    // BY GROUP ID, because the scope registration is exactly what may be wrong here: the scope form
    // resolves through it, would return null, and would leave the tree standing for the join to
    // early-return on.
    log(
      `[GRAINE] ${scopeLabel(scope)}: this device holds the distribution group but the group holds NO row for it (${roster?.length ?? 0} device(s) for this user) - the local group is stale, rejoining`
    );
    staleForgotten = mlsService.forgetDistributionGroupById(ref.groupId);
  }

  const outcome = await mlsService.ensureDistributionGroup(scope, ref);

  // THE TREE MOVED, SO THE DISK MOVES WITH IT - on the failing outcome as much as the happy one.
  // See {@link persistDistributionTreeChange}: the checkpoint is what makes the difference between
  // a failed re-join this device retries on its next load and one it is stranded by for ever.
  if (staleForgotten || outcome.joined) await persistDistributionTreeChange(mlsService, scope, log);

  if (!outcome.joined) {
    // NAMING THE RECOVERY, because this line used to be the last thing said about a salon that then
    // went unreadable for the rest of the session. What makes the claim true is the checkpoint above.
    //
    // AND NAMING THE CAUSE. Every refusal used to arrive here as one bare `false`, so a base no
    // retry can ever use read exactly like a race we lost - which is how a private salon's second
    // member was left resubmitting the same doomed commit for twenty minutes (production,
    // 2026-08-25). `stale_base` is not this device's to repair: it needs a member that HOLDS the
    // tree to republish, which the branch above does on its own next ordinary read of the salon.
    log(
      `[GRAINE] could not join the distribution group of ${scopeLabel(scope)} (${outcome.reason})` +
        (outcome.reason === 'stale_base'
          ? ` - the published base is at epoch ${outcome.baseEpoch} while the group is at ${outcome.serverEpoch},` +
            ' so no attempt from here can be accepted until a member holding the tree republishes it'
          : '') +
        (staleForgotten
          ? ' - the stale tree is gone from disk too, so the next load asks again instead of restoring it'
          : '')
    );
    return false;
  }

  await reconcileRoster(channelService, scope, log);
  await askForHistory(scope, log);
  return true;
}

/**
 * Republishes a scope's external-join base when the published one is behind the group's real epoch.
 *
 * ONE IMPLEMENTATION, IN `staleBase.ts`, SINCE 2026-09-04. This function was the only repair for a
 * lost base publish, and it ran for distribution groups alone - so the three CONVERSATIONS measured
 * stale on production that day had no cure at all. The predicate, the self-check and the two log
 * shapes moved to `chat/staleBase.ts`, where the connect-time repair for every group also reads
 * them; what stays here is the Graine label, because a `[GRAINE]` line naming its scope is what
 * makes a salon's lockout legible in a run log.
 *
 * The reasoning it carried is on the shared module: only a holder can mint a base, the trigger is
 * this device's ordinary read rather than a timer, termination is the server's own proof
 * (`baseEpoch >= activeEpoch`), and a device whose own tree is behind says so instead of publishing
 * an equally unusable base. Measured on production 2026-08-25 (COMM-8) on a two-member private
 * salon, and again 2026-09-04 across the whole estate.
 */
async function republishStaleBase(
  mlsService: IMlsService,
  ref: { groupId: string; baseEpoch: number | null; activeEpoch: number },
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  await republishBaseIfStale(mlsService, ref, (message) =>
    log(`[GRAINE] ${scopeLabel(scope)}: ${message}`)
  );
}

/** {@link ensureDistributionGroupFor} for a whole community. */
export function ensureCommunityDistributionGroup(
  mlsService: IMlsService,
  channelService: ChannelService,
  workspaceId: string,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  return ensureDistributionGroupFor(mlsService, channelService, workspaceScope(workspaceId), log);
}

/**
 * Writes a distribution-group join or forget to disk, so a reload cannot walk back into it.
 *
 * MEASURED ON PRODUCTION 2026-08-25 (COMM-22, WP-REGRANT-2). A re-granted member re-joined its
 * salon three times and was stranded on the fourth. One second after
 * `could not join the distribution group of salon 5b08828d` its own console said
 * `[SYNC] WASM kept 9a8d1b03` - the checkpoint still held the tree the forget had just dropped, so
 * the reload restored exactly the belief the forget existed to destroy. From there the device held a
 * group the server routed nothing to, took the early return above on every later pass, and read
 * nothing from that salon for the remaining 97 seconds of the run.
 *
 * BOTH OUTCOMES, AND THE FAILING ONE IS WHY THIS EXISTS. A forget followed by a failed join is the
 * state that must survive: it is the only one where memory and disk disagree ABOUT A BELIEF THAT IS
 * WRONG, and the disagreement is resolved by the reload in favour of the wrong side. Persisting it
 * turns a permanent strand into a device that holds nothing for the scope - which is the state every
 * existing trigger already knows how to repair.
 *
 * NOTHING ELSE COVERED IT, in any of the three places it could have: the walk that loads a community
 * does not checkpoint, the MLS layer's join path does not, and the roster reconciliation that runs
 * immediately after a join persists only when it actually removed a leaf. So a CONVERGED join was
 * never durable either, and every reload paid for a fresh external commit and left its previous leaf
 * standing in the tree.
 *
 * NOT A TIMER AND NOT A HEAL. There is no retry loop here and no clock: the next ordinary trigger -
 * a workspace load, the `online` event, opening the salon - finds no group held and joins from a
 * consistent state. What was missing was never a retry, it was the durability that makes one honest.
 *
 * Degrades rather than throws, and says so when it does: this runs inside a load that has already
 * decided what it is doing, and a checkpoint that cannot be written must not fail the join it
 * describes.
 */
async function persistDistributionTreeChange(
  mlsService: IMlsService,
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  if (!isGraineReady()) {
    log(
      `[GRAINE] the distribution tree of ${scopeLabel(scope)} changed in memory only - no Graine runtime to checkpoint through, so a reload before the next write restores the previous state`
    );
    return;
  }
  const { userId, deviceKeyB64 } = requireGraineRuntime('checkpoint a distribution group change');
  await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
}

/**
 * Makes the group's tree agree with the community's roster, best-effort.
 *
 * ON BOTH BRANCHES, and that is the point: the device that just joined is as able to carry a
 * departure as the one that has been in the group for a week, and a mechanism that only ran on one
 * of them would leave a community whose members all reconnect fresh with a tree nobody prunes.
 *
 * It must never fail the join, for the same reason the history request must not: a community whose
 * tree still holds a departed leaf works for every message from now on, badly, and refusing to load
 * it would only mean nobody ever prunes it.
 */
async function reconcileRoster(
  channelService: ChannelService,
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  try {
    await reconcileDistributionGroupRoster(channelService, scope, log);
  } catch (e) {
    log(
      `[GRAINE] roster reconciliation failed for ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Asks the community for a joiner's history, best-effort.
 *
 * ENTERING THE GROUP IS WHAT MAKES ASKING POSSIBLE, so asking belongs here rather than in a caller
 * that would have to know it had just happened. The request decides for itself whether it is needed
 * (this device holds no seed for the community) and whether it has already been made - see
 * {@link requestCommunityHistory}.
 *
 * ONLY ON THE COMMUNITY SCOPE, and that is a decision rather than an omission. The request means
 * "this device holds nothing at all for this community", which a salon join cannot answer: a member
 * joining a private salon already holds the community's seeds, so the ask would short-circuit and
 * they would still be missing the salon's past. What recovers that is the per-message repair, which
 * asks a named holder for the exact sessions a message needs - see `repair.ts`.
 *
 * It must never fail the join: a community whose group is held but whose past is missing still
 * works for every message from now on, and the failure is reported rather than propagated.
 */
async function askForHistory(
  scope: DistributionScope,
  log: (message: string) => void
): Promise<void> {
  if (scope.kind !== 'workspace') return;
  try {
    await requestCommunityHistory(scope.workspaceId);
  } catch (e) {
    log(
      `[GRAINE] could not ask for the history of ${scopeLabel(scope)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
