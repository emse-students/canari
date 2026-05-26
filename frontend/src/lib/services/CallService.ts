import { writable, get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { canari } from '../proto/canari.js';
import { encodeAppMessage, mkCallHangup, mkCallInvite } from '../proto/codec';
import EncryptionWorker from '../workers/encryption.worker?worker';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';

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

/**
 * Manages WebRTC group/DM calls: MLS signaling for ring/hangup, SFU for media,
 * MLS-derived keys for insertable-stream encryption, Cloudflare TURN for relay.
 */
export class CallService {
  private pc: RTCPeerConnection | null = null;
  private signaledWs: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private encryptionWorker: Worker | null = null;

  public currentCallId: string | null = null;
  public currentGroupId: string | null = null;
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

  constructor(private mlsService: IMlsService) {}

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
    this.currentCallId = crypto.randomUUID();

    try {
      this.callState.set('calling');
      await this.setupMedia(video);
      await this.setupEncryption(groupId, this.currentCallId!);
      await this.connectToSfu(this.currentCallId!);
      await this.sendMlsNotification(groupId, mkCallInvite(this.currentCallId!, video));
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
    if (notify && this.currentGroupId && this.currentCallId) {
      this.sendMlsNotification(this.currentGroupId, mkCallHangup(this.currentCallId)).catch(
        console.error
      );
    }
    this.cleanup();
  }

  private cleanup() {
    this.callState.set('idle');
    this.currentCallId = null;
    this.currentGroupId = null;
    this.incomingCallerId = null;
    this.callKey = null;
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
    }

    this.remoteStream.set(null);
    this.remoteStreams.set(new Map());
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
      throw new Error(`Failed to fetch ICE servers: ${res.status}${detail ? ` — ${detail}` : ''}`);
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
      if (pc.signalingState === 'have-remote-offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        appendLog(`[Call] SFU renegotiation → Answer (${answer.sdp?.length ?? 0} bytes)`);
        this.sendSfuMessage({ type: 'Answer', sdp: JSON.stringify(answer) });
        this.attachMediaTransforms();
      }
      return;
    }

    if (sdp.type === 'answer' && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(sdp);
    }
  }

  private async connectToSfu(roomId: string) {
    const callBaseUrl =
      import.meta.env.VITE_CALL_URL ||
      (typeof window !== 'undefined' ? window.location.origin : '');

    let tokenQuery = '';
    try {
      const token = await getToken();
      if (token) tokenQuery = `?token=${encodeURIComponent(token)}`;
    } catch {
      appendLog('[Call] SFU WS: pas de JWT en mémoire, cookie canari_ws_token uniquement');
    }

    const wsUrl = callBaseUrl.replace(/^http/, 'ws') + `/api/call${tokenQuery}`;
    appendLog(`[Call] connecting SFU WebSocket ${wsUrl.replace(/token=[^&]+/, 'token=***')}`);

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
        this.sendSfuMessage({ type: 'Join', room_id: roomId });
        joinTimeout = window.setTimeout(() => {
          fail(new Error('SFU Join ack timeout (20s) — redéployer call-service'));
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
            const candidate = JSON.parse(msg.candidate);
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          appendLog(`[Call] signaling error: ${detail}`);
          console.error('Signaling error:', err);
        }
      };
    });
  }

  /** Attaches MLS insertable-stream transforms after the SDP handshake (SFU is not extension-aware). */
  private attachMediaTransforms() {
    if (!this.pc || !this.callKey) return;
    appendLog('[Call] attaching E2E media transforms');
    for (const sender of this.pc.getSenders()) {
      this.setupSenderTransform(sender);
    }
    for (const receiver of this.pc.getReceivers()) {
      this.setupReceiverTransform(receiver);
    }
  }

  private async initPeerConnection() {
    if (!this.currentGroupId || !this.currentCallId) {
      throw new Error('No active call context');
    }

    const iceServers = await this.fetchIceServers(this.currentGroupId, this.currentCallId);

    appendLog('[Call] creating PeerConnection (iceTransportPolicy=relay)');
    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });

    let relayCandidateCount = 0;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (e.candidate.type === 'relay' || e.candidate.candidate.includes('typ relay')) {
          relayCandidateCount++;
        }
        this.sendSfuMessage({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      } else {
        appendLog(`[Call] ICE gathering complete (${relayCandidateCount} relay candidate(s) sent)`);
        if (relayCandidateCount === 0) {
          appendLog(
            '[Call] Aucun candidat TURN relay — Cloudflare TURN indisponible ou mal configuré'
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
      appendLog(`[Call] remote track received kind=${e.track.kind}`);
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      const peerKey = e.track.id || `peer-${Date.now()}`;

      this.remoteStreams.update((map) => {
        const next = new Map(map);
        next.set(peerKey, stream);
        return next;
      });

      if (get(this.remoteStreams).size === 1) {
        this.remoteStream.set(stream);
      }

      if (get(this.callState) === 'calling' || get(this.callState) === 'incoming') {
        this.callState.set('incall');
      }

      if (this.callKey) {
        this.setupReceiverTransform(e.receiver);
      }
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
          '[Call] ICE failed — vérifier Cloudflare TURN sur chat-delivery et call-service (mêmes secrets)'
        );
      }
    };

    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      appendLog(`[Call] adding ${tracks.length} local track(s) to PeerConnection`);
      tracks.forEach((track) => {
        this.pc!.addTrack(track, this.localStream!);
      });
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

    this.callKey = await crypto.subtle.importKey(
      'raw',
      secret as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    appendLog('[Call] encryption key derived from MLS');
  }

  private getOrCreateEncryptionWorker(): Worker {
    if (!this.encryptionWorker) {
      this.encryptionWorker = new EncryptionWorker();
      if (this.callKey) {
        this.encryptionWorker.postMessage({ type: 'setKey', payload: this.callKey });
      }
    }
    return this.encryptionWorker;
  }

  private setupSenderTransform(sender: RTCRtpSender) {
    if (!this.callKey) return;

    try {
      if (window.RTCRtpScriptTransform) {
        const worker = this.getOrCreateEncryptionWorker();
        worker.postMessage({ type: 'setKey', payload: this.callKey });
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

  private setupReceiverTransform(receiver: RTCRtpReceiver) {
    if (!this.callKey) return;

    try {
      if (window.RTCRtpScriptTransform) {
        const worker = this.getOrCreateEncryptionWorker();
        worker.postMessage({ type: 'setKey', payload: this.callKey });
        receiver.transform = new RTCRtpScriptTransform(worker, { side: 'receiver' });
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
