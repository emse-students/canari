import type { DistributionFrame, IMlsService } from '$lib/mls-client/IMlsService';
import type { ChannelMemberDto } from '$lib/services/ChannelService';
import { ChannelService } from '$lib/services/ChannelService';
import {
  AdmissionFormatError,
  decodeAdmissionVoucher,
  voucherSignaturesHold,
  type AdmissionPlace,
  type AdmissionVoucher,
} from '$lib/crypto/graineAdmission';
import { canonicalUserId, userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { workspaceScope } from '$lib/mls-client/distributionScope';
import { toBase64 } from '$lib/utils/hex';
import { ACCOUNT_KEY } from '../accountLocalKeys';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { historyVisibilityFor, isGraineReady, requireGraineRuntime } from './runtime';

/**
 * WHO MAY BE HANDED A COMMUNITY'S PAST: a member whose admission THIS DEVICE can verify, from what
 * it saw by itself (channel-encryption section 25, decided by the user 2026-10-22).
 *
 * A community stays `shared` by default - a newcomer reads the past - but the past is no longer
 * handed over on the roster's word. Before an answer carries anything from before the asker
 * arrived, the answering device checks the asker's admission against what it holds itself:
 *
 * - ROOTS (its ledger): the members present in the community's key group when this device first
 *   synced it after the proof existed, who arrived before {@link ADMISSION_PROOF_SINCE} or created
 *   the community. Recorded once, at that sync (`observeAdmissionState`, called by the roster
 *   reconciliation), never at a moment an ask chooses; a roster row with no leaf is never a root.
 * - SIGNER KEYS (the MLS layer, ONE trust source): a voucher is checked against its signer device's
 *   key in the key group's current tree, else the keys the MLS layer pinned for that device
 *   (`pinnedSignatureKeys`) - never a key the server publishes. An unpinned signer, or one pinned
 *   only after a prune (`anchored: false`), is unproven.
 * - REMOVALS (the MLS layer): the epochs at which a merged commit - live or caught up - removed the
 *   user's last leaf from the key group (`removalEpochs`); a device repair is one commit and records none. An admission
 *   placed before a removal no longer admits: a removed member who comes back with the voucher they
 *   had is a newcomer without one. NO REMOVAL SEEN IS "UNKNOWN", NOT PROOF OF CONTINUITY: a member
 *   who arrived after a commit never merged it.
 * - OBSERVATIONS (its ledger): where (the community key group's epoch) and when (its own clock)
 *   this device FIRST SAW each voucher on the roster - only on a DRAINED key group, and driven by
 *   the drain (`whenGroupDrained`). An ask decided before it is `unobserved`, parked, and decided
 *   again by that drain (`parkedAsks.ts`): the answer waits for the key group to catch up.
 * - VERIFIED ADMISSIONS (its ledger): a voucher counts when its signer was admitted WHERE THIS
 *   DEVICE FIRST SAW IT - a root, or admitted by a voucher placed before, with no removal in
 *   between - never at the place the signer wrote, which a removed signer could backdate. So a
 *   voucher from a member who has since left still admits if it was seen before they left, and a
 *   device that saw it late grants less, never more (user, 2026-10-23). A link voucher counts only
 *   if first seen before the expiry signed into it. Each one verified is recorded, so the chain
 *   survives its signers leaving the roster.
 *
 * Anything else - a newcomer through a link that carried no fragment, an admission by an older
 * client, a voucher that does not verify, a ledger that cannot be built - is answered as `joined`:
 * nothing from before their arrival, everything from it on. Never refused whole.
 *
 * WHO MAY SIGN: any admitted member's device, not only the members the product lets add or share a
 * link. That permission is roster data, and reading it would make a voucher depend on the server's
 * current word about its signer - the departed-signer problem again - while adding nothing against
 * a member: one who can sign a voucher holds the past and could hand it over directly.
 *
 * What it does not do, stated: a device key is pinned on first sight, and the tree admits devices
 * the way MLS BasicCredential does (section 21) - device cross-signing is that work.
 */

/**
 * The instant the admission proof starts: a member who arrived before it, and was present in the
 * key group when this device first synced the community, is a root. Compared only with the server's
 * own `joinedAt`, recorded once.
 *
 * THE DAY THE PRODUCTION STABLE CARRYING THE PROOF SHIPS (decided by the user, 2026-10-23), planned
 * for 2026-10-27 UTC. If that stable moves, this line moves with it, before the stable's final
 * pre-release is cut (the release checklist in the backlog says so).
 */
export const ADMISSION_PROOF_SINCE = Date.parse('2026-10-27T00:00:00.000Z');

/** What the answer to one asker may carry: everything held, or only from their arrival on. */
export type PastPolicy = GraineHistoryVisibility;

/**
 * The gate's answer: a {@link PastPolicy}, or `unobserved` - the asker is not proven YET because a
 * voucher on the roster waits for the key group to drain before this device may observe it. Not a
 * refusal: the caller parks the ask and decides it again once the group drains (`parkedAsks.ts`).
 *
 * Or `unverifiable`: the admission could not be CHECKED (the roster or the tree did not read). A
 * fact about this moment, not about the asker, so the caller answers with SILENCE - never a floored
 * seed, which is lasting at the requester, nor a "nothing here for you", recorded for the whole
 * roster (section 24). The requester asks again at its next start.
 */
export type PastDecision = PastPolicy | 'unobserved' | 'unverifiable';

/** Whether an admission is proven, not proven, or not decidable until the key group drains. */
export type AdmissionVerdict = 'proven' | 'unproven' | 'unobserved';

/** What this device recorded about one community. */
interface CommunityAdmissions {
  /** Members rooted at the first sync, with the arrival date the roster showed then. */
  roots: Record<string, number>;
  /** Admissions this device verified, at the place each voucher was signed. */
  admissions: Record<string, AdmissionPlace[]>;
  /**
   * When THIS device first saw each voucher the roster carries (keyed by the stored voucher): the
   * community key group's place then, and this device's clock then. A signer is judged at the
   * observed place, never at the place they wrote; a link's expiry against the observed instant.
   * Absent in a ledger written before observations existed - read as none observed yet.
   */
  observed?: Record<string, Observation>;
}

/** Where and when this device first saw one voucher. */
interface Observation {
  place: AdmissionPlace;
  /** This device's wall clock then - an upper bound for a link's expiry, deciding nothing else. */
  at: number;
}

/** The whole ledger of one account on this device. */
interface AdmissionLedger {
  communities: Record<string, CommunityAdmissions>;
}

/** One member of the roster, as the gate reads it. */
interface RosterRow {
  joinedAt: number;
  isCreator: boolean;
  voucher: string | null;
}

/** Each user's removals from one key group, read once per check. */
type Removals = (user: string) => Promise<AdmissionPlace[]>;

/**
 * Built on first use, never at import, for the reason `historyBoundary.ts` gives: the frame handler
 * is reached from the community-join path very early.
 */
let channelServiceInstance: ChannelService | null = null;
function channels(): ChannelService {
  channelServiceInstance ??= new ChannelService();
  return channelServiceInstance;
}

/**
 * Vouchers whose signatures already verified under a key, so a repair storm does not re-verify the
 * whole roster per request. Whether the SIGNER was admitted is decided every time.
 */
const verifiedSignatures = new Set<string>();

/**
 * Ledger updates run one at a time: each reads, records and writes the whole ledger, and two
 * interleaved would lose what one of them recorded.
 */
let ledgerTail: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = ledgerTail.then(work, work);
  ledgerTail = run.catch(() => undefined);
  return run;
}

/**
 * `workspaceId`'s COMMUNITY key group on this device - the one group whose tree, pins and removals
 * say who the community admitted, and the one every admission is placed in.
 *
 * @throws When this device holds no key group for the community: no admission can be placed or
 *   checked, and the caller says so (an issuer signs nothing, the gate answers `joined`).
 */
export function communityKeyGroupOf(mlsService: IMlsService, workspaceId: string): string {
  const keyGroupId = mlsService.distributionGroupFor(workspaceScope(workspaceId));
  if (!keyGroupId) {
    throw new Error(`this device holds no key group for community ${workspaceId.slice(0, 8)}`);
  }
  return keyGroupId;
}

/**
 * THE GATE, and the only one: what an answer to `frame`'s sender may carry. Both answer paths - the
 * HISTORY bundle and the SESSIONS repair - call it, so the two cannot disagree about a member.
 *
 * `joined` when the community is set to it, or when it shares its past and the asker's admission is
 * not proven. `unverifiable` when it cannot be checked (fail-closed, at warn): answered by silence.
 * `shared` only for a proven admission.
 * `unobserved` when the admission is not proven only because the key group has not drained on this
 * device since a voucher appeared - the caller waits for that drain rather than answering.
 */
export async function pastPolicyFor(frame: DistributionFrame): Promise<PastDecision> {
  if (historyVisibilityFor(frame.workspaceId) === 'joined') return 'joined';
  let verdict: AdmissionVerdict;
  try {
    // The COMMUNITY's key group, whichever group the ask arrived on: a private salon's own group
    // holds that salon's members and its own removals, and neither says who the community admitted.
    const { mlsService } = requireGraineRuntime('cannot check an admission');
    const keyGroupId = communityKeyGroupOf(mlsService, frame.workspaceId);
    verdict = await admissionVerdict(frame.workspaceId, keyGroupId, frame.sender);
  } catch (e) {
    console.warn(
      `[GRAINE] cannot verify ${frame.sender}'s admission to community ${frame.workspaceId.slice(0, 8)} - ` +
        `not answering, so nothing lasting reaches them; they ask again at their next start: ${String(e)}`
    );
    return 'unverifiable';
  }
  if (verdict === 'unobserved') {
    console.info(
      `[GRAINE] ${frame.sender}'s admission to community ${frame.workspaceId.slice(0, 8)} waits for its key group ` +
        `to drain on this device: a voucher on the roster is not observed yet`
    );
    return 'unobserved';
  }
  if (verdict === 'unproven') {
    // A decision, not a loss: the member reads from their arrival on, and a fresh link or an
    // admin's add gives them the rest.
    console.info(
      `[GRAINE] ${frame.sender}'s admission is not proven in community ${frame.workspaceId.slice(0, 8)} - ` +
        `answering as 'joined', nothing from before their arrival`
    );
    return 'joined';
  }
  return 'shared';
}

/**
 * Records `workspaceId`'s roots the first time it is called on this device: the members present
 * in its key group now who arrived before the proof existed or created the community. Called at
 * every community sync (the roster reconciliation) and before every check, so the roots are fixed
 * at the first sync after the proof existed and not at a moment an ask chooses.
 *
 * @param rows The roster when the caller already read it; fetched otherwise.
 * @throws When the roster or the tree cannot be read - nothing is recorded from half a view.
 */
export async function observeAdmissionState(
  workspaceId: string,
  keyGroupId: string,
  rows?: readonly ChannelMemberDto[]
): Promise<void> {
  const { userId: self, mlsService } = requireGraineRuntime('cannot observe admissions');
  const roster = rosterByUser(rows ?? (await channels().listWorkspaceMembers(workspaceId)));
  await serialized(async () => {
    const ledger = readLedger(self);
    const rooted = await recordRoots(ledger, mlsService, workspaceId, keyGroupId, roster);
    const { changed, deferred } = recordObservations(
      ledger.communities[workspaceId],
      mlsService,
      keyGroupId,
      roster
    );
    if (rooted || changed) writeLedger(self, ledger);
    if (deferred > 0) observeWhenDrained(mlsService, workspaceId, keyGroupId);
  });
}

/**
 * Communities (`workspaceId|keyGroupId`) whose observation already waits for a drain, per MLS
 * service: a session that ends takes its pending waits with it, and the next one arms its own.
 */
const observationsAwaitingDrain = new WeakMap<IMlsService, Set<string>>();

/**
 * THE DRAIN DRIVES THE OBSERVATION: a sync that found the key group not drained - the start-up sync
 * runs before the first full pull - observes again the moment it drains, from a fresh roster. Once
 * per community however many syncs deferred; a drain that finds it busy again re-arms it.
 */
function observeWhenDrained(mls: IMlsService, workspaceId: string, keyGroupId: string): void {
  const key = `${workspaceId}|${keyGroupId}`;
  let waiting = observationsAwaitingDrain.get(mls);
  if (!waiting) observationsAwaitingDrain.set(mls, (waiting = new Set()));
  if (waiting.has(key)) return;
  waiting.add(key);
  const armedFor = waiting;
  void mls.whenGroupDrained(keyGroupId).then(onDrained, (e: unknown) => {
    // The service ended first (`GroupDrainAbandonedError`, sign-out): nothing left to observe for.
    armedFor.delete(key);
    console.info(
      `[GRAINE] stopped waiting to observe community ${workspaceId.slice(0, 8)}: ${String(e)}`
    );
  });
  async function onDrained(): Promise<void> {
    armedFor.delete(key);
    if (!isGraineReady() || requireGraineRuntime('cannot observe admissions').mlsService !== mls) {
      console.info(
        `[GRAINE] key group ${keyGroupId.slice(0, 8)} drained after its session ended - nothing observed`
      );
      return;
    }
    console.info(
      `[GRAINE] key group ${keyGroupId.slice(0, 8)} drained - observing the admission vouchers of community ${workspaceId.slice(0, 8)}`
    );
    try {
      await observeAdmissionState(workspaceId, keyGroupId);
    } catch (e) {
      console.warn(
        `[GRAINE] could not observe the admission vouchers of community ${workspaceId.slice(0, 8)} after its key group drained: ${String(e)}`
      );
    }
  }
}

/**
 * Records, for each voucher the roster carries that this device has not seen yet, WHERE and WHEN it
 * first saw it: the community key group's epoch now, and its own clock now. Forgets the vouchers the
 * roster no longer carries, so the record stays the roster's size; seen again later, such a voucher
 * is observed anew, later - which grants less, never more.
 *
 * @returns whether the ledger changed, and how many vouchers wait for the key group to drain.
 */
function recordObservations(
  community: CommunityAdmissions,
  mls: IMlsService,
  keyGroupId: string,
  roster: Map<string, RosterRow>
): { changed: boolean; deferred: number } {
  const before = community.observed ?? {};
  const after: Record<string, Observation> = {};
  // AN OBSERVATION IS A CLAIM ABOUT THE KEY GROUP'S STATE, so it is made only on a state with no
  // commit still held for this device: a removal waiting in the mailbox would otherwise be observed
  // as not yet happened. Not drained, nothing new is observed: the caller waits for the drain
  // (`observeWhenDrained`, a parked ask) and the voucher does not admit before it.
  const drained = mls.isGroupDrained(keyGroupId);
  let added = 0;
  let deferred = 0;
  for (const row of roster.values()) {
    if (!row.voucher) continue;
    const seen = before[row.voucher];
    if (seen) {
      after[row.voucher] = seen;
      continue;
    }
    if (!drained) {
      deferred += 1;
      continue;
    }
    after[row.voucher] = { place: { keyGroupId, epoch: mls.getEpoch(keyGroupId) }, at: Date.now() };
    added += 1;
  }
  const dropped = Object.keys(before).filter((voucher) => !(voucher in after)).length;
  community.observed = after;
  if (added > 0 || dropped > 0) {
    console.info(
      `[GRAINE] admission vouchers observed at key-group epoch ${mls.getEpoch(keyGroupId)}: ${added} new, ${dropped} no longer on the roster`
    );
  }
  if (deferred > 0) {
    console.info(
      `[GRAINE] ${deferred} admission voucher(s) not observed yet: key group ${keyGroupId.slice(0, 8)} is not drained on this device`
    );
  }
  return { changed: added > 0 || dropped > 0, deferred };
}

/**
 * Whether `subject`'s admission to `workspaceId` is proven to THIS device - see the module comment.
 * {@link admissionVerdict}, read as a yes or no: `unobserved` is not proven.
 */
export async function admissionProven(
  workspaceId: string,
  keyGroupId: string,
  subject: string
): Promise<boolean> {
  return (await admissionVerdict(workspaceId, keyGroupId, subject)) === 'proven';
}

/**
 * `subject`'s admission to `workspaceId` as THIS device can judge it now: `proven`, `unproven`, or
 * `unobserved` when it is not proven and some voucher on the roster waits for the key group to drain
 * before this device may observe it - which may prove it, along the chain or directly.
 *
 * @param keyGroupId The community's key group: its tree, its pins and its removals.
 * @throws When the roster or the tree cannot be read: an admission nobody can check is not a
 *   proven one, and the caller fails closed.
 */
export async function admissionVerdict(
  workspaceId: string,
  keyGroupId: string,
  subject: string
): Promise<AdmissionVerdict> {
  const { userId: self, mlsService } = requireGraineRuntime('cannot check an admission');
  const who = canonicalUserId(subject);
  if (who === canonicalUserId(self)) return 'proven';

  const roster = rosterByUser(await channels().listWorkspaceMembers(workspaceId));
  if (!roster.has(who)) {
    console.info(
      `[GRAINE] ${who} is not on the roster of community ${workspaceId.slice(0, 8)} - no admission to prove`
    );
    return 'unproven';
  }

  const removalsCache = new Map<string, Promise<AdmissionPlace[]>>();
  const removals: Removals = (user) => {
    let found = removalsCache.get(user);
    if (!found) {
      found = mlsService
        .removalEpochs(keyGroupId, user)
        .then((epochs) => epochs.map((epoch) => ({ keyGroupId, epoch })));
      removalsCache.set(user, found);
    }
    return found;
  };

  return serialized(async () => {
    const ledger = readLedger(self);
    await recordRoots(ledger, mlsService, workspaceId, keyGroupId, roster);
    const community = ledger.communities[workspaceId];
    const { deferred } = recordObservations(community, mlsService, keyGroupId, roster);
    await verifyRosterVouchers(
      community,
      mlsService,
      self,
      workspaceId,
      keyGroupId,
      roster,
      removals
    );
    writeLedger(self, ledger);
    // A root counts NOW only while the roster still shows the arrival it was rooted with: one who
    // left and came back has a new row, and needs a voucher like anybody new.
    const rootHolds = community.roots[who] === roster.get(who)?.joinedAt;
    if (admittedAt(community, await removals(who), who, 'now', rootHolds)) return 'proven';
    return deferred > 0 ? 'unobserved' : 'unproven';
  });
}

/**
 * Records the community's roots when this device has none for it yet, from the key group's tree as
 * this device merged it and the roster. @returns whether the ledger changed.
 */
async function recordRoots(
  ledger: AdmissionLedger,
  mls: IMlsService,
  workspaceId: string,
  keyGroupId: string,
  roster: Map<string, RosterRow>
): Promise<boolean> {
  if (ledger.communities[workspaceId]) return false;
  const present = new Set(
    (await mls.getGroupMemberIdentities(keyGroupId)).map((id) => userIdOfLeaf(id))
  );
  const roots: Record<string, number> = {};
  for (const [user, row] of roster) {
    if ((row.joinedAt < ADMISSION_PROOF_SINCE || row.isCreator) && present.has(user)) {
      roots[user] = row.joinedAt;
    }
  }
  ledger.communities[workspaceId] = { roots, admissions: {} };
  console.info(
    `[GRAINE] admission roots of community ${workspaceId.slice(0, 8)} recorded at key-group epoch ${mls.getEpoch(keyGroupId)}: ` +
      `${Object.keys(roots).length} of ${roster.size} member(s), present in the tree and there before the proof or its creator`
  );
  return true;
}

/**
 * Verifies the vouchers the roster carries, chain by chain, and records each admission that holds.
 * Each pass admits whoever a member admitted AT THAT PLACE vouched for, until nothing moves.
 */
async function verifyRosterVouchers(
  community: CommunityAdmissions,
  mls: IMlsService,
  self: string,
  workspaceId: string,
  keyGroupId: string,
  roster: Map<string, RosterRow>,
  removals: Removals
): Promise<void> {
  const pending = new Map<
    string,
    { voucher: AdmissionVoucher; encoded: string; observed: Observation }
  >();
  for (const [user, row] of roster) {
    if (!row.voucher) continue;
    const voucher = readVoucher(workspaceId, user, row.voucher);
    if (!voucher || holdsAdmission(community, user, voucher.place)) continue;
    const observed = community.observed?.[row.voucher];
    // Not observed yet - the key group was not drained when this roster was read, and
    // `recordObservations` said so. Never judged where the signer claimed to be instead.
    if (!observed) continue;
    const why = observationRefuses(voucher, observed);
    if (why) {
      console.info(
        `[GRAINE] admission voucher of ${user} in community ${workspaceId.slice(0, 8)} not counted: ${why}`
      );
      continue;
    }
    pending.set(user, { voucher, encoded: row.voucher, observed });
  }
  let moved = true;
  while (moved && pending.size > 0) {
    moved = false;
    for (const [user, { voucher, encoded, observed }] of pending) {
      const signer = canonicalUserId(voucher.signer.userId);
      // THE SIGNER IS JUDGED WHERE THIS DEVICE FIRST SAW THE VOUCHER, never at the place the signer
      // wrote into it: a removed signer could write any place, but not make this device have seen
      // the voucher before their removal.
      if (
        signer !== canonicalUserId(self) &&
        !admittedAt(community, await removals(signer), signer, observed.place, true)
      ) {
        continue;
      }
      pending.delete(user);
      if (!(await signaturesHold(mls, keyGroupId, workspaceId, user, voucher, encoded))) continue;
      (community.admissions[user] ??= []).push(voucher.place);
      moved = true;
    }
  }
  for (const [user, { voucher, observed }] of pending) {
    console.info(
      `[GRAINE] admission voucher of ${user} in community ${workspaceId.slice(0, 8)} not counted: ` +
        `its signer ${voucher.signer.userId} was not admitted here when this device first saw it (epoch ${observed.place.epoch})`
    );
  }
}

/**
 * Why a voucher cannot count given where and when this device first saw it, or `null`:
 * - a place AFTER the observation in the same key group. The observation is made only on a drained
 *   group, so no honest signer was there yet; the newcomer's admission starts at that place, and a
 *   later one would step over removals of the newcomer.
 * - a link observed after the expiry signed into it. This device's clock is the only reference an
 *   instant can be compared with - the key group's epochs order commits, not time - so it bounds the
 *   link and decides nothing else.
 */
function observationRefuses(voucher: AdmissionVoucher, observed: Observation): string | null {
  if (
    voucher.place.keyGroupId === observed.place.keyGroupId &&
    voucher.place.epoch > observed.place.epoch
  ) {
    return `it claims epoch ${voucher.place.epoch}, after this device first saw it at ${observed.place.epoch}`;
  }
  if (voucher.kind === 'link' && observed.at > voucher.expiresAt) {
    return `its invite link had expired when this device first saw it`;
  }
  return null;
}

/** Whether `user` already has an admission recorded at exactly `place`. */
function holdsAdmission(
  community: CommunityAdmissions,
  user: string,
  place: AdmissionPlace
): boolean {
  return (community.admissions[user] ?? []).some(
    (p) => p.keyGroupId === place.keyGroupId && p.epoch === place.epoch
  );
}

/**
 * Whether `user` was admitted at `at` (or now): some admission at or before it - their root, or a
 * verified voucher - with no removal after that admission and at or before `at`. A removal's epoch
 * is the first one the user was out, so a voucher signed at that epoch or later comes after it.
 *
 * Places in two different key groups (a community whose key group was rebuilt) cannot be ordered;
 * the reading that hands nothing over is taken: such an admission does not precede `at`, and such
 * a removal does follow the admission and precede `at`.
 */
function admittedAt(
  community: CommunityAdmissions,
  removals: AdmissionPlace[],
  user: string,
  at: AdmissionPlace | 'now',
  rootHolds: boolean
): boolean {
  const starts: (AdmissionPlace | 'root')[] = [
    ...(community.roots[user] !== undefined && rootHolds ? (['root'] as const) : []),
    ...(community.admissions[user] ?? []),
  ];
  return starts.some((start) => {
    if (start !== 'root' && at !== 'now') {
      if (start.keyGroupId !== at.keyGroupId || start.epoch > at.epoch) return false;
    }
    return !removals.some((removal) => {
      const afterStart =
        start === 'root' || removal.keyGroupId !== start.keyGroupId || removal.epoch > start.epoch;
      const notAfterAt =
        at === 'now' || removal.keyGroupId !== at.keyGroupId || removal.epoch <= at.epoch;
      return afterStart && notAfterAt;
    });
  });
}

function rosterByUser(rows: readonly ChannelMemberDto[]): Map<string, RosterRow> {
  const out = new Map<string, RosterRow>();
  for (const row of rows) {
    const user = canonicalUserId(String(row.userId ?? ''));
    const joinedAt = Date.parse(String(row.joinedAt ?? ''));
    if (!user || !Number.isFinite(joinedAt)) continue;
    out.set(user, {
      joinedAt,
      isCreator: row.isCreator === true,
      voucher: typeof row.admissionVoucher === 'string' ? row.admissionVoucher : null,
    });
  }
  return out;
}

/**
 * A stored voucher, read, and checked to be ABOUT this member of this community - a voucher copied
 * from another row admits nobody. `null` (logged) for anything else.
 */
function readVoucher(workspaceId: string, user: string, encoded: string): AdmissionVoucher | null {
  let voucher: AdmissionVoucher;
  try {
    voucher = decodeAdmissionVoucher(encoded);
  } catch (e) {
    if (!(e instanceof AdmissionFormatError)) throw e;
    console.warn(
      `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ${e.message}`
    );
    return null;
  }
  const why =
    voucher.workspaceId !== workspaceId
      ? 'it admits to another community'
      : canonicalUserId(voucher.subjectUserId) !== user
        ? 'it admits somebody else'
        : canonicalUserId(voucher.signer.userId) === user
          ? 'it is signed by the member it admits'
          : null;
  if (why) {
    console.warn(
      `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ${why}`
    );
    return null;
  }
  return voucher;
}

/**
 * The signer device's keys this device stands behind: the one the key group's tree holds for it
 * now, else the MLS layer's ANCHORED pin for it. `null` when neither holds - an unpinned signer, or
 * one pinned only after a prune (`anchored: false`), is unproven, never forged: fail closed.
 */
async function signerKeys(
  mls: IMlsService,
  keyGroupId: string,
  userId: string,
  deviceId: string
): Promise<Uint8Array[] | null> {
  const inTree = await mls.memberSignatureKey(keyGroupId, `${userId}:${deviceId}`);
  if (inTree) return [inTree];
  const pin = await mls.pinnedSignatureKeys(userId, deviceId);
  if (pin && !pin.anchored) {
    console.info(
      `[GRAINE] signer device ${userId}:${deviceId} is pinned only since a prune (unanchored) - its voucher is unproven`
    );
    return null;
  }
  return pin ? pin.keys : null;
}

/**
 * Whether the voucher's signatures verify under ANY of its signer device's keys from
 * {@link signerKeys}. A signer device neither the tree nor the pins know is refused: a key the
 * server publishes alone is exactly what a forged device would carry.
 */
async function signaturesHold(
  mls: IMlsService,
  keyGroupId: string,
  workspaceId: string,
  user: string,
  voucher: AdmissionVoucher,
  encoded: string
): Promise<boolean> {
  const signer = `${canonicalUserId(voucher.signer.userId)}:${voucher.signer.deviceId}`;
  const keys = await signerKeys(
    mls,
    keyGroupId,
    canonicalUserId(voucher.signer.userId),
    voucher.signer.deviceId
  );
  if (!keys || keys.length === 0) {
    console.warn(
      `[GRAINE] admission voucher of ${user} in community ${workspaceId.slice(0, 8)} unproven: ` +
        `its signer device ${signer} is neither in the key group nor pinned on this device`
    );
    return false;
  }
  const engine = mls.graineSignatureEngine();
  for (const key of keys) {
    const memo = `${toBase64(key)}|${encoded}`;
    if (verifiedSignatures.has(memo)) return true;
    if (await voucherSignaturesHold(voucher, key, engine)) {
      verifiedSignatures.add(memo);
      return true;
    }
  }
  console.warn(
    `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ` +
      `it does not verify against any of the ${keys.length} key(s) of ${signer}`
  );
  return false;
}

function emptyLedger(): AdmissionLedger {
  return { communities: {} };
}

function readLedger(self: string): AdmissionLedger {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.admissionLedger(self));
  } catch (e) {
    console.warn(`[GRAINE] the admission ledger could not be read: ${String(e)}`);
    return emptyLedger();
  }
  if (!raw) return emptyLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<AdmissionLedger> | null;
    if (parsed && typeof parsed === 'object' && parsed.communities) {
      return parsed as AdmissionLedger;
    }
    console.warn('[GRAINE] the admission ledger is not a ledger - read as empty');
  } catch (e) {
    console.warn(`[GRAINE] the admission ledger is not valid JSON - read as empty: ${String(e)}`);
  }
  return emptyLedger();
}

function writeLedger(self: string, ledger: AdmissionLedger): void {
  try {
    localStorage.setItem(ACCOUNT_KEY.admissionLedger(self), JSON.stringify(ledger));
  } catch (e) {
    // Lost, and said: the next sync records the roots again, from the tree and roster as they stand.
    console.warn(`[GRAINE] the admission ledger could not be written: ${String(e)}`);
  }
}
