import {
  decodeInviteLinkGrant,
  encodeAdmissionVoucher,
  encodeDirectAdmission,
  encodeInviteLinkGrant,
  LINK_GRANT_DEFAULT_LIFETIME_MS,
  mintInviteLinkGrant,
  redeemInviteLinkGrant,
} from '$lib/crypto/graineAdmission';
import type { AdmissionPlace } from '$lib/crypto/graineAdmission';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';
import { communityKeyGroupOf } from './admissionGate';
import { platformGraineSignatureEngine } from '$lib/mls-client/platformGraineSignatureEngine';
import { requireGraineRuntime } from './runtime';

/**
 * Where an admission proof is MADE (channel-encryption section 25) - one function per way a
 * newcomer arrives. What a member does with one is `admissionGate.ts`.
 *
 * Each signs with THIS device's MLS credential key, the key its leaf in the community's key group
 * carries, so a member checks it against a key it already agreed on.
 */

/**
 * Where this device stands in `workspaceId`'s history now: its key group and that group's epoch.
 * Bound into every admission it signs, so a member who later sees the newcomer removed knows the
 * voucher came before (channel-encryption section 25).
 *
 * @throws When this device holds no key group for the community: it cannot place an admission, so
 *   it signs none - the caller says so, and the newcomer reads from their arrival on.
 */
export function admissionPlaceNow(mlsService: IMlsService, workspaceId: string): AdmissionPlace {
  const keyGroupId = communityKeyGroupOf(mlsService, workspaceId);
  return { keyGroupId, epoch: mlsService.getEpoch(keyGroupId) };
}

/**
 * The voucher this device signs when its member adds `subjectUserId` from the community panel,
 * sent with the invitation and stored on the newcomer's membership row.
 *
 * @throws When the messaging layer is not running here - the caller says so and invites anyway: an
 *   admission without a proof still admits, it gives no past.
 */
export async function signDirectAdmission(
  workspaceId: string,
  subjectUserId: string
): Promise<string> {
  const { mlsService, userId } = requireGraineRuntime('cannot sign an admission');
  const statement = {
    workspaceId,
    subjectUserId: canonicalUserId(subjectUserId),
    signer: { userId, deviceId: mlsService.getDeviceId() },
    place: admissionPlaceNow(mlsService, workspaceId),
    issuedAt: Date.now(),
  };
  const signature = await mlsService.signWithDeviceCredential(encodeDirectAdmission(statement));
  console.info(
    `[GRAINE] admission of ${statement.subjectUserId.slice(0, 8)} to community ${workspaceId.slice(0, 8)} signed by device ${statement.signer.deviceId.slice(0, 8)} at key-group epoch ${statement.place.epoch}`
  );
  return encodeAdmissionVoucher({ kind: 'direct', ...statement, signature });
}

/**
 * The fragment an invite link to `workspaceId` carries, minted by THIS device each time it shows
 * the link: a fresh link key, endorsed by this device. Nothing is stored - two displays give two
 * fragments for one server token, both valid, so any member's device that shows the link can stand
 * behind it without sharing a secret with any other.
 *
 * It carries a SECRET - whoever holds it can admit anyone with a proof - so it lives only in the
 * URL's fragment, which a browser never sends to a server.
 *
 * @param linkExpiresAt The invite link's own expiry (ISO, as the server returns it), or `null` for a
 *   link that never expires - its grant then admits for {@link LINK_GRANT_DEFAULT_LIFETIME_MS}.
 * @returns The fragment, without its `#`.
 */
export async function mintInviteFragment(
  workspaceId: string,
  linkExpiresAt: string | null
): Promise<string> {
  const { mlsService, userId } = requireGraineRuntime('cannot stand behind an invite link');
  const signer = { userId, deviceId: mlsService.getDeviceId() };
  const issuedAt = Date.now();
  const expiresAt =
    linkExpiresAt === null ? issuedAt + LINK_GRANT_DEFAULT_LIFETIME_MS : Date.parse(linkExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    // The display fails rather than signing a grant whose end nobody chose.
    throw new Error(`the invite link's expiry is not a date: ${linkExpiresAt}`);
  }
  const grant = await mintInviteLinkGrant(
    workspaceId,
    signer,
    admissionPlaceNow(mlsService, workspaceId),
    issuedAt,
    expiresAt,
    mlsService.graineSignatureEngine(),
    (message) => mlsService.signWithDeviceCredential(message)
  );
  console.info(
    `[GRAINE] invite link to community ${workspaceId.slice(0, 8)} endorsed by device ${signer.deviceId.slice(0, 8)}`
  );
  return encodeInviteLinkGrant(grant);
}

/**
 * The voucher of `userId` following an invite link whose fragment is `fragment`: the link's grant,
 * redeemed for them with the link's secret. Sent with the accept call and stored on the new
 * membership row.
 *
 * Needs no messaging layer - only this platform's Ed25519 engine - because joining comes before it
 * on a new device: a first sign-in reaches the join page before any MLS client exists.
 *
 * @throws `AdmissionFormatError` for a fragment that is not a grant - the caller says so and joins
 *   anyway, with no past.
 */
export async function voucherFromInviteFragment(fragment: string, userId: string): Promise<string> {
  const grant = decodeInviteLinkGrant(fragment);
  const voucher = await redeemInviteLinkGrant(
    grant,
    canonicalUserId(userId),
    platformGraineSignatureEngine()
  );
  console.info(
    `[GRAINE] invite link to community ${grant.workspaceId.slice(0, 8)} redeemed, endorsed by ${grant.signer.userId.slice(0, 8)}:${grant.signer.deviceId.slice(0, 8)}`
  );
  return encodeAdmissionVoucher(voucher);
}
