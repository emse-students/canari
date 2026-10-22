import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { ChannelMemberDto } from '$lib/services/ChannelService';
import { ChannelService } from '$lib/services/ChannelService';
import {
  AdmissionFormatError,
  decodeAdmissionVoucher,
  voucherSignaturesHold,
  type AdmissionVoucher,
} from '$lib/crypto/graineAdmission';
import { ACCOUNT_KEY } from '../accountLocalKeys';
import { deviceSignatureKeysFor } from './endorsement';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { historyVisibilityFor, requireGraineRuntime } from './runtime';

/**
 * WHO MAY BE HANDED A COMMUNITY'S PAST: a member whose admission THIS DEVICE can verify
 * (channel-encryption section 25, decided by the user 2026-10-22).
 *
 * A community stays `shared` by default - a newcomer reads the past - but the past is no longer
 * handed over on the roster's word. The roster is the server's, and a member that believes it hands
 * every seed it holds to whoever the roster names. So before an answer carries anything from before
 * the asker arrived, the answering device checks that the asker's admission is one it can prove:
 *
 * - ROOTED: the asker was a member before the proof existed (arrived before
 *   {@link ADMISSION_PROOF_SINCE}), or created the community. Recorded ONCE per community on this
 *   device, with each root's arrival date, the first time it is needed - so a roster that later
 *   backdates an arrival or names another creator moves nothing here;
 * - VOUCHED: the asker's membership carries a voucher (`graineAdmission.ts`) whose signer's device
 *   key verifies - from the key group's tree, as a Graine v2 endorsement does - and whose signer is
 *   admitted in turn, so a chain of vouchers always ends at a root;
 * - or the asker is this device's own account.
 *
 * Anything else - a newcomer through a link that carried no fragment, an admission by an older
 * client, a voucher that does not verify, a roster that cannot be read - is answered as `joined`:
 * nothing from before their arrival, everything from it on. Never refused whole: the floor is the
 * same one a `joined` community draws.
 *
 * What it does not do, stated: it proves a USER was admitted, not that a device is theirs. A device
 * the server adds under an admitted member's name is that member here, as it is to the v2
 * endorsement (BasicCredential's limit, section 21); that is the device cross-signing work.
 */

/**
 * The instant the admission proof starts: a member who arrived before it is admitted by that date
 * alone, everyone after needs a voucher (2026-10-22, the day the user decided it). A protocol cut,
 * like the v1 seed floor, and never compared with a device clock: only with the server's own
 * `joinedAt`, recorded once ({@link ADMISSION_PROOF_SINCE} is the only constant in the decision).
 */
export const ADMISSION_PROOF_SINCE = Date.parse('2026-10-22T00:00:00.000Z');

/** What the answer to one asker may carry: everything held, or only from their arrival on. */
export type PastPolicy = GraineHistoryVisibility;

/** Members of one community this device recorded as roots, with the arrival date it recorded. */
type Roots = Record<string, number>;

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
 * Vouchers whose signatures this device already checked against a key, so a repair storm does not
 * re-verify the whole roster per request. Only VALID signatures are kept, keyed by the key group and
 * the voucher's exact bytes; whether the SIGNER is admitted is decided again every time.
 */
const verifiedVouchers = new Set<string>();

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
 * Whether `subject`'s admission to `workspaceId` is proven to THIS device - see the module comment.
 *
 * @param keyGroupId The community's key group, whose tree holds the signers' device keys.
 * @throws When the roster cannot be read: an admission nobody can check is not a proven one, and
 *   the caller fails closed.
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

  const admitted = new Set<string>([self]);
  const roots = rootsOf(self, workspaceId, roster);
  for (const [user, row] of roster) {
    if (roots[user] !== undefined && roots[user] === row.joinedAt) admitted.add(user);
  }
  if (admitted.has(who)) return true;

  // A CHAIN OF VOUCHERS ENDS AT A ROOT: each pass admits whoever a member already admitted vouched
  // for, until nothing moves. Bounded by the roster: every pass admits at least one, or it stops.
  const pending = new Map<string, { voucher: AdmissionVoucher; encoded: string }>();
  for (const [user, row] of roster) {
    if (admitted.has(user) || !row.voucher) continue;
    const voucher = readVoucher(workspaceId, user, row.voucher);
    if (voucher) pending.set(user, { voucher, encoded: row.voucher });
  }
  let moved = true;
  while (moved && !admitted.has(who)) {
    moved = false;
    for (const [user, { voucher, encoded }] of pending) {
      if (!admitted.has(voucher.signer.userId.toLowerCase())) continue;
      pending.delete(user);
      if (await signaturesHold(mlsService, keyGroupId, workspaceId, user, voucher, encoded)) {
        admitted.add(user);
        moved = true;
      }
    }
  }
  return admitted.has(who);
}

/** One member of the roster, as the gate reads it. */
interface RosterRow {
  joinedAt: number;
  isCreator: boolean;
  voucher: string | null;
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

/** Whether the voucher's signatures verify under its signer device's key - logged when they do not. */
async function signaturesHold(
  mls: Parameters<typeof deviceSignatureKeysFor>[0],
  keyGroupId: string,
  workspaceId: string,
  user: string,
  voucher: AdmissionVoucher,
  encoded: string
): Promise<boolean> {
  const memo = `${keyGroupId}|${encoded}`;
  if (verifiedVouchers.has(memo)) return true;
  const signer = `${voucher.signer.userId}:${voucher.signer.deviceId}`;
  const keys = await deviceSignatureKeysFor(
    mls,
    keyGroupId,
    voucher.signer.userId,
    voucher.signer.deviceId
  );
  if (keys.kind === 'unanswered') {
    console.warn(
      `[GRAINE] admission voucher of ${user} in community ${workspaceId.slice(0, 8)} not checked: ${keys.why}`
    );
    return false;
  }
  const engine = mls.graineSignatureEngine();
  for (const key of keys.keys) {
    if (await voucherSignaturesHold(voucher, key, engine)) {
      verifiedVouchers.add(memo);
      return true;
    }
  }
  console.warn(
    `[GRAINE] REFUSED admission voucher of ${user} in community ${workspaceId.slice(0, 8)}: ` +
      `it does not verify against ${signer} from the ${keys.source} (${keys.keys.length} key(s))`
  );
  return false;
}

/**
 * The roots of `workspaceId` on this device: recorded the first time they are needed, then never
 * re-read from the roster. A member is a root when they arrived before {@link ADMISSION_PROOF_SINCE}
 * or created the community, and stays one only while the roster still shows THAT arrival - a member
 * who leaves and comes back has a new row, and needs a voucher like any newcomer.
 */
function rootsOf(self: string, workspaceId: string, roster: Map<string, RosterRow>): Roots {
  const all = readAllRoots(self);
  const known = all[workspaceId];
  if (known) return known;
  const roots: Roots = {};
  for (const [user, row] of roster) {
    if (row.joinedAt < ADMISSION_PROOF_SINCE || row.isCreator) roots[user] = row.joinedAt;
  }
  all[workspaceId] = roots;
  writeAllRoots(self, all);
  console.info(
    `[GRAINE] admission roots of community ${workspaceId.slice(0, 8)} recorded: ` +
      `${Object.keys(roots).length} of ${roster.size} member(s) arrived before the proof existed or created it`
  );
  return roots;
}

function readAllRoots(self: string): Record<string, Roots> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.admissionRoots(self));
  } catch (e) {
    console.warn(`[GRAINE] the admission roots could not be read: ${String(e)}`);
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, Roots>;
  } catch (e) {
    console.warn(`[GRAINE] the admission roots are not valid JSON - read as none: ${String(e)}`);
    return {};
  }
  console.warn('[GRAINE] the admission roots are not an object - read as none');
  return {};
}

function writeAllRoots(self: string, all: Record<string, Roots>): void {
  try {
    localStorage.setItem(ACCOUNT_KEY.admissionRoots(self), JSON.stringify(all));
  } catch (e) {
    // Lost, and said: the next check records them again, from the roster as it then stands.
    console.warn(`[GRAINE] the admission roots could not be written: ${String(e)}`);
  }
}
