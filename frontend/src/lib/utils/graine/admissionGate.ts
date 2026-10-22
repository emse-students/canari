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
import { userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { toBase64 } from '$lib/utils/hex';
import { ACCOUNT_KEY } from '../accountLocalKeys';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { historyVisibilityFor, requireGraineRuntime } from './runtime';

/**
 * WHO MAY BE HANDED A COMMUNITY'S PAST: a member whose admission THIS DEVICE can verify, from what
 * it saw by itself (channel-encryption section 25, decided by the user 2026-10-22).
 *
 * A community stays `shared` by default - a newcomer reads the past - but the past is no longer
 * handed over on the roster's word. Before an answer carries anything from before the asker
 * arrived, the answering device checks that the asker's admission holds against its own LEDGER:
 *
 * - ROOTS: the members present in the community's key group when this device first synced it
 *   after the proof existed, who arrived before {@link ADMISSION_PROOF_SINCE} or created the
 *   community. Recorded once, at that sync (`observeAdmissionState`, called by the roster
 *   reconciliation), never at a moment an ask chooses; a roster row with no leaf in the tree is
 *   never a root.
 * - SIGNER KEYS (not part of the ledger): a voucher is checked against its signer device's key in
 *   the key group's current tree, else the key the MLS layer PINNED for that device on first sight
 *   (`pinnedSignatureKey`, the one trust source shared with #2268) - never a key the server
 *   publishes, so a device the server invents off the tree signs nothing that counts.
 * - REMOVALS: a member whose every leaf left the tree between two observations is recorded as
 *   removed at the epoch this device saw it. An admission placed before a removal no longer admits:
 *   a removed member who comes back with the voucher they had is a newcomer without one.
 * - VERIFIED ADMISSIONS: a voucher counts when its signer was admitted AT THE PLACE IT WAS SIGNED -
 *   a root, or admitted by a voucher placed before, with no removal in between - so a voucher
 *   from a member who has since left still admits, and one signed after their removal does not.
 *   Each one verified is recorded, so the chain survives its signers leaving the roster.
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
 * What it does not do, stated: a device key is pinned on first sight, and the tree admits
 * devices the way MLS BasicCredential does (section 21) - device cross-signing is that work. A
 * removal is seen only by a device that observes the tree between it and the return.
 */

/**
 * The instant the admission proof starts: a member who arrived before it, and was present in the
 * key group when this device first synced the community, is a root (2026-10-22, the day the user
 * decided it). Compared only with the server's own `joinedAt`, recorded once.
 */
export const ADMISSION_PROOF_SINCE = Date.parse('2026-10-22T00:00:00.000Z');

/** What the answer to one asker may carry: everything held, or only from their arrival on. */
export type PastPolicy = GraineHistoryVisibility;

/** What this device recorded about one community. */
interface CommunityAdmissions {
  /** Members rooted at the first sync, with the arrival date the roster showed then. */
  roots: Record<string, number>;
  /** Users with at least one leaf in the key group at the last observation. */
  present: string[];
  /** Removals seen: a user's every leaf gone from the tree, at the place it was seen. */
  removals: Record<string, AdmissionPlace[]>;
  /** Admissions this device verified, at the place each voucher was signed. */
  admissions: Record<string, AdmissionPlace[]>;
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
 * Vouchers whose signatures already verified under their pinned key, so a repair storm does not
 * re-verify the whole roster per request. Whether the SIGNER was admitted is decided every time.
 */
const verifiedSignatures = new Set<string>();

/**
 * Ledger updates run one at a time: each reads, observes and writes the whole ledger, and two
 * interleaved would lose a removal one of them saw.
 */
let ledgerTail: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = ledgerTail.then(work, work);
  ledgerTail = run.catch(() => undefined);
  return run;
}

/**
 * THE GATE, and the only one: what an answer to `frame`'s sender may carry. Both answer paths - the
 * HISTORY bundle and the SESSIONS repair - call it, so the two cannot disagree about a member.
 *
 * `joined` when the community is set to it, or when it shares its past and the asker's admission is
 * not proven, or cannot be checked (fail-closed, at warn). `shared` only for a proven admission.
 */
export async function pastPolicyFor(frame: DistributionFrame): Promise<PastPolicy> {
  if (historyVisibilityFor(frame.workspaceId) === 'joined') return 'joined';
  let proven: boolean;
  try {
    proven = await admissionProven(frame.workspaceId, frame.groupId, frame.sender);
  } catch (e) {
    console.warn(
      `[GRAINE] cannot verify ${frame.sender}'s admission to community ${frame.workspaceId.slice(0, 8)} - ` +
        `answering as 'joined', nothing from before their arrival: ${String(e)}`
    );
    return 'joined';
  }
  if (!proven) {
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
 * Records what this device sees of `workspaceId`'s key group now: the roots on the first call, and
 * the members whose leaves have all gone since the last call. Called at every community sync (the roster reconciliation) and before every check, so
 * the roots are fixed at the first sync after the proof existed and not at a moment an ask chooses.
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
    await observe(ledger, mlsService, workspaceId, keyGroupId, roster);
    writeLedger(self, ledger);
  });
}

/**
 * Whether `subject`'s admission to `workspaceId` is proven to THIS device - see the module comment.
 *
 * @param keyGroupId The community's key group, whose tree is observed and whose epoch places things.
 * @throws When the roster or the tree cannot be read: an admission nobody can check is not a
 *   proven one, and the caller fails closed.
 */
export async function admissionProven(
  workspaceId: string,
  keyGroupId: string,
  subject: string
): Promise<boolean> {
  const { userId: self, mlsService } = requireGraineRuntime('cannot check an admission');
  const who = subject.toLowerCase();
  if (who === self) return true;

  const roster = rosterByUser(await channels().listWorkspaceMembers(workspaceId));
  if (!roster.has(who)) {
    console.info(
      `[GRAINE] ${who} is not on the roster of community ${workspaceId.slice(0, 8)} - no admission to prove`
    );
    return false;
  }

  return serialized(async () => {
    const ledger = readLedger(self);
    const community = await observe(ledger, mlsService, workspaceId, keyGroupId, roster);
    await verifyRosterVouchers(community, mlsService, self, workspaceId, keyGroupId, roster);
    writeLedger(self, ledger);
    // A root counts NOW only while the roster still shows the arrival it was rooted with: one who
    // left and came back has a new row, and needs a voucher like anybody new.
    const rootHolds = community.roots[who] === roster.get(who)?.joinedAt;
    return admittedAt(community, who, 'now', rootHolds);
  });
}

/** See {@link observeAdmissionState}; works on a loaded ledger and returns the community's record. */
async function observe(
  ledger: AdmissionLedger,
  mls: IMlsService,
  workspaceId: string,
  keyGroupId: string,
  roster: Map<string, RosterRow>
): Promise<CommunityAdmissions> {
  const leafIdentities = await mls.getGroupMemberIdentities(keyGroupId);
  const place: AdmissionPlace = { keyGroupId, epoch: mls.getEpoch(keyGroupId) };
  const present = new Set(leafIdentities.map((id) => userIdOfLeaf(id)));

  const known = ledger.communities[workspaceId];
  if (!known) {
    const roots: Record<string, number> = {};
    for (const [user, row] of roster) {
      if ((row.joinedAt < ADMISSION_PROOF_SINCE || row.isCreator) && present.has(user)) {
        roots[user] = row.joinedAt;
      }
    }
    const recorded: CommunityAdmissions = {
      roots,
      present: [...present],
      removals: {},
      admissions: {},
    };
    ledger.communities[workspaceId] = recorded;
    console.info(
      `[GRAINE] admission roots of community ${workspaceId.slice(0, 8)} recorded at key-group epoch ${place.epoch}: ` +
        `${Object.keys(roots).length} of ${roster.size} member(s), present in the tree and there before the proof or its creator`
    );
    return recorded;
  }

  for (const user of known.present) {
    if (present.has(user)) continue;
    (known.removals[user] ??= []).push(place);
    console.info(
      `[GRAINE] ${user} has no leaf left in the key group of community ${workspaceId.slice(0, 8)} - ` +
        `removal recorded at epoch ${place.epoch}: earlier admissions no longer hold`
    );
  }
  known.present = [...present];
  return known;
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
  roster: Map<string, RosterRow>
): Promise<void> {
  const pending = new Map<string, { voucher: AdmissionVoucher; encoded: string }>();
  for (const [user, row] of roster) {
    if (!row.voucher) continue;
    const voucher = readVoucher(workspaceId, user, row.voucher);
    if (voucher && !holdsAdmission(community, user, voucher.place)) {
      pending.set(user, { voucher, encoded: row.voucher });
    }
  }
  let moved = true;
  while (moved && pending.size > 0) {
    moved = false;
    for (const [user, { voucher, encoded }] of pending) {
      const signer = voucher.signer.userId.toLowerCase();
      if (signer !== self && !admittedAt(community, signer, voucher.place, true)) continue;
      pending.delete(user);
      if (!(await signaturesHold(mls, keyGroupId, workspaceId, user, voucher, encoded))) continue;
      (community.admissions[user] ??= []).push(voucher.place);
      moved = true;
    }
  }
  for (const [user, { voucher }] of pending) {
    console.info(
      `[GRAINE] admission voucher of ${user} in community ${workspaceId.slice(0, 8)} not counted: ` +
        `its signer ${voucher.signer.userId} was not admitted here at epoch ${voucher.place.epoch}`
    );
  }
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
 * verified voucher - with no removal seen after that admission and at or before `at`.
 *
 * Places in two different key groups (a community whose key group was rebuilt) cannot be ordered;
 * the reading that hands nothing over is taken: such an admission does not precede `at`, and such
 * a removal does follow the admission and precede `at`.
 */
function admittedAt(
  community: CommunityAdmissions,
  user: string,
  at: AdmissionPlace | 'now',
  rootHolds: boolean
): boolean {
  const removals = community.removals[user] ?? [];
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
    const user = String(row.userId ?? '').toLowerCase();
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
      : voucher.subjectUserId.toLowerCase() !== user
        ? 'it admits somebody else'
        : voucher.signer.userId.toLowerCase() === user
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
 * The ONE trust source for a device's signature key outside the current tree: the pins the MLS
 * layer keeps (`pinnedSignatureKey`, harden/mls-device-binding, #2268) - a key this device saw for
 * that device on first sight and never let change. Shared with every other caller that needs a
 * device key it can stand behind; never a key the server publishes.
 */
interface DevicePins {
  pinnedSignatureKey(userId: string, deviceId: string): Promise<Uint8Array | null>;
}

/**
 * The signer device's key this device stands behind: the one the key group's tree holds for it
 * now, else its pin. `null` when neither knows it - an unpinned signer is unproven.
 *
 * Until this branch is stacked on #2268, a messaging layer without the pin API answers `null` for a
 * device off the tree (said at warn): the gate then hands nothing over, it never asks the server.
 */
async function signerKey(
  mls: IMlsService,
  keyGroupId: string,
  userId: string,
  deviceId: string
): Promise<Uint8Array | null> {
  const inTree = await mls.memberSignatureKey(keyGroupId, `${userId}:${deviceId}`);
  if (inTree) return inTree;
  const pins = mls as IMlsService & Partial<DevicePins>;
  if (typeof pins.pinnedSignatureKey !== 'function') {
    console.warn(
      '[GRAINE] this messaging layer exposes no device pins - an off-tree signer is unproven'
    );
    return null;
  }
  return pins.pinnedSignatureKey(userId, deviceId);
}

/**
 * Whether the voucher's signatures verify under its signer device's key from {@link signerKey}. A
 * signer device neither the tree nor the pins know is refused: a key the server publishes alone is
 * exactly what a forged device would carry.
 */
async function signaturesHold(
  mls: IMlsService,
  keyGroupId: string,
  workspaceId: string,
  user: string,
  voucher: AdmissionVoucher,
  encoded: string
): Promise<boolean> {
  const signer = `${voucher.signer.userId.toLowerCase()}:${voucher.signer.deviceId}`;
  const key = await signerKey(
    mls,
    keyGroupId,
    voucher.signer.userId.toLowerCase(),
    voucher.signer.deviceId
  );
  if (!key) {
    console.warn(
      `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ` +
        `its signer device ${signer} is neither in the key group nor pinned on this device`
    );
    return false;
  }
  const memo = `${toBase64(key)}|${encoded}`;
  if (verifiedSignatures.has(memo)) return true;
  if (await voucherSignaturesHold(voucher, key, mls.graineSignatureEngine())) {
    verifiedSignatures.add(memo);
    return true;
  }
  console.warn(
    `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ` +
      `it does not verify against the key of ${signer}`
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
    // Lost, and said: the next observation records again, from the tree and roster as they stand.
    console.warn(`[GRAINE] the admission ledger could not be written: ${String(e)}`);
  }
}
