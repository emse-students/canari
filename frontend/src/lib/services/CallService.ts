import { writable, get } from 'svelte/store';
import type { IMlsService } from '$lib/mls-client';
import { canari } from '../proto/canari.js';
import { encodeAppMessage, mkCallHangup, mkCallInvite } from '../proto/codec';
import EncryptionWorker from '../workers/encryption.worker?worker';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { resolveMlsPublicUrls } from '$lib/mls-client/mlsDeliveryHttp';
import { apiFetch } from '$lib/utils/apiFetch';

export type CallState = 'idle' | 'calling' | 'incoming' | 'incall' | 'ended';

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

    const res = await apiFetch(url.toString(), { method: 'GET', credentials: 'include' });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`Failed to fetch ICE servers: ${res.status}${detail ? ` — ${detail}` : ''}`);
    }

    const data = (await res.json()) as { iceServers?: IceServerConfig[] };
    const servers = data.iceServers ?? [];

    if (servers.length === 0) {
      throw new Error('No ICE servers returned');
    }

    return servers.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }));
  }

  private async connectToSfu(roomId: string) {
    return new Promise<void>((resolve, reject) => {
      const callBaseUrl =
        import.meta.env.VITE_CALL_URL ||
        (typeof window !== 'undefined' ? window.location.origin : '');

      const wsUrl = callBaseUrl.replace(/^http/, 'ws') + `/api/call`;
      appendLog(`[Call] connecting SFU WebSocket ${wsUrl}`);
      this.signaledWs = new WebSocket(wsUrl);

      this.signaledWs.onopen = () => {
        appendLog('[Call] connected to SFU');
        this.sendSfuMessage({ type: 'Join', room_id: roomId });
        void this.initPeerConnection().then(resolve).catch(reject);
      };

      this.signaledWs.onerror = (e) => {
        console.error('SFU WebSocket Error', e);
        reject(e);
      };

      this.signaledWs.onmessage = async (event) => {
        if (!this.pc) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'Offer') {
            const sdp = JSON.parse(msg.sdp);
            await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
            if (sdp.type === 'offer') {
              const answer = await this.pc.createAnswer();
              await this.pc.setLocalDescription(answer);
              this.sendSfuMessage({ type: 'Answer', sdp: JSON.stringify(answer) });
            }
          } else if (msg.type === 'Answer') {
            const sdp = JSON.parse(msg.sdp);
            await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          } else if (msg.type === 'IceCandidate') {
            const candidate = JSON.parse(msg.candidate);
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        } catch (err) {
          console.error('Signaling error:', err);
        }
      };
    });
  }

  private async initPeerConnection() {
    if (!this.currentGroupId || !this.currentCallId) {
      throw new Error('No active call context');
    }

    const iceServers = await this.fetchIceServers(this.currentGroupId, this.currentCallId);

    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSfuMessage({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      }
    };

    this.pc.ontrack = (e) => {
      appendLog('[Call] remote track received');
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

      const receiver = e.receiver;
      this.setupReceiverTransform(receiver);
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        const sender = this.pc!.addTrack(track, this.localStream!);
        this.setupSenderTransform(sender);
      });
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
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

    if (window.RTCRtpScriptTransform) {
      const worker = this.getOrCreateEncryptionWorker();
      worker.postMessage({ type: 'setKey', payload: this.callKey });
      sender.transform = new RTCRtpScriptTransform(worker, { side: 'sender' });
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

    if (window.RTCRtpScriptTransform) {
      const worker = this.getOrCreateEncryptionWorker();
      worker.postMessage({ type: 'setKey', payload: this.callKey });
      receiver.transform = new RTCRtpScriptTransform(worker, { side: 'receiver' });
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
