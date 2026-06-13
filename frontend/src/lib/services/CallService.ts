import { writable, get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { canari } from '../proto/canari.js';
import { encodeAppMessage, mkCallHangup, mkCallInvite } from '../proto/codec';
import EncryptionWorker from '../workers/encryption.worker?worker';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';

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

/** Gecko (Firefox) - standard `RTCRtpScriptTransform`; no Chromium-only PC flags. */
function isGeckoBrowser(): boolean {
  return typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
}

function canUseRtpScriptTransform(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/**
 * Manages WebRTC group/DM calls: MLS signaling for ring/hangup, SFU for media,
 * MLS-derived keys for insertable-stream encryption, Cloudflare TURN for relay.
 */
export class CallService {
  private pc: RTCPeerConnection | null = null;
  private signaledWs: WebSocket | null = null;
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
   */
  public handleCallSignal(senderId: string, groupId: string, callMsg: canari.ICallMsg) {
    if (!callMsg?.callId) return;

    appendLog(`[Call] signal from ${senderId} in ${groupId} call=${callMsg.callId}`);

    if (callMsg.hangup) {
      if (this.currentCallId === callMsg.callId) {
        this.endCall(false);
      }
      return;
    }

    if (callMsg.offerSdp === 'START' || (callMsg.callId && !this.currentCallId)) {
      if (get(this.callState) !== 'idle') return;

      this.currentCallId = callMsg.callId;
      this.currentGroupId = groupId;
      this.incomingCallerId = senderId.toLowerCase();
      this.incomingHasVideo = callMsg.hasVideo !== false;
      this.callState.set('incoming');
    }
  }

  /** Starts an outgoing call in the given MLS group. */
  public async startCall(groupId: string, video: boolean = true) {
    if (get(this.callState) !== 'idle') return;

    this.currentGroupId = groupId;

    try {
      this.callState.set('calling');
      // Get server-issued room ID and access token before connecting.
      const { roomId, roomToken } = await this.fetchInitiateCall(groupId);
      this.currentCallId = roomId;
      this.currentRoomToken = roomToken;
      await this.setupMedia(video);
      await this.setupEncryption(groupId, this.currentCallId!);
      await this.connectToSfu(this.currentCallId!);
      await this.sendMlsNotification(groupId, mkCallInvite(this.currentCallId!, video));
      void this.chatNotifier?.onCallStarted(groupId, this.currentCallId!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] startCall failed: ${msg}`);
      console.error('Error starting call:', e);
      this.endCall(false);
      throw e;
    }
  }

  /** Accepts an incoming call after the user taps accept. */
  public async acceptCall(groupId: string, callId: string, video?: boolean) {
    if (get(this.callState) !== 'incoming') return;

    this.currentGroupId = groupId;
    this.currentCallId = callId;
    const useVideo = video ?? this.incomingHasVideo;

    try {
      this.callState.set('incall');
      // Fetch our own room token before connecting (the initiator already has theirs).
      this.currentRoomToken = await this.fetchRoomToken(groupId, callId);
      await this.setupMedia(useVideo);
      await this.setupEncryption(groupId, callId);
      await this.connectToSfu(callId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] acceptCall failed: ${msg}`);
      console.error('Error accepting call:', e);
      this.endCall();
    }
  }

  /** Ends the active call and optionally notifies the group via MLS. */
  public endCall(notify: boolean = true) {
    const groupId = this.currentGroupId;
    const callId = this.currentCallId;
    if (notify && groupId && callId) {
      this.sendMlsNotification(groupId, mkCallHangup(callId)).catch(console.error);
    }
    if (groupId && callId) {
      void this.chatNotifier?.onCallEnded(groupId, callId);
    }
    this.cleanup();
  }

  private cleanup() {
    this.callState.set('idle');
    this.currentCallId = null;
    this.currentGroupId = null;
    this.incomingCallerId = null;
    this.callKey = null;
    this.callKeyBytes = null;
    this.currentRoomToken = null;
    this.mergedRemoteStream = null;
    this.pendingRemoteIceCandidates = [];
    this.incomingHasVideo = true;

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
    if (this.encryptionWorker) {
      this.encryptionWorker.terminate();
      this.encryptionWorker = null;
      this.workerKeyReady = null;
    }

    this.remoteStream.set(null);
    this.remoteStreams.set(new Map());
  }

  /**
   * Asks chat-delivery-service to create a new call room.
   * Returns the server-generated `roomId` and a signed `roomToken` proving group membership.
   */
  private async fetchInitiateCall(groupId: string): Promise<{ roomId: string; roomToken: string }> {
    const { historyUrl } = resolveMlsPublicUrls();
    const url = new URL('/api/calls/initiate', historyUrl);
    const res = await apiFetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`calls/initiate failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json() as Promise<{ roomId: string; roomToken: string }>;
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
      const detail = await res.text().catch(() => '');
      throw new Error(`calls/room-token failed (${res.status})${detail ? `: ${detail}` : ''}`);
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
      const msg = e instanceof Error ? e.message : String(e);
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
    appendLog(`[Call] ${mapped.length} ICE server(s) (relay-only): ${urlPreview}`);

    return mapped;
  }

  /** Applies remote SDP from the SFU, handling renegotiation and offer glare. */
  private async applyRemoteSdp(sdp: RTCSessionDescriptionInit) {
    const pc = this.pc;
    if (!pc) return;

    if (sdp.type === 'offer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(sdp);
      await this.flushPendingRemoteIceCandidates();
      if (pc.signalingState === 'have-remote-offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        appendLog(`[Call] SFU renegotiation → Answer (${answer.sdp?.length ?? 0} bytes)`);
        this.sendSfuMessage({ type: 'Answer', sdp: JSON.stringify(answer) });
        await this.flushPendingRemoteIceCandidates();
        this.attachMediaTransforms();
      }
      return;
    }

    if (sdp.type === 'answer' && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(sdp);
      await this.flushPendingRemoteIceCandidates();
    }
  }

  /** Queues or applies a trickle ICE candidate from the SFU. */
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
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] addIceCandidate failed: ${msg}`);
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

  private async connectToSfu(roomId: string) {
    const callBaseUrl =
      import.meta.env.VITE_CALL_URL ||
      (typeof window !== 'undefined' ? window.location.origin : '');

    // Auth via cookie canari_ws_token only (no query param to avoid token leakage in logs).
    const wsUrl = callBaseUrl.replace(/^http/, 'ws') + '/api/call';
    appendLog('[Call] connecting SFU WebSocket');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.signaledWs = ws;
      let settled = false;

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
        fail(new Error('SFU WebSocket connection timeout (15s)'));
        ws.close();
      }, 15_000);

      let joinTimeout = 0;

      const startPeerSetup = () => {
        void this.initPeerConnection()
          .then(() => {
            clearTimers();
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch((err) => {
            clearTimers();
            fail(err);
          });
      };

      ws.onopen = () => {
        window.clearTimeout(connectTimeout);
        appendLog('[Call] connected to SFU, joining room…');
        this.sendSfuMessage({
          type: 'Join',
          room_id: roomId,
          room_token: this.currentRoomToken ?? undefined,
        });
        joinTimeout = window.setTimeout(() => {
          fail(new Error('SFU Join ack timeout (20s) - redéployer call-service'));
          ws.close();
        }, 20_000);
      };

      ws.onerror = () => {
        clearTimers();
        appendLog('[Call] SFU WebSocket error');
        fail(new Error('SFU WebSocket connection failed'));
      };

      ws.onclose = (ev) => {
        clearTimers();
        if (!settled) {
          fail(new Error(`SFU WebSocket closed before ready (code=${ev.code})`));
        } else if (get(this.callState) !== 'idle') {
          appendLog(`[Call] SFU WebSocket closed code=${ev.code}`);
        }
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === 'Joined') {
            window.clearTimeout(joinTimeout);
            appendLog(`[Call] SFU room ready (${msg.room_id ?? roomId})`);
            if (!settled) startPeerSetup();
            return;
          }

          if (!this.pc) return;

          if (msg.type === 'Offer' || msg.type === 'Answer') {
            const sdp = JSON.parse(msg.sdp) as RTCSessionDescriptionInit;
            appendLog(`[Call] SFU → ${msg.type} (signaling=${this.pc.signalingState})`);
            await this.applyRemoteSdp(sdp);
            if (msg.type === 'Answer') {
              this.attachMediaTransforms();
            } else if (msg.type === 'Offer') {
              appendLog('[Call] SFU renegotiation offer handled');
            }
          } else if (msg.type === 'IceCandidate') {
            const candidate = JSON.parse(msg.candidate) as RTCIceCandidateInit;
            await this.addRemoteIceCandidate(candidate);
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          appendLog(`[Call] signaling error: ${detail}`);
          console.error('Signaling error:', err);
        }
      };
    });
  }

  /** When false, media is relayed cleartext through the SFU (debug / fallback). */
  private isE2eMediaEnabled(): boolean {
    return import.meta.env.VITE_CALL_E2E_ENCRYPTION !== 'false';
  }

  /** Attaches MLS insertable-stream transforms after the SDP handshake (SFU is not extension-aware). */
  private attachMediaTransforms() {
    if (!this.pc || !this.callKey) return;
    if (!this.isE2eMediaEnabled()) {
      appendLog('[Call] E2E media encryption disabled (VITE_CALL_E2E_ENCRYPTION=false)');
      return;
    }
    if (!canUseRtpScriptTransform()) {
      appendLog(
        '[Call] RTCRtpScriptTransform indisponible - E2E désactivé (Firefox ≥ 117 : vérifier media.peerconnection.scripttransform.enabled)'
      );
      return;
    }
    appendLog('[Call] attaching E2E media transforms');
    void this.attachMediaTransformsAsync();
  }

  private async attachMediaTransformsAsync() {
    const pc = this.pc;
    if (!pc || !this.callKey || !this.isE2eMediaEnabled()) return;
    try {
      let senders = 0;
      let receivers = 0;
      for (const sender of pc.getSenders()) {
        await this.setupSenderTransform(sender);
        senders++;
      }
      for (const receiver of pc.getReceivers()) {
        const kind = receiver.track?.kind ?? 'unknown';
        await this.setupReceiverTransform(receiver, kind);
        receivers++;
      }
      appendLog(`[Call] E2E transforms attached (${senders} sender(s), ${receivers} receiver(s))`);
      await this.requestVideoKeyframes();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] E2E transforms failed: ${msg}`);
    }
  }

  /** Wires decrypt transform before exposing the track to the UI (avoids black video). */
  private async handleRemoteTrack(track: MediaStreamTrack, receiver: RTCRtpReceiver) {
    appendLog(
      `[Call] remote track kind=${track.kind} id=${track.id.slice(0, 8)}… readyState=${track.readyState} muted=${track.muted}`
    );

    if (this.callKey && this.isE2eMediaEnabled()) {
      await this.setupReceiverTransform(receiver, track.kind);
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
    };
    track.onended = () => {
      appendLog(`[Call] remote track ended kind=${track.kind}`);
      this.mergedRemoteStream?.removeTrack(track);
      this.publishRemoteStream();
    };

    this.publishRemoteStream();

    if (track.kind === 'video') {
      this.scheduleVideoUnmuteWatchdog(track);
    }

    if (get(this.callState) === 'calling' || get(this.callState) === 'incoming') {
      this.callState.set('incall');
    }
  }

  /** Asks local encoders to emit an IDR frame so remote decoders can start after E2E attach. */
  private async requestVideoKeyframes(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    for (const sender of pc.getSenders()) {
      const mediaTrack = sender.track;
      if (!mediaTrack || mediaTrack.kind !== 'video' || !mediaTrack.enabled) continue;

      const ext = sender as RTCRtpSender & { generateKeyFrame?: () => Promise<void> };
      if (typeof ext.generateKeyFrame !== 'function') {
        appendLog('[Call] generateKeyFrame unavailable in this browser');
        continue;
      }
      try {
        await ext.generateKeyFrame();
        appendLog('[Call] keyframe requested on local video sender');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendLog(`[Call] generateKeyFrame failed: ${msg}`);
      }
    }
  }

  private scheduleVideoUnmuteWatchdog(track: MediaStreamTrack) {
    window.setTimeout(() => {
      if (track.readyState === 'ended') return;
      if (!track.muted) return;
      appendLog('[Call] remote video still muted - requesting keyframe');
      void this.requestVideoKeyframes();
    }, 3_000);
  }

  /** Notifies subscribers so `<video>` re-binds when tracks start producing frames. */
  private publishRemoteStream() {
    if (!this.mergedRemoteStream) return;
    const stream = this.mergedRemoteStream;
    this.remoteStream.set(stream);
    this.remoteStreams.set(new Map([['remote', stream]]));
  }

  private async initPeerConnection() {
    if (!this.currentGroupId || !this.currentCallId) {
      throw new Error('No active call context');
    }

    const iceServers = await this.fetchIceServers(this.currentGroupId, this.currentCallId);

    appendLog(
      `[Call] creating PeerConnection (${isGeckoBrowser() ? 'Firefox' : 'non-Firefox'}, ` +
        `RTCRtpScriptTransform=${canUseRtpScriptTransform() ? 'oui' : 'non'})`
    );
    const pcConfig: RTCConfiguration = {
      iceServers,
      iceTransportPolicy: 'relay',
    };
    // Legacy Chromium flag - not used by Firefox (standard API since FF 117).
    if (!isGeckoBrowser()) {
      (
        pcConfig as RTCConfiguration & { encodedInsertableStreams?: boolean }
      ).encodedInsertableStreams = true;
    }
    this.pc = new RTCPeerConnection(pcConfig);

    let relayCandidateCount = 0;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (e.candidate.type === 'relay' || e.candidate.candidate.includes('typ relay')) {
          relayCandidateCount++;
        }
        this.sendSfuMessage({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      } else {
        appendLog(`[Call] ICE gathering complete (${relayCandidateCount} relay candidate(s) sent)`);
        this.sendSfuMessage({
          type: 'IceCandidate',
          candidate: JSON.stringify({ candidate: '' } satisfies RTCIceCandidateInit),
        });
        if (relayCandidateCount === 0) {
          appendLog(
            '[Call] Aucun candidat TURN relay - Cloudflare TURN indisponible ou mal configuré'
          );
        }
      }
    };

    this.pc.onicegatheringstatechange = () => {
      appendLog(`[Call] iceGatheringState=${this.pc?.iceGatheringState}`);
    };

    this.pc.onsignalingstatechange = () => {
      appendLog(`[Call] signalingState=${this.pc?.signalingState}`);
    };

    this.pc.ontrack = (e) => {
      const { track, receiver } = e;
      void this.handleRemoteTrack(track, receiver);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      appendLog(`[Call] connectionState=${state}`);
      if (state === 'connected' && get(this.callState) !== 'idle') {
        this.callState.set('incall');
      }
      if (state === 'failed' || state === 'disconnected') {
        appendLog(`[Call] WebRTC peer connection ${state}`);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc?.iceConnectionState;
      appendLog(`[Call] iceConnectionState=${iceState}`);
      if (iceState === 'connected' || iceState === 'completed') {
        if (get(this.callState) !== 'idle') {
          this.callState.set('incall');
        }
      }
      if (iceState === 'failed') {
        appendLog(
          '[Call] ICE failed - vérifier Cloudflare TURN sur chat-delivery et call-service (mêmes secrets)'
        );
      }
    };

    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      appendLog(`[Call] adding ${tracks.length} local track(s) to PeerConnection`);
      for (const track of tracks) {
        const sender = this.pc!.addTrack(track, this.localStream!);
        // Firefox/MDN: attach sender transform right after addTrack so the encoder pipeline is covered.
        if (this.callKey && this.isE2eMediaEnabled() && canUseRtpScriptTransform()) {
          void this.setupSenderTransform(sender);
        }
      }
    }

    appendLog('[Call] creating SDP offer…');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    appendLog(`[Call] local offer set (${offer.sdp?.length ?? 0} bytes), sending to SFU`);
    this.sendSfuMessage({ type: 'Offer', sdp: JSON.stringify(this.pc.localDescription) });
  }

  private sendSfuMessage(msg: Record<string, unknown>) {
    if (this.signaledWs && this.signaledWs.readyState === WebSocket.OPEN) {
      this.signaledWs.send(JSON.stringify(msg));
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
          appendLog(`[Call] E2E encrypting (${count} frame(s))`);
        } else if (type === 'decryptOk') {
          appendLog(`[Call] E2E decrypting ${mediaKind ?? '?'} (${count} frame(s))`);
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

  private async setupSenderTransform(sender: RTCRtpSender) {
    if (!this.callKey || !this.isE2eMediaEnabled()) return;
    if (sender.transform) return;

    try {
      if (canUseRtpScriptTransform()) {
        const worker = this.getOrCreateEncryptionWorker();
        await this.ensureWorkerKeyReady();
        sender.transform = new RTCRtpScriptTransform(worker, { side: 'sender' });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] sender transform failed: ${msg}`);
      return;
    }

    const s = sender as RTCRtpSender & {
      createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
    };
    const streams = s.createEncodedStreams?.();
    if (streams) {
      const transformer = new TransformStream({
        transform: async (frame, controller) => {
          await this.encryptFrame(frame, controller);
        },
      });
      streams.readable.pipeThrough(transformer).pipeTo(streams.writable);
    } else {
      console.warn('Insertable Streams not supported');
    }
  }

  private async setupReceiverTransform(receiver: RTCRtpReceiver, mediaKind = 'unknown') {
    if (!this.callKey || !this.isE2eMediaEnabled()) return;
    if (receiver.transform) return;

    try {
      if (canUseRtpScriptTransform()) {
        const worker = this.getOrCreateEncryptionWorker();
        await this.ensureWorkerKeyReady();
        receiver.transform = new RTCRtpScriptTransform(worker, { side: 'receiver' });
        appendLog(`[Call] E2E receiver transform attached (${mediaKind})`);
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`[Call] receiver transform failed: ${msg}`);
      return;
    }

    const r = receiver as RTCRtpReceiver & {
      createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
    };
    const streams = r.createEncodedStreams?.();
    if (streams) {
      const transformer = new TransformStream({
        transform: async (frame, controller) => {
          await this.decryptFrame(frame, controller);
        },
      });
      streams.readable.pipeThrough(transformer).pipeTo(streams.writable);
    }
  }

  private async encryptFrame(
    frame: RTCEncodedVideoFrame,
    controller: TransformStreamDefaultController
  ) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = frame.data;

    try {
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.callKey!, data);
      const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
      packed.set(iv, 0);
      packed.set(new Uint8Array(ciphertext), 12);
      frame.data = packed.buffer;
      controller.enqueue(frame);
    } catch (e) {
      console.error('Encryption failed', e);
    }
  }

  private async decryptFrame(
    frame: RTCEncodedVideoFrame,
    controller: TransformStreamDefaultController
  ) {
    const data = new Uint8Array(frame.data);
    if (data.byteLength < 12) return;

    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.callKey!,
        ciphertext
      );
      frame.data = plaintext;
      controller.enqueue(frame);
    } catch (e) {
      console.error('Decryption failed', e);
    }
  }

  private async setupMedia(video: boolean) {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user' } : false,
    });
    this.localStreamStore.set(this.localStream);
    this.isMuted.set(false);
    this.isVideoOff.set(!video);
  }

  private async sendMlsNotification(groupId: string, appMsgPartial: canari.IAppMessage) {
    const appMsg = {
      messageId: crypto.randomUUID(),
      sentAt: Date.now(),
      ...appMsgPartial,
    };
    const buffer = encodeAppMessage(appMsg);
    await this.mlsService.sendMessage(groupId, buffer);
  }

  /** Toggles microphone mute on the local audio track. */
  public toggleMute() {
    const muted = !get(this.isMuted);
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    this.isMuted.set(muted);
  }

  /** Toggles local video track on/off. */
  public toggleVideo() {
    const off = !get(this.isVideoOff);
    this.localStream?.getVideoTracks().forEach((t) => {
      t.enabled = !off;
    });
    this.isVideoOff.set(off);
  }
}
