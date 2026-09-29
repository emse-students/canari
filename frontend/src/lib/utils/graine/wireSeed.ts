import type { StoredGraineSession, StoredGraineV2 } from '$lib/db/types';
import type { canari } from '$lib/proto/canari';
import { fromBase64, toBase64 } from '$lib/utils/hex';

/**
 * A Graine seed as it travels on a distribution group, in both directions - the ONE place that reads
 * a `GraineMsg` into something the store understands, and the one that writes it back.
 *
 * It used to be spelled out at each of the three places a seed arrives, which is how a field added
 * to the wire reaches two of them. Graine v2 adds five (channel-encryption section 21), and a relay
 * that dropped them would turn every repaired v2 session into one nobody can verify.
 */

/** A seed as a frame states it, before anything has decided whether to hold it. */
export interface IncomingSeed {
  channelId: string;
  sessionId: string;
  seed: Uint8Array;
  firstIndex: number;
  createdAt: number;
  /** The v2 half, exactly as the minter wrote it, or undefined for a v1 seed. */
  v2?: IncomingSeedV2;
}

/** A v2 seed's endorsement fields, not yet verified - checking them is the reader's job. */
export interface IncomingSeedV2 {
  minterUserId: string;
  minterDeviceId: string;
  signingPublicKey: Uint8Array;
  endorsement: Uint8Array;
}

/**
 * Reads a wire seed. A `version` of 2 with any endorsement field missing is NOT degraded to v1: it
 * is returned as a v2 seed with that field empty, so the reader refuses it rather than storing a
 * session whose rows could then carry no signature at all.
 */
export function seedFromWire(graine: canari.GraineMsg.$Properties): IncomingSeed {
  const seed: IncomingSeed = {
    channelId: String(graine.channelId ?? ''),
    sessionId: String(graine.sessionId ?? ''),
    seed: graine.seed instanceof Uint8Array ? graine.seed : new Uint8Array(),
    firstIndex: Number(graine.firstIndex) || 0,
    createdAt: Number(graine.createdAt) || 0,
  };
  if (Number(graine.version) !== 2) return seed;
  return {
    ...seed,
    v2: {
      minterUserId: String(graine.minterUserId ?? ''),
      minterDeviceId: String(graine.minterDeviceId ?? ''),
      signingPublicKey:
        graine.signingPublicKey instanceof Uint8Array ? graine.signingPublicKey : new Uint8Array(),
      endorsement: graine.endorsement instanceof Uint8Array ? graine.endorsement : new Uint8Array(),
    },
  };
}

/** The stored v2 half of an incoming seed. The session secret never travels, so it is never here. */
export function storedV2Of(seed: IncomingSeed): StoredGraineV2 | undefined {
  if (!seed.v2) return undefined;
  return {
    minterDeviceId: seed.v2.minterDeviceId,
    signingPublicKeyB64: toBase64(seed.v2.signingPublicKey),
    endorsementB64: toBase64(seed.v2.endorsement),
  };
}

/**
 * Turns a held session into its wire form. The v2 fields travel UNTOUCHED - the endorsement signs
 * them, so a relay that re-derived any of them would hand over a seed the recipient refuses.
 * `signingSecretKeyB64` is deliberately not among them.
 */
export function toWireSeed(held: StoredGraineSession): canari.GraineMsg.$Properties {
  const wire: canari.GraineMsg.$Properties = {
    channelId: held.channelId,
    sessionId: held.sessionId,
    seed: fromBase64(held.seedB64),
    // The floor travels as ours: a member cannot hand over more than they were given themselves,
    // and raising it here is what stops a repair from widening access.
    firstIndex: held.firstIndex,
    createdAt: held.createdAt,
  };
  if (!held.v2) return wire;
  return {
    ...wire,
    version: 2,
    minterUserId: held.senderId,
    minterDeviceId: held.v2.minterDeviceId,
    signingPublicKey: fromBase64(held.v2.signingPublicKeyB64),
    endorsement: fromBase64(held.v2.endorsementB64),
  };
}
