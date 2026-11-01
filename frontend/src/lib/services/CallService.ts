import { writable, get } from 'svelte/store';
import { resolveServiceUrl } from '$lib/utils/apiUrl';
import type { IMlsService } from '$lib/mls-client';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { holdLeafRefresh } from '$lib/mls-client/leafRefresh';
import { canari } from '../proto/canari.js';
import {
  callEndReasonFromWire,
  encodeAppMessage,
  mkCallAnswered,
  mkCallBusy,
  mkCallHangup,
  mkCallInvite,
  type CallEndReason,
} from '../proto/codec';
import EncryptionWorker from '../workers/encryption.worker?worker';
import { appendLog } from '$lib/utils/sessionLog';
import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';
import { countVideoInputs } from '$lib/reels/cameraAccess';
import { takePendingCallAccept } from '$lib/stores/pendingCallAccept';
import { getToken } from '$lib/stores/auth';
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
  logCallAudioTrackSettings,
} from '$lib/utils/callAudio';
import { publishCallPresence } from '$lib/utils/callPresence';
import { deriveCallKeys, keyFingerprint, type CallKeys, type CallRole } from '$lib/utils/callKeys';
import { callMediaKind, type CallTransformOptions } from '$lib/utils/callFrameAad';
import {
  CallE2eBypassedError,
  CallE2eSetupError,
  CallSetupAbandonedError,
  CallE2eUnsupportedError,
  CallInitiateError,
  CallRelayWithheldError,
  CallSignallingRefusedError,
  describeCallFailure,
  TURN_DISABLED_CODE,
} from '$lib/utils/callFailure';
import { cappedReconnectDelayMs } from '$lib/utils/reconnectBackoff';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { CALLS_ENABLED, CALLS_VIDEO_ENABLED } from '$lib/features';
import { callsAvailableAnswered } from '$lib/utils/callsAvailability';
import { isAppOnScreen, onAppScreenChange } from '$lib/utils/appForeground';
import { serverCallsMode } from '$lib/stores/appVersionCheck.svelte';
import { isBlockedWith, refusalCodeOf } from '$lib/users/blocks';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import {
  audioCodecOrder,
  buildCallReport,
  callReportEngine,
  describeAudioCodecs,
  describeSelectedPair,
  describeVideoStats,
  refusedCallReport,
  relayGapIsSuspect,
  type CallReportContext,
  type MediaSnapshot,
} from '$lib/utils/callStats';
import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { nextPageRingHolder, reportPageRingingCall } from './pageGatewaySocket';
import {
  callVideoConstraints,
  canHoldVideoToVp8,
  preferVp8,
  type CameraFacing,
} from '$lib/utils/callVideo';
import { CallVideoQualityLoop } from '$lib/utils/callVideoQuality';
import {
  describeE2eReport,
  e2eBypassedSides,
  framesFor,
  describePacketCounts,
  inconclusiveMedia,
  readE2eEngineFacts,
  rtpPacketCounts,
  type E2eWorkerReport,
  type RtpPacketCounts,
} from '$lib/utils/callE2eReport';

export type CallState = 'idle' | 'calling' | 'incoming' | 'incall' | 'ended';

/** Remote participant shown on the call UI (avatar + name). */
export interface CallParticipant {
  userId: string;
  displayName: string;
}

/** Remote participant media keyed by sender user id. */
export type RemoteStreams = Map<string, MediaStream>;

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** What `ice-servers` answered: the servers, and the server's code when it withheld the relay (B7). */
interface FetchedIceServers {
  iceServers: RTCIceServer[];
  turnWithheldCode: string | null;
}

/** Optional hook to mirror call lifecycle events into the chat timeline. */
export interface CallChatNotifier {
  onCallStarted: (groupId: string, callId: string) => void | Promise<void>;
  /**
   * A call this device ended (or lost) LOCALLY. `outcome` is the typed reason it ended unanswered,
   * absent for an answered call; `starterId` is the caller, absent when it is this account. The
   * notifier hands it to the ONE call-record writer; remote hangups never come through here.
   */
  onCallEnded: (
    groupId: string,
    callId: string,
    outcome?: CallEndReason,
    starterId?: string
  ) => void | Promise<void>;
}

/**
 * Whether this engine can run the E2E frame transform. It is the ONLY way call media is encrypted
 * end to end, so its absence refuses the call ({@link CallE2eUnsupportedError}) - there is no
 * legacy `createEncodedStreams` path and no "transport-only" call any more.
 */
export function canUseRtpScriptTransform(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/**
 * The ICE policy of a 1:1 call: DIRECT first (host, then server-reflexive), the Cloudflare TURN
 * relay last. Decided by the user on 2026-10-16 - the production host cannot carry media (no UDP
 * out, realtime-media-feasibility section 8) and a direct path costs nothing. The trade, stated
 * once: each party can learn the other's public IP address. `'relay'` would hide it and bill every
 * call through Cloudflare.
 */
export const CALL_ICE_TRANSPORT_POLICY: RTCIceTransportPolicy = 'all';

/**
 * How many times the signalling socket is re-opened after it drops mid-call, on the shared
 * reconnect ladder CAPPED at {@link CALL_SIGNALLING_RESUME_MAX_DELAY_MS} (1, 2, 4, 4, 4... s: on a
 * network that refuses at once, attempt n starts `3 + 4 (n - 2)` s after the loss, the 15th at
 * 55 s). A BUDGET BY COUNT, never by wall time. `call-service` keeps the away seat 60 s
 * (`DEFAULT_P2P_SEAT_GRACE`) counted from when IT holds the socket dead - up to 30 s after the
 * loss on a half-open socket (`MISSED_PONGS_LIMIT`) - so the server MAY still give up first on a
 * black-holed network where every attempt runs its full timeout. Then the resume is answered
 * `call-over` and the call ends - the same outcome the budget would have reached.
 *
 * Was 5 on the UNCAPPED ladder (1, 2, 4, 8, 16 s) until the 2026-10-19 bench reading: a 14 s
 * Wi-Fi outage was only resumed by attempt 5, at +32 s, and a 90 s one was given up at +30 s.
 */
export const CALL_SIGNALLING_RESUME_ATTEMPTS = 15;

/**
 * The longest wait between two resume attempts. A call cannot wait 8 or 16 s for a network that
 * came back - the shared ladder's upper rungs are for a chat socket nobody is listening to.
 */
export const CALL_SIGNALLING_RESUME_MAX_DELAY_MS = 4_000;

/**
 * One resume attempt's deadline, for the socket to open AND the relay to answer `Joined`. Past it
 * the attempt counts as ONE failure and the next is armed. A RESOURCE bound, not a verdict: a
 * socket stuck CONNECTING on a black-holed network would otherwise hold the ladder past the seat
 * grace; a wrong value only costs one attempt of the budget, never the call by itself.
 */
export const CALL_SIGNALLING_RESUME_TIMEOUT_MS = 5_000;

/**
 * How many ICE restarts the initiator makes for ONE loss of the media path, ACROSS signalling
 * pairings (the count resets only when ICE connects again, or the peer connection is rebuilt). An
 * offer that went into a dead socket costs one: that is the price of a bound a flapping peer cannot
 * escape, now that the keepalive can break a pairing every 20-30 s. Each restart after the first is
 * triggered by ICE reporting `failed` or by a re-formed pairing finding the path still down - events,
 * not a clock.
 */
export const CALL_ICE_RESTART_ATTEMPTS = 3;

/**
 * How many times an E2E path check that could not judge some media (an m-line not negotiated yet,
 * a kind with no packet yet - `inconclusiveMedia`) re-arms itself, `E2E_REPORT_DELAY_MS` apart. A
 * BUDGET BY COUNT, never a verdict: past it the check waits for the next completed negotiation,
 * or an event that starts media (`recheckE2eOnMediaStart`). A wrong value costs a later look and a
 * withdrawn claim, never a call.
 */
export const CALL_E2E_PATH_RECHECKS = 6;

/**
 * How often a live call writes its `[CALL_REPORT]` (revival plan section 6, WP-C2). Each tick is
 * armed when the previous one has been WRITTEN, so two never overlap; a wrong value costs lines,
 * never a call.
 */
export const CALL_REPORT_INTERVAL_MS = 10_000;

/** The `engine=` field of every `[CALL_REPORT]` from this device. */
function currentEngine(): string {
  const shell = isAndroidTauriRuntime() ? 'android' : isIosTauriRuntime() ? 'ios' : null;
  return callReportEngine(typeof navigator === 'undefined' ? '' : navigator.userAgent, shell);
}

/** The suffix of an unjudged kind with packets and no frame yet: its verdict is the next check. */
const CARRIED_NO_FRAME_YET = ' carried packets, no frame yet';

/**
 * The media path of `pc` is down by EITHER of its two state machines. Both are read because they
 * disagree in the field: on the Mi 9T (Android Chromium, 2026-10-19) `connectionState` reached
 * `failed` while `iceConnectionState` stayed `disconnected`.
 */
export function mediaPathDown(pc: RTCPeerConnection): boolean {
  const ice = pc.iceConnectionState;
  const conn = pc.connectionState;
  return ice === 'disconnected' || ice === 'failed' || conn === 'disconnected' || conn === 'failed';
}

/**
 * Audio RTP packets received so far on `pc`, summed over its inbound streams - the LIVENESS
 * evidence of a media path, read twice around an outage: a count that did not grow across it is a
 * path that carried nothing, whatever its state machines still say. `null` when there is no
 * inbound audio stream to read (nothing to compare), or the read failed (logged).
 */
export async function inboundAudioPackets(pc: RTCPeerConnection): Promise<number | null> {
  try {
    const stats = await pc.getStats();
    let total = 0;
    let seen = false;
    stats.forEach((report: { type?: string; kind?: string; packetsReceived?: number }) => {
      if (
        report.type === 'inbound-rtp' &&
        report.kind === 'audio' &&
        typeof report.packetsReceived === 'number'
      ) {
        total += report.packetsReceived;
        seen = true;
      }
    });
    return seen ? total : null;
  } catch (e) {
    appendLog(`[Call] reading inbound packet counts failed: ${String(e)}`);
    return null;
  }
}

/** A server-to-client frame of the signalling socket (`apps/call-service`, `SignalMessage`). */
export type SignalFrame =
  | { type: 'Joined'; room_id?: string; resume_token?: string }
  | { type: 'PeerReady'; initiator: boolean; resumed?: boolean }
  | { type: 'PeerLeft' }
  | { type: 'PeerAway' }
  | { type: 'IceRestartRequest' }
  | { type: 'MicSuspended'; suspended: boolean }
  | { type: 'Refused'; reason: string }
  | { type: 'Offer' | 'Answer'; sdp: string }
  | { type: 'IceCandidate'; candidate: string };

/**
 * A session description as it travels inside an `Offer`/`Answer` frame's `sdp` string. `seq` is
 * the offer's IDENTITY: the offerer numbers each offer it sends, the answerer echoes the number of
 * the offer it answers, so an answer is matched to ITS offer and never to a later one (an answer to
 * an offer rolled back after its socket died would otherwise pair with the restart offer that
 * replaced it). It lives inside the string the relay already forwards verbatim, so `call-service`
 * is unchanged; a client older than it sends no `seq` and its answers are matched by signaling
 * state alone, as before.
 */
export type WireDescription = RTCSessionDescriptionInit & { seq?: number };

/** Serialises a local description for the relay, carrying the offer number it is or answers. */
export function wireDescription(
  desc: RTCSessionDescriptionInit | null,
  seq: number | undefined
): string {
  return JSON.stringify({ type: desc?.type, sdp: desc?.sdp, seq });
}

/**
 * Manages 1:1 calls: MLS signalling for ring/answer/hangup, a PEER-TO-PEER media path negotiated
 * through `call-service`'s two-person relay (`/api/call`, `mode: "p2p"`), MLS-derived keys for the
 * mandatory E2E frame transform, and Cloudflare TURN as the last-resort relay.
 */
export class CallService {
  private pc: RTCPeerConnection | null = null;
  /**
   * `pc` was built during the caller's ring and has not met its peer: it gathers candidates
   * (`iceCandidatePoolSize`) and negotiates nothing until `PeerReady` adopts it. Closed by every
   * end of the ring - `endCall`, `cleanup` - like any peer connection, at once rather than after
   * the ended summary, since it holds a TURN allocation for a call nobody answered.
   */
  private pcAwaitingPeer = false;
  private signaledWs: WebSocket | null = null;
  /** ICE servers fetched for this call before ringing, so a missing TURN key fails the call early. */
  private iceServers: RTCIceServer[] | null = null;
  /**
   * The server's code when it withheld the TURN relay for this call (`ice-servers` answered STUN
   * only, B7), else null. Kept so a call that then NEVER connects says why - see
   * {@link neverConnectedCause}.
   */
  private turnWithheldCode: string | null = null;
  /**
   * Perfect negotiation (W3C WebRTC section 10.5). `polite` is the side that yields on an offer
   * collision - the callee, as the server's `PeerReady { initiator: false }` says.
   */
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  /**
   * The ring window's timer, on either side. Its LENGTH is never this file's: it is the
   * `ringTimeoutMs` chat-delivery returned to the caller, relayed to the callee in the invite. A
   * wrong timer only stops a ring early or late; whether a callee may still answer is decided by
   * the server's own deadline (`room-token` answers 410), which no timer here can overrule.
   */
  private ringTimer: number | null = null;
  /** The invite reached the group, so an unanswered end IS a missed call (F7). */
  private inviteSent = false;
  /** The relay paired the two parties: the ring is over whatever the media then does. */
  private peerArrived = false;
  /** `performance.now()` at the user's tap (call or answer): the origin of `dur_ms`. */
  private tapAt: number | null = null;
  /**
   * `performance.now()` when the ring started: on the caller once the ring LEFT (the server's
   * fan-out answered, then the invite - the setup before it is the app's time, not the human's), on
   * the callee its page starting to ring (an answer from a system surface rings the page only as long as the join takes;
   * the native ring before it is not seen here).
   */
  private ringStartAt: number | null = null;
  /** `performance.now()` at the answer: the callee's tap, or the caller's first `PeerReady`. */
  private answeredAt: number | null = null;
  /**
   * The report's `ring_ms` (ring start to the answer) and `connect_ms` (the answer to the first
   * E2E proof). ONE `setup_ms` from the tap held both, so a person taking 40 s to answer read as a
   * 40 s setup (owner, 2026-10-31). `ring_ms` is a human; `connect_ms` is the app.
   */
  private ringMs: number | null = null;
  private connectMs: number | null = null;
  /** The next `[CALL_REPORT]` tick of the current peer connection (`armCallReport`). */
  private reportTimer: number | null = null;
  /**
   * The tick being read and written, if any, with the peer connection it reads: the end report is
   * written after it, and rates against it only if it read the SAME peer connection.
   */
  private reportInFlight: {
    pc: RTCPeerConnection;
    snapshot: Promise<MediaSnapshot | null>;
  } | null = null;
  /**
   * Which call setup is the live one: bumped when `startCall`/`acceptCall` begins and at every
   * `cleanup`, so a setup step resuming after its call ended can tell (`assertSetupLive`).
   */
  private callSetupSeq = 0;
  /** Settles the pending `ensureWorkerKeyReady` wait, if any (`cleanup` calls it). */
  private abandonWorkerKeyWait: (() => void) | null = null;
  /** The previous reading's byte totals on the CURRENT peer connection, so the next states a rate. */
  private lastSnapshot: MediaSnapshot | null = null;
  /**
   * The relay's token for THIS device's seat (`Joined.resume_token`): what lets a new socket take
   * the seat back after the old one dropped. Replaced by every `Joined`.
   */
  private resumeToken: string | null = null;
  /** The signalling socket dropped after the room was joined and has not been resumed yet. */
  private signallingLost = false;
  /** Resume attempts since the loss; reset when a resume is joined. See the attempt budget. */
  private resumeAttempts = 0;
  private resumeTimer: number | null = null;
  private resumeInFlight = false;
  /** The relay said the other party's socket dropped (`PeerAway`) and it has not come back. */
  private peerAway = false;
  /** ICE of the CURRENT peer connection reached `connected` at least once. */
  private mediaEverConnected = false;
  /** ICE restarts since the media path was last connected. See the restart budget. */
  private iceRestarts = 0;
  /**
   * Bumped every time the signalling PAIR breaks (this socket lost, `PeerAway`) or re-forms
   * (`PeerReady`). A restart offer or request belongs to the pairing it was sent in: one sent in
   * an earlier pairing may have gone into a dead socket, so it never blocks a new one.
   */
  private pairEpoch = 0;
  /** The pairing whose restart OFFER awaits its answer (initiator); `null` when none does. */
  private restartOfferEpoch: number | null = null;
  /** The pairing whose restart REQUEST awaits the initiator's offer (polite); `null` when none. */
  private restartRequestEpoch: number | null = null;
  /** Inbound audio packets when the pair broke, compared once it re-forms. */
  private packetsAtLoss: Promise<number | null> | null = null;
  /**
   * Inbound audio packets when the latest restart's negotiation completed (its answer applied on
   * the initiator, the asked-for offer answered on the polite side). Packets counted ABOVE it later
   * prove the restart worked even if ICE never left `connected` - the refund evidence.
   */
  private packetsAtRestart: Promise<number | null> | null = null;
  /** The call whose queued steps were last dropped as stale - logged once per call. */
  private staleStepsOfCall: string | null = null;
  /** The number of the last offer this side sent (see {@link WireDescription}). */
  private localOfferSeq = 0;
  /** The number of this side's offer awaiting its answer; `null` when none is. */
  private pendingOfferSeq: number | null = null;
  /**
   * EVERY negotiation step runs here, one at a time, in order: the relay's frames AND this side's
   * own offers (`negotiationneeded`, an ICE restart). An offer made beside the frame chain could be
   * rolled back or replaced while an answer frame was half applied - the race the async fake of
   * `CallService.p2p.test.ts` reproduces.
   */
  private signalQueue: Promise<void> = Promise.resolve();
  private localStream: MediaStream | null = null;
  private encryptionWorker: Worker | null = null;
  private workerKeyReady: Promise<void> | null = null;
  /**
   * The worker ANSWERED `keyReady` for this call's key. Read synchronously by
   * `attachSenderTransform` / `attachReceiverTransform`, which may not await anything: Chromium
   * short-circuits a transform assigned one task after its sender or transceiver was created
   * (CALL-E2E-BYPASS-MI9T), so the key is in the worker BEFORE the first track is added.
   */
  private workerKeyApplied = false;
  /** A sender transform of the CURRENT peer connection encrypted a frame (worker `inPath`). */
  private e2eSenderSeen = false;
  /** A receiver transform of the CURRENT peer connection decrypted a frame from the peer (`inPath`). */
  private e2eReceiverSeen = false;
  /**
   * Which peer connection a transform belongs to, passed in its options and echoed by the worker
   * (`inPath`, `framesInBy`). Incremented by every `initPeerConnection` and NEVER reset, so a
   * rebuilt peer connection - or a late message from the previous call's worker - can never lend
   * its evidence to this one.
   */
  private transformEpoch = 0;
  /** A path check is due (`scheduleE2ePathCheck`): its timer, so two triggers make one check. */
  private e2ePathCheckTimer: number | null = null;
  /** The triggers the pending path check covers, as its log tag. */
  private e2ePathCheckReason = '';
  /**
   * Re-checks spent on media the last check could not judge. A BUDGET BY COUNT: when it runs out
   * the claim is withdrawn and the check waits for an event that starts media (a negotiation
   * reaching `stable`, a remote track or the camera unmuting - `recheckE2eOnMediaStart`). Reset by
   * a conclusive check and by each such event.
   */
  private e2eRechecks = 0;
  /** The last path check could not judge some media: an event that starts media re-checks. */
  private e2ePathInconclusive = false;
  /** What the last inconclusive check could not judge, so a re-check logs only a CHANGE. */
  private e2eLastUnjudged = '';
  /**
   * The RTP packet counts read by the previous path check of this peer connection - the PROOF a
   * bypass is judged against (`checkE2eInPath`). `null` before the first check of a peer connection.
   */
  private e2ePrevPackets: RtpPacketCounts | null = null;
  /**
   * The screen's claim was WITHDRAWN (a worker that did not answer, media never judged): no frame
   * evidence brings it back, only an answered, conclusive path check (`claimE2eIfProven`).
   */
  private e2eClaimWithdrawn = false;
  /** The worker missed its last report request: the ERROR was logged once, until it answers again. */
  private e2eWorkerSilent = false;
  /** Whether the CURRENT peer connection's first `connected` already scheduled its path check. */
  private e2eConnectChecked = false;
  /**
   * Whether a path check (`scheduleE2ePathCheck`) RAN in this call - media had its delay to flow.
   * The end report judges a side with no frame only when this is true (`diagnoseE2eReport`).
   */
  private e2eReportFired = false;
  /** All remote tracks merged for 1:1 display (audio + video in one MediaStream). */
  private mergedRemoteStream: MediaStream | null = null;
  /** This call's media keys, one per direction (`utils/callKeys.ts`); raw bytes, for the worker. */
  private callKeys: CallKeys | null = null;
  /** The key-mismatch notice (`onUndecryptable`) was shown in this call: once per call. */
  private keyMismatchShown = false;
  private pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];

  /** The call this device rings, joins or runs - read and written through {@link currentCallId}. */
  private _currentCallId: string | null = null;
  /** The call this device rings, joins or runs, or null. */
  public get currentCallId(): string | null {
    return this._currentCallId;
  }
  /**
   * Every write re-judges the call this page rings ({@link syncPageRingingCall}), so the native side
   * hears of the call whichever of the two - the id or the state - moves last.
   */
  public set currentCallId(next: string | null) {
    this._currentCallId = next;
    this.syncPageRingingCall();
  }
  public currentGroupId: string | null = null;
  /** Room access token issued by chat-delivery-service, sent in the SFU Join message. */
  private currentRoomToken: string | null = null;
  /** User id of the peer who rang (incoming); used for avatar when no conversation is selected. */
  public incomingCallerId: string | null = null;
  /** The ringing invite asked for VIDEO (`CallMsg.hasVideo === true`): accepting opens the camera. */
  public incomingHasVideo = false;

  private callHasVideo = false;
  /**
   * Whether this call carries VIDEO: set with the microphone (before `localStreamStore` publishes it,
   * so a reader woken by the stream sees it already), and true once the camera joined mid-call.
   */
  public get hasVideo(): boolean {
    return this.callHasVideo;
  }
  /** Unsubscribes the on-screen listener installed during a call (`onAppScreenChange`); cleanup calls it. */
  private backgroundUnsubscribe: (() => void) | null = null;
  /** True while the camera was auto-paused because the tab/app went to the background. */
  private videoPausedByBackground = false;
  /**
   * When the OS took the microphone (`performance.now()`, monotonic: a wall clock moved by the
   * network time while the phone was locked would misstate the duration), while it holds it;
   * `null` otherwise.
   */
  private micSuspendedSince: number | null = null;
  /** Removes the listeners {@link watchSystemMicrophone} put on the capture track. */
  private micWatchCleanup: (() => void) | null = null;
  /**
   * The transceiver the camera SENDS on, in the current peer connection: the `addTrack` one of a
   * call that started with video, or the FRESH one `toggleVideo` made. Kept across camera off/on
   * and switches - its sender keeps its E2E transform, and `replaceTrack` only changes the capture
   * (measured fed in the rig, rows `video-switch` and `video-off-on`). Null before a camera ever
   * went on in this peer connection.
   */
  private cameraTransceiver: RTCRtpTransceiver | null = null;
  /** A camera operation (on, off, switch) is running; another tap is dropped, except OFF (`offPending`). */
  private cameraBusy = false;
  /**
   * An OFF asked while an on or a switch was in flight: applied when that operation ends, so the
   * last word is OFF whatever the order the two finished in (off always wins).
   */
  private offPending = false;
  /** Where the running camera operation leads: `on` (on, switch) or `off`. */
  private cameraOpTarget: 'on' | 'off' = 'off';
  /** The worker's `videoCodecUnexpected` was logged in this call: one ERROR line, not one per post. */
  private videoCodecUnexpectedLogged = false;
  /**
   * The camera sender's quality ladder (`utils/callVideoQuality.ts`), for the peer connection and
   * sender it was started on; `null` when no camera transceiver exists.
   */
  private videoQuality: CallVideoQualityLoop | null = null;

  public callState = writable<CallState>('idle');
  /**
   * THE UI's "Reconnexion..." flag (`m.call_reconnecting()`): `true` while a call that had
   * connected is getting its connection back - this device's signalling is being resumed, the
   * other party's is (`PeerAway`), or the media path is down and being restarted. A network blip
   * no longer ends the call; this is what the screen shows instead. Always `false` outside a call,
   * and while a call has not connected yet (that is `calling`, not reconnecting).
   */
  public reconnecting = writable<boolean>(false);
  /**
   * THE EVIDENCE behind the screen's "end-to-end encrypted": `true` once this call's worker has
   * encrypted one frame AND decrypted one, both posted from inside the transforms. Never set from a
   * transform being ATTACHED - on Chromium an attached transform could be short-circuited and see
   * nothing while the screen said encrypted (CALL-E2E-BYPASS-MI9T, 2026-10-20). `false` outside a call.
   */
  public e2eProven = writable<boolean>(false);
  /** @deprecated Use remoteStreams for multi-party; kept for single-remote fallback. */
  public remoteStream = writable<MediaStream | null>(null);
  public remoteStreams = writable<RemoteStreams>(new Map());
  public localStreamStore = writable<MediaStream | null>(null);
  public isMuted = writable<boolean>(false);
  /**
   * THIS device's operating system holds the microphone: the capture track is `muted`, which no
   * button here set (that is {@link isMuted}). The other party hears nothing meanwhile. Measured on
   * the iPhone, locked or in the background (CALL-IOS-MIC-HIDDEN, 2026-10-20). `false` outside a call.
   */
  public localMicSuspended = writable<boolean>(false);
  /**
   * The OTHER party's operating system holds ITS microphone, as it said over the relay
   * (`MicSuspended`). Cleared when the other party goes away (`PeerAway`: no fresh evidence) and
   * rebuilt at every pairing from the sender's own truth (see {@link announceMicOnPairing}), never
   * inferred from silence. `false` outside a call.
   */
  public peerMicSuspended = writable<boolean>(false);
  public isVideoOff = writable<boolean>(true);
  /**
   * THIS side's picture is sent reduced: the quality ladder stands at or below
   * `CALL_VIDEO_REDUCED_FROM_RUNG` because the link or the CPU could not carry more. The screen
   * says so while the camera is on. `false` outside a call and while no ladder runs.
   */
  public videoSendReduced = writable<boolean>(false);
  /** Which camera is sending (`user` = the screen side, mirrored in the self view). */
  public cameraFacing = writable<CameraFacing>('user');
  /** The device has more than one camera, so the switch is offered (read once the camera is open). */
  public canSwitchCamera = writable<boolean>(false);
  /**
   * When the media path FIRST reached `connected` (epoch ms), or null before. The call UI derives its
   * timer from this one timestamp (`utils/callClock.ts`) rather than counting ticks, so a frozen
   * background tab or a throttled WebView reads the right duration the moment it paints again, and
   * a transient `disconnected` -> `connected` does not restart it. `incall` is not the moment: the
   * callee enters `incall` at the tap, seconds before any media flows.
   */
  public connectedAt = writable<number | null>(null);
  /** When the call reached `ended` (epoch ms): the summary shows a duration that no longer runs. */
  public endedAt = writable<number | null>(null);

  private chatNotifier: CallChatNotifier | null = null;

  /** Releases the leaf-refresh hold this service took on its call's group, when it holds one. */
  private releaseLeafRefreshHold: (() => void) | null = null;
  /** The group {@link releaseLeafRefreshHold} is for. */
  private leafRefreshHeldGroup: string | null = null;

  /** This instance's name in the native ring's facts (`page_ring.rs`). */
  private readonly pageRingHolder = nextPageRingHolder('call-service');
  /** The call last told to the native side as ringing in this page, or null. */
  private pageRingingCall: string | null = null;
  /**
   * Whether this instance tells the native side the call it rings: in Tauri, until it is retired
   * ({@link retireFromPageRing}). Set in the constructor, so the field initializers that run before
   * it (`_currentCallId`) report nothing.
   */
  private reportsPageRinging = false;
  /** Ends the `callState` subscription that feeds {@link syncPageRingingCall}. */
  private pageRingUnsubscribe: (() => void) | null = null;

  constructor(private mlsService: IMlsService) {
    // NO LEAF REFRESH IN A GROUP WHILE ONE OF ITS CALLS RINGS, IS SET UP OR RUNS. Each end derives
    // the media keys from the group's CURRENT epoch (`setupEncryption`), the caller before the
    // ring and the callee after the answer: a refresh in between - a read receipt sent while it
    // rings is enough - gives the two ends different keys. Held from leaving `idle` until the
    // call is over (`idle` or `ended`); a commit a person asked for is not delayed by it.
    this.callState.subscribe((state) => this.syncLeafRefreshHold(state));
    // THE CALL THIS PAGE RINGS, told to the native side (`page_ring.rs`): the iPhone's handover ends
    // an unanswered CallKit ring only when the page rings THAT call. Holding the socket does not
    // say it: the invite of a call rung at the PIN gate was skipped, and the socket the unlock then
    // opens rings nothing (calls.md, "The handover ends an unanswered ring only when the page rings
    // that call").
    if (isTauriRuntime()) {
      this.reportsPageRinging = true;
      this.pageRingUnsubscribe = this.callState.subscribe(() => this.syncPageRingingCall());
    }
  }

  /**
   * Tells the native side the call this page rings - the one it is `incoming` on - on every change,
   * never on a repeat. Run on every move of the state AND every write of {@link currentCallId}, so it
   * holds whatever order the two are written in.
   */
  private syncPageRingingCall(): void {
    if (!this.reportsPageRinging) return;
    const ringing = get(this.callState) === 'incoming' ? this._currentCallId : null;
    if (ringing === this.pageRingingCall) return;
    this.pageRingingCall = ringing;
    reportPageRingingCall(this.pageRingHolder, ringing);
  }

  /**
   * Retires this instance from the native ring's facts: withdraws the call it said it rings, and
   * says nothing more. Called when the instance is REPLACED (an account switch builds a new one,
   * `useChatSession.initServices`) - a replaced service left `incoming` would otherwise keep a
   * holder nobody withdraws until the next page load.
   */
  public retireFromPageRing(): void {
    if (!this.reportsPageRinging) return;
    this.reportsPageRinging = false;
    this.pageRingUnsubscribe?.();
    this.pageRingUnsubscribe = null;
    if (this.pageRingingCall !== null) {
      this.pageRingingCall = null;
      reportPageRingingCall(this.pageRingHolder, null);
    }
  }

  /** Takes, moves or releases the leaf-refresh hold to follow the call's state and group. */
  private syncLeafRefreshHold(state: CallState): void {
    const groupId = state === 'idle' || state === 'ended' ? null : this.currentGroupId;
    if (groupId === this.leafRefreshHeldGroup) return;
    this.releaseLeafRefreshHold?.();
    this.releaseLeafRefreshHold = groupId ? holdLeafRefresh(groupId, 'call') : null;
    this.leafRefreshHeldGroup = groupId;
  }

  /** Registers callbacks that insert call system messages into the chat timeline. */
  public setChatNotifier(notifier: CallChatNotifier | null): void {
    this.chatNotifier = notifier;
  }

  /**
   * Handles an incoming MLS `CallMsg` for a specific group conversation.
   * Ignores invites from the same user (other device) and dismisses sibling rings on `answered`.
   *
   * Hangups and `answered` frames are handled synchronously; an invite rings only after the
   * block check of {@link admitInvite}, so the returned promise settles once that is decided.
   */
  public async handleCallSignal(
    senderId: string,
    groupId: string,
    callMsg: canari.ICallMsg,
    currentUserId: string,
    currentDeviceId: string
  ): Promise<void> {
    if (!callMsg?.callId) return;

    // Calls are held off (see CALLS_ENABLED). This device no longer initiates, but a peer still
    // running an older build does, and its invite arrives here as an ordinary MLS frame - so the
    // guard belongs at the signal, not at the button. Logged rather than dropped in silence: this
    // line is the only evidence that legacy callers are still out there, and it is what tells a
    // later reader whether the server also needs to refuse the ring.
    if (!CALLS_ENABLED) {
      appendLog(
        `[Call] calls disabled - ignoring signal from ${senderId} in ${groupId} call=${callMsg.callId}`
      );
      return;
    }

    appendLog(`[Call] signal from ${senderId} in ${groupId} call=${callMsg.callId}`);

    const senderNorm = senderId.toLowerCase();
    const userNorm = currentUserId.toLowerCase();
    const signalDeviceId = (callMsg.deviceId ?? '').trim();

    if (callMsg.hangup) {
      if (this.currentCallId === callMsg.callId) {
        // Remote origin: `handleCallSignalForChat` writes this call's record from the same frame.
        this.endCall(false, callEndReasonFromWire(callMsg.endReason), true);
      }
      return;
    }

    if (callMsg.busy) {
      // The callee's device is in another call: only the caller's device, still ringing THIS call,
      // acts on it. Our own other devices (a sibling of the caller, or a busy sibling of the callee
      // answering for itself) have nothing to end.
      if (
        senderNorm !== userNorm &&
        callMsg.callId === this.currentCallId &&
        get(this.callState) === 'calling' &&
        !this.peerArrived
      ) {
        appendLog(`[Call] ${senderId} is busy - ending call ${callMsg.callId} at once`);
        showToast(m.call_busy(), 'info');
        this.endCall(true, 'busy');
      } else {
        appendLog(
          `[Call] busy answer for ${callMsg.callId} ignored (state=${get(this.callState)})`
        );
      }
      return;
    }

    if (callMsg.answered) {
      if (
        callMsg.callId === this.currentCallId &&
        signalDeviceId &&
        signalDeviceId !== currentDeviceId &&
        senderNorm === userNorm &&
        get(this.callState) === 'incoming'
      ) {
        appendLog('[Call] picked up on another device - stopping ring');
        this.dismissIncomingCall();
      }
      return;
    }

    if (callMsg.offerSdp === 'START' || (callMsg.callId && !this.currentCallId)) {
      if (senderNorm === userNorm) {
        appendLog('[Call] ignoring invite from own account on another device');
        return;
      }
      // The server's kill switch (`calls_mode`, B12): with calls closed the server refuses every
      // call request, so an invite that reaches us anyway (a caller on an older client, or one
      // that skipped the server) must not ring a call this estate does not allow.
      if (!(await callsAvailableAnswered())) {
        appendLog(
          `[Call] invite ${callMsg.callId} in ${groupId} not rung - calls are off on the server (mode=${serverCallsMode()})`
        );
        return;
      }
      // The conversation's call permission: the server already withheld the ring push, and the
      // in-app invite is the half it cannot read. The missed-call line is `handleCallSignalForChat`'s
      // to write, from the same predicate, so the timeline has one writer.
      if (!notificationPreferences.callsAllowed(groupId)) {
        appendLog(
          `[Call] invite ${callMsg.callId} in ${groupId} not rung - calls are not allowed in this conversation`
        );
        return;
      }
      // An invite with no window comes from a build before the ring window existed: it would
      // ring here for as long as nobody touched it. Calls are dev-only, so it is refused, named.
      const ringTimeoutMs = callMsg.ringTimeoutMs ?? 0;
      if (ringTimeoutMs <= 0) {
        appendLog(
          `[Call] WARN invite ${callMsg.callId} carries no ring window - an older build, not rung`
        );
        return;
      }

      if (!(await this.admitInvite(senderNorm, callMsg.callId))) return;

      // Only an ADMITTED invite (permission, ring window, no block) can meet a busy device: busy is
      // answered only for an admitted invite. Re-read AFTER the await above, which another invite
      // may have used to take the slot.
      if (get(this.callState) !== 'idle' || this.currentCallId) {
        if (
          !(await this.yieldToOrAnswerBusy(senderNorm, groupId, callMsg.callId, currentDeviceId))
        ) {
          return;
        }
      }

      this.currentCallId = callMsg.callId;
      this.currentGroupId = groupId;
      this.incomingCallerId = senderNorm;
      // Video only when the invite ASKS for it: an invite that says nothing never opens a camera.
      // And only on a build that carries video: an audio-only build (production, 2026-10-21) rings
      // a video invite as an AUDIO call - accepting it never opens the camera.
      this.incomingHasVideo = CALLS_VIDEO_ENABLED && callMsg.hasVideo === true;
      if (callMsg.hasVideo === true && !CALLS_VIDEO_ENABLED) {
        appendLog(
          `[Call] invite ${callMsg.callId} asks for video - this build is audio only, it rings as audio`
        );
      }
      this.callState.set('incoming');
      this.ringStartAt = performance.now();
      this.armRingTimer(callMsg.callId, ringTimeoutMs, 'incoming');
      // An answer already given on a system surface is not looked for here: it joins on its own
      // facts the moment the session can ({@link answerFromSystemSurface}), and this invite, if it
      // arrives after, meets that call as its own redelivery.
    }
  }

  /**
   * JOINS A CALL THE USER ANSWERED ON A SYSTEM SURFACE (the Android ring, iOS CallKit), from the
   * facts that answer carries - never from the caller's MLS `call_invite`.
   *
   * That invite is a TRANSPORT frame: the server hands it only to a device online when it is sent
   * (`TRANSPORT_SKIPPED_OFFLINE`), and a phone the native ring reached was, by construction, closed.
   * Waiting for it made every answer from a closed phone ring out its window into "missed" on both
   * sides (1.5.2-alpha.1, Mi 9T). Nothing the invite carries is needed to join: the conversation,
   * the call and whether it is video came with the ring, and every rule the invite's admission
   * applies here was applied by the server before it rang (calls_mode, the conversation's
   * permission, blocks) and is applied AGAIN by the room token this join asks for - a closed window
   * or a block set since is its `410`/`403`, an answer, not a guess.
   *
   * Called by `pendingCallAccept.ts` once BOTH an intent is held and the session's socket has
   * caught up (`ConnectionDeps.onCaughtUp`), whichever comes second; the intent is taken once
   * ({@link takePendingCallAccept}).
   *
   * @param why What called it, for the log.
   */
  public answerFromSystemSurface(why: string): void {
    if (!CALLS_ENABLED) return;
    const intent = takePendingCallAccept();
    if (!intent) return;
    const state = get(this.callState);
    if (state !== 'idle' && state !== 'incoming' && this.currentCallId === intent.callId) {
      // This answer's call is already being joined, held, or just ended here: a second answer of
      // it is a duplicate - no warning, no second setup, and never a rejoin of a call ended.
      console.debug(`[Call] system-surface answer of call=${intent.callId} - already ${state}`);
      return;
    }
    appendLog(
      `[Call] system-surface answer of call=${intent.callId} (${why}) meets state=${state} call=${this.currentCallId}`
    );
    if (state === 'incoming' && this.currentCallId === intent.callId) {
      // The invite did reach this device (it was online when it left): the same call, answered.
      void this.acceptCall(intent.groupId, intent.callId);
      return;
    }
    if (state === 'ended') this.cleanup();
    if (get(this.callState) !== 'idle') {
      // In another call: the answer cannot be honoured without dropping that one, which only the
      // user decides. Its ring rings out; said, never silent.
      appendLog(
        `[Call] WARN system-surface answer of call=${intent.callId} dropped - this device is in call=${this.currentCallId}`
      );
      return;
    }
    this.currentCallId = intent.callId;
    this.currentGroupId = intent.groupId;
    this.incomingCallerId = intent.callerId ? intent.callerId.toLowerCase() : null;
    this.incomingHasVideo = CALLS_VIDEO_ENABLED && intent.hasVideo;
    this.callState.set('incoming');
    this.ringStartAt = performance.now();
    appendLog(
      `[Call] joining call=${intent.callId} from the system-surface answer - no invite awaited`
    );
    void this.acceptCall(intent.groupId, intent.callId);
  }

  /**
   * Whether an invite from `senderNorm` may ring here. The server refuses `initiate` and `ring`
   * across a block, so an honest caller never sends this invite; a client that skips them can
   * still send the MLS `call_invite` itself, and THIS is where that ring is stopped - a block must
   * not ring the in-app UI either. A failure to ASK is not an answer, so it does not ring and says
   * so at error level. It checks the block ONLY: the caller re-reads the slot after it.
   */
  private async admitInvite(senderNorm: string, callId: string): Promise<boolean> {
    try {
      if (await isBlockedWith(senderNorm)) {
        appendLog(`[Call] invite ${callId} from ${senderNorm} dropped: a block stands between us`);
        return false;
      }
    } catch (e) {
      console.error(`[Call] invite ${callId} not rung: could not ask whether a block stands`, e);
      return false;
    }
    return true;
  }

  /**
   * A new admitted invite meets a device that is not idle. BUSY means THIS DEVICE is in a call.
   *
   * - The invite of the call this device is already in (a redelivery) is itself: ignored, no answer.
   * - The ENDED summary is not a call: it is cleared at once (its timer too) and the invite RINGS,
   *   as a glare loser's does. Dropping it would leave the caller ringing into nothing.
   * - GLARE (both sides calling each other in one conversation): the LOWER callId wins. The winner
   *   ignores the other invite and sends no busy; the loser drops its own call and rings the
   *   winner's. Both sides decide from the two ids alone, so they cannot both yield or both stay.
   * - Otherwise a typed busy frame answers it, which ends the caller's ring at once (a hangup would
   *   have reached every device of the conversation).
   *
   * @returns True when this device is idle again and the invite may ring (a glare it lost).
   */
  private async yieldToOrAnswerBusy(
    senderNorm: string,
    groupId: string,
    callId: string,
    deviceId: string
  ): Promise<boolean> {
    const state = get(this.callState);
    appendLog(
      `[Call] invite ${callId} in ${groupId} meets state=${state} call=${this.currentCallId}`
    );
    if (callId === this.currentCallId) return false;
    if (state === 'ended') {
      appendLog(`[Call] invite ${callId} meets the ended summary - clearing it to ring`);
      this.cleanup();
      return get(this.callState) === 'idle';
    }
    // 'calling' with no id yet is a call still in its setup (`startCall` takes the id from the
    // server after it sets the state): it has rung nobody, so it loses any glare in its conversation.
    if (state === 'calling' && this.currentGroupId === groupId) {
      if (this.currentCallId && this.currentCallId < callId) {
        appendLog(`[Call] glare with ${callId}: this call wins (lower id), no busy sent`);
        return false;
      }
      // The loser's own hangup reaches the winner, whose record writer files it as a missed call
      // from the loser (the loser did call, and the winner never rang for it): accepted.
      appendLog(
        `[Call] glare with ${callId}: this call loses (higher id or none yet) - dropping it to ring`
      );
      this.endCall(true, 'cancelled');
      this.cleanup();
      return get(this.callState) === 'idle';
    }
    try {
      await this.sendMlsNotification(groupId, mkCallBusy(callId, deviceId));
    } catch (e) {
      console.error(`[Call] busy answer for ${callId} to ${senderNorm} not sent`, e);
    }
    return false;
  }

  /** Stops an incoming ring without notifying the group (sibling device answered). */
  private dismissIncomingCall() {
    this.cleanup();
  }

  /**
   * Ends the ring when the server's window closes. On the caller nobody answered: the call ends
   * as a missed one, for both parties (hangup + ring-end). On the callee the caller's own timer
   * does the same, so this only covers a caller that vanished without saying so - the ring stops
   * and nothing is written, the missed-call line being the caller's to write.
   */
  private armRingTimer(callId: string, ringTimeoutMs: number, side: 'calling' | 'incoming') {
    this.clearRingTimer();
    this.ringTimer = window.setTimeout(() => {
      this.ringTimer = null;
      if (this.currentCallId !== callId || get(this.callState) !== side || this.peerArrived) {
        return;
      }
      appendLog(`[Call] ring window (${ringTimeoutMs} ms) closed unanswered - call=${callId}`);
      if (side === 'calling') this.endCall(true, 'not-answered');
      else this.dismissIncomingCall();
    }, ringTimeoutMs);
  }

  private clearRingTimer() {
    if (this.ringTimer !== null) {
      window.clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  /** Starts an outgoing call in the given MLS group. */
  public async startCall(groupId: string, video: boolean = true) {
    // The buttons that call this are not rendered while calls are held off (see CALLS_ENABLED);
    // this guard is the API boundary saying so, so a future caller cannot reopen the surface by
    // accident without reading why it was closed.
    if (!CALLS_ENABLED) {
      appendLog('[Call] calls disabled - startCall refused');
      return;
    }
    if (get(this.callState) !== 'idle') return;
    // Refused BEFORE any request: no room, no ring, nothing the other party could answer.
    if (!canUseRtpScriptTransform()) {
      appendLog(refusedCallReport('-', currentEngine()));
      throw new CallE2eUnsupportedError();
    }

    this.currentGroupId = groupId;
    // An audio-only build never places a video call, whatever its caller asked: the default of
    // `video` is `true`, so this is the boundary that holds it, not the buttons.
    if (video && !CALLS_VIDEO_ENABLED) {
      appendLog('[Call] startCall asked for video - this build is audio only, calling as audio');
      video = false;
    }
    this.tapAt = performance.now();
    const seq = ++this.callSetupSeq;

    try {
      this.callState.set('calling');
      // Get server-issued room ID and access token before connecting.
      const { roomId, roomToken, ringTimeoutMs } = await this.fetchInitiateCall(groupId);
      this.assertSetupLive(seq, 'after the initiate');
      this.currentCallId = roomId;
      this.currentRoomToken = roomToken;
      // Before ringing: a server without TURN credentials (503) fails the call here, not after
      // the callee has answered into a call that can never connect.
      const ice = await this.fetchIceServers(groupId, roomId);
      this.assertSetupLive(seq, 'after the ICE servers');
      this.adoptIceServers(ice);
      await this.setupMedia(video, seq);
      this.installBackgroundHandler();
      await this.setupEncryption(groupId, roomId, 'caller', seq);
      // The caller joins first, so the relay makes it the initiator when the callee arrives.
      await this.connectSignalling(roomId, seq);
      // Before the ring: a call that ended while the socket joined must ring nobody.
      this.assertSetupLive(seq, 'after the join');
      // The peer connection is built NOW and gathers its candidates through the ring, its
      // negotiation held until `PeerReady` adopts it - so the answer meets candidates in hand.
      await this.initPeerConnection({ awaitingPeer: true });
      this.assertSetupLive(seq, 'after the peer connection was built');
      // The ring OPENS the server's answer window, and it goes BEFORE the invite: no callee can
      // learn of the call before the server would hand it a token, so an early answer (a quick tap,
      // an auto-accept) can never meet a 410 and hang up a call that was fine. Nothing the caller
      // did before (ICE servers, a first microphone prompt, the join) eats into the window. The
      // server's clock therefore starts a little BEFORE the callee's timer (armed on the invite's
      // arrival): the ends differ by the invite's delivery time, and a callee answering in that
      // last stretch is told the call is over. WP-XP-5: the ring also fans out call_ring (Android)
      // / APNs VoIP (iOS CallKit) for killed devices.
      await this.triggerServerRing(groupId, roomId, video);
      // From here on devices may be ringing: an unanswered or failed end is a missed call, and the
      // hangup + ring-end must go out. Before it (initiate refused, no ICE servers, no microphone,
      // a refused ring - the server opens the window BEFORE it fans out) nobody was rung.
      this.inviteSent = true;
      // `ring_ms` starts HERE, where the ring left (the server's fan-out, then the invite): the
      // setup before it is the app's, and a callee can answer from its system ring before the
      // invite's own send resolves - so not later than this either.
      this.ringStartAt = performance.now();
      if (!this.stillCalling(roomId, 'after the ring')) {
        // The hangup's ring-end left while this ring was still fanning out, so it may have reached
        // the server FIRST; this one is ordered after a fan-out known to be complete.
        void this.endServerRing(groupId, roomId, 'cancelled');
        return;
      }
      const deviceId = this.mlsService.getDeviceId();
      await this.sendMlsNotification(groupId, mkCallInvite(roomId, video, deviceId, ringTimeoutMs));
      if (!this.stillCalling(roomId, 'after the invite')) return;
      // The caller's timer starts after the window opened, so it never gives up before the server.
      this.armRingTimer(roomId, ringTimeoutMs, 'calling');
      void this.chatNotifier?.onCallStarted(groupId, roomId);
      this.syncCallPresence(true);
    } catch (e) {
      // The call already ended (and was cleaned up, or is showing its summary): nothing to undo,
      // and a step that failed BECAUSE it ended (its socket closed under it) is no failure to show.
      if (e instanceof CallSetupAbandonedError) return;
      if (!this.setupLive(seq)) {
        appendLog(`[Call] a setup step failed after its call ended: ${String(e)} - not reported`);
        return;
      }
      const msg = String(e);
      appendLog(`[Call] startCall failed: ${msg}`);
      console.error('Error starting call:', e);
      // Once the invite has left, the other party is ringing: hang up so it stops, rather than
      // leaving it to ring into a call that will never answer.
      // A setup that failed AFTER the invite left is a call nobody answered, not one the user cancelled.
      this.endCall(this.inviteSent, 'not-answered');
      throw e;
    }
  }

  /** Marks the answer once per call: `ring_ms` closes, `connect_ms` starts (see {@link ringMs}). */
  private markAnswered(who: string): void {
    if (this.answeredAt !== null) return;
    this.answeredAt = performance.now();
    if (this.ringStartAt !== null) this.ringMs = this.answeredAt - this.ringStartAt;
    appendLog(
      `[Call] answered (${who}) ring_ms=${this.ringMs === null ? '-' : Math.round(this.ringMs)}`
    );
  }

  /**
   * Runs one setup step and logs its own duration. The callee's steps run SIDE BY SIDE, so the
   * total says nothing about which one was long: each says its own time, or its failure.
   */
  private async timedStep<T>(step: string, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    const took = () => Math.round(performance.now() - startedAt);
    try {
      const value = await run();
      appendLog(`[Call] setup step ${step}: ${took()} ms`);
      return value;
    } catch (e) {
      // A step stopped because its call ended - a sibling step failed, or a hang-up - did not fail:
      // the line names the step that did, once, and this one says it was abandoned.
      appendLog(
        e instanceof CallSetupAbandonedError
          ? `[Call] setup step ${step} abandoned after ${took()} ms (the call ended)`
          : `[Call] setup step ${step} failed after ${took()} ms: ${String(e)}`
      );
      throw e;
    }
  }

  /**
   * Whether the call `roomId` is still this service's ringing call after an await. A hangup (or a
   * peer leaving) during the await has already cleaned up; going on would arm a timer for nothing
   * or publish presence `active: true` with no call behind it.
   */
  private stillCalling(roomId: string, when: string): boolean {
    if (this.currentCallId === roomId && get(this.callState) === 'calling') return true;
    appendLog(
      `[Call] call ${roomId} ended ${when} (state=${get(this.callState)}) - not arming the ring`
    );
    return false;
  }

  /**
   * THROWS `CallSetupAbandonedError` unless the setup `seq` is still the live one and its call is
   * neither over nor showing its summary. Called after EVERY await of a call's setup: a hangup
   * during the microphone prompt used to let `startCall` resume after `cleanup`, key a NEW worker
   * whose memo outlived the call, and leave the NEXT call's keys unsent - a silent call that the
   * mismatch notice then blamed on the app's version.
   */
  private assertSetupLive(seq: number, step: string): void {
    if (this.setupLive(seq)) return;
    const state = get(this.callState);
    appendLog(`[Call] the call ended during its setup (${step}, state=${state}) - setup abandoned`);
    throw new CallSetupAbandonedError(step);
  }

  /** Whether the setup `seq` is still the live one and its call neither over nor in its summary. */
  private setupLive(seq: number): boolean {
    const state = get(this.callState);
    return seq === this.callSetupSeq && state !== 'idle' && state !== 'ended';
  }

  /** Accepts an incoming call after the user taps accept. */
  public async acceptCall(groupId: string, callId: string, video?: boolean) {
    if (get(this.callState) !== 'incoming') return;

    this.currentGroupId = groupId;
    this.currentCallId = callId;
    // Answered: the server's deadline, not this timer, now decides (a late token is a 410).
    this.clearRingTimer();
    this.tapAt = performance.now();
    // `incomingHasVideo` is already false on an audio-only build; an explicit `video` is held too.
    const useVideo = CALLS_VIDEO_ENABLED && (video ?? this.incomingHasVideo);
    const seq = ++this.callSetupSeq;

    try {
      if (!canUseRtpScriptTransform()) {
        appendLog(refusedCallReport(callId, currentEngine()));
        throw new CallE2eUnsupportedError();
      }
      this.callState.set('incall');
      this.markAnswered('this device answered');
      // FOUR STEPS SIDE BY SIDE, joined before the room: none needs another's result. Serial, they
      // were 1.2-2.6 s of "connecting" (Android 1.5.3, 2026-10-31). Each logs its own duration.
      // - The token is where the server refuses (a block set while the call rang, a closed window),
      //   and a refused answer must not have told anyone it was answered: the "answered" notice and
      //   the ring-end leave only once it is in hand.
      // - The ICE servers need only membership (`calls.service.ts` getIceServers).
      // - The microphone (and camera): one granted for an answer the server then refuses is
      //   released by `setupMedia`'s own `assertSetupLive`, as for a hangup during the prompt.
      // - The keys: zeroed by `setupEncryption` when derived for a call that ended meanwhile.
      // Any one failing fails the answer; the others settle into the same `seq` guard.
      const token = this.timedStep('room-token', async () => {
        const roomToken = await this.fetchRoomToken(groupId, callId);
        this.assertSetupLive(seq, 'after the room token');
        this.currentRoomToken = roomToken;
        this.announceAnswered(groupId, callId);
      });
      const [, ice] = await Promise.all([
        token,
        this.timedStep('ice-servers', () => this.fetchIceServers(groupId, callId)),
        this.timedStep('media', () => this.setupMedia(useVideo, seq)),
        this.timedStep('keys', () => this.setupEncryption(groupId, callId, 'callee', seq)),
      ]);
      this.assertSetupLive(seq, 'after the parallel setup');
      this.adoptIceServers(ice);
      this.installBackgroundHandler();
      await this.timedStep('join', () => this.connectSignalling(callId, seq));
      this.assertSetupLive(seq, 'after the join');
      this.syncCallPresence(true);
    } catch (e) {
      // The call already ended (and was cleaned up, or is showing its summary): nothing to undo,
      // and a step that failed BECAUSE it ended (its socket closed under it) is no failure to show.
      if (e instanceof CallSetupAbandonedError) return;
      if (!this.setupLive(seq)) {
        appendLog(`[Call] a setup step failed after its call ended: ${String(e)} - not reported`);
        return;
      }
      const msg = String(e);
      appendLog(`[Call] acceptCall failed: ${msg}`);
      showToast(describeCallFailure(e), 'warning');
      this.endCall();
    }
  }

  /**
   * Tells this account's other devices, and every system-surface ring (WP-XP-5), that the call was
   * answered here. NOT AWAITED by the join: the one thing that reads the MLS notice is a SIBLING
   * device still ringing this call (`handleCallSignal`, `callMsg.answered`), whose ring stops when it
   * lands - nothing on the caller or in the record waits for it, and the server's ring-end stops the
   * system surfaces on its own path. Awaited, it held the media path 0.3-0.7 s. A notice that fails
   * leaves those siblings ringing until their window closes, so it is said at ERROR.
   */
  private announceAnswered(groupId: string, callId: string): void {
    const sentAt = performance.now();
    this.sendMlsNotification(groupId, mkCallAnswered(callId, this.mlsService.getDeviceId())).then(
      () =>
        appendLog(
          `[Call] answered notice sent to our other devices: ${Math.round(performance.now() - sentAt)} ms`
        ),
      (e: unknown) =>
        appendLog(
          `[Call] ERROR answered notice for ${callId} not sent - our other devices keep ringing until their window closes: ${String(e)}`
        )
    );
    void this.endServerRing(groupId, callId, 'answered');
  }

  /**
   * Ends the active call and optionally notifies the group via MLS.
   *
   * @param reason Why a call that was never answered ended (typed, sent on the hangup). Left out,
   *   it is inferred from what this device was doing: a ring refused is 'declined', a ring the user
   *   abandoned is 'cancelled'. An answered call carries none, and a call whose callee already
   *   reached the room (`peerArrived`) is ANSWERED even if its media never connected: no outcome,
   *   whatever `reason` says - so the record cannot depend on whether the relay's `PeerLeft` or the
   *   MLS hangup arrives first (both reach the one writer with the same fact).
   * @param remoteOrigin True when the OTHER party ended it (its MLS hangup): the call-record writer
   *   already has that frame, so this device writes nothing.
   */
  public endCall(notify: boolean = true, reason?: CallEndReason, remoteOrigin: boolean = false) {
    const groupId = this.currentGroupId;
    const callId = this.currentCallId;
    // Guard against double-calls: if cleanup already ran - or the call is already showing its
    // ended summary - do not re-enter. A peer-to-peer hangup arrives TWICE (the MLS `call_hangup`
    // and the relay's `PeerLeft`), and a second pass would write a second "call ended" message.
    const state = get(this.callState);
    if (state === 'idle' || state === 'ended') return;
    // Captured BEFORE cleanup: 'calling' means nobody answered yet (ring cancellation).
    const wasCalling = state === 'calling';
    // Typed, and only for a call nobody answered: incoming = a ring this device refused; calling =
    // a ring someone was actually rung by (a call that failed before its invite rang nobody), AND
    // whose callee never reached the room: `peerArrived` means it ANSWERED and the media had not
    // connected yet, which is an answered call (a duration), not an unanswered one.
    const outcome: CallEndReason | undefined =
      state === 'incoming'
        ? (reason ?? 'declined')
        : wasCalling && this.inviteSent && !this.peerArrived
          ? (reason ?? (notify ? 'cancelled' : 'not-answered'))
          : undefined;
    // No typed outcome is one of TWO facts, and the log names which: a ring that never left (a
    // call that failed before its invite: still `calling`, nobody arrived) rang nobody; anything
    // else was ANSWERED. One label for both read as a doubt on every answered call (#2706).
    const ended = outcome ?? (wasCalling && !this.peerArrived ? 'unrung' : 'answered');
    appendLog(
      `[Call] ending call ${callId} state=${state} outcome=${ended} notify=${notify} remote=${remoteOrigin}`
    );
    // The ended summary is not a reconnection, and a resume must not be attempted behind it.
    this.clearResumeTimer();
    this.reconnecting.set(false);
    if (notify && groupId && callId) {
      this.sendMlsNotification(
        groupId,
        mkCallHangup(callId, this.mlsService.getDeviceId(), outcome)
      ).catch(console.error);
      // WP-XP-5: stop the system-surface rings on every device (cancelled before pickup,
      // or a late ring after the call ended).
      void this.endServerRing(
        groupId,
        callId,
        wasCalling && !this.peerArrived ? 'cancelled' : 'ended'
      );
    }
    if (groupId && callId && !remoteOrigin) {
      // The one record writer, told WHY the call ended. A call that failed before its invite
      // (initiate refused, no ICE servers, no microphone) rang nobody: no outcome, no record.
      void this.chatNotifier?.onCallEnded(
        groupId,
        callId,
        outcome,
        state === 'incoming' ? (this.incomingCallerId ?? undefined) : undefined
      );
    }

    // The call is over from here: a microphone the system gives back during the summary is no
    // longer news for anyone. Nor is the link: the camera's ladder stops reading it.
    this.stopWatchingMicrophone();
    this.stopVideoQuality();
    // A ring that ended unanswered: its peer connection never met a peer, and has no report to
    // write - closed now rather than when the summary closes.
    this.closeRingPeerConnection('the ring ended unanswered');

    // Show the "ended" summary screen briefly (1.5 s) so the user sees the call
    // duration and result before the overlay disappears (P4).
    if (get(this.callState) === 'incall' || get(this.callState) === 'calling') {
      // Read NOW, while the peer connection and the worker are alive: `cleanup` releases both
      // when the summary closes.
      this.writeEndReport();
      this.endedAt.set(Date.now());
      this.callState.set('ended');
      this.clearEndedSummaryTimer();
      this.endedSummaryTimer = window.setTimeout(() => {
        this.endedSummaryTimer = null;
        if (get(this.callState) === 'ended') {
          this.cleanup();
        }
      }, 1_500);
    } else {
      // incoming → declined: no summary, go straight to idle.
      this.cleanup();
    }
  }

  /**
   * Terminates a call that hit a non-recoverable transport failure: a media path that never
   * connected, or one whose reconnection budget ran out (signalling resumes, ICE restarts - a
   * network blip alone is resumed, never ended here). Without this, a dead media path
   * left the UI stuck "in call" on a frozen stream. No-op once the call is already
   * idle, so overlapping failure events (ICE + connection both fire `failed`) only
   * tear down once. It DOES send the MLS hangup (calls are 1:1): the other party's ring stops and
   * its record row is finalized by it.
   */
  private failCall(reason: string, cause?: Error): void {
    const state = get(this.callState);
    // A call already over (idle, or showing its ended summary) cannot fail: a late step saying so
    // would only print a second, false "terminal failure" and a toast.
    if (state === 'idle' || state === 'ended') return;
    appendLog(`[Call] terminal failure: ${reason} - ending call`);
    // A TYPED cause reads as its own sentence (`describeCallFailure`); anything else is a transport
    // failure, the connection lost.
    showToast(cause ? describeCallFailure(cause) : m.call_connection_lost(), 'error');
    // The hangup goes out: the other party's row is finalized by it, and its ring (if any) stops.
    this.endCall(true, 'not-answered');
  }

  /**
   * Why a call that NEVER connected failed, when this side knows more than "connection lost": the
   * server withheld the relay, so only a direct path could have worked. Undefined otherwise - the
   * generic sentence then stands, which is the truth for a call whose relay was offered.
   */
  private neverConnectedCause(): CallRelayWithheldError | undefined {
    return this.turnWithheldCode ? new CallRelayWithheldError(this.turnWithheldCode) : undefined;
  }

  /** Publishes Redis-backed call presence so sibling devices can detect an active call. */
  private syncCallPresence(active: boolean): void {
    const deviceId = this.mlsService.getDeviceId();
    if (!deviceId?.trim()) return;

    void publishCallPresence({
      deviceId,
      active,
      callId: active ? (this.currentCallId ?? undefined) : undefined,
      groupId: active ? (this.currentGroupId ?? undefined) : undefined,
    }).catch(() => {});
  }

  /** The pending close of the ended summary; cleared by `cleanup` so it cannot cut a LATER call's summary short. */
  private endedSummaryTimer: number | null = null;

  private clearEndedSummaryTimer(): void {
    if (this.endedSummaryTimer !== null) {
      window.clearTimeout(this.endedSummaryTimer);
      this.endedSummaryTimer = null;
    }
  }

  private cleanup() {
    this.clearEndedSummaryTimer();
    // Any setup still awaiting belongs to the call ending here (`assertSetupLive`).
    this.callSetupSeq += 1;
    // Read before the reset below: only a call that connected owes a final worker report.
    const wasConnected = get(this.connectedAt) !== null;
    const endedCallId = this.currentCallId;
    const fiveSecondReportRan = this.e2eReportFired;
    this.e2eReportFired = false;
    this.resetE2eEvidence();
    this.clearRingTimer();
    this.clearResumeTimer();
    this.stopCallReports();
    this.reportInFlight = null;
    this.lastSnapshot = null;
    this.tapAt = null;
    this.ringStartAt = null;
    this.answeredAt = null;
    this.ringMs = null;
    this.connectMs = null;
    this.pcAwaitingPeer = false;
    this.inviteSent = false;
    this.peerArrived = false;
    this.resumeToken = null;
    this.signallingLost = false;
    this.resumeAttempts = 0;
    this.resumeInFlight = false;
    this.peerAway = false;
    this.mediaEverConnected = false;
    this.iceRestarts = 0;
    this.pairEpoch = 0;
    this.restartOfferEpoch = null;
    this.restartRequestEpoch = null;
    this.packetsAtLoss = null;
    this.packetsAtRestart = null;
    this.localOfferSeq = 0;
    this.pendingOfferSeq = null;
    this.signalQueue = Promise.resolve();
    this.reconnecting.set(false);
    this.removeBackgroundHandler();
    this.syncCallPresence(false);
    this.callState.set('idle');
    this.currentCallId = null;
    this.currentGroupId = null;
    this.incomingCallerId = null;
    this.dropCallKeys();
    this.keyMismatchShown = false;
    this.currentRoomToken = null;
    this.mergedRemoteStream = null;
    this.pendingRemoteIceCandidates = [];
    this.iceServers = null;
    this.turnWithheldCode = null;
    this.polite = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.incomingHasVideo = false;
    this.callHasVideo = false;
    this.cameraTransceiver = null;
    this.stopVideoQuality();
    this.cameraBusy = false;
    this.offPending = false;
    this.videoCodecUnexpectedLogged = false;
    this.cameraFacing.set('user');
    this.canSwitchCamera.set(false);
    this.isVideoOff.set(true);

    this.stopWatchingMicrophone();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.localStreamStore.set(null);

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.signaledWs) {
      this.signaledWs.close();
      this.signaledWs = null;
    }
    // A key wait still pending belongs to this call: settled now, never by its timer in the next.
    this.abandonWorkerKeyWait?.();
    if (this.encryptionWorker) {
      const worker = this.encryptionWorker;
      this.encryptionWorker = null;
      this.workerKeyReady = null;
      this.workerKeyApplied = false;
      // The counters die with the worker, so the final report is asked BEFORE it goes.
      if (wasConnected)
        void this.askE2eReport(`call end, call=${endedCallId ?? '?'}`, worker)
          .then((report) => {
            if (report) {
              appendLog(
                describeE2eReport(
                  report,
                  readE2eEngineFacts(),
                  fiveSecondReportRan,
                  this.transformEpoch
                )
              );
            }
          })
          .finally(() => worker.terminate());
      else worker.terminate();
    }

    this.remoteStream.set(null);
    this.remoteStreams.set(new Map());
    this.connectedAt.set(null);
    this.endedAt.set(null);
  }

  /**
   * `POST /api/calls/ring`: opens the server's answer window for this room (G1), then fans out the
   * cleartext ring (WP-XP-5: call_ring for Android CallStyle, APNs VoIP for iOS CallKit). The
   * fan-out stays best-effort on the server - a device it cannot reach does not fail the request -
   * but the REQUEST is load-bearing: a refused or unreachable ring means no callee could ever get
   * a token, so it throws and the call ends.
   */
  private async triggerServerRing(groupId: string, callId: string, hasVideo: boolean) {
    const { historyUrl } = resolveMlsPublicUrls();
    const url = new URL('/api/calls/ring', historyUrl);
    const res = await apiFetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, callId, hasVideo }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new CallInitiateError(
        'ring',
        res.status,
        `calls/ring failed (${res.status})${detail ? `: ${detail}` : ''}`,
        refusalCodeOf(detail)
      );
    }
    appendLog('[Call] server ring sent - answer window open');
  }

  /**
   * Stops the system-surface rings on every member device (WP-XP-5): POST /api/calls/ring-end.
   * `reason`: 'answered' (someone picked up), 'cancelled' (caller gave up before pickup),
   * 'ended' (call over). Best-effort - the 60s local timeout covers a lost signal.
   */
  private async endServerRing(
    groupId: string,
    callId: string,
    reason: 'answered' | 'cancelled' | 'ended'
  ) {
    try {
      const { historyUrl } = resolveMlsPublicUrls();
      const url = new URL('/api/calls/ring-end', historyUrl);
      await apiFetch(url.toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, callId, reason }),
      });
    } catch (e) {
      appendLog(`[Call] ring-end error: ${String(e)}`);
    }
  }

  /**
   * Asks chat-delivery-service to create a new call room.
   * Returns the server-generated `roomId` and a signed `roomToken` proving group membership.
   */
  private async fetchInitiateCall(
    groupId: string
  ): Promise<{ roomId: string; roomToken: string; ringTimeoutMs: number }> {
    const { historyUrl } = resolveMlsPublicUrls();
    const url = new URL('/api/calls/initiate', historyUrl);
    const res = await apiFetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    if (!res.ok) {
      // THE STATUS CROSSES THE THROW, and the body stays in the message for the log. Spelling the
      // status into the sentence made the only consumer read it back out with `msg.includes(...)`
      // to tell one refusal from another - see `CallInitiateError`.
      const detail = await res.text().catch(() => '');
      throw new CallInitiateError(
        'initiate',
        res.status,
        `calls/initiate failed (${res.status})${detail ? `: ${detail}` : ''}`,
        refusalCodeOf(detail)
      );
    }
    return res.json() as Promise<{ roomId: string; roomToken: string; ringTimeoutMs: number }>;
  }

  /**
   * Fetches a room access token for an existing room (used by call recipients).
   * The room ID comes from the MLS CallInvite message sent by the initiator.
   */
  private async fetchRoomToken(groupId: string, roomId: string): Promise<string> {
    const { historyUrl } = resolveMlsPublicUrls();
    const url = new URL('/api/calls/room-token', historyUrl);
    url.searchParams.set('groupId', groupId);
    url.searchParams.set('roomId', roomId);
    const res = await apiFetch(url.toString(), { method: 'GET', credentials: 'include' });
    if (!res.ok) {
      // Typed, as the initiate's refusal is: a 410 HERE (ring window closed) is told as "this call
      // is over" by `describeCallFailure`, which reads the step and the status, never the message.
      const detail = await res.text().catch(() => '');
      throw new CallInitiateError(
        'room-token',
        res.status,
        `calls/room-token failed (${res.status})${detail ? `: ${detail}` : ''}`,
        refusalCodeOf(detail)
      );
    }
    const data = (await res.json()) as { roomToken: string };
    return data.roomToken;
  }

  /** The ICE servers of a call, and the server's code when it withheld the TURN relay. */
  private adoptIceServers(ice: FetchedIceServers): void {
    this.iceServers = ice.iceServers;
    this.turnWithheldCode = ice.turnWithheldCode;
  }

  /**
   * Fetches short-lived TURN credentials from chat-delivery (Bearer auth, same as /api/mls). RETURNS
   * what it learned and sets nothing: on the callee it runs beside other steps, and an answer landing
   * after its call ended must not leave a withheld-relay code on the service for the next call.
   */
  private async fetchIceServers(groupId: string, callId: string): Promise<FetchedIceServers> {
    const { historyUrl } = resolveMlsPublicUrls();
    const url = new URL('/api/calls/ice-servers', historyUrl);
    url.searchParams.set('groupId', groupId);
    url.searchParams.set('callId', callId);

    appendLog(`[Call] fetching ICE servers for group=${groupId}`);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    let res: Response;
    try {
      res = await apiFetch(url.toString(), {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (e) {
      const msg = String(e);
      appendLog(`[Call] ICE servers request failed: ${msg}`);
      throw e;
    } finally {
      window.clearTimeout(timeout);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      appendLog(`[Call] ICE servers HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      // Typed like the other setup steps: the kill switch (`CALLS_DISABLED`) is an answer the reader
      // is told as such, read from the code. A spent relay budget is NOT a refusal: see below.
      throw new CallInitiateError(
        'ice-servers',
        res.status,
        `Failed to fetch ICE servers: ${res.status}${detail ? ` - ${detail}` : ''}`,
        refusalCodeOf(detail)
      );
    }

    const data = (await res.json()) as {
      iceServers?: IceServerConfig[];
      turn?: { status?: string; code?: string };
    };
    const servers = data.iceServers ?? [];
    // TURN WITHHELD, CALL STILL ON (B7). The server answers STUN only when the month's relay budget
    // is spent or its meter cannot be read: a call between two reachable peers needs no relay, so
    // refusing it would fail calls that cost nothing. Said loudly - a call that then cannot connect
    // will be the one behind a NAT, and this line is what explains it.
    let turnWithheldCode: string | null = null;
    if (data.turn?.status === 'unavailable') {
      turnWithheldCode = data.turn.code ?? 'no code';
      // TURN OFF BY CONFIGURATION is the owner's choice and said at info; any other withheld relay
      // is an outage the server is already accusing, and said as one.
      appendLog(
        turnWithheldCode === TURN_DISABLED_CODE
          ? '[Call] TURN relay disabled by the server (TURN_DISABLED) - direct path only'
          : `[Call] ERROR: TURN relay withheld by the server (${turnWithheldCode}) - direct path only`
      );
    }

    if (servers.length === 0) {
      appendLog('[Call] ICE servers: empty response');
      throw new Error('No ICE servers returned');
    }

    const mapped = servers.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }));

    // EVERY url, not a preview: the relay is listed LAST, so a cut at two hid it, and a reading of a
    // call could not tell "no TURN configured" from "TURN configured and unused". The query
    // (`?transport=`) is dropped; no credential is in a url.
    const urlPreview = mapped
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .map((u) => (typeof u === 'string' ? u.split('?')[0] : u))
      .join(', ');
    appendLog(
      `[Call] ${mapped.length} ICE server(s) (direct first, TURN relay last): ${urlPreview}`
    );

    return { iceServers: mapped, turnWithheldCode };
  }

  /**
   * Applies one remote description under perfect negotiation (W3C WebRTC section 10.5): an offer
   * that collides with our own is dropped by the impolite side and wins on the polite side, where
   * `setRemoteDescription` rolls our offer back implicitly. Every applied offer is answered.
   */
  private async handleRemoteDescription(sdp: WireDescription): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      appendLog(`[Call] remote ${sdp.type} with no peer connection - dropped`);
      return;
    }
    if (sdp.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') {
        // The answer to an offer this side rolled back for a newer restart: nothing to apply it to.
        appendLog(
          `[Call] answer to offer #${sdp.seq ?? '?'} with no offer of ours pending (signaling=${pc.signalingState}) - dropped`
        );
        return;
      }
      if (sdp.seq !== undefined && sdp.seq !== this.pendingOfferSeq) {
        // An answer to an EARLIER offer (one rolled back after its socket died), arriving while a
        // newer one is pending: applied, it would pair the new offer with a stale answer.
        appendLog(
          `[Call] answer to offer #${sdp.seq} while offer #${this.pendingOfferSeq ?? '?'} is pending - stale, dropped`
        );
        return;
      }
      if (sdp.seq === undefined) {
        // A client older than the offer numbering: matched by signaling state alone, as before.
        appendLog('[Call] unnumbered answer (older client) - applied to the pending offer');
      }
    }
    const collision = sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) {
      appendLog('[Call] offer collision - the impolite side keeps its own offer');
      return;
    }
    await pc.setRemoteDescription({ type: sdp.type, sdp: sdp.sdp });
    await this.flushPendingRemoteIceCandidates();
    if (sdp.type === 'answer') {
      this.pendingOfferSeq = null;
      this.restartOfferEpoch = null;
    }
    if (this.iceRestarts > 0) this.packetsAtRestart = inboundAudioPackets(pc);
    if (sdp.type === 'offer') {
      // The initiator's offer is what a restart request asked for; an offer of ours it collided
      // with on this (polite) side was rolled back by `setRemoteDescription`.
      this.restartRequestEpoch = null;
      this.pendingOfferSeq = null;
      await pc.setLocalDescription();
      appendLog(
        `[Call] answer to offer #${sdp.seq ?? '?'} (${pc.localDescription?.sdp?.length ?? 0} bytes) -> peer`
      );
      this.sendSignal({ type: 'Answer', sdp: wireDescription(pc.localDescription, sdp.seq) });
    }
    await configureCallAudioSenders(pc, this.callHasVideo, appendLog);
  }

  /** Queues or applies a trickle ICE candidate from the other party. */
  private async addRemoteIceCandidate(init: RTCIceCandidateInit): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    const isEnd = !init.candidate;
    if (!pc.remoteDescription) {
      if (!isEnd) {
        this.pendingRemoteIceCandidates.push(init);
        const n = this.pendingRemoteIceCandidates.length;
        if (n <= 3 || n % 50 === 0) {
          appendLog(`[Call] ICE candidate buffered (${n}, waiting for remote SDP)`);
        }
      }
      return;
    }

    try {
      await pc.addIceCandidate(isEnd ? null : new RTCIceCandidate(init));
      if (isEnd) {
        appendLog('[Call] remote ICE end-of-candidates');
      }
    } catch (e) {
      // A candidate for the offer we just ignored (impolite side, collision) is expected to fail;
      // anything else is a defect and is named.
      if (!this.ignoreOffer) {
        appendLog(`[Call] addIceCandidate failed: ${String(e)}`);
      }
    }
  }

  private async flushPendingRemoteIceCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc?.remoteDescription || this.pendingRemoteIceCandidates.length === 0) return;

    const pending = this.pendingRemoteIceCandidates.splice(0);
    appendLog(`[Call] applying ${pending.length} buffered ICE candidate(s)`);
    for (const init of pending) {
      await this.addRemoteIceCandidate(init);
    }
  }

  /**
   * Opens the signalling socket (`/api/call`, the existing HTTPS origin - no port of its own) and
   * joins the call's PEER-TO-PEER room. Resolves once the relay has seated us; the peer connection
   * is built later, when `PeerReady` says the other party is there and which role this side plays.
   *
   * `joinToken` is the room token from chat-delivery for a first join, or this seat's resume token
   * when the socket is re-opened after a drop ({@link resumeSignalling}). A `Refused` answer
   * rejects with {@link CallSignallingRefusedError}; anything else is a transport failure.
   * `attemptTimeoutMs`, given for a resume, is one deadline for the socket to open AND be joined.
   */
  private async connectSignalling(
    roomId: string,
    seq: number,
    joinToken = this.currentRoomToken,
    attemptTimeoutMs?: number
  ) {
    // `apiUrl.ts` owns this decision - see `resolveServiceUrl`.
    const callBaseUrl = resolveServiceUrl(
      (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CALL_URL,
      ''
    );

    const wsBase = callBaseUrl.replace(/^https?:/, (m: string) =>
      m === 'https:' ? 'wss:' : 'ws:'
    );

    // Same-origin web can use the canari_ws_token cookie; Tauri mobile needs ?token=
    // (cross-origin WebSocket cannot send WebView cookies - parity with chat-gateway).
    let tokenParam = '';
    try {
      const token = await getToken();
      if (token) {
        tokenParam = `?token=${encodeURIComponent(token)}`;
      }
    } catch {
      appendLog('[Call] signalling WS: no in-memory token, relying on canari_ws_token cookie');
    }
    // The call may have ended during that await (a hangup, a resume racing one, or the ended
    // summary - where the room id still matches): opening a socket now would seat a device in a
    // call that is already over.
    this.assertSetupLive(seq, 'before the signalling socket');

    const wsUrl = `${wsBase}/api/call${tokenParam}`;
    appendLog(
      `[Call] connecting signalling WebSocket${tokenParam ? ' (token in query)' : ' (cookie auth)'}`
    );

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.signaledWs = ws;
      let settled = false;
      // The relay seated us on THIS socket. Only a socket that was joined can be LOST: one that
      // failed before its `Joined` has already rejected, and its close is not a second event.
      let joined = false;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const clearTimers = () => {
        window.clearTimeout(connectTimeout);
        window.clearTimeout(joinTimeout);
      };

      // A resume attempt has ONE deadline for open AND Joined (a socket stuck CONNECTING on a
      // black-holed network must not outlast the relay's seat grace); a first join keeps the two.
      const connectTimeout = window.setTimeout(() => {
        fail(
          new Error(
            attemptTimeoutMs === undefined
              ? 'call signalling WebSocket connection timeout (15s)'
              : `call signalling resume attempt timeout (${attemptTimeoutMs} ms)`
          )
        );
        ws.close();
      }, attemptTimeoutMs ?? 15_000);

      let joinTimeout = 0;

      ws.onopen = () => {
        if (attemptTimeoutMs === undefined) window.clearTimeout(connectTimeout);
        appendLog('[Call] signalling connected, joining p2p room...');
        this.sendSignal({
          type: 'Join',
          room_id: roomId,
          room_token: joinToken ?? undefined,
          mode: 'p2p',
        });
        if (attemptTimeoutMs !== undefined) return;
        joinTimeout = window.setTimeout(() => {
          fail(new Error('call signalling Join ack timeout (20s)'));
          ws.close();
        }, 20_000);
      };

      ws.onerror = () => {
        clearTimers();
        appendLog('[Call] signalling WebSocket error');
        fail(new Error('call signalling WebSocket connection failed'));
      };

      ws.onclose = (ev) => {
        clearTimers();
        if (!joined) {
          fail(new Error(`call signalling WebSocket closed before ready (code=${ev.code})`));
        } else if (this.signaledWs === ws && get(this.callState) !== 'idle') {
          // cleanup() detaches the socket before closing it, so reaching here means the server
          // or the network dropped it mid-call. A transport failure is not an answer: resume.
          this.onSignallingLost(roomId, ev.code);
        }
      };

      ws.onmessage = (event) => {
        let frame: SignalFrame;
        try {
          frame = JSON.parse(event.data as string) as SignalFrame;
        } catch (err) {
          appendLog(`[Call] unparseable signalling frame: ${String(err)}`);
          return;
        }
        if (frame.type === 'Joined') {
          clearTimers();
          joined = true;
          this.signallingLost = false;
          this.resumeToken = frame.resume_token ?? null;
          appendLog(
            `[Call] p2p room ready (${frame.room_id ?? roomId})${frame.resume_token ? '' : ' - WARN no resume token: a network blip will end this call'}`
          );
          this.updateReconnecting();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (frame.type === 'Refused') {
          clearTimers();
          appendLog(`[Call] signalling refused: ${frame.reason}`);
          if (!settled) {
            fail(new CallSignallingRefusedError(frame.reason));
          } else {
            this.failCall(`signalling refused: ${frame.reason}`);
          }
          return;
        }
        void this.serialized(`signalling ${frame.type}`, () => this.handleSignalFrame(frame));
      };
    });
  }

  /**
   * Appends one negotiation step to {@link signalQueue}. A step that throws is a negotiation this
   * side could not complete: named, and the call ends (an unanswerable offer leaves nothing to
   * wait for). Returns the step's own completion, which the caller may await.
   */
  private serialized(label: string, step: () => Promise<void>): Promise<void> {
    const callId = this.currentCallId;
    const run = this.signalQueue
      .then(async () => {
        if (!this.isCallLive(callId)) {
          this.dropStaleStep(label, callId);
          return;
        }
        await step();
      })
      .catch((err: unknown) => {
        appendLog(`[Call] ${label} failed: ${String(err)}`);
        // A step of a call already over ends nothing: the call it belonged to is gone.
        if (!this.isCallLive(callId)) return;
        this.failCall(`${label} failed`);
      });
    this.signalQueue = run;
    return run;
  }

  /**
   * A queued step outlived its call (hung up, or a new call began, while it waited): it would act
   * on the wrong call - a `PeerLeft` ending the next one, a restart on its peer connection. Logged
   * ONCE per call, the drops after the first being the same fact. A call showing its ended summary
   * is over too ({@link isCallLive}).
   */
  private dropStaleStep(label: string, callId: string | null): void {
    // The SAME call, merely over: an ordinary hangup delivers both the MLS hangup and the relay's
    // `PeerLeft`, so a step dropped here is expected and says nothing worth a line.
    if (this.currentCallId === callId) return;
    if (this.staleStepsOfCall === callId) return;
    this.staleStepsOfCall = callId;
    appendLog(
      `[Call] ${label} of call ${callId ?? 'none'} dropped - the call is now ${this.currentCallId ?? 'none'} (${get(this.callState)})`
    );
  }

  /** `callId` is still the call in progress, and that call is not over (idle, or its ended summary). */
  private isCallLive(callId: string | null): boolean {
    const state = get(this.callState);
    return this.currentCallId === callId && state !== 'idle' && state !== 'ended';
  }

  /** Acts on one frame from the relay, after the room is joined. */
  private async handleSignalFrame(frame: SignalFrame): Promise<void> {
    switch (frame.type) {
      case 'PeerReady':
        await this.onPeerReady(frame.initiator, frame.resumed === true);
        return;
      case 'PeerLeft':
        // An ANSWER: the other party hung up, or its away seat was never resumed.
        appendLog('[Call] the other party left the call room');
        this.endCall(false);
        return;
      case 'IceRestartRequest':
        // The polite side lost its media path and cannot restart ICE itself.
        this.onIceRestartRequested();
        return;
      case 'PeerAway':
        // NOT an end: the relay keeps its seat for a resume, and says `PeerReady { resumed }` or
        // `PeerLeft` next.
        appendLog('[Call] the other party lost its signalling connection - waiting for it');
        this.peerAway = true;
        // Its microphone report is about a device we can no longer hear from: no fresh evidence,
        // so no claim. Its `PeerReady { resumed }` re-announces a microphone still held.
        this.peerMicSuspended.set(false);
        this.onPairBroken('peer away');
        this.updateReconnecting();
        return;
      case 'MicSuspended':
        appendLog(
          frame.suspended
            ? "[Call] the other party's system took its microphone - it cannot be heard"
            : "[Call] the other party's system gave its microphone back"
        );
        this.peerMicSuspended.set(frame.suspended === true);
        return;
      case 'Offer':
      case 'Answer': {
        const sdp = JSON.parse(frame.sdp) as WireDescription;
        appendLog(`[Call] peer -> ${frame.type} (signaling=${this.pc?.signalingState ?? 'none'})`);
        await this.handleRemoteDescription(sdp);
        return;
      }
      case 'IceCandidate':
        await this.addRemoteIceCandidate(JSON.parse(frame.candidate) as RTCIceCandidateInit);
        return;
      default:
        appendLog(`[Call] unexpected signalling frame ${frame.type} - ignored`);
    }
  }

  /**
   * The other party is in the room. Builds the peer connection with this side's role; a second
   * `PeerReady` means the other party's device was replaced, and negotiation restarts from nothing.
   *
   * `resumed`: the pair is back together after one side's signalling dropped and was RESUMED in
   * place (same seats, same roles). The peer connection is kept - the media may never have
   * stopped - and {@link restartIfMediaDidNotSurvive} decides, from evidence, whether ICE restarts.
   */
  private async onPeerReady(initiator: boolean, resumed = false): Promise<void> {
    this.polite = !initiator;
    this.peerArrived = true;
    this.peerAway = false;
    this.clearRingTimer();
    this.pairEpoch += 1;
    appendLog(
      `[Call] peer ready - this side is ${initiator ? 'initiator' : 'polite'}${resumed ? ' (resumed)' : ''} (pairing ${this.pairEpoch})`
    );
    this.announceMicOnPairing();
    // The caller's answer is the callee in the room (the callee marked its own at its tap).
    this.markAnswered('the peer joined');
    if (this.pc && this.pcAwaitingPeer) {
      // Built during the ring, and never paired: there is nothing to resume or replace.
      this.adoptRingPeerConnection(this.pc);
      this.updateReconnecting();
      return;
    }
    if (this.pc && resumed) {
      this.updateReconnecting();
      await this.restartIfMediaDidNotSurvive();
      return;
    }
    if (this.pc) {
      appendLog('[Call] the other device was replaced - rebuilding the peer connection');
      this.pc.close();
      this.pc = null;
      // The new peer connection earns its own E2E claim and its own path check: nothing the dead
      // one proved is evidence about it.
      this.resetE2eEvidence();
      // The new peer connection gets the camera on its own transceiver (`initPeerConnection`),
      // and its own ladder: the dead link's evidence says nothing about the new one.
      this.cameraTransceiver = null;
      this.stopVideoQuality();
      // It counts its bytes from zero: a rate against the old one's totals would be negative.
      // (A tick of the old one still in flight is refused by `writeEndReport`: it names its pc.)
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
    await this.initPeerConnection();
    this.updateReconnecting();
  }

  /**
   * The signalling socket of `roomId` dropped after its room was joined - a transport failure, so
   * NOT an end: the relay keeps this device's seat for a while, and the socket is re-opened on the
   * shared ladder with the seat's resume token. The media path is independent and may well still
   * be flowing. What ends the call is an answer (a `Refused` resume, `PeerLeft`, the MLS hangup)
   * or the attempt budget running out.
   */
  private onSignallingLost(roomId: string, code: number): void {
    if (this.currentCallId !== roomId) return;
    if (!this.resumeToken) {
      // A relay older than the resume protocol: nothing can take the seat back.
      this.failCall(`signalling WebSocket closed code=${code} and the relay gave no resume token`);
      return;
    }
    appendLog(`[Call] signalling WebSocket closed code=${code} - resuming (call=${roomId})`);
    this.signallingLost = true;
    this.resumeAttempts = 0;
    this.onPairBroken('signalling lost');
    this.updateReconnecting();
    this.scheduleSignallingResume(roomId);
  }

  /** Arms the next resume attempt on the shared ladder, or ends the call once the budget is spent. */
  private scheduleSignallingResume(roomId: string): void {
    if (this.resumeTimer !== null || this.resumeInFlight) {
      appendLog(
        `[Call] signalling resume request dropped - ${this.resumeInFlight ? 'an attempt is running' : 'an attempt is already armed'}`
      );
      return;
    }
    const attempt = this.resumeAttempts + 1;
    if (attempt > CALL_SIGNALLING_RESUME_ATTEMPTS) {
      this.failCall(
        `signalling not restored after ${CALL_SIGNALLING_RESUME_ATTEMPTS} resume attempts`
      );
      return;
    }
    this.resumeAttempts = attempt;
    const delay = cappedReconnectDelayMs(attempt - 1, CALL_SIGNALLING_RESUME_MAX_DELAY_MS);
    appendLog(
      `[Call] signalling resume attempt ${attempt}/${CALL_SIGNALLING_RESUME_ATTEMPTS} in ${delay} ms`
    );
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null;
      void this.resumeSignalling(roomId);
    }, delay);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /**
   * One resume attempt: a new socket, `Join` with this seat's resume token. Joined -> the call goes
   * on (the relay then sends `PeerReady { resumed }` or `PeerAway`). Refused -> the relay ANSWERED
   * that this seat is gone (`call-over`: the grace ran out or the other party hung up), so the call
   * ends. Any other failure is transport, and the next attempt is armed.
   */
  private async resumeSignalling(roomId: string): Promise<void> {
    if (this.currentCallId !== roomId || !this.signallingLost) return;
    this.resumeInFlight = true;
    let retry = false;
    // The live call's sequence: a cleanup during the resume makes it stale (`assertSetupLive`).
    const seq = this.callSetupSeq;
    try {
      await this.connectSignalling(
        roomId,
        seq,
        this.resumeToken,
        CALL_SIGNALLING_RESUME_TIMEOUT_MS
      );
      appendLog(`[Call] signalling resumed on attempt ${this.resumeAttempts}`);
      this.resumeAttempts = 0;
    } catch (e) {
      // The call ended during the resume: nothing to retry, nothing to end.
      if (e instanceof CallSetupAbandonedError) return;
      if (e instanceof CallSignallingRefusedError) {
        appendLog(`[Call] signalling resume refused (${e.reason}) - the call is over`);
        this.endCall(true, 'not-answered');
        return;
      }
      appendLog(`[Call] signalling resume attempt ${this.resumeAttempts} failed: ${String(e)}`);
      retry = true;
    } finally {
      this.resumeInFlight = false;
    }
    if (retry && this.currentCallId === roomId) this.scheduleSignallingResume(roomId);
  }

  /**
   * The signalling pair broke (this side's socket, or the other's: `PeerAway`). Opens a new
   * pairing - so a restart offer or request sent before is never waited on again, since it may
   * have gone into the dead socket - and snapshots the inbound packet count, the evidence
   * {@link restartIfMediaDidNotSurvive} compares once the pair re-forms. The FIRST break of an
   * outage keeps its snapshot: a second one inside the same outage measures nothing new.
   *
   * The restart BUDGET is NOT reset here: it counts per media loss, across pairings. An offer sent
   * into a dead socket costs one restart, and since the keepalive can break a pairing every 20-30 s,
   * a reset per pairing would let a flapping peer restart for ever.
   */
  private onPairBroken(why: string): void {
    this.pairEpoch += 1;
    // A peer connection built during the ring carries no media yet: a baseline read from it (no
    // inbound stream yet) would outlive the ring and hide a later dead-but-"connected" path from the restart.
    if (this.pc && !this.pcAwaitingPeer && !this.packetsAtLoss) {
      this.packetsAtLoss = inboundAudioPackets(this.pc);
    }
    appendLog(`[Call] signalling pair broken (${why}) - pairing ${this.pairEpoch}`);
  }

  /**
   * The pair re-formed after an outage (`PeerReady { resumed }`). Decides from EVIDENCE whether the
   * media path survived, never from a timer: it did not when either state machine says it is down
   * ({@link mediaPathDown}), when not one audio packet arrived between the break and now (a path
   * whose state still reads `connected` while carrying nothing), or - on the initiator - when an
   * offer is still pending: its answer was lost with the dead socket, and until it is rolled back
   * no restart can ever be negotiated (`restartIce()` fires no `negotiationneeded` outside
   * `stable` - the 2026-10-19 bench stall, both phones on "Reconnexion..." for good).
   */
  private async restartIfMediaDidNotSurvive(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const before = this.packetsAtLoss ? await this.packetsAtLoss : null;
    this.packetsAtLoss = null;
    const atRestart = this.packetsAtRestart ? await this.packetsAtRestart : null;
    const now = await inboundAudioPackets(pc);
    if (this.pc !== pc) return;
    if (this.iceRestarts > 0 && atRestart !== null && before !== null && before > atRestart) {
      // Audio arrived after the last restart and before this outage: that restart WORKED, even if
      // ICE never left `connected` to say so. The budget is per media loss, and that loss is over.
      this.refundIceRestarts(`audio packets ${atRestart} -> ${before} after the last restart`);
    }
    const staleOffer = !this.polite && pc.signalingState === 'have-local-offer';
    const stalled = before !== null && now !== null && now <= before;
    const down = mediaPathDown(pc);
    appendLog(
      `[Call] pair resumed: ice=${pc.iceConnectionState} connection=${pc.connectionState} signaling=${pc.signalingState} audio packets ${before ?? '?'} -> ${now ?? '?'}`
    );
    if (!staleOffer && !stalled && !down) {
      appendLog('[Call] the media path carried audio across the outage - no ICE restart');
      // Refunded only on PROOF that audio flowed: unreadable stats (`null`) are no evidence.
      if (this.iceRestarts > 0 && before !== null && now !== null && now > before) {
        this.refundIceRestarts(`audio carried across the outage (packets ${before} -> ${now})`);
      }
      return;
    }
    const why = [
      staleOffer && 'unanswered offer',
      stalled && 'no packet since the break',
      down && 'path down',
    ]
      .filter(Boolean)
      .join(', ');
    this.maybeRestartIce(`signalling resumed: ${why}`, true);
  }

  /**
   * Restarts ICE when the media path is down and the pair can renegotiate. Called on the events
   * that can heal it: the pair re-forming after an outage (`force`, the evidence already read),
   * and either state machine reporting the path `disconnected` (first restart only) or `failed`.
   *
   * Only the INITIATOR offers ({@link sendIceRestartOffer}); two offerers would collide. The
   * POLITE side sends `IceRestartRequest` instead, which the initiator honours
   * ({@link onIceRestartRequested}). One offer or one request per pairing is in flight at a time:
   * its answer (or the offer it asked for) comes over a live relay, or the pair breaks and a new
   * pairing starts - a fact either way, never a timeout. The budget counts restarts (or requests)
   * since the path was last connected; spent, the call ends.
   */
  private maybeRestartIce(reason: string, force = false): void {
    const pc = this.pc;
    if (!pc) return;
    const ice = pc.iceConnectionState;
    if (!force && !mediaPathDown(pc)) return;
    if (this.signallingLost || this.peerAway) {
      appendLog(
        `[Call] ICE ${ice} (${reason}) - restart deferred until both parties are back on the relay`
      );
      return;
    }
    if (this.restartOfferEpoch === this.pairEpoch) {
      appendLog(`[Call] ICE ${ice} (${reason}) - a restart offer is already awaiting its answer`);
      return;
    }
    if (this.polite && this.restartRequestEpoch === this.pairEpoch) {
      appendLog(`[Call] ICE ${ice} (${reason}) - a restart request is already awaiting its offer`);
      return;
    }
    const failed = ice === 'failed' || pc.connectionState === 'failed';
    if (!force && !failed && this.iceRestarts > 0) {
      // A restart already ran for this loss and was answered; the next one waits for `failed`.
      return;
    }
    if (this.polite) {
      // Only the initiator offers, and it may see its own path as fine: ASK it, on THIS side's
      // budget, so a loss only the polite side sees still ends in a restart or in the call's end.
      // Charged HERE: the request leaves in this same call.
      if (this.iceRestarts >= CALL_ICE_RESTART_ATTEMPTS) {
        this.failCall(`media path not restored after ${CALL_ICE_RESTART_ATTEMPTS} ICE restarts`);
        return;
      }
      this.iceRestarts += 1;
      appendLog(
        `[Call] ICE ${ice} (${reason}) - asking the initiator to restart (${this.iceRestarts}/${CALL_ICE_RESTART_ATTEMPTS})`
      );
      this.restartRequestEpoch = this.pairEpoch;
      this.sendSignal({ type: 'IceRestartRequest' });
      return;
    }
    this.enqueueIceRestartOffer(`${reason}, ice=${ice}`);
  }

  /**
   * Decides an initiator restart NOW (the pairing's in-flight mark is set at once, so a second
   * trigger in the same tick adds none) and runs it on {@link signalQueue}, after whatever frame is
   * being applied - never beside it.
   */
  private enqueueIceRestartOffer(why: string): void {
    const epoch = this.pairEpoch;
    this.restartOfferEpoch = epoch;
    appendLog(`[Call] ICE restart decided (${why})`);
    void this.serialized('ICE restart offer', () => this.sendIceRestartOffer(epoch));
  }

  /**
   * The initiator's restart: an EXPLICIT `createOffer({ iceRestart: true })`, sent at once, after
   * rolling back any offer still pending (its answer died with a socket - see
   * {@link restartIfMediaDidNotSurvive}). Not `pc.restartIce()`: that only flags the next
   * negotiation, and a connection stuck in `have-local-offer` never starts one. Runs on the queue
   * only.
   *
   * An engine that cannot CREATE the offer ends the call, named: nothing this side does next would
   * differ (same connection, same state), so a retry would only repeat the refusal.
   */
  private async sendIceRestartOffer(epoch: number): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (epoch !== this.pairEpoch) {
      // The pair broke again before this step ran: the next `PeerReady` decides afresh.
      appendLog(`[Call] ICE restart of pairing ${epoch} dropped - pairing ${this.pairEpoch} now`);
      return;
    }
    // Charged HERE, once the offer is certain to be made: a restart dropped above cost nothing.
    if (this.iceRestarts >= CALL_ICE_RESTART_ATTEMPTS) {
      this.failCall(`media path not restored after ${CALL_ICE_RESTART_ATTEMPTS} ICE restarts`);
      return;
    }
    this.iceRestarts += 1;
    appendLog(`[Call] ICE restart ${this.iceRestarts}/${CALL_ICE_RESTART_ATTEMPTS}`);
    this.makingOffer = true;
    try {
      if (pc.signalingState === 'have-local-offer') {
        appendLog(
          `[Call] rolling back unanswered offer #${this.pendingOfferSeq ?? '?'} - its answer can no longer come`
        );
        await pc.setLocalDescription({ type: 'rollback' });
        this.pendingOfferSeq = null;
      }
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      if (this.pc !== pc) return;
      const seq = this.nextOfferSeq();
      appendLog(
        `[Call] ICE restart offer #${seq} (${pc.localDescription?.sdp?.length ?? 0} bytes) -> peer`
      );
      this.sendSignal({ type: 'Offer', sdp: wireDescription(pc.localDescription, seq) });
    } catch (e) {
      if (this.pc !== pc) return;
      this.failCall(`ICE restart offer could not be made: ${String(e)}`);
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Gives the restart budget back: the media loss it was counting is PROVEN over by packets, not by
   * a state machine (which may never have left `connected`).
   */
  private refundIceRestarts(evidence: string): void {
    appendLog(`[Call] media path restored after ${this.iceRestarts} ICE restart(s) - ${evidence}`);
    this.iceRestarts = 0;
    this.packetsAtRestart = null;
  }

  /** Numbers the offer this side is about to send, and marks it as the one awaiting an answer. */
  private nextOfferSeq(): number {
    this.localOfferSeq += 1;
    this.pendingOfferSeq = this.localOfferSeq;
    return this.localOfferSeq;
  }

  /**
   * The polite side asked for an ICE restart. Honoured unless this side's own restart offer of
   * the SAME pairing is awaiting its answer (both sides saw the loss: the asker gets that offer).
   * An offer of an earlier pairing never blocks it - that is what stalled the 2026-10-19 bench
   * call. Counted against this side's budget too, so a misbehaving peer cannot drive restarts for
   * ever.
   */
  private onIceRestartRequested(): void {
    if (!this.pc || this.polite) {
      appendLog('[Call] ICE restart request ignored - this side does not offer');
      return;
    }
    if (this.restartOfferEpoch === this.pairEpoch) {
      appendLog("[Call] ICE restart request - this pairing's restart offer is already on its way");
      return;
    }
    // Counted when the offer is made (`sendIceRestartOffer`), against this side's budget too.
    this.enqueueIceRestartOffer('requested by the other party');
  }

  /**
   * Recomputes {@link reconnecting} from the three facts that make it: this device's signalling
   * resuming, the other party's (`PeerAway`), and a media path that had connected and is not
   * connected now. Logged on every change, with the facts, so a "Reconnexion..." seen on a phone
   * is explained in its exported log.
   */
  private updateReconnecting(): void {
    const ice = this.pc?.iceConnectionState;
    const mediaDown = this.mediaEverConnected && ice !== 'connected' && ice !== 'completed';
    const next =
      get(this.callState) === 'incall' && (this.signallingLost || this.peerAway || mediaDown);
    if (next === get(this.reconnecting)) return;
    appendLog(
      `[Call] reconnecting=${next} (signalling=${this.signallingLost ? 'lost' : 'up'} peer=${this.peerAway ? 'away' : 'present'} ice=${ice ?? 'none'})`
    );
    this.reconnecting.set(next);
  }

  /** Wires decrypt transform before exposing the track to the UI (avoids black video). */
  private async handleRemoteTrack(
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver,
    transceiver: RTCRtpTransceiver | undefined
  ) {
    appendLog(
      `[Call] remote track kind=${track.kind} id=${track.id.slice(0, 8)}… readyState=${track.readyState} muted=${track.muted}`
    );

    // A transceiver the peer's offer CREATED (a kind this side never sent): both its transforms go
    // on HERE, in the task `ontrack` fires in - SYNCHRONOUSLY, nothing awaited first. Measured on
    // the Mi 9T's WebView 152 (2026-10-20): its receiver attached here is fed, and so is its SENDER;
    // but a sender left bare and reused LATER by `addTrack` is short-circuited even when its
    // transform is assigned in the same task as that `addTrack` - Chromium decided when the
    // transceiver was created. So the sender gets its transform now, before it carries anything.
    const newMline = !receiver.transform;
    let side: 'receiver' | 'sender' = 'receiver';
    try {
      this.attachReceiverTransform(receiver, track.kind);
      side = 'sender';
      // Armed with no track yet: it sends nothing until a later `addTrack` reuses it.
      if (transceiver)
        this.attachSenderTransform(transceiver.sender, track.kind, 'armed, no track yet');
    } catch (e) {
      appendLog(`[Call] E2E ${side} transform failed in ontrack (${track.kind}): ${String(e)}`);
      this.failCall(
        `E2E ${side} transform failed`,
        e instanceof CallE2eSetupError
          ? e
          : new CallE2eSetupError(`${side} (${track.kind})`, { cause: e })
      );
      return;
    }
    // The peer's camera m-line is held to VP8 on this side too, so whichever side answers, the
    // negotiated codec is the one the transform frames (`utils/callVideoFrame.ts`).
    if (track.kind === 'video' && transceiver) preferVp8(transceiver, appendLog);
    // A new m-line is media the 5 s check of the first connect may not have seen: check it again.
    if (newMline && this.pc) this.scheduleE2ePathCheck(this.pc, `after a new ${track.kind} m-line`);

    // AN AUDIO-ONLY BUILD RECEIVES A PEER'S VIDEO AND SHOWS NOTHING OF IT. Only a modified client
    // (or a later build) sends one. The m-line is answered `recvonly` - this side never adds a
    // camera - and its transforms are attached above, so its frames are decrypted and the E2E path
    // check keeps judging it: left bare, its packets would end the call as media AROUND the
    // transform. The track never reaches the UI.
    // `inactive` WOULD be possible (after the first remote description either side may
    // renegotiate, and set here it would even shape this side's answer) and would save the peer's
    // video bandwidth and CPU. It is not taken: how the E2E path check treats a negotiated m-line
    // that carries nothing is unmeasured on a phone (it may withdraw the E2E claim of a healthy
    // audio call), and the case comes only from a modified client until video ships - when the
    // floor rises past this build or the `inactive` route is built (docs/wiki/frontend/modules/calls.md, B0).
    if (track.kind === 'video' && !CALLS_VIDEO_ENABLED) {
      appendLog(
        '[Call] the peer sends video - this build is audio only, it is received and not shown'
      );
      track.onunmute = () => this.recheckE2eOnMediaStart('after the remote video unmuted');
      return;
    }

    if (!this.mergedRemoteStream) {
      this.mergedRemoteStream = new MediaStream();
    }
    const already = this.mergedRemoteStream.getTracks().some((t) => t.id === track.id);
    if (!already) {
      // Renegotiation adds new m-lines; drop stale tracks of the same kind (UI kept the dead one).
      for (const old of this.mergedRemoteStream.getTracks()) {
        if (old.kind === track.kind && old.id !== track.id) {
          this.mergedRemoteStream.removeTrack(old);
          old.stop();
          appendLog(`[Call] replaced stale remote ${old.kind} track ${old.id.slice(0, 8)}…`);
        }
      }
      this.mergedRemoteStream.addTrack(track);
    }

    track.onunmute = () => {
      appendLog(`[Call] remote track unmuted kind=${track.kind}`);
      this.publishRemoteStream();
      this.recheckE2eOnMediaStart(`after the remote ${track.kind} unmuted`);
    };
    // The peer's camera OFF is a renegotiation to `recvonly` on its side, which mutes this track
    // (measured in the rig, row `video-off-on`): the screen shows the avatar again, not a frozen
    // last frame.
    track.onmute = () => {
      appendLog(`[Call] remote track muted kind=${track.kind}`);
      this.publishRemoteStream();
    };
    // Watchdog: a remote track that never unmutes means no media reached us - the usual cause
    // of "no audio on this call". Logged so a failing call is diagnosable from the exported log.
    setTimeout(() => {
      if (track.readyState === 'live' && track.muted) {
        appendLog(`[Call] WARN remote ${track.kind} still muted after 5s - no media received`);
      }
    }, 5000);
    track.onended = () => {
      appendLog(`[Call] remote track ended kind=${track.kind}`);
      this.mergedRemoteStream?.removeTrack(track);
      this.publishRemoteStream();
    };

    this.publishRemoteStream();

    if (get(this.callState) === 'calling' || get(this.callState) === 'incoming') {
      this.callState.set('incall');
    }
  }

  /** Notifies subscribers so `<video>` re-binds when tracks start producing frames. */
  private publishRemoteStream() {
    if (!this.mergedRemoteStream) return;
    const stream = this.mergedRemoteStream;
    this.remoteStream.set(stream);
    this.remoteStreams.set(new Map([['remote', stream]]));
  }

  /**
   * One offer, on the negotiation queue: from `negotiationneeded`, and from the adoption of a peer
   * connection built during the ring (its `negotiationneeded` fired while it waited, and made none).
   */
  private async offerIfNeeded(pc: RTCPeerConnection): Promise<void> {
    // Nothing is offered before the peer is in the room. The polite side never opens the
    // negotiation: it answers the initiator's first offer, which already carries a slot for its
    // tracks. After that, either side may renegotiate.
    if (this.pc !== pc || this.pcAwaitingPeer || (this.polite && !pc.remoteDescription)) return;
    if (pc.signalingState !== 'stable') {
      // A step queued before this one (an ICE restart offer) already opened a negotiation.
      appendLog(`[Call] negotiationneeded in signaling=${pc.signalingState} - already offering`);
      return;
    }
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      const seq = this.nextOfferSeq();
      appendLog(`[Call] offer #${seq} (${pc.localDescription?.sdp?.length ?? 0} bytes) -> peer`);
      this.sendSignal({ type: 'Offer', sdp: wireDescription(pc.localDescription, seq) });
    } catch (e) {
      appendLog(`[Call] creating an offer failed: ${String(e)}`);
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * The peer joined a call whose peer connection was built during the ring: it becomes the call's,
   * with what was held back until now - the report ticks, the camera's ladder, and the offer.
   * Runs INSIDE the negotiation queue (`onPeerReady`), so the offer is queued after it, never awaited.
   */
  private adoptRingPeerConnection(pc: RTCPeerConnection): void {
    this.pcAwaitingPeer = false;
    // No outage before the pairing is evidence about the media this pairing will carry.
    this.packetsAtLoss = null;
    appendLog(
      `[Call] the peer joined - the peer connection built during the ring is adopted (ice gathering=${pc.iceGatheringState})`
    );
    this.armCallReport(pc);
    const camera = this.liveCameraTransceiver();
    if (camera?.sender.track) this.startVideoQuality(pc, camera.sender);
    void this.serialized('offer', () => this.offerIfNeeded(pc));
  }

  /**
   * Closes a peer connection built during the ring that never met its peer - at once, not after the
   * ended summary: it holds a TURN allocation for a call nobody answered. `cleanup` closes it too,
   * on the paths that reach it first.
   */
  private closeRingPeerConnection(why: string): void {
    if (!this.pc || !this.pcAwaitingPeer) return;
    appendLog(`[Call] closing the peer connection built during the ring (${why})`);
    this.pc.close();
    this.pc = null;
    this.pcAwaitingPeer = false;
  }

  /**
   * Builds the peer connection to the OTHER PARTY (no SFU in between), attaches the E2E sender
   * transform to every local track, and lets `negotiationneeded` drive the offers.
   *
   * `awaitingPeer`: the CALLER's build during its ring, before anyone answered. The candidates are
   * gathered now (`iceCandidatePoolSize`, which gathers before any description and surfaces them at
   * the first `setLocalDescription`), and nothing that needs the peer runs - no offer, no report
   * tick, no path check, no video ladder - until `PeerReady` adopts it ({@link adoptRingPeerConnection}).
   * The pool gathers ONE transport: both kinds ride it under BUNDLE.
   */
  private async initPeerConnection(opts: { awaitingPeer?: boolean } = {}) {
    if (!this.currentGroupId || !this.currentCallId || !this.iceServers) {
      throw new Error('No active call context');
    }
    const awaitingPeer = opts.awaitingPeer === true;

    appendLog(
      `[Call] creating PeerConnection (policy=${CALL_ICE_TRANSPORT_POLICY}, ${this.iceServers.length} ICE server(s)${awaitingPeer ? ', during the ring: gathering now, negotiating once the peer joins' : ''})`
    );
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: CALL_ICE_TRANSPORT_POLICY,
      ...(awaitingPeer ? { iceCandidatePoolSize: 1 } : {}),
    });
    this.pc = pc;
    this.pcAwaitingPeer = awaitingPeer;
    this.transformEpoch += 1;
    if (!awaitingPeer) this.armCallReport(pc);

    const gathered = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    /** Gathering ended with no relay candidate and no working pair yet - see `onicecandidate`. */
    let relayGap = false;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const type = e.candidate.type;
        if (type && type in gathered) gathered[type as keyof typeof gathered]++;
        this.sendSignal({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      } else {
        appendLog(
          `[Call] ICE gathering complete (host=${gathered.host} srflx=${gathered.srflx} relay=${gathered.relay} ice=${pc.iceConnectionState})`
        );
        this.sendSignal({
          type: 'IceCandidate',
          candidate: JSON.stringify({ candidate: '' } satisfies RTCIceCandidateInit),
        });
        // A working direct pair stops libwebrtc's gathering before TURN answers (CALL-GATHER-0),
        // and the ICE state the attribute shows here may lag the pair that ended it. So nothing
        // is concluded now: the gap is remembered, and accused only if ICE then FAILS without
        // ever connecting (`oniceconnectionstatechange` below).
        relayGap = relayGapIsSuspect(gathered.relay, pc.iceConnectionState);
      }
    };

    // On the negotiation queue like every other step, so an offer is never made while a frame
    // is half applied.
    pc.onnegotiationneeded = () => this.serialized('offer', () => this.offerIfNeeded(pc));

    pc.onicegatheringstatechange = () => {
      appendLog(`[Call] iceGatheringState=${pc.iceGatheringState}`);
    };

    pc.onsignalingstatechange = () => {
      appendLog(`[Call] signalingState=${pc.signalingState}`);
      // `stable` follows a completed negotiation - the media the last path check could not judge
      // (an m-line not negotiated yet) can flow now - and also a ROLLBACK, after which one more
      // check costs a look and never a verdict.
      if (pc.signalingState === 'stable' && this.pc === pc) {
        this.recheckE2eOnMediaStart('after signalling reached stable');
      }
    };

    pc.ontrack = (e) => {
      const { track, receiver, transceiver } = e;
      void this.handleRemoteTrack(track, receiver, transceiver);
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      appendLog(`[Call] connectionState=${state}`);
      if (state === 'connected') {
        // Only a RINGING call becomes `incall` here, as in `handleRemoteTrack`: ICE that connects
        // during the 1.5 s summary must not turn `ended` back into a call - the summary's timer would
        // then skip `cleanup`, leaving the microphone open under an overlay that says "in call".
        const callState = get(this.callState);
        if (callState === 'ended' || callState === 'idle') {
          appendLog(`[Call] connected after the call ended (state=${callState}) - not reopened`);
          return;
        }
        if (callState === 'calling' || callState === 'incoming') this.callState.set('incall');
        if (get(this.connectedAt) === null) this.connectedAt.set(Date.now());
        void pc
          .getStats()
          .then((stats) => appendLog(`[Call] selected path ${describeSelectedPair(stats)}`))
          .catch((e: unknown) => appendLog(`[Call] getStats failed: ${String(e)}`));
        // The RTP streams bind their codec on the first packet, after `connected`: read once
        // the media has had time to flow (a diagnostic read, nothing waits on it).
        setTimeout(() => this.logAudioCodecs(pc), CallService.CODEC_READ_DELAY_MS);
        // ONE path check per peer connection at its first connect (a reconnect does not re-arm
        // it; a rebuilt peer connection does), plus the report at the end (`cleanup`).
        if (!this.e2eConnectChecked) {
          this.e2eConnectChecked = true;
          this.scheduleE2ePathCheck(pc, '5 s after connected');
        }
      }
      if (state === 'disconnected') {
        // 'disconnected' is often transient (WebRTC may recover); log but do not tear down.
        appendLog('[Call] WebRTC peer connection disconnected (may recover)');
      }
      if (state === 'failed') {
        if (this.mediaEverConnected) {
          // A path that HAD connected. Acted on HERE too: Android Chromium was measured reaching
          // connectionState=failed while iceConnectionState stayed `disconnected`.
          this.maybeRestartIce('connectionState=failed');
          this.updateReconnecting();
        } else {
          this.failCall('connectionState=failed', this.neverConnectedCause());
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const iceState = pc.iceConnectionState;
      appendLog(`[Call] iceConnectionState=${iceState}`);
      if (iceState === 'connected' || iceState === 'completed') {
        if (this.iceRestarts > 0) {
          appendLog(`[Call] media path restored after ${this.iceRestarts} ICE restart(s)`);
        }
        this.mediaEverConnected = true;
        this.iceRestarts = 0;
        this.packetsAtRestart = null;
        this.restartOfferEpoch = null;
        this.restartRequestEpoch = null;
      } else if (iceState === 'failed' && !this.mediaEverConnected) {
        // Never connected: there is no path at all, and a restart would find the same candidates.
        appendLog(
          '[Call] ICE failed - no direct path and no TURN relay pair (check Cloudflare TURN on chat-delivery)'
        );
        if (relayGap) {
          // The call settled with no working pair AND no relay gathered: now the gap is evidence.
          appendLog(
            '[Call] WARN no TURN relay candidate was gathered and no direct pair worked (Cloudflare TURN unreachable or misconfigured)'
          );
        }
        this.failCall('iceConnectionState=failed', this.neverConnectedCause());
        return;
      } else if (iceState === 'disconnected' || iceState === 'failed') {
        // A path that had connected and was lost - a network change, a blip. Restart, not end.
        this.maybeRestartIce(`iceConnectionState=${iceState}`);
      }
      this.updateReconnecting();
    };

    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      appendLog(`[Call] adding ${tracks.length} local track(s) to PeerConnection`);
      for (const track of tracks) {
        // `addTrack` and BOTH transforms of its transceiver in ONE task, nothing awaited between
        // them. Chromium short-circuits a sender or receiver whose transform is not assigned by the
        // end of the task that created it, FOR GOOD: the transform keeps its transformer and is
        // never handed a frame, so clear media leaves and the peer's ciphertext reaches the decoder
        // (CALL-E2E-BYPASS-MI9T, measured on the Mi 9T's WebView 152 and desktop Chrome 155,
        // 2026-10-20 - an await of the worker's `keyReady` here was that task boundary). The key is
        // in the worker since `setupEncryption`. Both ends add an audio track before negotiating,
        // and the polite side's answer reuses this transceiver, so the remote audio always lands on
        // a receiver that already decrypts.
        const sender = pc.addTrack(track, this.localStream);
        this.attachSenderTransform(sender);
        // A track muted by the OS (or not producing yet) starts sending with no negotiation.
        track.onunmute = () => this.recheckE2eOnMediaStart(`after the local ${track.kind} unmuted`);
        const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
        if (!transceiver) throw new Error(`no transceiver for the ${track.kind} sender just added`);
        this.attachReceiverTransform(transceiver.receiver, track.kind);
        if (track.kind === 'video') {
          if (!preferVp8(transceiver, appendLog)) {
            this.refuseCameraSender(pc, sender, track);
            continue;
          }
          this.cameraTransceiver = transceiver;
          this.startVideoQuality(pc, sender);
        }
      }
      await configureCallAudioSenders(pc, this.callHasVideo, appendLog);
    }
  }

  /** How long after `connected` the E2E worker is asked for its report (see `askE2eReport`). */
  private static readonly E2E_REPORT_DELAY_MS = 5_000;
  /** How long the worker has to answer a report request before the bridge itself is accused. */
  private static readonly E2E_REPORT_ANSWER_MS = 1_500;

  /**
   * Asks the E2E worker for its counters; the caller logs them as ONE line (`describeE2eReport`).
   * WHY (2026-10-19): the Mi 9T logged no worker line in five calls, which could mean a lost
   * message bridge, a transform never handed to the worker, or a transform never fed a frame.
   * Asked, not waited for: no answer within `E2E_REPORT_ANSWER_MS` accuses the bridge in its own
   * line and resolves `null`.
   */
  private askE2eReport(tag: string, worker: Worker): Promise<E2eWorkerReport | null> {
    return new Promise<E2eWorkerReport | null>((resolve) => {
      const onAnswer = (event: MessageEvent<{ type?: string; tag?: string }>) => {
        if (event.data?.type !== 'report' || event.data.tag !== tag) return;
        window.clearTimeout(timer);
        worker.removeEventListener('message', onAnswer);
        if (this.e2eWorkerSilent) {
          this.e2eWorkerSilent = false;
          appendLog(`[Call] E2E worker report (${tag}): the worker answers again`);
        }
        resolve(event.data as E2eWorkerReport);
      };
      const timer = window.setTimeout(() => {
        worker.removeEventListener('message', onAnswer);
        // ONE line per silence, not one per re-check: the next answer says it is over.
        if (!this.e2eWorkerSilent) {
          this.e2eWorkerSilent = true;
          appendLog(
            `[Call] ERROR E2E worker report (${tag}): the worker did not answer in ${CallService.E2E_REPORT_ANSWER_MS} ms - its messages do not reach this thread`
          );
        }
        resolve(null);
      }, CallService.E2E_REPORT_ANSWER_MS);
      worker.addEventListener('message', onAnswer);
      worker.postMessage({ type: 'report', tag });
    });
  }

  /**
   * Forgets every piece of E2E evidence and every pending path check: a new call, or a peer
   * connection rebuilt for a replaced device, earns its claim from its OWN transforms.
   */
  private resetE2eEvidence(): void {
    if (this.e2ePathCheckTimer !== null) {
      window.clearTimeout(this.e2ePathCheckTimer);
      this.e2ePathCheckTimer = null;
    }
    this.e2eConnectChecked = false;
    // A rebuilt peer connection's end report judges frames only once ITS check has run.
    this.e2eReportFired = false;
    this.e2eRechecks = 0;
    this.e2ePathInconclusive = false;
    this.e2eLastUnjudged = '';
    this.e2ePrevPackets = null;
    this.e2eClaimWithdrawn = false;
    this.e2eWorkerSilent = false;
    this.e2eSenderSeen = false;
    this.e2eReceiverSeen = false;
    this.e2eProven.set(false);
  }

  /**
   * Arms ONE path check `E2E_REPORT_DELAY_MS` from now for `pc` (a check already pending covers
   * this trigger too). Triggers: the first `connected` of a peer connection, a camera added, a new
   * remote m-line - each is media the previous check did not see. The delay only lets packets flow
   * so there is something to compare; the verdict is the comparison (`checkE2eInPath`).
   */
  private scheduleE2ePathCheck(pc: RTCPeerConnection, why: string): void {
    // A peer connection still waiting for its peer has no media to judge: its first `connected`
    // arms the check, after the adoption.
    if (this.pcAwaitingPeer && pc === this.pc) return;
    const worker = this.encryptionWorker;
    if (!worker) {
      appendLog(`[Call] WARN E2E path check (${why}) not armed: no worker`);
      return;
    }
    // A check already pending KEEPS its deadline and takes this trigger's reason too: re-arming
    // on every trigger could postpone it for ever (review S2 of #2158). Media too young to be
    // judged at that deadline makes the check inconclusive, and it re-arms itself.
    if (this.e2ePathCheckTimer !== null) {
      this.e2ePathCheckReason = `${this.e2ePathCheckReason}, ${why}`;
      return;
    }
    this.e2ePathCheckReason = why;
    this.e2ePathCheckTimer = window.setTimeout(() => {
      this.e2ePathCheckTimer = null;
      this.e2eReportFired = true;
      void this.checkE2eInPath(pc, worker, this.e2ePathCheckReason);
    }, CallService.E2E_REPORT_DELAY_MS);
  }

  /**
   * The worker's report, and the PROOF it is read against: this peer connection's RTP packets as
   * the PREVIOUS check read them. A side and kind that had packets then and still no frame through
   * a transform of THIS peer connection now is media around the worker - clear media sent, or the
   * peer's ciphertext fed to the decoder - and the call ENDS, typed (`CallE2eBypassedError`).
   *
   * WHY the previous reading and not this one (review of #2159): `packetsReceived` counts packets,
   * and a video frame reaches the receiver transform only once all its packets are in, so a stream
   * whose first packets landed just before this read has packets and no frame yet - a healthy call
   * that a joined trigger checked early would have been ended. A whole check interval later, every
   * packet counted then has had its frame through the transform. A kind with packets now and no
   * frame, and no earlier reading, is too YOUNG: re-checked, never judged.
   *
   * Media too young, an m-line not negotiated yet, or a kind with no packet (`inconclusiveMedia`)
   * re-arms the check, up to `CALL_E2E_PATH_RECHECKS` times; past that the claim is WITHDRAWN and
   * the next event that starts media re-checks (`recheckE2eOnMediaStart`). NO ANSWER from the
   * worker withdraws the claim the same way and re-checks. No stats proves nothing: logged.
   */
  private async checkE2eInPath(pc: RTCPeerConnection, worker: Worker, why: string): Promise<void> {
    const recheck = this.e2eRechecks > 0;
    let packets: RtpPacketCounts | null = null;
    let stats: RTCStatsReport | null = null;
    let statsError = '';
    try {
      stats = await pc.getStats();
      packets = rtpPacketCounts(stats);
    } catch (e) {
      statsError = String(e);
    }
    const epoch = this.transformEpoch;
    // Without packets there is nothing to read the frames against: the worker is not asked.
    const report = packets ? await this.askE2eReport(why, worker) : null;
    // Stale FIRST: a check of a replaced peer connection may not withdraw the new one's claim.
    if (this.pc !== pc || this.encryptionWorker !== worker) {
      appendLog(
        `[Call] E2E path check (${why}) dropped: its peer connection was replaced or the call ended`
      );
      return;
    }
    if (!packets) {
      // Unverifiable, exactly as a worker that does not answer: withdrawn, and re-checked.
      this.withdrawE2eClaim(why, 'the stats cannot be read');
      this.recheckE2ePath(pc, why, [`getStats failed (${statsError})`], 'no packet counts');
      return;
    }
    const counts = describePacketCounts(packets);
    if (!report) {
      this.withdrawE2eClaim(why, 'the worker cannot be asked');
      this.recheckE2ePath(pc, why, ['the worker did not answer'], counts);
      return;
    }
    const facts = readE2eEngineFacts();
    const prev = this.e2ePrevPackets;
    this.e2ePrevPackets = packets;
    const sides = prev ? e2eBypassedSides(report, prev, epoch) : [];
    if (prev && sides.length > 0) {
      appendLog(describeE2eReport(report, facts, true, epoch));
      const frames = sides
        .map((k) => {
          const [side, kind] = k.split(':') as ['sender' | 'receiver', 'audio' | 'video'];
          return `${k}=${framesFor(report, epoch, side, kind)}`;
        })
        .join(' ');
      appendLog(
        `[Call] ERROR E2E path check (${why}): media flowed AROUND the transform on ${sides.join(' and ')} (previous check ${describePacketCounts(prev)}; now ${counts}; frames ${frames})`
      );
      this.failCall('E2E transform bypassed', new CallE2eBypassedError(sides));
      return;
    }
    const unjudged = [
      ...e2eBypassedSides(report, packets, epoch).map((k) => `${k}${CARRIED_NO_FRAME_YET}`),
      ...inconclusiveMedia(
        pc.getTransceivers().map((t) => ({
          kind: t.receiver.track?.kind ?? t.sender.track?.kind ?? '',
          currentDirection: t.currentDirection ?? null,
          hasTrack: !!t.sender.track,
          stopped: t.currentDirection === 'stopped',
        })),
        packets
      ),
    ];
    if (unjudged.length === 0) {
      appendLog(describeE2eReport(report, facts, true, epoch));
      this.e2eRechecks = 0;
      this.e2ePathInconclusive = false;
      this.e2eLastUnjudged = '';
      // THE SUCCESS LINE, worded as what it proved: every packet counted on every side carried a
      // frame through the transform (the bypass check above found none around it).
      appendLog(
        `[Call] E2E path check (${why}): PASS - all media went through the E2E transform (${counts})`
      );
      // A call carrying video says, at each conclusive check, whether the picture DECODES - an
      // encrypted frame can reach the decoder and still never show (frame rate, freezes, PLIs).
      if (stats && packets.sent.video + packets.received.video > 0) {
        appendLog(`[Call] ${describeVideoStats(stats)}`);
      }
      if (this.e2eClaimWithdrawn) {
        this.e2eClaimWithdrawn = false;
        this.claimE2eIfProven();
      }
      return;
    }
    // A re-check's report is logged only with a changed verdict below, and never judged: its media
    // is the one the check already said it cannot judge yet.
    if (!recheck) appendLog(describeE2eReport(report, facts, true, epoch));
    this.recheckE2ePath(pc, why, unjudged, counts);
  }

  /**
   * A check could not judge `unjudged`: re-armed while the budget lasts, logged only when what it
   * cannot judge CHANGES; past the budget, the claim is withdrawn and an event that starts media
   * re-checks (`recheckE2eOnMediaStart`).
   */
  private recheckE2ePath(
    pc: RTCPeerConnection,
    why: string,
    unjudged: readonly string[],
    counts: string
  ): void {
    this.e2ePathInconclusive = true;
    const state = unjudged.join(', ');
    // Packets with no frame YET is judged by the very next check - a frame through the transform,
    // or a bypass against this reading - so that state cannot repeat, and its next check is owed
    // OUTSIDE the budget: spending the budget must never drop a verdict that is one check away.
    const verdictNext = unjudged.some((u) => u.endsWith(CARRIED_NO_FRAME_YET));
    if (!verdictNext && this.e2eRechecks >= CALL_E2E_PATH_RECHECKS) {
      appendLog(
        `[Call] WARN E2E path check (${why}): still not judged after ${CALL_E2E_PATH_RECHECKS} re-checks (${state}; ${counts}) - waiting for media to start`
      );
      this.withdrawE2eClaim(why, `media not judged (${state})`);
      return;
    }
    if (!verdictNext) this.e2eRechecks += 1;
    if (state !== this.e2eLastUnjudged) {
      this.e2eLastUnjudged = state;
      appendLog(
        `[Call] E2E path check (${why}): not yet judged: ${state} (${counts}) - re-checking, at most ${CALL_E2E_PATH_RECHECKS} times`
      );
    }
    this.scheduleE2ePathCheck(pc, 're-check');
  }

  /** What a report says that the peer connection and the worker do not, stamped at THIS moment. */
  private reportStamp(phase: CallReportContext['phase']): Omit<CallReportContext, 'ice' | 'e2e'> {
    return {
      callId: this.currentCallId ?? '-',
      phase,
      durMs: this.tapAt === null ? 0 : performance.now() - this.tapAt,
      ringMs: this.ringMs,
      connectMs: this.connectMs,
      engine: currentEngine(),
    };
  }

  /**
   * Starts reading one `[CALL_REPORT]` of `pc`: its ICE state now, its stats and the worker's
   * counts (`askE2eReport`, bounded, `null` when the worker does not answer). Both reads START
   * here, so the end report reads a peer connection and a worker that are still alive. It never
   * rejects: a failed read is carried as `error`, to be said when the line is due.
   */
  private readCallReport(
    pc: RTCPeerConnection,
    phase: CallReportContext['phase']
  ): Promise<
    { stats: RTCStatsReport; e2e: E2eWorkerReport | null; ice: string } | { error: unknown }
  > {
    const worker = this.encryptionWorker;
    const ice = pc.iceConnectionState;
    return Promise.all([
      pc.getStats(),
      worker ? this.askE2eReport(`call report ${phase}`, worker) : Promise.resolve(null),
    ]).then(
      ([stats, e2e]) => ({ stats, e2e, ice }),
      (error: unknown) => ({ error })
    );
  }

  /**
   * Writes the line of a reading begun by `readCallReport` and returns its snapshot - or, when the
   * stats could not be read, says so and returns `null`. A tick of a peer connection rebuilt
   * meanwhile is not a failure: it is named as dropped.
   */
  private async logCallReport(
    pc: RTCPeerConnection,
    reading: ReturnType<CallService['readCallReport']>,
    stamp: Omit<CallReportContext, 'ice' | 'e2e'>,
    previous: MediaSnapshot | null
  ): Promise<MediaSnapshot | null> {
    const read = await reading;
    if ('error' in read) {
      appendLog(
        stamp.phase === 'tick' && this.pc !== pc
          ? '[Call] call report tick dropped - its peer connection was rebuilt while it was read'
          : `[Call] WARN call report (${stamp.phase}) not written: ${String(read.error)}`
      );
      return null;
    }
    const report = buildCallReport(
      read.stats,
      { ...stamp, ice: read.ice, e2e: read.e2e },
      previous
    );
    appendLog(report.line);
    return report.snapshot;
  }

  /**
   * Arms the next 10 s `[CALL_REPORT]` tick of `pc`. A tick reports only while the call is
   * `incall` (before that there is nothing to rate) and re-arms itself once its line is written,
   * for as long as `pc` is the call's peer connection.
   */
  private armCallReport(pc: RTCPeerConnection): void {
    this.stopCallReports();
    this.reportTimer = window.setTimeout(() => {
      this.reportTimer = null;
      if (this.pc !== pc) return;
      if (get(this.callState) !== 'incall') {
        this.armCallReport(pc);
        return;
      }
      const inFlight = {
        pc,
        snapshot: this.logCallReport(
          pc,
          this.readCallReport(pc, 'tick'),
          this.reportStamp('tick'),
          this.lastSnapshot
        ).then((snapshot) => {
          if (this.reportInFlight === inFlight) this.reportInFlight = null;
          if (this.pc !== pc) return snapshot;
          if (snapshot) this.lastSnapshot = snapshot;
          // Not after the end report began: it stopped the ticks, and `callState` says it.
          if (get(this.callState) === 'incall') this.armCallReport(pc);
          return snapshot;
        }),
      };
      this.reportInFlight = inFlight;
    }, CALL_REPORT_INTERVAL_MS);
  }

  private stopCallReports(): void {
    if (this.reportTimer !== null) {
      window.clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
  }

  /**
   * The END `[CALL_REPORT]`, once per call that built a peer connection: stamped and READ now,
   * while the peer connection and the worker are alive (`cleanup` releases them when the summary
   * closes), and WRITTEN after a tick still in flight, so no tick line follows it.
   */
  private writeEndReport(): void {
    const pc = this.pc;
    if (!pc) return;
    this.stopCallReports();
    const stamp = this.reportStamp('end');
    const reading = this.readCallReport(pc, 'end');
    const tick = this.reportInFlight;
    const previous = this.lastSnapshot;
    // Written after a tick in flight, so no tick line follows it; rated against that tick only if
    // it read THIS peer connection - an old one's totals would make a negative or bogus rate.
    void (tick?.snapshot ?? Promise.resolve(null)).then((tickSnapshot) =>
      this.logCallReport(pc, reading, stamp, (tick?.pc === pc ? tickSnapshot : null) ?? previous)
    );
  }

  /** How long after `connected` the negotiated audio codecs are read (see `logAudioCodecs`). */
  private static readonly CODEC_READ_DELAY_MS = 3_000;

  /**
   * Logs the audio codec each direction is bound to and the order each SDP offered them in. WHY
   * (2026-10-19): an iPhone's audio reached every receiver as noise while all Chromium pairs were
   * clean, and which codec WebKit really sends was in no log. Codec names only, never an address.
   */
  private logAudioCodecs(pc: RTCPeerConnection): void {
    if (this.pc !== pc || pc.connectionState !== 'connected') return;
    void pc
      .getStats()
      .then((stats) =>
        appendLog(
          `[Call] ${describeAudioCodecs(stats)} | local m=audio ${audioCodecOrder(pc.localDescription?.sdp)} | remote m=audio ${audioCodecOrder(pc.remoteDescription?.sdp)}`
        )
      )
      .catch((e: unknown) => appendLog(`[Call] getStats (codecs) failed: ${String(e)}`));
  }

  /** Writes one frame to the signalling socket. A frame that cannot leave is named, never dropped silently. */
  private sendSignal(msg: Record<string, unknown>) {
    if (this.signaledWs && this.signaledWs.readyState === WebSocket.OPEN) {
      this.signaledWs.send(JSON.stringify(msg));
    } else {
      appendLog(
        `[Call] signalling ${String(msg.type)} NOT sent - socket ${this.signaledWs ? `state ${this.signaledWs.readyState}` : 'absent'}`
      );
    }
  }

  /**
   * Derives this call's two media keys - one per direction, `role` deciding which one this device
   * sends with (`utils/callKeys.ts`) - and puts them in the worker. The log carries a SHA-256
   * fingerprint of each, never key bytes: one side's `send_fp` equals the other's `recv_fp` exactly
   * when the two ends agree, which two exported logs can show.
   */
  private async setupEncryption(groupId: string, callId: string, role: CallRole, seq: number) {
    this.assertSetupLive(seq, 'before the keys');
    const keys = await deriveCallKeys(
      (g, label, context, length) => this.mlsService.exportSecret(g, label, context, length),
      groupId,
      callId,
      role
    );
    try {
      this.assertSetupLive(seq, 'after the key export');
    } catch (e) {
      // Derived for a call that is over: zeroed here, never handed to a worker.
      keys.send.fill(0);
      keys.receive.fill(0);
      throw e;
    }
    this.dropCallKeys();
    this.callKeys = keys;
    // Not awaited: the digests are a diagnostic, and the call's setup does not wait on them.
    void Promise.all([keyFingerprint(keys.send), keyFingerprint(keys.receive)]).then(
      ([send, receive]) =>
        appendLog(
          `[Call] media keys derived from MLS (role=${role} send_fp=${send} recv_fp=${receive}, sha256)`
        ),
      (e: unknown) =>
        appendLog(
          `[Call] media keys derived from MLS (role=${role}, fingerprint failed: ${String(e)})`
        )
    );
    // The keys go INTO the worker now, before any track is added: the transforms are attached in
    // the task that creates their sender, where nothing may be awaited (`attachSenderTransform`).
    await this.ensureWorkerKeyReady();
    // A cleanup during the wait terminated that worker and dropped its memo and the keys.
    this.assertSetupLive(seq, 'after the worker took the keys');
    appendLog('[Call] E2E worker holds the call keys');
  }

  private getOrCreateEncryptionWorker(): Worker {
    if (!this.encryptionWorker) {
      const worker = new EncryptionWorker();
      this.encryptionWorker = worker;
      worker.onmessage = (
        event: MessageEvent<{ type: string; detail?: string; count?: number; mediaKind?: string }>
      ) => {
        const { type, detail, count, mediaKind } = event.data ?? {};
        if (type === 'decryptError') {
          appendLog(
            `[Call] E2E decrypt failed (${mediaKind ?? '?'}, ${count ?? '?'}): ${detail ?? 'unknown'}`
          );
        } else if (type === 'keyError') {
          appendLog(`[Call] E2E worker key error: ${detail ?? 'unknown'}`);
        } else if (type === 'droppedNoKey') {
          appendLog(`[Call] E2E frames dropped (no key in worker, ${count ?? '?'})`);
        } else if (type === 'warn') {
          appendLog(`[Call] E2E worker: ${detail ?? 'warn'}`);
        } else if (type === 'encryptOk') {
          appendLog(`[Call] E2E encrypting ${mediaKind ?? '?'} (${count} frame(s))`);
        } else if (type === 'decryptOk') {
          appendLog(`[Call] E2E decrypting ${mediaKind ?? '?'} (${count} frame(s))`);
        } else if (type === 'undecryptable') {
          const d = event.data as unknown as { epoch: number; failures: number };
          this.onUndecryptable(worker, d.epoch, mediaKind ?? '?', d.failures);
        } else if (type === 'transformError') {
          appendLog(
            `[Call] ERROR E2E transform threw (${count ?? '?'} so far): ${detail ?? 'unknown'}`
          );
        } else if (type === 'inPath') {
          const d = event.data as unknown as { side: string; epoch: number; mediaKind: string };
          this.noteE2eEvidence(worker, d.side, d.epoch, d.mediaKind);
        } else if (type === 'videoCodecUnexpected') {
          // Once per call: the worker keeps counting, and the report line carries the count.
          if (!this.videoCodecUnexpectedLogged) {
            this.videoCodecUnexpectedLogged = true;
            const mime = (event.data as unknown as { mimeType?: string }).mimeType ?? '?';
            appendLog(
              `[Call] ERROR E2E: video frames of ${mime}, not VP8, crossed the transform - encrypted whole, they cannot decode (${count ?? '?'} so far)`
            );
          }
        } else if (type === 'videoKeyframeIn') {
          appendLog(`[Call] remote video keyframe received (#${count})`);
        } else if (type === 'opusInvalid') {
          // The side that first shows a non-Opus payload is the side that corrupted it: a sender
          // line means this device's ENGINE handed the transform something else; a receiver line
          // with no sender line on the other device means it arrived that way.
          const { side, length, toc, payloadType } = event.data as unknown as {
            side: string;
            length: number;
            toc: number;
            payloadType: number;
          };
          appendLog(
            `[Call] ERROR E2E ${side}: audio payload is not an Opus packet (${count ?? '?'} so far; len=${length} toc=0x${toc.toString(16)} pt=${payloadType})`
          );
        } else if (type === 'transformer') {
          // ONE line per transformer: the app attaches one per sender and one per receiver, so a
          // second `sender` count for the same kind is a double attach; the codec is what the
          // engine actually feeds the transform.
          const d = event.data as unknown as Record<string, unknown>;
          appendLog(
            `[Call] E2E ${String(d.side)} transformer #${String(d.id)} (${String(d.count)} ${String(d.side)} in this worker): first frame ${String(d.mediaKind)} mime=${String(d.mimeType)} pt=${String(d.payloadType)}`
          );
        } else if (type === 'senderAudioShape') {
          // Posted once after 50 frames, and again only while an anomaly counter is non-zero:
          // `own-iv` is this device's OWN output handed back (a double pass), `repeated-ts` one
          // frame handed over twice, `not-opus` the engine feeding something else.
          const d = event.data as unknown as Record<string, number | string>;
          const anomalous = Number(d.notOpus) + Number(d.repeatedTs) + Number(d.ownIv) > 0;
          appendLog(
            `[Call] ${anomalous ? 'ERROR ' : ''}E2E sender audio #${d.id}: ${d.frames} frame(s), not-opus=${d.notOpus} repeated-ts=${d.repeatedTs} own-iv=${d.ownIv} len=${d.lenMin}..${d.lenMax} avg=${d.lenAvg} toc=${d.tocClass} (${d.tocShare}%)`
          );
        } else if (type === 'doubleEncrypted') {
          appendLog(
            `[Call] ERROR E2E receiver: audio frames decrypt TWICE - the other device encrypts each frame two times (${count ?? '?'} so far)`
          );
        }
      };
    }
    return this.encryptionWorker;
  }

  /**
   * One side of the E2E evidence: a transform of THIS call's worker and THIS peer connection
   * (`epoch`) encrypted (`sender`) or decrypted (`receiver`) its first frame. Both seen =
   * `e2eProven`, the only thing the screen's encryption claim reads. A late message from a previous
   * call's worker, or from a peer connection since rebuilt, is logged and lends nothing.
   */
  private noteE2eEvidence(worker: Worker, side: string, epoch: number, mediaKind: string): void {
    if (this.encryptionWorker !== worker || epoch !== this.transformEpoch) {
      appendLog(
        `[Call] E2E ${side} evidence (${mediaKind}) from a stale transform (epoch ${epoch}, current ${this.transformEpoch}) - ignored`
      );
      return;
    }
    if (side === 'sender') this.e2eSenderSeen = true;
    else if (side === 'receiver') this.e2eReceiverSeen = true;
    if (this.e2eClaimWithdrawn) {
      appendLog(
        `[Call] E2E ${side} evidence (${mediaKind}) noted - the claim stays withdrawn until a path check concludes`
      );
      return;
    }
    this.claimE2eIfProven();
  }

  /**
   * A receiver transform failed `DECRYPT_MISMATCH_FAILURES` frames and decrypted none (worker
   * `undecryptable`, F5 of #1997's review). When NO receiver of this peer connection has decrypted
   * anything, the two ends hold different keys - different MLS epochs, or a build on the other side
   * that derives them differently - and the call "connects" in silence: said in the log at ERROR and
   * shown to the user, once per call. When another receiver DID decrypt, the keys agree and this one
   * receiver's frames are broken another way: logged at ERROR, no notice. Decided by COUNTS the
   * worker kept, never by a timer.
   */
  private onUndecryptable(
    worker: Worker,
    epoch: number,
    mediaKind: string,
    failures: number
  ): void {
    if (this.encryptionWorker !== worker || epoch !== this.transformEpoch) {
      appendLog(
        `[Call] E2E undecryptable ${mediaKind} receiver of a stale transform (epoch ${epoch}, current ${this.transformEpoch}) - ignored`
      );
      return;
    }
    if (this.e2eReceiverSeen) {
      appendLog(
        `[Call] ERROR E2E ${mediaKind} receiver: ${failures} frame(s) failed and none decrypted, while another receiver of this call decrypts - not a key mismatch`
      );
      return;
    }
    appendLog(
      `[Call] ERROR E2E key mismatch - ${failures} ${mediaKind} frame(s) failed and none decrypted: the two ends hold different keys (compare this device's send_fp/recv_fp with the other's)`
    );
    if (this.keyMismatchShown) return;
    this.keyMismatchShown = true;
    showToast(m.call_e2e_key_mismatch(), 'error');
  }

  /** Sets the screen's claim when both sides were seen and nothing withdrew it. */
  private claimE2eIfProven(): void {
    if (!this.e2eSenderSeen || !this.e2eReceiverSeen || this.e2eClaimWithdrawn) return;
    if (get(this.e2eProven)) return;
    // connect_ms: the answer to the FIRST proof of the call (a claim withdrawn and earned again is
    // not a second connect).
    if (this.connectMs === null && this.answeredAt !== null) {
      this.connectMs = performance.now() - this.answeredAt;
    }
    appendLog(
      `[Call] E2E proven: this device encrypted a frame and decrypted one from the peer (connect_ms=${this.connectMs === null ? '-' : Math.round(this.connectMs)})`
    );
    this.e2eProven.set(true);
  }

  /**
   * Takes the screen's claim back until an answered, conclusive path check returns it: a worker
   * that cannot be asked, or media never judged, cannot be verified, whatever was proven before.
   */
  private withdrawE2eClaim(why: string, reason: string): void {
    this.e2eClaimWithdrawn = true;
    if (!get(this.e2eProven)) return;
    appendLog(`[Call] WARN E2E claim withdrawn (${why}): ${reason}`);
    this.e2eProven.set(false);
  }

  /**
   * An event that STARTS media - signalling back to `stable`, a remote track or the camera
   * unmuting - after a check that could not judge everything: a fresh re-check budget, one check
   * `E2E_REPORT_DELAY_MS` later. Nothing when the last check concluded.
   */
  private recheckE2eOnMediaStart(why: string): void {
    const pc = this.pc;
    if (!pc || !this.e2ePathInconclusive) return;
    this.e2eRechecks = 0;
    this.scheduleE2ePathCheck(pc, why);
  }

  /**
   * Forgets this call's media keys, ZEROING their bytes first: a key outlives its call only in the
   * worker, which is terminated at cleanup. The copies posted to the worker were transferred.
   */
  private dropCallKeys(): void {
    if (!this.callKeys) return;
    this.callKeys.send.fill(0);
    this.callKeys.receive.fill(0);
    this.callKeys = null;
  }

  /**
   * Pushes this call's two media keys into the encryption worker and waits until applied. A
   * `cleanup` during the wait SETTLES it (`abandonWorkerKeyWait`): its timer is cleared, so it can
   * never fire into the NEXT call, and the wait rejects with `CallSetupAbandonedError`.
   */
  private ensureWorkerKeyReady(): Promise<void> {
    if (!this.callKeys) return Promise.resolve();
    if (this.workerKeyReady) return this.workerKeyReady;

    const worker = this.getOrCreateEncryptionWorker();
    const ready: Promise<void> = new Promise<void>((resolve, reject) => {
      /** Ends this wait: its timer, its listener, and its memo - only if the memo is still its own. */
      const settle = (forget: boolean) => {
        window.clearTimeout(timeout);
        worker.removeEventListener('message', onReady);
        if (forget && this.workerKeyReady === ready) this.workerKeyReady = null;
        if (this.abandonWorkerKeyWait === abandon) this.abandonWorkerKeyWait = null;
      };
      const timeout = window.setTimeout(() => {
        settle(true);
        reject(new Error('encryption worker key timeout'));
      }, 3_000);
      const abandon = () => {
        settle(true);
        appendLog('[Call] the call ended while the worker took its keys - the wait is settled');
        reject(new CallSetupAbandonedError('waiting for the worker to take the keys'));
      };
      const onReady = (event: MessageEvent<{ type: string; detail?: string }>) => {
        if (event.data?.type === 'keyReady') {
          settle(false);
          // Only if this is still the call's worker: a call ended meanwhile cleared it.
          if (this.encryptionWorker === worker) this.workerKeyApplied = true;
          resolve();
        } else if (event.data?.type === 'keyError') {
          settle(true);
          reject(new Error(event.data.detail ?? 'worker key import failed'));
        }
      };
      this.abandonWorkerKeyWait = abandon;
      worker.addEventListener('message', onReady);
      const keys = this.callKeys;
      if (!keys) {
        settle(true);
        reject(new Error('no call keys'));
        return;
      }
      // Copies, transferred: the worker owns its bytes, and these copies leave this thread.
      const send = keys.send.slice().buffer;
      const receive = keys.receive.slice().buffer;
      worker.postMessage({ type: 'setKeys', send, receive }, [send, receive]);
    });
    this.workerKeyReady = ready;
    return ready;
  }

  /**
   * The keyed worker a transform is attached to, or a THROW: a call is refused, never sent in clear
   * (`CallE2eUnsupportedError` already refused an engine without the API). SYNCHRONOUS on purpose -
   * see `attachSenderTransform`.
   */
  private keyedWorker(side: 'sender' | 'receiver', mediaKind: string): Worker {
    if (!this.callKeys || !this.encryptionWorker || !this.workerKeyApplied) {
      throw new CallE2eSetupError(`${side} (${mediaKind}): the worker holds no call key`);
    }
    return this.encryptionWorker;
  }

  /**
   * A transform's options: its side, its track's kind - authenticated in every frame, so the worker
   * is TOLD it rather than reading it off a frame - and the peer connection it belongs to
   * (`transformEpoch`). THROWS for a kind that is neither audio nor video: such a transform could
   * not authenticate a frame, so it is never made.
   */
  private transformOptions(side: 'sender' | 'receiver', trackKind: string): CallTransformOptions {
    const kind = callMediaKind(trackKind);
    if (!kind) throw new CallE2eSetupError(`${side} (${trackKind}): not an audio or video track`);
    return { side, kind, epoch: this.transformEpoch };
  }

  /**
   * Attaches the E2E encrypt transform to a sender, in the SAME task as the `addTrack` that created
   * it: SYNCHRONOUS, it awaits nothing. Chromium short-circuits a sender whose transform is assigned
   * one task late, for good, and then sends clear media while the transform sits unfed
   * (CALL-E2E-BYPASS-MI9T, 2026-10-20). THROWS when the worker holds no key.
   */
  private attachSenderTransform(
    sender: RTCRtpSender,
    mediaKind = sender.track?.kind ?? 'unknown',
    how = 'attached'
  ): void {
    if (sender.transform) return;
    sender.transform = new RTCRtpScriptTransform(
      this.keyedWorker('sender', mediaKind),
      this.transformOptions('sender', mediaKind)
    );
    appendLog(`[Call] E2E sender transform ${how} (${mediaKind})`);
  }

  /** Attaches the E2E decrypt transform to a receiver: synchronous and throwing, like the sender. */
  private attachReceiverTransform(receiver: RTCRtpReceiver, mediaKind = 'unknown'): void {
    if (receiver.transform) return;
    receiver.transform = new RTCRtpScriptTransform(
      this.keyedWorker('receiver', mediaKind),
      this.transformOptions('receiver', mediaKind)
    );
    appendLog(`[Call] E2E receiver transform attached (${mediaKind})`);
  }

  /**
   * The camera goes OFF while the app is in the background and comes back ON when it returns -
   * through the SAME `cameraOff` / `cameraOn` as the button, never `track.enabled = false` (which
   * keeps the capture open and sends black frames the peer cannot tell from a camera). The peer
   * sees the avatar meanwhile; the audio goes on. A phone's OS stops a hidden page's capture
   * anyway, so this is what the peer would get - said instead of frozen.
   *
   * **Both signals, through `onAppScreenChange`**: `visibilitychange` on web, desktop and iOS, and
   * `canari:foreground` on Android, whose WebView reports `visible` in the background and fires no
   * visibility event at all (MainActivity.kt, `utils/appForeground.ts`). Listening to the first
   * alone left an Android camera to the OS, which ended it as `ended by the system` with no resume.
   */
  private installBackgroundHandler() {
    if (this.backgroundUnsubscribe) return;
    this.backgroundUnsubscribe = onAppScreenChange((onScreen) => {
      if (!this.localStream) return;
      if (!onScreen) {
        // Only a camera HEADED ON is paused: one the user turned off (an off in flight, or an off
        // queued behind an opening camera) must never come back at the return.
        if (!this.cameraHeadedOn()) return;
        this.videoPausedByBackground = true;
        appendLog('[Call] backgrounded - camera off until the app returns (audio continues)');
        void this.cameraOff('app in the background');
        return;
      }
      if (!this.videoPausedByBackground) return;
      if (this.cameraBusy && this.cameraOpTarget === 'on' && this.offPending) {
        // The pause's own off is still queued behind a camera that is opening - on Android, the
        // permission dialog itself pauses the activity. Cancel it: the opening camera is the answer.
        this.offPending = false;
        this.videoPausedByBackground = false;
        appendLog('[Call] foregrounded - the queued background off is cancelled, the camera opens');
        return;
      }
      if (this.cameraBusy && this.cameraOpTarget === 'off') {
        // The pause's off is still running: its end turns the camera on again (`cameraOff`).
        appendLog('[Call] foregrounded - camera on again once the running off ends');
        return;
      }
      this.videoPausedByBackground = false;
      appendLog('[Call] foregrounded - camera on again');
      void this.cameraOn();
    });
  }

  /** Where the camera is going: the running operation's target unless an off is queued, else its state. */
  private cameraHeadedOn(): boolean {
    return this.cameraBusy
      ? this.cameraOpTarget === 'on' && !this.offPending
      : !get(this.isVideoOff);
  }

  private removeBackgroundHandler() {
    this.backgroundUnsubscribe?.();
    this.backgroundUnsubscribe = null;
    this.videoPausedByBackground = false;
  }

  /**
   * Opens the microphone - REQUIRED: no call without it - and, for a video call, the camera
   * (`cameraOn`). A camera that cannot open (refused, busy, absent, no VP8) does not refuse the
   * call: it is said on screen (`call_camera_unavailable`) and logged, and the call goes on with
   * the camera off, which the user can retry from the call screen.
   */
  private async setupMedia(video: boolean, seq: number) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: buildCallAudioConstraints(),
      video: false,
    });
    try {
      this.assertSetupLive(seq, 'after the microphone prompt');
    } catch (e) {
      // Granted after the call ended: the microphone belongs to nobody, so it is released now.
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
    this.callHasVideo = video;
    this.localStream = stream;
    logCallAudioTrackSettings(this.localStream, appendLog);
    this.localStreamStore.set(this.localStream);
    this.isMuted.set(false);
    this.isVideoOff.set(true);
    const mic = this.localStream.getAudioTracks()[0];
    if (mic) this.watchSystemMicrophone(mic);
    if (video) {
      // `cameraOn` stops a capture that resolves after its call (`sameCameraCall`).
      await this.cameraOn();
      this.assertSetupLive(seq, 'after the camera');
    }
  }

  /**
   * THE OS TAKING THE MICROPHONE, told to both ends. A capture track goes `muted` when the system
   * stops feeding it - on the iPhone at every lock or trip to the background (CALL-IOS-MIC-HIDDEN,
   * measured 2026-10-20: the process and its WebRTC stack kept running, only the capture stopped) -
   * and that is not the user's mute: nothing on this screen set it. The partner is told over the
   * relay (`MicSuspended`), because only THIS side knows why the voice stopped; on the partner's
   * side silence, a lost path and a quiet room look the same. On the way back the user is told how
   * long they could not be heard, since the screen was not visible while it lasted.
   */
  private watchSystemMicrophone(mic: MediaStreamTrack): void {
    this.micWatchCleanup?.();
    const onMute = () => {
      if (this.micSuspendedSince !== null) return;
      this.micSuspendedSince = performance.now();
      appendLog(
        `[Call] WARN the system took the microphone (track muted, page ${typeof document !== 'undefined' && document.hidden ? 'hidden' : 'visible'}) - telling the other party`
      );
      this.localMicSuspended.set(true);
      this.sendMicState(true);
    };
    const onUnmute = () => {
      if (this.micSuspendedSince === null) return;
      const seconds = Math.max(1, Math.round((performance.now() - this.micSuspendedSince) / 1000));
      this.micSuspendedSince = null;
      appendLog(`[Call] the system gave the microphone back after ${seconds} s`);
      this.localMicSuspended.set(false);
      this.sendMicState(false);
      showToast(m.call_mic_was_suspended({ seconds }), 'warning');
    };
    const onEnded = () => appendLog('[Call] WARN the microphone track ended');
    mic.addEventListener('mute', onMute);
    mic.addEventListener('unmute', onUnmute);
    mic.addEventListener('ended', onEnded);
    this.micWatchCleanup = () => {
      mic.removeEventListener('mute', onMute);
      mic.removeEventListener('unmute', onUnmute);
      mic.removeEventListener('ended', onEnded);
    };
    // A track can be handed over already muted (the app was hidden while the call was set up).
    if (mic.muted) onMute();
  }

  /** Drops the capture track's listeners and both microphone states: the call is over. */
  private stopWatchingMicrophone(): void {
    this.micWatchCleanup?.();
    this.micWatchCleanup = null;
    this.micSuspendedSince = null;
    this.localMicSuspended.set(false);
    this.peerMicSuspended.set(false);
  }

  /** Sends this device's microphone state to the partner, once the pair exists to receive it. */
  private sendMicState(suspended: boolean): void {
    // Before the pairing there is nobody to tell; `announceMicOnPairing` sends it then.
    if (!this.peerArrived) return;
    this.sendSignal({ type: 'MicSuspended', suspended });
  }

  /**
   * A pairing (first, a replaced device, or a resume) starts from what each side KNOWS of itself:
   * the partner's earlier report may be about a device that is gone, or its `false` may have died
   * in a socket that dropped, so it is cleared, and this side re-announces a microphone the system
   * still holds. Both ends receive `PeerReady`, so both rebuild the pair's state the same way.
   */
  private announceMicOnPairing(): void {
    this.peerMicSuspended.set(false);
    if (this.micSuspendedSince !== null) {
      appendLog('[Call] the system still holds the microphone - telling the other party again');
      this.sendSignal({ type: 'MicSuspended', suspended: true });
    }
  }

  private async sendMlsNotification(groupId: string, appMsgPartial: canari.IAppMessage) {
    const appMsg = {
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      ...appMsgPartial,
    };
    const buffer = encodeAppMessage(appMsg);
    // WP-XP-5: ALL call signaling is sent silent - visible ringing on killed devices comes
    // exclusively from the explicit /api/calls/ring fan-out (CallStyle/CallKit), so these
    // protos must never surface as "new message" pushes (they used to, as generic fallbacks).
    // Ephemeral too: signalling is only meaningful while the call is live, so replaying it out of
    // the shared log would ring a device about a call that ended.
    await this.mlsService.sendMessage(groupId, buffer, undefined, DELIVERY.transport);
  }

  /** Toggles microphone mute on the local audio track. */
  public toggleMute() {
    const muted = !get(this.isMuted);
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    this.isMuted.set(muted);
  }

  /**
   * The camera button: OFF stops the capture (the camera light goes out), empties the sender and
   * renegotiates `recvonly`, so the peer's track MUTES and its screen shows the avatar; ON opens a
   * capture and hands it to the SAME sender, `sendrecv` again. A call that had no camera yet gets
   * one on a FRESH transceiver. Never `track.enabled = false`: that keeps the camera open and sends
   * black frames the peer cannot tell from a camera. A tap while an ON or a switch is still opening
   * the camera means OFF (the button already shows where that operation leads).
   */
  public async toggleVideo(): Promise<void> {
    // The user decides now: an automatic resume pending from the background is dropped.
    this.videoPausedByBackground = false;
    const turnOn = this.cameraBusy ? this.cameraOpTarget === 'off' : get(this.isVideoOff);
    if (turnOn) await this.cameraOn();
    else await this.cameraOff('turned off');
  }

  /**
   * Switches between the front and the back camera: the current capture is STOPPED first (a phone
   * opens one camera at a time), the other one opened with an EXACT facing, and handed to the same
   * sender - its E2E transform stays, no negotiation. A switch that cannot open the other camera
   * leaves the camera OFF, said on screen and logged; it never silently keeps the old one.
   */
  public async switchCamera(): Promise<void> {
    const old = this.localStream?.getVideoTracks()[0];
    if (!old || get(this.isVideoOff) || !this.beginCameraOp('switch', 'on')) return;
    const call = this.cameraCallToken();
    try {
      const next: CameraFacing = get(this.cameraFacing) === 'user' ? 'environment' : 'user';
      this.releaseCameraTrack(old);
      let track: MediaStreamTrack | undefined;
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: callVideoConstraints(next, true),
        });
        track = cam.getVideoTracks()[0];
        if (!track) throw new Error('no video track in the capture');
      } catch (e) {
        if (!this.sameCameraCall(call, 'switch')) return;
        appendLog(`[Call] ERROR camera switch to ${next} failed: ${String(e)} - the camera is off`);
        showToast(m.call_camera_switch_failed(), 'warning');
        await this.sendNoCamera('the switch failed');
        return;
      }
      if (!this.sameCameraCall(call, 'switch')) {
        track.stop();
        return;
      }
      this.adoptCameraTrack(track, next);
      const t = this.liveCameraTransceiver();
      if (t) await t.sender.replaceTrack(track);
      appendLog(
        `[Call] camera switched to ${get(this.cameraFacing)}${t ? ' (replaceTrack: same sender, same transform)' : ''}`
      );
    } finally {
      this.endCameraOp(call);
    }
  }

  /**
   * What a camera operation was started FOR: the call and its local stream. A capture that
   * resolves after either changed (the call ended, another one began while the permission prompt
   * was up) belongs to nobody and is stopped - never adopted by the NEXT call.
   */
  private cameraCallToken(): { callId: string | null; stream: MediaStream | null } {
    return { callId: this.currentCallId, stream: this.localStream };
  }

  /** Whether `token` names the call that is up now (no log: `sameCameraCall` is the logged form). */
  private isCameraCallCurrent(token: {
    callId: string | null;
    stream: MediaStream | null;
  }): boolean {
    return this.isCallLive(token.callId) && this.localStream === token.stream;
  }

  /** The call a camera operation was started for is still the live one (`cameraCallToken`). */
  private sameCameraCall(
    token: { callId: string | null; stream: MediaStream | null },
    what: string
  ): boolean {
    if (this.isCameraCallCurrent(token)) return true;
    appendLog(
      `[Call] camera ${what} of call ${token.callId ?? 'none'} resolved after it ended - capture stopped, not adopted`
    );
    return false;
  }

  /** Whether a call is up (ringing, connecting or in progress): a camera opened now has a use. */
  private callUp(): boolean {
    const state = get(this.callState);
    return state !== 'idle' && state !== 'ended' && !!this.localStream;
  }

  /**
   * Takes the camera lock for an operation leading to `target`, or says why a tap was dropped (one
   * camera operation at a time). An OFF asked while another runs is not dropped: it is kept as the
   * final state (`offPending`), applied by `endCameraOp` - off always wins.
   */
  private beginCameraOp(what: string, target: 'on' | 'off'): boolean {
    if (this.cameraBusy) {
      if (target === 'off' && this.cameraOpTarget === 'on') {
        this.offPending = true;
        appendLog(`[Call] camera ${what} queued - applied once the running camera operation ends`);
      } else {
        appendLog(`[Call] camera ${what} dropped - another camera operation is running`);
      }
      return false;
    }
    this.cameraBusy = true;
    this.cameraOpTarget = target;
    return true;
  }

  /**
   * Releases the camera lock, then applies an OFF that was asked meanwhile (`offPending`) - only
   * for the call the operation was started for: an operation that outlived its call (the call was
   * hung up, `cleanup` reset the lock, another call began) must not release THAT call's lock.
   */
  private endCameraOp(token: { callId: string | null; stream: MediaStream | null }): void {
    if (!this.isCameraCallCurrent(token)) return;
    this.cameraBusy = false;
    if (!this.offPending) return;
    this.offPending = false;
    void this.cameraOff('turned off while the camera was opening');
  }

  /** The camera transceiver, if it still belongs to the live peer connection. */
  private liveCameraTransceiver(): RTCRtpTransceiver | null {
    const t = this.cameraTransceiver;
    const pc = this.pc;
    if (!t || !pc || t.currentDirection === 'stopped') return null;
    return pc.getTransceivers().includes(t) ? t : null;
  }

  /**
   * Makes `track` the call's camera: in the local stream (the self view, and what a rebuilt peer
   * connection adds), its facing recorded, and its two events wired - `unmute` re-checks the E2E
   * path (an OS-muted camera starts sending with no negotiation), `ended` is the SYSTEM taking the
   * camera (another app, a revoked permission) and turns it off, said in the log.
   */
  private adoptCameraTrack(track: MediaStreamTrack, requested: CameraFacing): void {
    this.localStream?.addTrack(track);
    const settings = track.getSettings?.() ?? {};
    const settled = settings.facingMode;
    // What the camera REALLY captures (the constraints are ideals): the top rung is this size.
    appendLog(
      `[Call] camera captures ${settings.width ?? '?'}x${settings.height ?? '?'} at ${settings.frameRate ?? '?'} fps (${settled ?? requested})`
    );
    this.cameraFacing.set(settled === 'environment' || settled === 'user' ? settled : requested);
    track.onunmute = () => this.recheckE2eOnMediaStart('after the camera unmuted');
    track.onended = () => {
      if (!this.localStream?.getVideoTracks().some((t) => t === track)) return;
      // Only a camera HEADED ON is the background pause's (as in the handler): one the user was
      // already turning off stays off at the return.
      if (!isAppOnScreen() && this.cameraHeadedOn()) {
        // The OS took the camera of an app already off screen, before the background handler
        // could: the same pause as the handler's, so the return turns it on again.
        this.videoPausedByBackground = true;
        appendLog('[Call] the system ended the camera of a backgrounded app - on again at return');
        void this.cameraOff('app in the background');
        return;
      }
      appendLog('[Call] WARN the system ended the camera - turning it off');
      void this.cameraOff('ended by the system');
    };
    this.localStreamStore.set(this.localStream);
    this.isVideoOff.set(false);
  }

  /** Stops a camera capture and takes it out of the local stream (its `ended` is not the system's). */
  private releaseCameraTrack(track: MediaStreamTrack): void {
    track.onended = null;
    track.onunmute = null;
    track.stop();
    this.localStream?.removeTrack(track);
  }

  /**
   * Opens the camera and sends it: on the camera transceiver this peer connection already has
   * (`replaceTrack`, then `sendrecv`), on a FRESH transceiver when it has none, or - before the peer
   * connection exists - into the local stream, which `initPeerConnection` adds.
   */
  private async cameraOn(): Promise<void> {
    // THE choke point of every camera open (a video call's setup, the camera button): an
    // audio-only build never opens one, whatever path asked.
    if (!CALLS_VIDEO_ENABLED) {
      appendLog('[Call] camera refused - this build is audio only');
      return;
    }
    if (!this.callUp() || !this.beginCameraOp('on', 'on')) return;
    const call = this.cameraCallToken();
    try {
      if (!canHoldVideoToVp8()) {
        appendLog('[Call] ERROR this engine cannot hold video to VP8 - the camera stays off');
        showToast(m.call_camera_unavailable(), 'warning');
        return;
      }
      const facing = get(this.cameraFacing);
      let track: MediaStreamTrack | undefined;
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: callVideoConstraints(facing),
        });
        track = cam.getVideoTracks()[0];
        if (!track) throw new Error('no video track in the capture');
      } catch (e) {
        if (!this.sameCameraCall(call, 'on')) return;
        appendLog(`[Call] WARN the camera could not open: ${String(e)} - it stays off`);
        showToast(m.call_camera_unavailable(), 'warning');
        return;
      }
      // The call may have ended - and another begun - while the permission prompt was up.
      if (!this.sameCameraCall(call, 'on')) {
        track.stop();
        return;
      }
      this.callHasVideo = true;
      this.adoptCameraTrack(track, facing);
      void this.refreshCameraCount();
      const pc = this.pc;
      if (!pc) {
        appendLog('[Call] camera on - sent once the peer connection is built');
        return;
      }
      const t = this.liveCameraTransceiver();
      if (t) {
        await t.sender.replaceTrack(track);
        t.direction = 'sendrecv';
        // The ladder paused while the sender had no camera: it samples again, from a new baseline.
        this.videoQuality?.resume();
        this.scheduleE2ePathCheck(pc, 'after the camera came back');
        appendLog('[Call] camera on again (replaceTrack on its sender, sendrecv - renegotiating)');
        return;
      }
      this.addCameraTransceiver(pc, track);
    } finally {
      this.endCameraOp(call);
    }
  }

  /**
   * The first camera of a peer connection that has none: a FRESH transceiver, never `addTrack`,
   * which may REUSE a transceiver the peer's offer created, whose sender Chromium short-circuited
   * if it was bare at its creation (measured on the Mi 9T, 2026-10-20; rig row
   * `fault-video-bare-sender`). Both transforms in the task that creates it, as in
   * `initPeerConnection`; `negotiationneeded` then carries the new m-line.
   */
  private addCameraTransceiver(pc: RTCPeerConnection, track: MediaStreamTrack): void {
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendrecv',
      streams: this.localStream ? [this.localStream] : [],
    });
    try {
      this.attachSenderTransform(transceiver.sender, 'video');
      this.attachReceiverTransform(transceiver.receiver, 'video');
    } catch (e) {
      // Never a video sender without its transform: removed before any negotiation carries it.
      pc.removeTrack(transceiver.sender);
      this.releaseCameraTrack(track);
      this.isVideoOff.set(true);
      appendLog(`[Call] E2E transform for the camera failed: ${String(e)}`);
      this.failCall(
        'E2E transform for the camera failed',
        e instanceof CallE2eSetupError ? e : new CallE2eSetupError('sender (video)', { cause: e })
      );
      return;
    }
    if (!preferVp8(transceiver, appendLog)) {
      this.refuseCameraSender(pc, transceiver.sender, track);
      return;
    }
    this.cameraTransceiver = transceiver;
    this.scheduleE2ePathCheck(pc, 'after the camera was added');
    this.startVideoQuality(pc, transceiver.sender);
    appendLog('[Call] camera added mid-call on a fresh transceiver (renegotiating)');
  }

  /**
   * Starts the camera sender's quality ladder (`CallVideoQualityLoop`, the loop the rig runs too):
   * the start rung applied now, then one `getStats()` sample every 2 s while the camera sends. It
   * belongs to THIS sender of THIS peer connection; a rebuilt one stops it.
   */
  private startVideoQuality(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    this.stopVideoQuality();
    // A peer connection still waiting for its peer sends nothing to sample: the adoption starts
    // the ladder on the camera sender it then has ({@link adoptRingPeerConnection}).
    if (this.pcAwaitingPeer && pc === this.pc) return;
    const loop = new CallVideoQualityLoop({
      pc,
      sender,
      log: appendLog,
      onReduced: (reduced) => {
        if (this.videoQuality === loop) this.videoSendReduced.set(reduced);
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    this.videoQuality = loop;
    loop.start();
  }

  /**
   * Stops the ladder: the call ended or its peer connection was rebuilt, so the picture it reduced
   * is gone too. (A rung the ENGINE refused stops the loop by itself and leaves the flag as the
   * sender still is.)
   */
  private stopVideoQuality(): void {
    this.videoQuality?.stop();
    this.videoQuality = null;
    this.videoSendReduced.set(false);
  }

  /**
   * A camera sender whose transceiver could not be held to VP8 (`preferVp8` said why, at ERROR) is
   * taken back before any negotiation carries it: a codec the transform does not frame is never
   * sent, not even encrypted whole. The call goes on without the camera, said on screen.
   */
  private refuseCameraSender(pc: RTCPeerConnection, sender: RTCRtpSender, track: MediaStreamTrack) {
    pc.removeTrack(sender);
    this.releaseCameraTrack(track);
    this.isVideoOff.set(true);
    this.localStreamStore.set(this.localStream);
    showToast(m.call_camera_unavailable(), 'warning');
    appendLog('[Call] camera sender removed - not VP8, never sent');
  }

  /**
   * Turns the camera OFF: every capture stopped (the camera light goes out), and the sender
   * emptied with the transceiver `recvonly` (`sendNoCamera`), so the peer's track mutes.
   */
  private async cameraOff(why: string): Promise<void> {
    if (!this.beginCameraOp('off', 'off')) return;
    const call = this.cameraCallToken();
    try {
      for (const track of this.localStream?.getVideoTracks() ?? []) this.releaseCameraTrack(track);
      await this.sendNoCamera(why);
    } finally {
      // An off that outlived its call touches nothing of the next one: its lock, its resume.
      if (this.isCameraCallCurrent(call)) this.finishCameraOff();
    }
  }

  /** The end of a current call's `cameraOff`: the lock released, then a deferred background resume. */
  private finishCameraOff(): void {
    this.cameraBusy = false;
    // A background pause whose return came while this off was still running: resume now.
    if (this.videoPausedByBackground && isAppOnScreen() && this.callUp()) {
      this.videoPausedByBackground = false;
      appendLog('[Call] foregrounded during the background off - camera on again');
      void this.cameraOn();
    }
  }

  /** The camera is off: nothing on its sender, `recvonly` (renegotiates), the screen says so. */
  private async sendNoCamera(why: string): Promise<void> {
    this.isVideoOff.set(true);
    this.localStreamStore.set(this.localStream);
    const t = this.liveCameraTransceiver();
    if (t) {
      try {
        await t.sender.replaceTrack(null);
      } catch (e) {
        appendLog(`[Call] emptying the camera sender failed: ${String(e)}`);
      }
      if (t.direction !== 'recvonly' && t.direction !== 'inactive') t.direction = 'recvonly';
    }
    appendLog(
      `[Call] camera off (${why})${t ? ' - sender emptied, recvonly (renegotiating)' : ''}`
    );
  }

  /** Reads how many cameras the device has, once one is open (labels and counts need the grant). */
  private async refreshCameraCount(): Promise<void> {
    try {
      const cameras = await countVideoInputs();
      if (cameras >= 2 !== get(this.canSwitchCamera)) {
        appendLog(`[Call] ${cameras} camera(s) on this device`);
        this.canSwitchCamera.set(cameras >= 2);
      }
    } catch (e) {
      appendLog(`[Call] listing the cameras failed: ${String(e)} - no camera switch offered`);
    }
  }
}
