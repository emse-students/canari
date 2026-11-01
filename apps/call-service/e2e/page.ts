/**
 * One participant of the SFU end-to-end call (`run.mjs`), in one headless Chrome whose fake
 * microphone plays Chrome's built-in tone.
 *
 * What is the app's, IMPORTED rather than copied: the E2E frame transform (`encryption.worker.ts`,
 * built from source and served as-is), the capture constraints and the sender parameters
 * (`utils/callAudio.ts`), and the ORDER the durable rule requires - each transform assigned in the
 * task that created its sender or transceiver, and in `ontrack` for a transceiver
 * `setRemoteDescription` created, sender included
 * (docs/wiki/durable-rules.md, "Calls, and their record").
 *
 * What is a stand-in: the keys (fixed test bytes, one per direction as `setKeys` takes them, not an
 * MLS export), the tokens (minted by the driver with the service's own secrets, not by
 * chat-delivery-service) and the absence of a ring. The SIGNALLING is the service's real protocol
 * in SFU mode - `Join { mode: "sfu" }`, `Joined`, the client's `Offer`, the SFU's `Answer`, the
 * SFU's renegotiation `Offer` when the other participant publishes, trickled `IceCandidate` both
 * ways - because that protocol is the thing under test. The client has no SFU code path today
 * (calls are peer to peer since 2026-10-17), so this page IS the SFU client until WP-C11 builds one.
 *
 * The page proves nothing itself: it reports, and the driver decides from the reports.
 */
import {
  buildCallAudioConstraints,
  configureCallAudioSenders,
} from '../../../frontend/src/lib/utils/callAudio';

interface E2eConfig {
  /** `ws://host:port/ws` of the call-service under test. */
  ws: string;
  /** An ACCESS token for this participant, signed with the service's `JWT_SECRET`. */
  token: string;
  roomId: string;
  /** A room token (`room_id`, `sub`, `group_id`), signed with `CALL_ROOM_SECRET`. */
  roomToken: string;
  /** Picks the direction keys: the caller sends with `caller` and receives with `callee`. */
  role: 'caller' | 'callee';
  iceServers: RTCIceServer[];
  /** `relay` when a TURN server is given: every packet then goes through it, as production does. */
  iceTransportPolicy: RTCIceTransportPolicy;
}

/**
 * The call's two media keys, one per direction (`utils/callKeys.ts`): the two participants hold
 * them crossed, so a frame one of them DECRYPTS was encrypted by the other one and nobody else.
 */
const testKey = (a: number, b: number) => Uint8Array.from({ length: 32 }, (_, i) => i * a + b);
const KEYS = { caller: testKey(7, 3), callee: testKey(13, 1) };

const log: string[] = [];
let cfg: E2eConfig;
let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let worker: Worker | null = null;
/** Every server frame type received, in order: what the driver prints when a run fails. */
const frames: string[] = [];
/** Set once: why this participant's call cannot go on (a refusal, a socket that ended, an error). */
let fault: string | null = null;
/** True once `hangup()` closed the socket: an end this page asked for is not a fault. */
let hungUp = false;
let lastReport: Record<string, unknown> | null = null;
/**
 * Server frames are handled ONE AT A TIME, in arrival order: each handler awaits the peer
 * connection, and two running at once would apply a candidate before the description it belongs to.
 */
let signalChain: Promise<void> = Promise.resolve();
/**
 * Candidates that arrived before any remote description: the SFU starts gathering when it sets its
 * answer locally and trickles from that moment, so its first candidates can overtake the Answer.
 */
const earlyCandidates: RTCIceCandidateInit[] = [];

function note(msg: string) {
  log.push(`${(performance.now() / 1000).toFixed(2)} ${msg}`);
}

function setFault(why: string) {
  note(`FAULT ${why}`);
  fault ??= why;
}

function send(frame: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setFault(`could not send ${String(frame.type)}: the socket is not open`);
    return;
  }
  ws.send(JSON.stringify(frame));
}

/** The app worker, keyed as `CallService.ensureWorkerKeyReady` keys it, BEFORE the first track. */
async function keyWorker(): Promise<Worker> {
  const w = new Worker('/encryption.worker.js', { type: 'module' });
  w.addEventListener('message', (e: MessageEvent<{ type?: string; detail?: string }>) => {
    const t = e.data?.type;
    if (t === 'report') lastReport = e.data as Record<string, unknown>;
    else if (
      ['decryptError', 'keyError', 'warn', 'transformError', 'undecryptable'].includes(t ?? '')
    )
      note(`worker ${JSON.stringify(e.data)}`);
  });
  await new Promise<void>((resolve, reject) => {
    const onKey = (e: MessageEvent<{ type?: string; detail?: string }>) => {
      if (e.data?.type === 'keyReady') resolve();
      if (e.data?.type === 'keyError') reject(new Error(e.data.detail));
    };
    w.addEventListener('message', onKey);
    const send = KEYS[cfg.role].slice().buffer;
    const receive = KEYS[cfg.role === 'caller' ? 'callee' : 'caller'].slice().buffer;
    w.postMessage({ type: 'setKeys', send, receive }, [send, receive]);
  });
  return w;
}

function transform(side: 'sender' | 'receiver', kind: 'audio' | 'video') {
  return new RTCRtpScriptTransform(worker!, { side, kind });
}

async function flushEarlyCandidates(peer: RTCPeerConnection) {
  for (const init of earlyCandidates.splice(0)) await peer.addIceCandidate(init);
}

async function onSignal(raw: string) {
  const msg = JSON.parse(raw) as {
    type: string;
    sdp?: string;
    candidate?: string;
    reason?: string;
  };
  frames.push(msg.type);
  const peer = pc!;
  switch (msg.type) {
    case 'Joined': {
      // The client offers first in SFU mode: its own track, both transforms already assigned.
      await peer.setLocalDescription(await peer.createOffer());
      send({ type: 'Offer', sdp: JSON.stringify(peer.localDescription) });
      return;
    }
    case 'Answer':
      await peer.setRemoteDescription(JSON.parse(msg.sdp!));
      await flushEarlyCandidates(peer);
      return;
    case 'Offer': {
      // The SFU's renegotiation: the other participant's track was added to this connection.
      await peer.setRemoteDescription(JSON.parse(msg.sdp!));
      await flushEarlyCandidates(peer);
      await peer.setLocalDescription(await peer.createAnswer());
      send({ type: 'Answer', sdp: JSON.stringify(peer.localDescription) });
      return;
    }
    case 'IceCandidate': {
      const init = JSON.parse(msg.candidate!) as RTCIceCandidateInit;
      if (!init.candidate) return;
      if (peer.remoteDescription) await peer.addIceCandidate(init);
      else earlyCandidates.push(init);
      return;
    }
    case 'Refused':
      setFault(`the service refused the Join: ${msg.reason}`);
      return;
    default:
      note(`unexpected frame ${msg.type}`);
  }
}

/** Builds the peer connection, keys the worker, opens the socket and joins the room. */
async function start(config: E2eConfig) {
  cfg = config;
  worker = await keyWorker();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: buildCallAudioConstraints() });
  pc = new RTCPeerConnection({
    iceServers: cfg.iceServers,
    iceTransportPolicy: cfg.iceTransportPolicy,
  });
  const peer = pc;
  peer.ontrack = (e) => {
    const kind = e.track.kind as 'audio' | 'video';
    // As CallService.handleRemoteTrack: a transceiver the remote offer created is armed HERE, in
    // the task that created it - receiver and sender both.
    if (!e.receiver.transform) e.receiver.transform = transform('receiver', kind);
    if (!e.transceiver.sender.transform) e.transceiver.sender.transform = transform('sender', kind);
    const audio = new Audio();
    audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    void audio.play().catch((err) => note(`play: ${String(err)}`));
    note(`ontrack ${kind} mid=${e.transceiver.mid}`);
  };
  peer.onicecandidate = (e) => {
    if (e.candidate)
      send({ type: 'IceCandidate', candidate: JSON.stringify(e.candidate.toJSON()) });
  };
  peer.onicecandidateerror = (e) => {
    const why = `TURN/STUN ${e.url} answered ${e.errorCode} ${e.errorText}`;
    // Relay-only with ONE server: an allocation it refused is a relay candidate this side will
    // never have, so the call cannot connect - a proof, not a symptom to wait out.
    if (cfg.iceTransportPolicy === 'relay') setFault(why);
    else note(why);
  };
  peer.onconnectionstatechange = () => {
    note(`connectionState=${peer.connectionState}`);
    if (peer.connectionState === 'failed') setFault('the peer connection to the SFU FAILED');
  };
  for (const track of stream.getAudioTracks()) {
    const sender = peer.addTrack(track, stream);
    const t = peer.getTransceivers().find((x) => x.sender === sender)!;
    // In the task that created the sender and its transceiver: one task later, Chromium
    // short-circuits both for good (CALL-E2E-BYPASS-MI9T).
    sender.transform = transform('sender', 'audio');
    t.receiver.transform = transform('receiver', 'audio');
  }
  await configureCallAudioSenders(peer, false, note);

  ws = new WebSocket(`${cfg.ws}?token=${encodeURIComponent(cfg.token)}`);
  ws.onopen = () =>
    send({ type: 'Join', room_id: cfg.roomId, room_token: cfg.roomToken, mode: 'sfu' });
  ws.onmessage = (e) => {
    const raw = String(e.data);
    signalChain = signalChain
      .then(() => onSignal(raw))
      .catch((err) => setFault(`signal: ${String(err)}`));
  };
  ws.onclose = (e) => {
    note(`socket closed code=${e.code}`);
    if (!hungUp) setFault(`the signalling socket closed (code ${e.code}) before the hangup`);
  };
}

/**
 * What the driver decides from: the worker's own report (frames encrypted and decrypted per kind,
 * decrypt failures), the inbound audio counters, and the selected candidate pair's types.
 */
async function state() {
  const peer = pc;
  const answered = new Promise<void>((resolve) => {
    const onReport = (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type !== 'report') return;
      worker?.removeEventListener('message', onReport);
      resolve();
    };
    worker?.addEventListener('message', onReport);
  });
  worker?.postMessage({ type: 'report', tag: 'e2e' });
  let inbound: Record<string, unknown> | null = null;
  let pair: Record<string, unknown> | null = null;
  if (peer) {
    const stats = await peer.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
    for (const s of byId.values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        inbound = { packetsReceived: s.packetsReceived, bytesReceived: s.bytesReceived };
      }
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const p = byId.get(String(s.selectedCandidatePairId));
        const local = p && byId.get(String(p.localCandidateId));
        const remote = p && byId.get(String(p.remoteCandidateId));
        pair = {
          local: local?.candidateType ?? null,
          localProtocol: local?.protocol ?? null,
          remote: remote?.candidateType ?? null,
        };
      }
    }
  }
  await answered;
  return {
    fault,
    frames,
    connectionState: peer?.connectionState ?? null,
    report: lastReport,
    inbound,
    pair,
  };
}

/** Ends this participant's call the way a hangup does: a Close frame on the signalling socket. */
function hangup() {
  hungUp = true;
  ws?.close(1000);
  pc?.close();
}

Object.assign(window, { e2e: { start, state, hangup, log: () => log } });
document.title = 'e2e-ready';
