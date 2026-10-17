import { writable, get } from 'svelte/store';
import { resolveServiceUrl } from '$lib/utils/apiUrl';
import type { IMlsService } from '$lib/mls-client';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { canari } from '../proto/canari.js';
import { encodeAppMessage, mkCallAnswered, mkCallHangup, mkCallInvite } from '../proto/codec';
import EncryptionWorker from '../workers/encryption.worker?worker';
import { appendLog } from '$lib/utils/sessionLog';
import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';
import { consumePendingCallAccept } from '$lib/stores/pendingCallAccept';
import { getToken } from '$lib/stores/auth';
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
  logCallAudioTrackSettings,
} from '$lib/utils/callAudio';
import { publishCallPresence } from '$lib/utils/callPresence';
import {
  CallE2eUnsupportedError,
  CallInitiateError,
  describeCallFailure,
} from '$lib/utils/callFailure';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { getCallSystemMessageContext, recordCallMissed } from '$lib/utils/chat/callSystemMessages';
import { CALLS_ENABLED } from '$lib/features';
import { isBlockedWith, refusalCodeOf } from '$lib/users/blocks';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import {
  buildCallReport,
  describeEngine,
  describeSelectedPair,
  refusedCallReport,
  type CallReportContext,
  type E2eCounters,
  type MediaSnapshot,
} from '$lib/utils/callStats';
import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';

/** How often a live call writes its `[CALL_REPORT]` (revival plan section 6). */
const CALL_REPORT_INTERVAL_MS = 10_000;

/** The `engine=` field of every report from this device. */
function currentEngine(): string {
  const shell = isAndroidTauriRuntime() ? 'android' : isIosTauriRuntime() ? 'ios' : null;
  return describeEngine(navigator.userAgent, shell);
}

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

/** Optional hook to mirror call lifecycle events into the chat timeline. */
export interface CallChatNotifier {
  onCallStarted: (groupId: string, callId: string) => void | Promise<void>;
  onCallEnded: (groupId: string, callId: string) => void | Promise<void>;
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

/** A server-to-client frame of the signalling socket (`apps/call-service`, `SignalMessage`). */
export type SignalFrame =
  | { type: 'Joined'; room_id?: string }
  | { type: 'PeerReady'; initiator: boolean }
  | { type: 'PeerLeft' }
  | { type: 'Refused'; reason: string }
  | { type: 'Offer' | 'Answer'; sdp: string }
  | { type: 'IceCandidate'; candidate: string };

/**
 * Manages 1:1 calls: MLS signalling for ring/answer/hangup, a PEER-TO-PEER media path negotiated
 * through `call-service`'s two-person relay (`/api/call`, `mode: "p2p"`), MLS-derived keys for the
 * mandatory E2E frame transform, and Cloudflare TURN as the last-resort relay.
 */
export class CallService {
  private pc: RTCPeerConnection | null = null;
  private signaledWs: WebSocket | null = null;
  /** ICE servers fetched for this call before ringing, so a missing TURN key fails the call early. */
  private iceServers: RTCIceServer[] | null = null;
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
  /** `performance.now()` at the user's tap (call or answer): the origin of `dur_ms`/`setup_ms`. */
  private tapAt: number | null = null;
  /** Tap to the first unmuted remote audio track - the plan's `setup_ms`. */
  private setupMs: number | null = null;
  /** The 10 s `[CALL_REPORT]` cadence, from the peer connection's creation to cleanup. */
  private reportTimer: number | null = null;
  /** The previous reading's byte totals, so the next one can state a rate. */
  private lastSnapshot: MediaSnapshot | null = null;
  /** The end report's context, stamped when the call ended rather than when its summary closed. */
  private endStamp: Omit<CallReportContext, 'ice' | 'e2e'> | null = null;
  private localStream: MediaStream | null = null;
  private encryptionWorker: Worker | null = null;
  private workerKeyReady: Promise<void> | null = null;
  /** All remote tracks merged for 1:1 display (audio + video in one MediaStream). */
  private mergedRemoteStream: MediaStream | null = null;
  private callKeyBytes: Uint8Array | null = null;
  private pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];

  public currentCallId: string | null = null;
  public currentGroupId: string | null = null;
  /** Room access token issued by chat-delivery-service, sent in the SFU Join message. */
  private currentRoomToken: string | null = null;
  /** User id of the peer who rang (incoming); used for avatar when no conversation is selected. */
  public incomingCallerId: string | null = null;
  public incomingHasVideo = true;
  private callKey: CryptoKey | null = null;

  private callHasVideo = false;
  /** `visibilitychange` listener installed during a call; removed on cleanup. */
  private backgroundVisibilityHandler: (() => void) | null = null;
  /** True while the camera was auto-paused because the tab/app went to the background. */
  private videoPausedByBackground = false;

  public callState = writable<CallState>('idle');
  /** @deprecated Use remoteStreams for multi-party; kept for single-remote fallback. */
  public remoteStream = writable<MediaStream | null>(null);
  public remoteStreams = writable<RemoteStreams>(new Map());
  public localStreamStore = writable<MediaStream | null>(null);
  public isMuted = writable<boolean>(false);
  public isVideoOff = writable<boolean>(false);

  private chatNotifier: CallChatNotifier | null = null;

  constructor(private mlsService: IMlsService) {}

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
        this.endCall(false);
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
      // The conversation's call permission: the server already withheld the ring push, and the
      // in-app invite is the half it cannot read. The missed-call line is `handleCallSignalForChat`'s
      // to write, from the same predicate, so the timeline has one writer.
      if (!notificationPreferences.callsAllowed(groupId)) {
        appendLog(
          `[Call] invite ${callMsg.callId} in ${groupId} not rung - calls are not allowed in this conversation`
        );
        return;
      }
      if (get(this.callState) !== 'idle') return;
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

      this.currentCallId = callMsg.callId;
      this.currentGroupId = groupId;
      this.incomingCallerId = senderNorm;
      this.incomingHasVideo = callMsg.hasVideo !== false;
      this.callState.set('incoming');
      this.armRingTimer(callMsg.callId, ringTimeoutMs, 'incoming');

      // WP-XP-5: the user may have ALREADY answered this call on a system surface (Android
      // CallStyle notification deep link / iOS CallKit) before the app was unlocked and the
      // invite reached us over WS. Consume the recorded intent and auto-accept.
      const pendingAccept = consumePendingCallAccept(callMsg.callId);
      if (pendingAccept) {
        appendLog(`[Call] auto-accepting call ${callMsg.callId} (system-surface answer)`);
        void this.acceptCall(groupId, callMsg.callId);
      }
    }
  }

  /**
   * Whether an invite from `senderNorm` may ring here. The server refuses `initiate` and `ring`
   * across a block, so an honest caller never sends this invite; a client that skips them can
   * still send the MLS `call_invite` itself, and THIS is where that ring is stopped - a block must
   * not ring the in-app UI either. A failure to ASK is not an answer, so it does not ring and says
   * so at error level. Re-checks the slot afterwards: another invite may have rung during the await.
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
    if (get(this.callState) !== 'idle' || this.currentCallId) {
      appendLog(`[Call] invite ${callId} not rung: another call took this device meanwhile`);
      return false;
    }
    return true;
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
      if (side === 'calling') this.endCall(true);
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
    this.tapAt = performance.now();

    try {
      this.callState.set('calling');
      // Get server-issued room ID and access token before connecting.
      const { roomId, roomToken, ringTimeoutMs } = await this.fetchInitiateCall(groupId);
      this.currentCallId = roomId;
      this.currentRoomToken = roomToken;
      // Before ringing: a server without TURN credentials (503) fails the call here, not after
      // the callee has answered into a call that can never connect.
      this.iceServers = await this.fetchIceServers(groupId, roomId);
      await this.setupMedia(video);
      this.installBackgroundHandler();
      await this.setupEncryption(groupId, this.currentCallId!);
      // The caller joins first, so the relay makes it the initiator when the callee arrives.
      await this.connectSignalling(roomId);
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
      const msg = String(e);
      appendLog(`[Call] startCall failed: ${msg}`);
      console.error('Error starting call:', e);
      // Once the invite has left, the other party is ringing: hang up so it stops, rather than
      // leaving it to ring into a call that will never answer.
      this.endCall(this.inviteSent);
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

  /** Accepts an incoming call after the user taps accept. */
  public async acceptCall(groupId: string, callId: string, video?: boolean) {
    if (get(this.callState) !== 'incoming') return;

    this.currentGroupId = groupId;
    this.currentCallId = callId;
    // Answered: the server's deadline, not this timer, now decides (a late token is a 410).
    this.clearRingTimer();
    this.tapAt = performance.now();
    const useVideo = video ?? this.incomingHasVideo;

    try {
      if (!canUseRtpScriptTransform()) {
        appendLog(refusedCallReport(callId, currentEngine()));
        throw new CallE2eUnsupportedError();
      }
      this.callState.set('incall');
      // The token FIRST: it is where the server refuses (a block set while the call rang, a closed
      // window), and a refused answer must not have told anyone it was answered. Our siblings stop
      // ringing one round trip later than they would otherwise - nothing reads that gap.
      this.currentRoomToken = await this.fetchRoomToken(groupId, callId);
      const deviceId = this.mlsService.getDeviceId();
      // Tell our other devices to stop ringing before joining the SFU.
      await this.sendMlsNotification(groupId, mkCallAnswered(callId, deviceId));
      // WP-XP-5: also stop the system-surface rings (CallStyle notifs / CallKit) everywhere.
      void this.endServerRing(groupId, callId, 'answered');
      this.iceServers = await this.fetchIceServers(groupId, callId);
      await this.setupMedia(useVideo);
      this.installBackgroundHandler();
      await this.setupEncryption(groupId, callId);
      await this.connectSignalling(callId);
      this.syncCallPresence(true);
    } catch (e) {
      const msg = String(e);
      appendLog(`[Call] acceptCall failed: ${msg}`);
      showToast(describeCallFailure(e), 'warning');
      this.endCall();
    }
  }

  /** Ends the active call and optionally notifies the group via MLS. */
  public endCall(notify: boolean = true) {
    const groupId = this.currentGroupId;
    const callId = this.currentCallId;
    // Guard against double-calls: if cleanup already ran - or the call is already showing its
    // ended summary - do not re-enter. A peer-to-peer hangup arrives TWICE (the MLS `call_hangup`
    // and the relay's `PeerLeft`), and a second pass would write a second "call ended" message.
    const state = get(this.callState);
    if (state === 'idle' || state === 'ended') return;
    // Captured BEFORE cleanup: 'calling' means nobody answered yet (ring cancellation).
    const wasCalling = get(this.callState) === 'calling';
    if (notify && groupId && callId) {
      this.sendMlsNotification(groupId, mkCallHangup(callId, this.mlsService.getDeviceId())).catch(
        console.error
      );
      // WP-XP-5: stop the system-surface rings on every device (cancelled before pickup,
      // or a late ring after the call ended).
      void this.endServerRing(groupId, callId, wasCalling ? 'cancelled' : 'ended');
    }
    if (groupId && callId) {
      void this.chatNotifier?.onCallEnded(groupId, callId);
      // Missed only if someone was actually rung: a call that failed before its invite (the
      // initiate refused, no ICE servers, no microphone) rang nobody and missed nothing.
      if (wasCalling && this.inviteSent) {
        const ctx = getCallSystemMessageContext();
        const callerId = ctx?.userId ?? '';
        void recordCallMissed(ctx, groupId, callId, callerId);
      }
    }

    // Show the "ended" summary screen briefly (1.5 s) so the user sees the call
    // duration and result before the overlay disappears (P4).
    if (get(this.callState) === 'incall' || get(this.callState) === 'calling') {
      // The end report describes the call as it ENDED, not as the summary screen left it 1.5 s later.
      this.endStamp = this.reportContext('end');
      this.callState.set('ended');
      setTimeout(() => {
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
   * Terminates a call that hit a non-recoverable transport failure (ICE/connection
   * `failed`, or the SFU socket dropping mid-call). Without this, a dead media path
   * left the UI stuck "in call" on a frozen stream. No-op once the call is already
   * idle, so overlapping failure events (ICE + connection both fire `failed`) only
   * tear down once. Ends only this leg without broadcasting an MLS hangup: in a group
   * call one peer's failed relay must not end everyone else's call.
   */
  private failCall(reason: string): void {
    if (get(this.callState) === 'idle') return;
    appendLog(`[Call] terminal failure: ${reason} - ending call`);
    showToast(m.call_connection_lost(), 'error');
    this.endCall(false);
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

  private cleanup() {
    this.clearRingTimer();
    this.stopCallReports();
    // The END report is read from the peer connection and the worker BEFORE either is released,
    // and they are released only once it is written: the order is the guarantee, not a delay.
    const pc = this.pc;
    const worker = this.encryptionWorker;
    const ending = pc ? (this.endStamp ?? this.reportContext('end')) : null;
    const previous = this.lastSnapshot;
    this.endStamp = null;
    this.pc = null;
    this.encryptionWorker = null;
    this.workerKeyReady = null;
    this.lastSnapshot = null;
    this.tapAt = null;
    this.setupMs = null;
    this.inviteSent = false;
    this.peerArrived = false;
    this.removeBackgroundHandler();
    this.syncCallPresence(false);
    this.callState.set('idle');
    this.currentCallId = null;
    this.currentGroupId = null;
    this.incomingCallerId = null;
    this.callKey = null;
    this.callKeyBytes = null;
    this.currentRoomToken = null;
    this.mergedRemoteStream = null;
    this.pendingRemoteIceCandidates = [];
    this.iceServers = null;
    this.polite = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.incomingHasVideo = true;
    this.callHasVideo = false;

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.localStreamStore.set(null);

    if (this.signaledWs) {
      this.signaledWs.close();
      this.signaledWs = null;
    }
    const release = () => {
      pc?.close();
      worker?.terminate();
    };
    if (pc && ending) {
      void this.writeCallReport(pc, worker, ending, previous)
        .catch((e: unknown) => appendLog(`[Call] WARN end report not written: ${String(e)}`))
        .finally(release);
    } else {
      release();
    }

    this.remoteStream.set(null);
    this.remoteStreams.set(new Map());
  }

  /** What a report says that the peer connection and the worker do not, stamped at THIS moment. */
  private reportContext(phase: CallReportContext['phase']): Omit<CallReportContext, 'ice' | 'e2e'> {
    return {
      callId: this.currentCallId ?? '-',
      phase,
      durMs: this.tapAt === null ? 0 : performance.now() - this.tapAt,
      setupMs: this.setupMs,
      engine: currentEngine(),
    };
  }

  /**
   * Asks the E2E worker for its exact totals. No timeout: a live worker always answers, and a dead
   * one says so through its `error` event, which rejects - so the end report can never hold the
   * peer connection open waiting for an answer that cannot come.
   */
  private requestCounters(worker: Worker): Promise<E2eCounters> {
    return new Promise<E2eCounters>((resolve, reject) => {
      const done = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const onMessage = (event: MessageEvent<{ type?: string; counters?: E2eCounters }>) => {
        if (event.data?.type !== 'counters' || !event.data.counters) return;
        done();
        resolve(event.data.counters);
      };
      const onError = (event: Event) => {
        done();
        reject(new Error(`encryption worker failed: ${event.type}`));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'getCounters' });
    });
  }

  /**
   * Reads `getStats()` and the worker's counters, writes ONE `[CALL_REPORT]` line, and keeps the
   * snapshot the next tick turns into a rate (WP-C2, revival plan section 6).
   */
  private async writeCallReport(
    pc: RTCPeerConnection,
    worker: Worker | null,
    stamp: Omit<CallReportContext, 'ice' | 'e2e'>,
    previous: MediaSnapshot | null
  ) {
    const ice = pc.iceConnectionState;
    const stats = await pc.getStats();
    let e2e: E2eCounters | null = null;
    if (worker) {
      try {
        e2e = await this.requestCounters(worker);
      } catch (e) {
        appendLog(`[Call] WARN E2E counters unavailable for the report: ${String(e)}`);
      }
    }
    const report = buildCallReport(stats, { ...stamp, ice, e2e }, previous);
    appendLog(report.line);
    return report.snapshot;
  }

  /** Starts the 10 s reports of a live call; a second start replaces the first (a rebuilt pc). */
  private startCallReports() {
    this.stopCallReports();
    this.reportTimer = window.setInterval(() => {
      const pc = this.pc;
      if (!pc || get(this.callState) !== 'incall') return;
      void this.writeCallReport(
        pc,
        this.encryptionWorker,
        this.reportContext('tick'),
        this.lastSnapshot
      )
        .then((snapshot) => {
          // A report that resolves after the call ended or the pc was rebuilt keeps no snapshot.
          if (this.pc === pc) this.lastSnapshot = snapshot;
        })
        .catch((e: unknown) => appendLog(`[Call] WARN call report not written: ${String(e)}`));
    }, CALL_REPORT_INTERVAL_MS);
  }

  private stopCallReports() {
    if (this.reportTimer !== null) {
      window.clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
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
        `calls/ring failed (${res.status})${detail ? `: ${detail}` : ''}`
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

  /** Fetches short-lived TURN credentials from chat-delivery (Bearer auth, same as /api/mls). */
  private async fetchIceServers(groupId: string, callId: string): Promise<RTCIceServer[]> {
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
      throw new Error(`Failed to fetch ICE servers: ${res.status}${detail ? ` - ${detail}` : ''}`);
    }

    const data = (await res.json()) as { iceServers?: IceServerConfig[] };
    const servers = data.iceServers ?? [];

    if (servers.length === 0) {
      appendLog('[Call] ICE servers: empty response');
      throw new Error('No ICE servers returned');
    }

    const mapped = servers.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }));

    const urlPreview = mapped
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .slice(0, 2)
      .map((u) => (typeof u === 'string' ? u.split('?')[0] : u))
      .join(', ');
    appendLog(
      `[Call] ${mapped.length} ICE server(s) (direct first, TURN relay last): ${urlPreview}`
    );

    return mapped;
  }

  /**
   * Applies one remote description under perfect negotiation (W3C WebRTC section 10.5): an offer
   * that collides with our own is dropped by the impolite side and wins on the polite side, where
   * `setRemoteDescription` rolls our offer back implicitly. Every applied offer is answered.
   */
  private async handleRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      appendLog(`[Call] remote ${sdp.type} with no peer connection - dropped`);
      return;
    }
    const collision = sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) {
      appendLog('[Call] offer collision - the impolite side keeps its own offer');
      return;
    }
    await pc.setRemoteDescription(sdp);
    await this.flushPendingRemoteIceCandidates();
    if (sdp.type === 'offer') {
      await pc.setLocalDescription();
      appendLog(`[Call] answer (${pc.localDescription?.sdp?.length ?? 0} bytes) -> peer`);
      this.sendSignal({ type: 'Answer', sdp: JSON.stringify(pc.localDescription) });
    }
    await configureCallAudioSenders(pc, this.callHasVideo);
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
   */
  private async connectSignalling(roomId: string) {
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

    const wsUrl = `${wsBase}/api/call${tokenParam}`;
    appendLog(
      `[Call] connecting signalling WebSocket${tokenParam ? ' (token in query)' : ' (cookie auth)'}`
    );

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.signaledWs = ws;
      let settled = false;
      // Frames are handled ONE AT A TIME, in arrival order: building the peer connection on
      // `PeerReady` awaits the E2E worker, and the initiator's Offer can arrive meanwhile.
      let chain: Promise<void> = Promise.resolve();

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const clearTimers = () => {
        window.clearTimeout(connectTimeout);
        window.clearTimeout(joinTimeout);
      };

      const connectTimeout = window.setTimeout(() => {
        fail(new Error('call signalling WebSocket connection timeout (15s)'));
        ws.close();
      }, 15_000);

      let joinTimeout = 0;

      ws.onopen = () => {
        window.clearTimeout(connectTimeout);
        appendLog('[Call] signalling connected, joining p2p room...');
        this.sendSignal({
          type: 'Join',
          room_id: roomId,
          room_token: this.currentRoomToken ?? undefined,
          mode: 'p2p',
        });
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
        if (!settled) {
          fail(new Error(`call signalling WebSocket closed before ready (code=${ev.code})`));
        } else if (this.signaledWs === ws && get(this.callState) !== 'idle') {
          // cleanup() detaches the socket before closing it, so reaching here means the server
          // or the network dropped it mid-call.
          this.failCall(`signalling WebSocket closed code=${ev.code}`);
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
          appendLog(`[Call] p2p room ready (${frame.room_id ?? roomId})`);
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
            fail(new Error(`call signalling refused: ${frame.reason}`));
          } else {
            this.failCall(`signalling refused: ${frame.reason}`);
          }
          return;
        }
        chain = chain
          .then(() => this.handleSignalFrame(frame))
          .catch((err) => {
            appendLog(`[Call] signalling ${frame.type} failed: ${String(err)}`);
            this.failCall(`signalling ${frame.type} failed`);
          });
      };
    });
  }

  /** Acts on one frame from the relay, after the room is joined. */
  private async handleSignalFrame(frame: SignalFrame): Promise<void> {
    switch (frame.type) {
      case 'PeerReady':
        await this.onPeerReady(frame.initiator);
        return;
      case 'PeerLeft':
        appendLog('[Call] the other party left the call room');
        this.endCall(false);
        return;
      case 'Offer':
      case 'Answer': {
        const sdp = JSON.parse(frame.sdp) as RTCSessionDescriptionInit;
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
   */
  private async onPeerReady(initiator: boolean): Promise<void> {
    this.polite = !initiator;
    this.peerArrived = true;
    this.clearRingTimer();
    appendLog(`[Call] peer ready - this side is ${initiator ? 'initiator' : 'polite'}`);
    if (this.pc) {
      appendLog('[Call] the other device was replaced - rebuilding the peer connection');
      this.pc.close();
      this.pc = null;
      // A new pc counts its bytes from zero: a rate against the old one's totals would be negative.
      this.lastSnapshot = null;
      this.mergedRemoteStream = null;
      this.pendingRemoteIceCandidates = [];
      this.makingOffer = false;
      this.ignoreOffer = false;
    }
    await this.initPeerConnection();
  }

  /** Wires decrypt transform before exposing the track to the UI (avoids black video). */
  private async handleRemoteTrack(track: MediaStreamTrack, receiver: RTCRtpReceiver) {
    appendLog(
      `[Call] remote track kind=${track.kind} id=${track.id.slice(0, 8)}… readyState=${track.readyState} muted=${track.muted}`
    );

    try {
      if (!receiver.transform) {
        // A receiver the peer's offer created (a kind this side never sent). Attaching here is
        // the only option left, and Chrome 155 was measured NOT to deliver frames to a transform
        // attached this late - so this line accuses: expect silence on this track.
        appendLog(
          `[Call] WARN late E2E receiver transform (${track.kind}) - attached in ontrack, measured to receive no frames in Chrome`
        );
      }
      await this.setupReceiverTransform(receiver, track.kind);
    } catch (e) {
      appendLog(`[Call] E2E receiver transform failed: ${String(e)}`);
      this.failCall('E2E receiver transform failed');
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
      // setup_ms: the user's tap to the first remote audio that actually flows - what they waited.
      if (track.kind === 'audio' && this.setupMs === null && this.tapAt !== null) {
        this.setupMs = performance.now() - this.tapAt;
      }
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
   * Builds the peer connection to the OTHER PARTY (no SFU in between), attaches the E2E sender
   * transform to every local track, and lets `negotiationneeded` drive the offers.
   */
  private async initPeerConnection() {
    if (!this.currentGroupId || !this.currentCallId || !this.iceServers) {
      throw new Error('No active call context');
    }

    appendLog(
      `[Call] creating PeerConnection (policy=${CALL_ICE_TRANSPORT_POLICY}, ${this.iceServers.length} ICE server(s))`
    );
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: CALL_ICE_TRANSPORT_POLICY,
    });
    this.pc = pc;
    this.startCallReports();

    const gathered = { host: 0, srflx: 0, relay: 0, prflx: 0 };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const type = e.candidate.type;
        if (type && type in gathered) gathered[type as keyof typeof gathered]++;
        this.sendSignal({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      } else {
        appendLog(
          `[Call] ICE gathering complete (host=${gathered.host} srflx=${gathered.srflx} relay=${gathered.relay})`
        );
        this.sendSignal({
          type: 'IceCandidate',
          candidate: JSON.stringify({ candidate: '' } satisfies RTCIceCandidateInit),
        });
        if (gathered.relay === 0) {
          appendLog(
            '[Call] WARN no TURN relay candidate - a call that cannot go direct will fail (Cloudflare TURN unreachable or misconfigured)'
          );
        }
      }
    };

    pc.onnegotiationneeded = async () => {
      // The polite side never opens the negotiation: it answers the initiator's first offer,
      // which already carries a slot for its tracks. After that, either side may renegotiate.
      if (this.polite && !pc.remoteDescription) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        appendLog(`[Call] offer (${pc.localDescription?.sdp?.length ?? 0} bytes) -> peer`);
        this.sendSignal({ type: 'Offer', sdp: JSON.stringify(pc.localDescription) });
      } catch (e) {
        appendLog(`[Call] creating an offer failed: ${String(e)}`);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicegatheringstatechange = () => {
      appendLog(`[Call] iceGatheringState=${pc.iceGatheringState}`);
    };

    pc.onsignalingstatechange = () => {
      appendLog(`[Call] signalingState=${pc.signalingState}`);
    };

    pc.ontrack = (e) => {
      const { track, receiver } = e;
      void this.handleRemoteTrack(track, receiver);
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      appendLog(`[Call] connectionState=${state}`);
      if (state === 'connected') {
        if (get(this.callState) !== 'idle') this.callState.set('incall');
        void pc
          .getStats()
          .then((stats) => appendLog(`[Call] selected path ${describeSelectedPair(stats)}`))
          .catch((e: unknown) => appendLog(`[Call] getStats failed: ${String(e)}`));
      }
      if (state === 'disconnected') {
        // 'disconnected' is often transient (WebRTC may recover); log but do not tear down.
        appendLog('[Call] WebRTC peer connection disconnected (may recover)');
      }
      if (state === 'failed') {
        this.failCall('connectionState=failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const iceState = pc.iceConnectionState;
      appendLog(`[Call] iceConnectionState=${iceState}`);
      if (iceState === 'failed') {
        appendLog(
          '[Call] ICE failed - no direct path and no TURN relay pair (check Cloudflare TURN on chat-delivery)'
        );
        this.failCall('iceConnectionState=failed');
      }
    };

    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      appendLog(`[Call] adding ${tracks.length} local track(s) to PeerConnection`);
      for (const track of tracks) {
        const sender = pc.addTrack(track, this.localStream);
        // Before the first frame is encoded: a sender without its transform would send clear media.
        await this.setupSenderTransform(sender);
        // The RECEIVER of the same transceiver, now, before any negotiation. Measured in Chrome 155
        // (2026-10-17): a receiver transform attached in `ontrack` never sees a single frame - the
        // call connects, packets arrive, and every sample is concealed silence. Attached here, at
        // transceiver creation, every frame decrypts. Both ends add an audio track before
        // negotiating, and the polite side's offer-answer reuses this transceiver, so the remote
        // audio always lands on a receiver that already decrypts.
        const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
        if (transceiver) await this.setupReceiverTransform(transceiver.receiver, track.kind);
        if (track.kind === 'video') void this.applyVideoSenderLimits(sender);
      }
      await configureCallAudioSenders(pc, this.callHasVideo);
    }
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

  private async setupEncryption(groupId: string, callId: string) {
    const context = new TextEncoder().encode(callId);
    const secret = await this.mlsService.exportSecret(groupId, 'mls-webrtc-media', context, 32);
    this.callKeyBytes = Uint8Array.from(secret);

    this.callKey = await crypto.subtle.importKey(
      'raw',
      this.callKeyBytes as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    const fp = Array.from(this.callKeyBytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    appendLog(`[Call] encryption key derived from MLS (fp=${fp}…)`);
  }

  private getOrCreateEncryptionWorker(): Worker {
    if (!this.encryptionWorker) {
      this.encryptionWorker = new EncryptionWorker();
      this.encryptionWorker.onmessage = (
        event: MessageEvent<{ type: string; detail?: string; count?: number; mediaKind?: string }>
      ) => {
        const { type, detail, count, mediaKind } = event.data ?? {};
        if (type === 'decryptError') {
          appendLog(`[Call] E2E decrypt failed (${count ?? '?'}): ${detail ?? 'unknown'}`);
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
        } else if (type === 'videoKeyframeIn') {
          appendLog(`[Call] remote video keyframe received (#${count})`);
        } else if (type === 'transformError') {
          appendLog(`[Call] WARN E2E transform error: ${detail ?? 'unknown'}`);
        }
      };
    }
    return this.encryptionWorker;
  }

  /** Pushes the MLS call key into the encryption worker and waits until it is applied. */
  private ensureWorkerKeyReady(): Promise<void> {
    if (!this.callKey) return Promise.resolve();
    if (this.workerKeyReady) return this.workerKeyReady;

    const worker = this.getOrCreateEncryptionWorker();
    this.workerKeyReady = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.removeEventListener('message', onReady);
        this.workerKeyReady = null;
        reject(new Error('encryption worker key timeout'));
      }, 3_000);
      const onReady = (event: MessageEvent<{ type: string; detail?: string }>) => {
        if (event.data?.type === 'keyReady') {
          window.clearTimeout(timeout);
          worker.removeEventListener('message', onReady);
          resolve();
        } else if (event.data?.type === 'keyError') {
          window.clearTimeout(timeout);
          worker.removeEventListener('message', onReady);
          this.workerKeyReady = null;
          reject(new Error(event.data.detail ?? 'worker key import failed'));
        }
      };
      worker.addEventListener('message', onReady);
      const keyBytes = this.callKeyBytes;
      if (!keyBytes) {
        reject(new Error('no call key bytes'));
        return;
      }
      const keyCopy = keyBytes.slice();
      worker.postMessage({ type: 'setKey', payload: keyCopy.buffer }, [keyCopy.buffer]);
    });
    return this.workerKeyReady;
  }

  /**
   * Attaches the E2E encrypt transform to a sender. THROWS when it cannot: a call is refused,
   * never sent in clear (`CallE2eUnsupportedError` already refused an engine without the API).
   */
  private async setupSenderTransform(sender: RTCRtpSender): Promise<void> {
    if (sender.transform) return;
    if (!this.callKey) throw new Error('no call key for the sender transform');
    const worker = this.getOrCreateEncryptionWorker();
    await this.ensureWorkerKeyReady();
    sender.transform = new RTCRtpScriptTransform(worker, { side: 'sender' });
    appendLog(`[Call] E2E sender transform attached (${sender.track?.kind ?? 'unknown'})`);
  }

  /** Attaches the E2E decrypt transform to a receiver. THROWS when it cannot, like the sender. */
  private async setupReceiverTransform(receiver: RTCRtpReceiver, mediaKind = 'unknown') {
    if (receiver.transform) return;
    if (!this.callKey) throw new Error('no call key for the receiver transform');
    const worker = this.getOrCreateEncryptionWorker();
    await this.ensureWorkerKeyReady();
    receiver.transform = new RTCRtpScriptTransform(worker, { side: 'receiver' });
    appendLog(`[Call] E2E receiver transform attached (${mediaKind})`);
  }

  /**
   * Pauses the camera while the tab/app is backgrounded (and resumes on return). Mobile
   * browsers freeze a hidden tab's encoder anyway, so this just stops wasting relay
   * bandwidth on a frozen frame; audio keeps flowing so the call continues in background.
   */
  private installBackgroundHandler() {
    if (typeof document === 'undefined' || this.backgroundVisibilityHandler) return;
    const handler = () => {
      if (!this.localStream) return;
      if (document.hidden) {
        if (get(this.isVideoOff)) return; // camera already off - nothing to pause
        const liveVideo = this.localStream.getVideoTracks().filter((t) => t.enabled);
        if (liveVideo.length === 0) return;
        liveVideo.forEach((t) => (t.enabled = false));
        this.videoPausedByBackground = true;
        appendLog('[Call] backgrounded - camera paused (audio continues)');
      } else if (this.videoPausedByBackground) {
        this.localStream.getVideoTracks().forEach((t) => (t.enabled = true));
        this.videoPausedByBackground = false;
        appendLog('[Call] foregrounded - camera resumed');
      }
    };
    document.addEventListener('visibilitychange', handler);
    this.backgroundVisibilityHandler = handler;
  }

  private removeBackgroundHandler() {
    if (this.backgroundVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.backgroundVisibilityHandler);
    }
    this.backgroundVisibilityHandler = null;
    this.videoPausedByBackground = false;
  }

  private async setupMedia(video: boolean) {
    this.callHasVideo = video;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: buildCallAudioConstraints(),
      video: video ? CallService.VIDEO_CONSTRAINTS : false,
    });
    logCallAudioTrackSettings(this.localStream, appendLog);
    this.localStreamStore.set(this.localStream);
    this.isMuted.set(false);
    this.isVideoOff.set(!video);
  }

  /**
   * Caps the camera capture so the stream fits the Cloudflare TURN relay (all media is
   * relay-only here). 640x480@30 keeps motion smooth without flooding the relay.
   */
  private static readonly VIDEO_CONSTRAINTS: MediaTrackConstraints = {
    facingMode: 'user',
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  };

  /** Target max video bitrate (bps). The relay path is the bottleneck, so we cap to limit loss/corruption. */
  private static readonly MAX_VIDEO_BITRATE = 700_000;

  /**
   * Caps a video sender's bitrate so the encoder doesn't overshoot the TURN relay's
   * capacity (which causes the blocky corruption seen on constrained links).
   */
  private async applyVideoSenderLimits(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = CallService.MAX_VIDEO_BITRATE;
      params.encodings[0].maxFramerate = 30;
      await sender.setParameters(params);
      appendLog(`[Call] video sender capped at ${CallService.MAX_VIDEO_BITRATE / 1000} kbps`);
    } catch (e) {
      appendLog(`[Call] applyVideoSenderLimits failed: ${String(e)}`);
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
   * Toggles the local camera. When the call started audio-only there is no video
   * track yet, so enabling it acquires the camera, adds the track (with the E2E
   * sender transform) and renegotiates with the peer. Otherwise it just flips the
   * existing track's `enabled` flag.
   */
  public async toggleVideo() {
    const off = !get(this.isVideoOff);

    const existing = this.localStream?.getVideoTracks() ?? [];
    if (!off && existing.length === 0) {
      // Enabling video on a call that started audio-only: acquire the camera now.
      if (!this.localStream || !this.pc) return;
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: CallService.VIDEO_CONSTRAINTS,
        });
        const videoTrack = camStream.getVideoTracks()[0];
        if (!videoTrack) return;
        this.localStream.addTrack(videoTrack);
        this.callHasVideo = true;
        // `negotiationneeded` fires from this addTrack and carries the new m-line to the peer; no
        // frame leaves before that negotiation completes, so the transform is in place first.
        const sender = this.pc.addTrack(videoTrack, this.localStream);
        await this.setupSenderTransform(sender);
        void this.applyVideoSenderLimits(sender);
        this.localStreamStore.set(this.localStream);
        this.isVideoOff.set(false);
        appendLog('[Call] camera acquired and added mid-call (renegotiating)');
      } catch (e) {
        const msg = String(e);
        appendLog(`[Call] enabling camera failed: ${msg}`);
      }
      return;
    }

    existing.forEach((t) => {
      t.enabled = !off;
    });
    this.isVideoOff.set(off);
  }
}
