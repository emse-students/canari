/**
 * One participant of a GROUP end-to-end call (`run.mjs --scenario mesh` and `--scenario sfu-group`),
 * in one headless Chrome whose fake microphone plays Chrome's built-in tone.
 *
 * THE MESH (WP-GC2). call-service's p2p mode seats up to `max_seats` users and tells each pair to
 * negotiate (`PeerReady { initiator, peer }`, the earlier seat initiates); every frame is addressed
 * (`to`, set here) and stamped by the relay with its sender (`from`). This page holds ONE peer
 * connection per other participant, made when that pair's `PeerReady` arrives, and routes every
 * received frame by its `from`.
 *
 * THE RELAY (WP-GC4). call-service's SFU mode seats up to `max_seats` users; this page holds ONE peer
 * connection, to the SFU, through THE APP'S OWN SFU LEG (`frontend/src/lib/services/callSfuLeg.ts`):
 * its microphone on a SEND-ONLY transceiver (so the SFU never answers a forwarded track on it, and
 * every forwarded track arrives on a transceiver of its own), the offer on `Joined`, the SFU's
 * renegotiations answered, and WHO SENT each forwarded track read from its stream id, which the SFU
 * sets to the sender's user id (`sfu_seats::forwarded_stream_id`). That id is the `peer` its receiver
 * transform names. The page hands the leg the transforms below, as `CallService` hands it its own.
 *
 * THE KEYS (WP-GC1). One key per SENDER, `deriveGroupCallKeys` from `utils/callKeys.ts` - the app's
 * own derivation, imported - over a stand-in exporter (HKDF of a secret the driver hands every page:
 * the MLS exporter is out of scope, the transport and the transforms are the thing under test). The
 * worker is keyed with `setGroupKeys` before the first track; each SENDER transform names this
 * participant, each RECEIVER transform the remote participant whose frames it carries, so the worker
 * opens them with THAT participant's key (`CallTransformOptions.peer`). Both are assigned in the task
 * that created the sender and its transceiver (CALL-E2E-BYPASS-MI9T, durable-rules "Calls, and their
 * record").
 *
 * What is the app's: the transform, the key derivation, the capture constraints and the sender
 * parameters. What is a stand-in: the exporter secret, the tokens (minted by the driver with the
 * service's own secrets) and the absence of a ring. The SIGNALLING is the service's real protocol.
 */
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
} from '../../../frontend/src/lib/utils/callAudio';
import { deriveGroupCallKeys, type ExportSecret } from '../../../frontend/src/lib/utils/callKeys';
import {
  CallSfuLeg,
  sfuJoinFrame,
  type SfuServerFrame,
} from '../../../frontend/src/lib/services/callSfuLeg';
import {
  askReport,
  currentFault,
  keyCommand,
  legStats,
  log,
  note,
  sendFrame,
  setFault,
  startWorker,
  transform,
  type LegStats,
  type WorkerHandle,
} from './common';

interface GroupConfig {
  /** `ws://host:port/ws` of the call-service under test. */
  ws: string;
  /** An ACCESS token for this participant, signed with the service's `JWT_SECRET`. */
  token: string;
  roomId: string;
  /** A room token (`room_id`, `sub`, `group_id`, `max_seats`), signed with `CALL_ROOM_SECRET`. */
  roomToken: string;
  groupId: string;
  /** This participant's user id (lowercase, as the signalling names it). */
  self: string;
  /** Every participant's user id, this one included: whose frames this page may open. */
  participants: string[];
  /** The stand-in exporter secret, hex, the same on every page of the run. */
  exporterSecret: string;
  iceServers: RTCIceServer[];
  /** `relay` when a TURN server is given: every packet then goes through it, as production does. */
  iceTransportPolicy: RTCIceTransportPolicy;
  /** `mesh`: one peer connection per other participant (p2p). `sfu`: one, to the relay. */
  mode: 'mesh' | 'sfu';
}

/** One frame of the service's protocol, as this page reads it. */
interface ServerFrame {
  type: string;
  sdp?: string;
  candidate?: string;
  reason?: string;
  initiator?: boolean;
  peer?: string;
  from?: string;
  others?: number;
}

/** One leg of the mesh: the peer connection to one other participant. */
interface Leg {
  pc: RTCPeerConnection;
  /** Candidates that arrived before this leg's remote description. */
  early: RTCIceCandidateInit[];
}

let cfg: GroupConfig;
let ws: WebSocket | null = null;
let wh: WorkerHandle | null = null;
let stream: MediaStream | null = null;
const legs = new Map<string, Leg>();
/** `sfu` mode: the app's SFU leg, the one connection to the relay. */
let relay: CallSfuLeg | null = null;
/** `sfu` mode: the sender (user id) of each forwarded track, by track id, as the leg read it. */
const trackSender = new Map<string, string>();
/** Every server frame type received, in order: what the driver prints when a run fails. */
const frames: string[] = [];
/** True once the driver said the call is ending: a `PeerLeft` is then expected, not a fault. */
let ending = false;
/**
 * Server frames are handled ONE AT A TIME, in arrival order: each handler awaits a peer connection,
 * and two running at once would apply a candidate before the description it belongs to.
 */
let signalChain: Promise<void> = Promise.resolve();

function send(frame: Record<string, unknown>) {
  sendFrame(ws, frame);
}

/** The stand-in exporter: HKDF-SHA256 of the run's shared secret, salted by the group, over label|context. */
function stubExporter(secretHex: string): ExportSecret {
  const secret = Uint8Array.from(secretHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return async (groupId, label, context, length) => {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const info = new Uint8Array([...new TextEncoder().encode(`${label}|`), ...context]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(groupId), info },
      base,
      length * 8
    );
    return new Uint8Array(bits);
  };
}

/** The app worker, keyed with one send key and one receive key per other participant. */
async function keyWorker(): Promise<WorkerHandle> {
  note(`keying the worker for ${cfg.participants.length - 1} other participant(s)`);
  const h = startWorker();
  const keys = await deriveGroupCallKeys(
    stubExporter(cfg.exporterSecret),
    cfg.groupId,
    cfg.roomId,
    cfg.self,
    cfg.participants
  );
  const sendKey = keys.send.slice().buffer;
  const receive = [...keys.receive].map(([peer, key]) => ({ peer, key: key.slice().buffer }));
  await keyCommand(
    h,
    { type: 'setGroupKeys', send: sendKey, receive },
    [sendKey, ...receive.map((r) => r.key)],
    'keyReady'
  );
  return h;
}

/**
 * The leg to `peer`, made on its pair's `PeerReady` (or on an offer that overtook it): this
 * participant's microphone track added, and BOTH transforms of its transceiver assigned in this same
 * task - the sender naming this participant, the receiver naming `peer`.
 */
function legTo(peer: string): Leg {
  const known = legs.get(peer);
  if (known) return known;
  note(`leg to ${peer}: creating its peer connection`);
  const pc = new RTCPeerConnection({
    iceServers: cfg.iceServers,
    iceTransportPolicy: cfg.iceTransportPolicy,
  });
  const leg: Leg = { pc, early: [] };
  legs.set(peer, leg);
  pc.ontrack = (e) => {
    const kind = e.track.kind as 'audio' | 'video';
    // A transceiver the remote offer created is armed HERE, in the task that created it.
    if (!e.receiver.transform) e.receiver.transform = transform(wh!, 'receiver', kind, peer);
    if (!e.transceiver.sender.transform)
      e.transceiver.sender.transform = transform(wh!, 'sender', kind, cfg.self);
    const audio = new Audio();
    audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    void audio.play().catch((err) => note(`play: ${String(err)}`));
    note(`leg to ${peer}: ontrack ${kind} mid=${e.transceiver.mid}`);
  };
  watchConnection(pc, `leg to ${peer}`, peer);
  for (const track of stream!.getAudioTracks()) {
    const sender = pc.addTrack(track, stream!);
    const t = pc.getTransceivers().find((x) => x.sender === sender)!;
    // In the task that created the sender and its transceiver: one task later, Chromium
    // short-circuits both for good (CALL-E2E-BYPASS-MI9T).
    sender.transform = transform(wh!, 'sender', 'audio', cfg.self);
    t.receiver.transform = transform(wh!, 'receiver', 'audio', peer);
  }
  return leg;
}

/**
 * The handlers every connection of this page shares: its candidates sent (addressed to `to` in a
 * mesh), a refused TURN allocation and a `failed` connection made faults.
 */
function watchConnection(pc: RTCPeerConnection, label: string, to?: string) {
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const candidate = JSON.stringify(e.candidate.toJSON());
    send(
      to === undefined
        ? { type: 'IceCandidate', candidate }
        : { type: 'IceCandidate', candidate, to }
    );
  };
  watchIceErrors(pc, label);
  pc.onconnectionstatechange = () => connectionChanged(label, pc.connectionState);
}

/** A refused TURN allocation is a fault when the run is relay-only (see below). */
function watchIceErrors(pc: RTCPeerConnection, label: string) {
  pc.onicecandidateerror = (e) => {
    const why = `${label}: TURN/STUN ${e.url} answered ${e.errorCode} ${e.errorText}`;
    // Relay-only with ONE server: an allocation it refused is a relay candidate this connection
    // will never have, so it cannot connect - a proof, not a symptom to wait out.
    if (cfg.iceTransportPolicy === 'relay') setFault(why);
    else note(why);
  };
}

/** A connection's new state, noted; `failed` is a fault. */
function connectionChanged(label: string, state: RTCPeerConnectionState) {
  note(`${label}: connectionState=${state}`);
  if (state === 'failed') setFault(`${label} FAILED`);
}

/**
 * `sfu` mode: the app's SFU leg, given this page's transforms - the sender naming this participant,
 * a forwarded track's receiver the sender its stream id names - and its signalling. Audio only, so
 * no codec is held.
 */
function relayLeg(): CallSfuLeg {
  note('relay: opening the app SFU leg');
  const leg = new CallSfuLeg(
    cfg.self,
    { stream: stream!, tracks: stream!.getAudioTracks() },
    {
      createPeerConnection: () => {
        const pc = new RTCPeerConnection({
          iceServers: cfg.iceServers,
          iceTransportPolicy: cfg.iceTransportPolicy,
        });
        watchIceErrors(pc, 'the connection to the SFU');
        return pc;
      },
      holdVideoCodec: () => undefined,
      attachSenderTransform: (sender, kind) => {
        sender.transform = transform(wh!, 'sender', kind, cfg.self);
      },
      attachReceiverTransform: (receiver, kind, peer) => {
        receiver.transform = transform(wh!, 'receiver', kind, peer);
      },
      senderCreated: () => {},
      cameraRefused: () => setFault('relay: a camera was refused, and this page sends none'),
      sendSignal: (frame) => send(frame),
      onJoined: (others) => note(`joined the relay (others=${String(others)})`),
      onRemoteTrack: (peer, track, remoteStream) => {
        trackSender.set(track.id, peer);
        const audio = new Audio();
        audio.srcObject = remoteStream;
        void audio.play().catch((err) => note(`play: ${String(err)}`));
        note(`relay: ontrack ${track.kind} from ${peer}`);
      },
      onRemoteTrackGone: (peer, track) => {
        // Reported before any re-attachment of the same track, so the entry is still this peer's.
        trackSender.delete(track.id);
        note(`relay: ${track.kind} track of ${peer} gone`);
      },
      onConnectionState: (state) => connectionChanged('the connection to the SFU', state),
      onFailed: (e) => setFault(`relay: ${e.message}`),
    }
  );
  leg.open();
  return leg;
}

/** `sfu` mode: one server frame - the leg's, or the Join's refusal. */
async function onRelaySignal(msg: ServerFrame) {
  switch (msg.type) {
    case 'Joined':
    case 'Offer':
    case 'Answer':
    case 'IceCandidate':
      await relay!.handle(msg as SfuServerFrame);
      return;
    case 'Refused':
      setFault(`the service refused the Join: ${msg.reason}`);
      return;
    default:
      note(`unexpected frame ${msg.type}`);
  }
}

async function flushEarly(leg: Leg) {
  for (const init of leg.early.splice(0)) await leg.pc.addIceCandidate(init);
}

async function onSignal(raw: string) {
  const msg = JSON.parse(raw) as ServerFrame;
  frames.push(
    msg.from ? `${msg.type}<${msg.from}` : msg.peer ? `${msg.type}:${msg.peer}` : msg.type
  );
  if (cfg.mode === 'sfu') return onRelaySignal(msg);
  switch (msg.type) {
    case 'Joined':
      note('joined');
      return;
    case 'PeerReady': {
      if (!msg.peer) {
        setFault('a PeerReady without a peer: the service is not a mesh');
        return;
      }
      const leg = legTo(msg.peer);
      await configureCallAudioSenders(leg.pc, false, note);
      if (!msg.initiator) return;
      // The earlier seat of the pair offers.
      await leg.pc.setLocalDescription(await leg.pc.createOffer());
      send({ type: 'Offer', sdp: JSON.stringify(leg.pc.localDescription), to: msg.peer });
      return;
    }
    case 'Offer': {
      const leg = legTo(msg.from!);
      await leg.pc.setRemoteDescription(JSON.parse(msg.sdp!));
      await flushEarly(leg);
      await leg.pc.setLocalDescription(await leg.pc.createAnswer());
      send({ type: 'Answer', sdp: JSON.stringify(leg.pc.localDescription), to: msg.from });
      return;
    }
    case 'Answer': {
      const leg = legs.get(msg.from!);
      if (!leg) {
        setFault(`an Answer from ${msg.from}, to whom no offer was made`);
        return;
      }
      await leg.pc.setRemoteDescription(JSON.parse(msg.sdp!));
      await flushEarly(leg);
      return;
    }
    case 'IceCandidate': {
      const init = JSON.parse(msg.candidate!) as RTCIceCandidateInit;
      if (!init.candidate) return;
      const leg = legTo(msg.from!);
      if (leg.pc.remoteDescription) await leg.pc.addIceCandidate(init);
      else leg.early.push(init);
      return;
    }
    case 'PeerLeft':
    case 'PeerAway':
      if (ending) note(`${msg.type} ${msg.peer ?? '(this device)'}`);
      else setFault(`${msg.type} ${msg.peer ?? '(this device)'} before the call was ending`);
      return;
    case 'Refused':
      setFault(`the service refused the Join: ${msg.reason}`);
      return;
    default:
      note(`unexpected frame ${msg.type}`);
  }
}

/** Keys the worker, opens the microphone and the socket, and joins the room (a mesh seat, or the relay). */
async function start(config: GroupConfig) {
  cfg = config;
  note(`start: ${cfg.self} joins room ${cfg.roomId}`);
  wh = await keyWorker();
  stream = await navigator.mediaDevices.getUserMedia({ audio: buildCallAudioConstraints() });
  if (cfg.mode === 'sfu') relay = relayLeg();
  ws = new WebSocket(`${cfg.ws}?token=${encodeURIComponent(cfg.token)}`);
  ws.onopen = () =>
    send(
      cfg.mode === 'sfu'
        ? sfuJoinFrame(cfg.roomId, cfg.roomToken)
        : { type: 'Join', room_id: cfg.roomId, room_token: cfg.roomToken, mode: 'p2p' }
    );
  ws.onmessage = (e) => {
    const raw = String(e.data);
    signalChain = signalChain
      .then(() => onSignal(raw))
      .catch((err) => setFault(`signal: ${String(err)}`));
  };
  ws.onclose = (e) => {
    note(`socket closed code=${e.code}`);
    if (!ending) setFault(`the signalling socket closed (code ${e.code}) before the hangup`);
  };
}

/**
 * The NEGATIVE proof's lever: replaces the receive key of `peer` with random bytes, so that leg's
 * frames can no longer open. Resolves once the worker acknowledged the new key.
 */
async function rekeyWrong(peer: string) {
  note(`rekeyWrong: ${peer}'s receive key replaced with random bytes`);
  const key = crypto.getRandomValues(new Uint8Array(32)).buffer;
  await keyCommand(wh!, { type: 'addReceiveKey', peer, key }, [key], 'peerKeyReady', peer);
}

/**
 * What the driver decides from: the worker's report (its `byPeer` counts each sender's frames
 * apart) and each leg's stats, keyed by the remote participant.
 */
async function state() {
  const perLeg: Record<string, LegStats> = {};
  for (const [peer, leg] of legs) perLeg[peer] = await legStats(leg.pc);
  if (relay) {
    // One connection carries every sender: each sender's leg is ITS track's inbound counters, on
    // the connection's one candidate pair.
    const all = await legStats(relay.connection);
    for (const [trackId, sender] of trackSender) {
      const packets = all.inboundByTrack[trackId] ?? 0;
      perLeg[sender] = { ...all, inbound: { packetsReceived: packets, bytesReceived: 0 } };
    }
  }
  if (wh) await askReport(wh);
  return { fault: currentFault(), frames, report: wh?.lastReport ?? null, legs: perLeg };
}

/** Says the call is ending: the others' departures that follow are expected. */
function expectEnd() {
  note('the call is ending');
  ending = true;
}

/** Ends this participant's call the way a hangup does: a Close frame on the signalling socket. */
function hangup() {
  note('hangup');
  ending = true;
  ws?.close(1000);
  for (const leg of legs.values()) leg.pc.close();
  relay?.close();
}

/** Whether the signalling socket finished its close handshake: the service has this end. */
function closed() {
  return ws?.readyState === WebSocket.CLOSED;
}

Object.assign(window, {
  e2e: { start, state, rekeyWrong, expectEnd, hangup, closed, log: () => log },
});
document.title = 'e2e-ready';
