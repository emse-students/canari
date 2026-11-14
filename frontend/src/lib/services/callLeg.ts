import type { CallVideoQualityLoop } from '$lib/utils/callVideoQuality';
import type { MediaSnapshot } from '$lib/utils/callStats';
import type { RtpPacketCounts } from '$lib/utils/callE2eReport';

/**
 * The key of a 1:1 call's ONE leg. A 1:1 call keys nothing on the relay's peer id: the other
 * party's device may be REPLACED (a new `PeerReady` with another peer id), and its leg is rebuilt in
 * place, as before group calls.
 */
export const ONE_TO_ONE_LEG = '';

/**
 * The user part of a relay peer id. call-service names each seat `<userId>:<uuid>` (`main.rs`), so
 * the user is everything before the LAST colon, lowercased - the form the group keys are derived
 * under (`utils/callKeys.ts`, `deriveGroupCallKeys`).
 */
export function peerUserOf(peerId: string): string {
  const i = peerId.lastIndexOf(':');
  return (i > 0 ? peerId.slice(0, i) : peerId).toLowerCase();
}

/**
 * ONE LEG OF A CALL: the peer connection to ONE other participant and everything negotiating it
 * (WP-GC2). A 1:1 call is one leg ({@link ONE_TO_ONE_LEG}); a group call - a mesh - is one leg per
 * other participant, keyed by that participant's user id. `CallService` runs every leg through the
 * SAME negotiation, restart, E2E-proof and report code; this class only holds the state each of
 * them owns, so two legs can never read each other's.
 *
 * Every field below used to be a field of `CallService` itself, with the same meaning; their
 * rationale is in `CallService.ts`, where they are used.
 */
export class CallLeg {
  /** The peer connection, or null before the pair formed / after the leg closed. */
  pc: RTCPeerConnection | null = null;
  /** `pc` was built during the caller's ring and has not met its peer yet (1:1 only). */
  awaitingPeer = false;
  /**
   * Which peer connection this leg's transforms belong to (`CallTransformOptions.epoch`): a value
   * of the service's counter, which is never reset, so two legs - or a leg and its rebuilt self -
   * never share one.
   */
  epoch = 0;
  /** Perfect negotiation (W3C WebRTC 10.5): the side that yields on an offer collision. */
  polite = false;
  makingOffer = false;
  ignoreOffer = false;
  pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];
  /** The relay paired this leg at least once (`PeerReady`). */
  arrived = false;
  /** The relay said this leg's party lost its signalling (`PeerAway`), and it has not come back. */
  away = false;
  /** ICE of the CURRENT peer connection reached `connected` at least once. */
  mediaEverConnected = false;
  iceRestarts = 0;
  pairEpoch = 0;
  restartOfferEpoch: number | null = null;
  restartRequestEpoch: number | null = null;
  packetsAtLoss: Promise<number | null> | null = null;
  packetsAtRestart: Promise<number | null> | null = null;
  localOfferSeq = 0;
  pendingOfferSeq: number | null = null;
  /** This leg's remote tracks, merged into one stream (audio + video). */
  mergedRemoteStream: MediaStream | null = null;
  /** This leg's party said its OS holds its microphone (`MicSuspended`). */
  peerMicSuspended = false;

  // -- The E2E evidence of THIS leg's peer connection -------------------------------------------
  e2eSenderSeen = false;
  e2eReceiverSeen = false;
  /** Both sides seen and nothing withdrew it: this leg's share of the screen's claim. */
  e2eProven = false;
  e2eClaimWithdrawn = false;
  e2eConnectChecked = false;
  e2ePathCheckTimer: number | null = null;
  e2ePathCheckReason = '';
  e2eRechecks = 0;
  e2ePathInconclusive = false;
  e2eLastUnjudged = '';
  e2ePrevPackets: RtpPacketCounts | null = null;

  // -- The camera sender and the report of THIS leg's peer connection ---------------------------
  cameraTransceiver: RTCRtpTransceiver | null = null;
  videoQuality: CallVideoQualityLoop | null = null;
  videoSendReduced = false;
  reportTimer: number | null = null;
  reportInFlight: { pc: RTCPeerConnection; snapshot: Promise<MediaSnapshot | null> } | null = null;
  lastSnapshot: MediaSnapshot | null = null;

  /**
   * @param key {@link ONE_TO_ONE_LEG}, or the other participant's user id (lowercased).
   * @param peerId The relay's id of that participant's CURRENT seat (`PeerReady.peer`), what a
   *   group call's frames are addressed to (`to`); replaced when its device is.
   */
  constructor(
    readonly key: string,
    public peerId: string | null
  ) {}

  /** A group call's leg: its frames are addressed, its receiver transforms name its participant. */
  get isGroup(): boolean {
    return this.key !== ONE_TO_ONE_LEG;
  }

  /**
   * The participant this leg's RECEIVER transforms decrypt (`CallTransformOptions.peer`): the
   * user id of a group leg, `undefined` on a 1:1 leg (the worker's one 1:1 receive key).
   */
  get receivePeer(): string | undefined {
    return this.isGroup ? this.key : undefined;
  }

  /**
   * The leg's name in a log line, after `[Call]`: empty on a 1:1 leg, so a 1:1 call's lines are
   * exactly what they were before group calls; ` [leg <user8>]` on a group leg.
   */
  get tag(): string {
    return this.isGroup ? ` [leg ${this.key.slice(0, 8)}]` : '';
  }

  /**
   * Forgets the negotiation of a peer connection that is being REBUILT (the party's device was
   * replaced): the new one earns everything again. The E2E evidence is reset by its owner
   * (`CallService.resetE2eEvidence`), which also clears its pending check.
   */
  resetNegotiation(): void {
    this.cameraTransceiver = null;
    this.lastSnapshot = null;
    this.mergedRemoteStream = null;
    this.pendingRemoteIceCandidates = [];
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.mediaEverConnected = false;
    this.iceRestarts = 0;
    this.restartOfferEpoch = null;
    this.restartRequestEpoch = null;
    this.packetsAtLoss = null;
    this.packetsAtRestart = null;
    this.pendingOfferSeq = null;
  }
}
