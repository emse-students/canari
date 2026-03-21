import { writable, get } from 'svelte/store';
import type { IMlsService } from './IMlsService';
import { canari } from '../proto/canari.js';

export type CallState = 'idle' | 'calling' | 'incoming' | 'incall' | 'ended';

export class CallService {
  private pc: RTCPeerConnection | null = null;
  private signaledWs: WebSocket | null = null;
  private localStream: MediaStream | null = null;

  private currentCallId: string | null = null;
  private currentGroupId: string | null = null;
  private callKey: CryptoKey | null = null;

  // Stores for UI
  public callState = writable<CallState>('idle');
  public remoteStream = writable<MediaStream | null>(null);
  public isMuted = writable<boolean>(false);
  public isVideoOff = writable<boolean>(false);

  constructor(private mlsService: IMlsService) {}

  // --- 1. Signaling (MLS) ---

  /**
   * Called when an incoming MLS AppMessage contains call information.
   * This handles the initial invitation/notification.
   */
  public handleCallSignal(senderId: string, callMsg: any) {
    if (!callMsg || !callMsg.callId) return;

    if (callMsg.hangup) {
      if (this.currentCallId === callMsg.callId) {
        this.endCall();
      }
      return;
    }

    // New Call Invitation
    if (callMsg.offerSdp === 'START' || (callMsg.callId && !this.currentCallId)) {
      if (get(this.callState) !== 'idle') return;

      console.log(`Incoming call ${callMsg.callId} from ${senderId}`);
      this.currentCallId = callMsg.callId;
      // Note: We don't get groupId in handleCallSignal if it's called with just payload.
      // But typically this is called in context of a group message.
      // The caller (UI/Service) needs to set groupId or pass it.
      // For now we assume the UI will check groupId matches current view.
      this.callState.set('incoming');
    }
  }

  // --- 2. Call Control ---

  public async startCall(groupId: string, video: boolean = true) {
    if (get(this.callState) !== 'idle') return;

    this.currentGroupId = groupId;
    this.currentCallId = crypto.randomUUID();

    try {
      this.callState.set('calling');
      await this.setupMedia(video);
      await this.setupEncryption(groupId, this.currentCallId!);
      await this.connectToSfu(this.currentCallId!);

      // Notify Group via MLS
      await this.sendMlsNotification(groupId, { offerSdp: 'START' });
    } catch (e) {
      console.error('Error starting call:', e);
      this.endCall();
    }
  }

  public async acceptCall(groupId: string, callId: string) {
    if (get(this.callState) !== 'incoming') return;

    this.currentGroupId = groupId;
    this.currentCallId = callId;

    try {
      this.callState.set('incall');
      await this.setupMedia(true);
      await this.setupEncryption(groupId, callId);
      await this.connectToSfu(callId);
    } catch (e) {
      console.error('Error accepting call:', e);
      this.endCall();
    }
  }

  public endCall() {
    if (this.currentGroupId && this.currentCallId) {
      this.sendMlsNotification(this.currentGroupId, { hangup: true }).catch(console.error);
    }
    this.cleanup();
  }

  private cleanup() {
    this.callState.set('idle');
    this.currentCallId = null;
    this.currentGroupId = null;
    this.callKey = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.signaledWs) {
      this.signaledWs.close();
      this.signaledWs = null;
    }
    this.remoteStream.set(null);
  }

  // --- 3. SFU Connection & WebRTC ---

  private async connectToSfu(roomId: string) {
    return new Promise<void>((resolve, reject) => {
      // Use config or env var for SFU URL (ws://localhost:3001/ws by default)
      const wsUrl = import.meta.env?.VITE_CALL_SERVICE_URL || 'ws://localhost:3001/ws';
      this.signaledWs = new WebSocket(wsUrl);

      this.signaledWs.onopen = () => {
        console.log('Connected to SFU');
        this.sendSfuMessage({ type: 'Join', room_id: roomId });
        this.initPeerConnection();
        resolve();
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

  private initPeerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSfuMessage({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate) });
      }
    };

    this.pc.ontrack = (e) => {
      console.log('Remote track received');
      const receiver = e.receiver;
      this.setupReceiverTransform(receiver);
      this.remoteStream.set(e.streams[0]);
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        const sender = this.pc!.addTrack(track, this.localStream!);
        this.setupSenderTransform(sender);
      });
    }

    // Initiate negotiation (send Offer to SFU to publish local stream)
    this.pc
      .createOffer()
      .then((offer) => {
        return this.pc!.setLocalDescription(offer);
      })
      .then(() => {
        this.sendSfuMessage({ type: 'Offer', sdp: JSON.stringify(this.pc!.localDescription) });
      });
  }

  private sendSfuMessage(msg: any) {
    if (this.signaledWs && this.signaledWs.readyState === WebSocket.OPEN) {
      this.signaledWs.send(JSON.stringify(msg));
    }
  }

  // --- 4. Encryption (Insertable Streams) ---

  private async setupEncryption(groupId: string, callId: string) {
    const context = new TextEncoder().encode(callId);
    // Export secret from MLS for media encryption
    const secret = await this.mlsService.exportSecret(groupId, 'mls-webrtc-media', context, 32);

    this.callKey = await crypto.subtle.importKey(
      'raw',
      secret as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    console.log('Call encryption key derived');
  }

  private setupSenderTransform(sender: RTCRtpSender) {
    if (!this.callKey) return;

    // Use WebRTC Insertable Streams API
    const s = sender as any;
    const streams = s.createEncodedStreams ? s.createEncodedStreams() : null;

    if (streams) {
      const transformer = new TransformStream({
        transform: async (frame, controller) => {
          await this.encryptFrame(frame, controller);
        },
      });
      streams.readable.pipeThrough(transformer).pipeTo(streams.writable);
    } else {
      console.warn('Insertable Streams not supported by browser/webview');
    }
  }

  private setupReceiverTransform(receiver: RTCRtpReceiver) {
    if (!this.callKey) return;

    const r = receiver as any;
    const streams = r.createEncodedStreams ? r.createEncodedStreams() : null;

    if (streams) {
      const transformer = new TransformStream({
        transform: async (frame, controller) => {
          await this.decryptFrame(frame, controller);
        },
      });
      streams.readable.pipeThrough(transformer).pipeTo(streams.writable);
    }
  }

  /**
   * Encrypt encoded frame using AES-GCM.
   * Frame Format: [IV (12 bytes)][Ciphertext + Tag]
   */
  private async encryptFrame(frame: any, controller: TransformStreamDefaultController) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = frame.data; // ArrayBuffer

    try {
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.callKey!, data);

      const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
      packed.set(iv, 0);
      packed.set(new Uint8Array(ciphertext), 12);

      frame.data = packed.buffer;
      controller.enqueue(frame);
    } catch (e) {
      console.error('Encryption failed', e);
      // Determine strategy: drop frame or pass unencrypted? (Drop is safer for privacy)
    }
  }

  private async decryptFrame(frame: any, controller: TransformStreamDefaultController) {
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

  // --- Helpers ---

  private async setupMedia(video: boolean) {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user' } : false,
    });
    this.isMuted.set(false);
    this.isVideoOff.set(!video);
  }

  private async sendMlsNotification(groupId: string, payload: any) {
    // Construct AppMessage.CallMsg
    const appMsg = {
      messageId: crypto.randomUUID(),
      call: {
        callId: this.currentCallId,
        ...payload,
      },
    };

    // Use generated proto encoder
    const message = canari.AppMessage.create(appMsg);
    const buffer = canari.AppMessage.encode(message).finish();

    await this.mlsService.sendMessage(groupId, buffer);
  }
}
