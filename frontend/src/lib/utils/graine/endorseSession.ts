import { encodeGraineEndorsementV2, graineSeedCommitment } from '$lib/crypto/graineV2';
import type { StoredGraineSession, StoredGraineV2 } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * Makes a freshly minted session a Graine v2 one (channel-encryption section 21, WP-G2-5): a session
 * key pair, and this device's endorsement of it.
 *
 * The endorsement is this device's MLS credential key signing `D` - the salon, the session, the
 * minter and its device, the session's public key, a commitment to the seed and the instant. A
 * member checks it against this device's leaf in the key group, so a seed relayed by anybody else
 * still names, provably, who minted it and which key signs its rows.
 *
 * The secret is returned INSIDE the stored v2 half, which the store seals under the device key; it
 * never travels (`toWireSeed` leaves it out).
 */
export async function endorseNewSession(
  mls: IMlsService,
  session: StoredGraineSession
): Promise<StoredGraineV2> {
  const { secret, publicKey } = await mls.graineSignatureEngine().newSessionKeyPair();
  const minterDeviceId = mls.getDeviceId();
  const descriptor = encodeGraineEndorsementV2({
    channelId: session.channelId,
    sessionId: session.sessionId,
    minterUserId: session.senderId,
    minterDeviceId,
    signingPublicKey: publicKey,
    seedCommitment: await graineSeedCommitment(fromBase64(session.seedB64)),
    createdAt: session.createdAt,
  });
  const endorsement = await mls.signWithDeviceCredential(descriptor);
  console.debug(
    `[GRAINE] session ${session.sessionId.slice(0, 8)} endorsed by device ${minterDeviceId.slice(0, 8)}`
  );
  return {
    minterDeviceId,
    signingPublicKeyB64: toBase64(publicKey),
    endorsementB64: toBase64(endorsement),
    signingSecretKeyB64: toBase64(secret),
  };
}
