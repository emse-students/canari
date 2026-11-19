/**
 * THE SFU LEG OF A GROUP CALL (WP-GC4 client, 2026-11-16): ONE peer connection, to the relay,
 * carrying this device's tracks out and every other participant's tracks in.
 *
 * A mesh holds one {@link CallLeg} per other participant (`callLeg.ts`); past the mesh cap, or when
 * `platform_config.call_relay` puts the call on the relay from the start, the call goes through
 * call-service's SFU instead (owner decision D2), and the room token says so (`mode: sfu`,
 * `utils/callRoomToken.ts`, `roomTokenMode`). This class owns that one connection and the SFU
 * flavour of call-service's protocol - the one `apps/call-service/e2e/group-page.ts` drove in CI
 * before it, and which that page now drives through THIS class:
 *
 * - **The client offers once, on `Joined`.** Its tracks go out on SEND-ONLY transceivers, so the SFU
 *   never answers a forwarded track on one of them and every forwarded track arrives on a
 *   transceiver of its own.
 * - **The SFU renegotiates.** As participants publish, it offers this connection their forwarded
 *   tracks; the leg answers. An SFU offer that crosses the client's own (the relay saw a new track
 *   between this join and its offer's arrival) is a glare the relay resolves its way - it cannot
 *   apply the client's offer while its own is out - so the leg is the POLITE side: it rolls its
 *   offer back, answers the relay's, and offers again from `stable` for the transceivers the
 *   rollback left unplaced (`mid === null`, a fact of the connection, never a timer).
 * - **Who sent a forwarded track** is its stream id, which the SFU sets to the publisher's USER id
 *   (`apps/call-service/src/sfu_seats.rs`, `forwarded_stream_id`). Every group frame is keyed PER
 *   SENDER (WP-GC1, `utils/callKeys.ts`), so that id is the participant the track's RECEIVER
 *   transform names (`CallTransformOptions.peer`). A forwarded track naming nobody, or this device's
 *   own user, is refused: its frames could be opened under no key, or the wrong one.
 * - **`Joined { others }`** states how many seats other users hold (the relay's `Joined`; the p2p
 *   one states it once WP-GC6 lands): handed to the caller, which decides what an empty room means.
 * - **A forwarded track going away** is its stream's `removetrack` (the browser mutes a track the
 *   relay drops and never ends it), or the same track re-attached under another stream id (a freed
 *   transceiver reused): either is reported through `onRemoteTrackGone`, once per `onRemoteTrack`.
 *
 * WHAT IT DOES NOT OWN, ON PURPOSE. The transforms, the worker and its keys, the codec hold, the
 * camera policy and the socket stay `CallService`'s, reached through {@link CallSfuLegHooks}: the
 * leg calls them at the moments the E2E rules fix (the sender's transform in the task that created
 * its transceiver - CALL-E2E-BYPASS-MI9T - and a forwarded track's both transforms in the task
 * `ontrack` fires in), so there is ONE implementation of each and the leg cannot drift from the
 * mesh's. Nothing here is a fallback: a refusal of any hook the media needs, or a `failed`
 * connection, ends the leg through `onFailed`; a throw of a SCREEN hook (`onRemoteTrack`,
 * `onRemoteTrackGone`) is logged at error and leaves the leg standing.
 *
 * It imports only relative modules that import nothing of the app's session, so the CI page bundles
 * it as it is (`Bun.build`, no `$lib` alias).
 */
import { configureCallAudioSenders } from '../utils/callAudio';
import type { CallMediaKind } from '../utils/callE2eReport';
import { callMediaKind } from '../utils/callFrameAad';
import { appendLog } from '../utils/sessionLog';

/** A client-to-relay frame of the SFU flavour (`apps/call-service`, `SignalMessage`). */
export type SfuClientFrame =
  | { type: 'Offer' | 'Answer'; sdp: string }
  | { type: 'IceCandidate'; candidate: string };

/**
 * A relay-to-client frame the SFU leg reads. `Joined.others` is absent from a relay older than the
 * field. `Refused` and the p2p frames are the socket's owner's, never routed here.
 */
export type SfuServerFrame =
  | { type: 'Joined'; room_id?: string; others?: number }
  | { type: 'Offer' | 'Answer'; sdp: string }
  | { type: 'IceCandidate'; candidate: string };

/** The `Join` of a relay room: call-service's SFU mode, which the room token must sign. */
export function sfuJoinFrame(roomId: string, roomToken: string) {
  return { type: 'Join' as const, room_id: roomId, room_token: roomToken, mode: 'sfu' as const };
}

/**
 * A forwarded track whose stream id names no other participant: the relay did not say whose frames
 * it carries, so no receive key may be chosen for it. The leg ends rather than guess.
 */
export class CallSfuTrackUnattributedError extends Error {
  constructor(
    public readonly kind: string,
    public readonly streamId: string | null
  ) {
    super(
      `the relay forwarded a ${kind} track naming no other sender (stream ${String(streamId)})`
    );
    this.name = 'CallSfuTrackUnattributedError';
  }
}

/**
 * The connection to the relay reached `failed`: ICE found no path and will not find one by itself,
 * so the leg cannot go on (`onFailed`), as a refused negotiation step cannot.
 */
export class CallSfuConnectionFailedError extends Error {
  constructor() {
    super('the connection to the relay failed');
    this.name = 'CallSfuConnectionFailedError';
  }
}

/** A negotiation step of the SFU leg was refused by the engine (`step` names which). */
export class CallSfuNegotiationError extends Error {
  constructor(
    public readonly step: string,
    options?: { cause?: unknown }
  ) {
    super(`the SFU leg's negotiation failed at ${step}`, options);
    this.name = 'CallSfuNegotiationError';
  }
}

/**
 * What the SFU leg asks of its owner. Each is the owner's ONE implementation - `CallService`'s
 * transform attach, codec hold and camera refusal for a mesh leg, the CI page's for the CI call.
 * The transform hooks are SYNCHRONOUS and THROW when no transform could be made.
 */
export interface CallSfuLegHooks {
  /** A new peer connection to the relay, with the call's ICE servers. */
  createPeerConnection(): RTCPeerConnection;
  /**
   * Holds a VIDEO transceiver to the codec the transforms frame (VP8), BEFORE its transforms are
   * made, and answers it - `undefined` for audio, or for a video transceiver the engine would not
   * hold (its camera is then refused, never sent).
   */
  holdVideoCodec(transceiver: RTCRtpTransceiver, kind: CallMediaKind): string | undefined;
  /** Attaches the ENCRYPT transform of this device's `sender`. */
  attachSenderTransform(
    sender: RTCRtpSender,
    kind: CallMediaKind,
    videoCodec: string | undefined,
    how: 'attached' | 'armed, no track yet'
  ): void;
  /** Attaches the DECRYPT transform of a forwarded track, opening `peer`'s frames. */
  attachReceiverTransform(
    receiver: RTCRtpReceiver,
    kind: CallMediaKind,
    peer: string,
    videoCodec: string | undefined
  ): void;
  /** A local sender now carries `track`, its transform attached (the microphone switch hooks here). */
  senderCreated(sender: RTCRtpSender, track: MediaStreamTrack): void;
  /** The camera `track` is not sent: the engine would not hold its transceiver to the codec. */
  cameraRefused(track: MediaStreamTrack): void;
  /** Sends one frame on the signalling socket. */
  sendSignal(frame: SfuClientFrame): void;
  /** The relay seated this device; `others` = seats other users hold, `null` from an older relay. */
  onJoined(others: number | null): void;
  /** A forwarded track of `peer` (user id, lowercased), decrypted, ready for the screen. */
  onRemoteTrack(peer: string, track: MediaStreamTrack, stream: MediaStream): void;
  /**
   * The forwarded `track` no longer carries `peer`'s frames: the relay dropped it (its stream fired
   * `removetrack`), or reused its transceiver for another publisher (it arrives again through
   * `onRemoteTrack` right after). Called once per `onRemoteTrack`, before any re-attachment of the
   * same track. A track the relay drops is MUTED, never `ended`, so its `ended` event says nothing.
   */
  onRemoteTrackGone(peer: string, track: MediaStreamTrack): void;
  /** The connection to the relay changed state (a `failed` one also ends the leg, `onFailed`). */
  onConnectionState(state: RTCPeerConnectionState): void;
  /** The leg cannot go on; it is closed already. Called once. */
  onFailed(error: Error): void;
}

/** What this device sends: its tracks, and the stream they belong to (`a=msid`). */
export interface CallSfuLegMedia {
  stream: MediaStream;
  /** The tracks to send - the microphone as the switch hands it, the camera, if any. */
  tracks: MediaStreamTrack[];
}

/** The leg's own log tag, after `[Call]`. */
const TAG = '[Call] [sfu]';

/** The one connection of a group call through the relay. See the module comment. */
export class CallSfuLeg {
  private pc: RTCPeerConnection | null = null;
  /** The transceivers THIS device made to send on: placed once their `mid` is set. */
  private readonly own: RTCRtpTransceiver[] = [];
  /** Candidates of the relay that arrived before a remote description. */
  private early: RTCIceCandidateInit[] = [];
  /** The sender (user id) of each forwarded track, and the stream it came in, by track id. */
  private readonly senders = new Map<string, { peer: string; stream: MediaStream }>();
  /** The forwarded streams whose `removetrack` this leg already listens to. */
  private readonly watched = new WeakSet<MediaStream>();
  /** This device's user id, lowercased as the forwarded stream ids are compared. */
  private readonly self: string;
  /** Relay frames, handled ONE AT A TIME in arrival order: each awaits the connection. */
  private chain: Promise<void> = Promise.resolve();
  private joined = false;
  private ended = false;

  /**
   * @param self This device's user id: a forwarded track naming it is refused (in any case, as the
   *   stream id is read lowercased).
   */
  constructor(
    self: string,
    private readonly media: CallSfuLegMedia,
    private readonly hooks: CallSfuLegHooks
  ) {
    this.self = self.toLowerCase();
  }

  /** The connection to the relay, or null before `open` / after the leg ended. */
  get connection(): RTCPeerConnection | null {
    return this.pc;
  }

  /** The participant whose frames the forwarded track `trackId` carries, if it arrived. */
  senderOf(trackId: string): string | undefined {
    return this.senders.get(trackId)?.peer;
  }

  /**
   * Makes the connection and adds this device's tracks, each on a send-only transceiver whose
   * encrypt transform is attached in THIS task (synchronous: nothing is awaited before the last
   * one). Sends nothing: the offer waits for the relay's `Joined`. THROWS what a hook threw, the
   * leg then closed - the caller has not joined yet.
   */
  open(): void {
    if (this.pc) throw new Error('the SFU leg is already open');
    const pc = this.hooks.createPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => this.onTrack(e);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.hooks.sendSignal({
        type: 'IceCandidate',
        candidate: JSON.stringify(e.candidate.toJSON()),
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.ended) {
        appendLog(`${TAG} connectionState=${pc.connectionState} after the leg ended - ignored`);
        return;
      }
      const state = pc.connectionState;
      appendLog(`${TAG} connectionState=${state}`);
      this.hooks.onConnectionState(state);
      if (state === 'failed') this.fail(new CallSfuConnectionFailedError());
    };
    try {
      for (const track of this.media.tracks) this.addLocal(pc, track);
    } catch (e) {
      appendLog(`${TAG} ERROR a local track could not be sent encrypted: ${String(e)}`);
      this.close();
      throw e;
    }
    appendLog(`${TAG} opened: ${this.own.length} send-only transceiver(s), waiting for Joined`);
  }

  /** One local track: its transceiver, the codec held, its transform - in one task. */
  private addLocal(pc: RTCPeerConnection, track: MediaStreamTrack): void {
    const kind = callMediaKind(track.kind);
    if (!kind) {
      appendLog(`${TAG} a local ${track.kind} track is not media - not sent`);
      return;
    }
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.media.stream],
    });
    const videoCodec = this.hooks.holdVideoCodec(transceiver, kind);
    if (kind === 'video' && !videoCodec) {
      // Never sent: a video frame the transform cannot frame would be encrypted whole and undecodable.
      pc.removeTrack(transceiver.sender);
      appendLog(`${TAG} ERROR the camera is not sent: its transceiver would not hold VP8`);
      this.hooks.cameraRefused(track);
      return;
    }
    this.hooks.attachSenderTransform(transceiver.sender, kind, videoCodec, 'attached');
    this.hooks.senderCreated(transceiver.sender, track);
    this.own.push(transceiver);
  }

  /**
   * A forwarded track: both transforms of its transceiver attached HERE, in the task `ontrack` fires
   * in (the receiver opening its sender's frames, the transceiver's own sender armed naming this
   * device), and only then handed to the screen.
   */
  private onTrack(e: RTCTrackEvent): void {
    if (this.ended) {
      appendLog(`${TAG} a forwarded ${e.track.kind} track after the leg ended - ignored`);
      return;
    }
    const kind = callMediaKind(e.track.kind);
    if (!kind) {
      appendLog(`${TAG} a forwarded ${e.track.kind} track is not media - ignored`);
      return;
    }
    const stream = e.streams[0];
    const peer = stream?.id ? stream.id.toLowerCase() : null;
    if (!peer || peer === this.self) {
      this.fail(new CallSfuTrackUnattributedError(kind, stream?.id ?? null));
      return;
    }
    try {
      const videoCodec = this.hooks.holdVideoCodec(e.transceiver, kind);
      this.hooks.attachReceiverTransform(e.receiver, kind, peer, videoCodec);
      this.hooks.attachSenderTransform(
        e.transceiver.sender,
        kind,
        videoCodec,
        'armed, no track yet'
      );
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // A transceiver the relay freed and reused for a later publisher fires `ontrack` again with
    // the SAME track under a new stream id: the old attribution ends before the new one starts.
    this.trackGone(e.track);
    this.senders.set(e.track.id, { peer, stream });
    this.watch(stream);
    appendLog(
      `${TAG} forwarded ${kind} track of ${peer.slice(0, 8)} (mid=${String(e.transceiver.mid)})`
    );
    try {
      this.hooks.onRemoteTrack(peer, e.track, stream);
    } catch (err) {
      appendLog(`${TAG} ERROR onRemoteTrack threw for ${peer.slice(0, 8)}: ${String(err)}`);
    }
  }

  /**
   * Listens, once per forwarded stream, for the relay dropping one of its tracks: the browser then
   * fires `removetrack` on the stream (and mutes the track; it never ends it).
   */
  private watch(stream: MediaStream): void {
    if (this.watched.has(stream)) return;
    this.watched.add(stream);
    stream.addEventListener('removetrack', (ev) => {
      if (this.ended) {
        appendLog(`${TAG} removetrack after the leg ended - nothing to report`);
        return;
      }
      const { track } = ev as MediaStreamTrackEvent;
      // A track already re-attached to another stream was reported gone from this one then.
      if (this.senders.get(track.id)?.stream !== stream) {
        appendLog(
          `${TAG} removetrack of a track this stream no longer carries - nothing to report`
        );
        return;
      }
      this.trackGone(track);
    });
  }

  /** Reports `track`'s current attribution gone and forgets it; nothing when it has none. */
  private trackGone(track: MediaStreamTrack): void {
    const entry = this.senders.get(track.id);
    if (!entry) return;
    this.senders.delete(track.id);
    appendLog(`${TAG} forwarded ${track.kind} track of ${entry.peer.slice(0, 8)} gone`);
    try {
      this.hooks.onRemoteTrackGone(entry.peer, track);
    } catch (err) {
      appendLog(
        `${TAG} ERROR onRemoteTrackGone threw for ${entry.peer.slice(0, 8)}: ${String(err)}`
      );
    }
  }

  /**
   * Hands the leg one relay frame. Frames are applied in arrival order, one at a time; a step the
   * engine refuses ends the leg (`onFailed`). Resolves once this frame is handled.
   */
  handle(frame: SfuServerFrame): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.ended || !this.pc) {
        appendLog(`${TAG} ${frame.type} after the leg ended - dropped`);
        return;
      }
      try {
        await this.apply(this.pc, frame);
      } catch (e) {
        this.fail(
          e instanceof CallSfuNegotiationError
            ? e
            : new CallSfuNegotiationError(frame.type, { cause: e })
        );
      }
    });
    return this.chain;
  }

  private async apply(pc: RTCPeerConnection, frame: SfuServerFrame): Promise<void> {
    switch (frame.type) {
      case 'Joined': {
        if (this.joined) {
          appendLog(`${TAG} a second Joined - ignored, the leg already offered`);
          return;
        }
        this.joined = true;
        const others = typeof frame.others === 'number' ? frame.others : null;
        appendLog(`${TAG} joined the relay (others=${others ?? 'unstated'})`);
        this.hooks.onJoined(others);
        await this.offer(pc, 'after Joined');
        return;
      }
      case 'Answer': {
        if (pc.signalingState !== 'have-local-offer') {
          // The answer to an offer this side rolled back in a glare: the relay never applied it.
          appendLog(
            `${TAG} an Answer in ${pc.signalingState} - it answers no offer of ours, dropped`
          );
          return;
        }
        await pc.setRemoteDescription(parseDescription(frame.sdp));
        await this.flushEarly(pc);
        appendLog(`${TAG} answer applied`);
        await this.offerUnplaced(pc);
        return;
      }
      case 'Offer': {
        if (pc.signalingState === 'have-local-offer') {
          appendLog(
            `${TAG} the relay's offer crossed ours - ours rolled back (polite), offered again once stable`
          );
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(parseDescription(frame.sdp));
        await this.flushEarly(pc);
        await pc.setLocalDescription(await pc.createAnswer());
        this.hooks.sendSignal({ type: 'Answer', sdp: describe(pc.localDescription) });
        appendLog(`${TAG} relay offer answered`);
        await this.offerUnplaced(pc);
        return;
      }
      case 'IceCandidate': {
        const init = JSON.parse(frame.candidate) as RTCIceCandidateInit;
        // The relay's end-of-candidates: nothing to add.
        if (!init.candidate) return;
        if (pc.remoteDescription) await pc.addIceCandidate(init);
        else this.early.push(init);
        return;
      }
    }
  }

  /** Offers this device's tracks to the relay (the one offer the client makes, or its retry). */
  private async offer(pc: RTCPeerConnection, why: string): Promise<void> {
    const video = this.own.some((t) => t.sender.track?.kind === 'video');
    await configureCallAudioSenders(pc, video, appendLog);
    await pc.setLocalDescription(await pc.createOffer());
    this.hooks.sendSignal({ type: 'Offer', sdp: describe(pc.localDescription) });
    appendLog(`${TAG} offer sent (${why})`);
  }

  /**
   * Back in `stable`, offers again when a transceiver of this device was never placed - its offer
   * was rolled back in a glare. A fact of the connection (`mid === null`), so it runs exactly when
   * owed, and never before the first offer (`joined`).
   */
  private async offerUnplaced(pc: RTCPeerConnection): Promise<void> {
    if (!this.joined || pc.signalingState !== 'stable') return;
    const unplaced = this.own.filter((t) => t.mid === null).length;
    if (unplaced === 0) return;
    await this.offer(pc, `${unplaced} track(s) of ours never placed`);
  }

  private async flushEarly(pc: RTCPeerConnection): Promise<void> {
    for (const init of this.early.splice(0)) await pc.addIceCandidate(init);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    appendLog(`${TAG} ERROR the leg ends: ${error.message}`);
    this.close();
    this.hooks.onFailed(error);
  }

  /** Closes the connection; later relay frames are dropped. Idempotent. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.early = [];
    this.pc?.close();
    this.pc = null;
    appendLog(`${TAG} closed`);
  }
}

/** A session description as an `Offer`/`Answer` frame carries it (call-service parses this JSON). */
function describe(desc: RTCSessionDescription | null): string {
  if (!desc) throw new CallSfuNegotiationError('describe: no local description');
  return JSON.stringify({ type: desc.type, sdp: desc.sdp });
}

function parseDescription(sdp: string): RTCSessionDescriptionInit {
  return JSON.parse(sdp) as RTCSessionDescriptionInit;
}
