/**
 * What every page of the end-to-end calls (`run.mjs`) shares: the page's log and its one fault, the
 * app's encryption worker and the way it is keyed and asked for its report, the transforms, and
 * what a peer connection's stats say about the leg it carries.
 *
 * The page proves nothing itself: it reports, and the driver decides from the reports.
 */

/** Every line this page noted, with its time: what the driver prints when a run fails. */
export const log: string[] = [];
let fault: string | null = null;

/** Appends one line to the page's log. */
export function note(msg: string) {
  log.push(`${(performance.now() / 1000).toFixed(2)} ${msg}`);
}

/** Records why this participant's call cannot go on; only the FIRST reason is kept. */
export function setFault(why: string) {
  note(`FAULT ${why}`);
  fault ??= why;
}

/**
 * Sends one signalling frame on `ws`, or records a fault naming the frame when the socket is not
 * open - the one implementation both pages use (`page.ts`, `group-page.ts`).
 */
export function sendFrame(ws: WebSocket | null, frame: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setFault(`could not send ${String(frame.type)}: the socket is not open`);
    return;
  }
  ws.send(JSON.stringify(frame));
}

/** The first fault this page recorded, or null while it may still succeed. */
export function currentFault(): string | null {
  return fault;
}

/** The app's worker, and what the page knows of it. */
export interface WorkerHandle {
  worker: Worker;
  /**
   * Settles once the worker can no longer answer (a script that would not load or parse, an
   * uncaught error, a message it could not deserialise): every wait on the worker races it, so a
   * dead worker is a fault the driver reads rather than a report it waits for forever.
   */
  dead: Promise<void>;
  /** The last `report` it answered. */
  lastReport: Record<string, unknown> | null;
}

/** The worker's lines a run needs in its log when it fails. */
const WORKER_LINES = new Set([
  'decryptError',
  'keyError',
  'warn',
  'transformError',
  'undecryptable',
  'droppedNoKey',
]);

/** Starts the app's own encryption worker (`encryption.worker.ts`, built from source by the driver). */
export function startWorker(): WorkerHandle {
  const worker = new Worker('/encryption.worker.js', { type: 'module' });
  const handle: WorkerHandle = { worker, dead: new Promise(() => {}), lastReport: null };
  handle.dead = new Promise<void>((resolve) => {
    worker.addEventListener('error', (e: ErrorEvent) => {
      setFault(`the encryption worker failed: ${e.message || 'it did not load'}`);
      resolve();
    });
    worker.addEventListener('messageerror', () => {
      setFault('the encryption worker sent a message that could not be deserialised');
      resolve();
    });
  });
  worker.addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
    const t = e.data?.type ?? '';
    if (t === 'report') handle.lastReport = e.data as Record<string, unknown>;
    else if (WORKER_LINES.has(t)) note(`worker ${JSON.stringify(e.data)}`);
  });
  return handle;
}

/**
 * Posts one keying command and resolves on its acknowledgement (`ok`, and when `peer` is given,
 * the acknowledgement naming that participant); rejects on a `keyError` or a dead worker.
 */
export async function keyCommand(
  h: WorkerHandle,
  command: Record<string, unknown>,
  transfer: ArrayBuffer[],
  ok: 'keyReady' | 'peerKeyReady',
  peer?: string
): Promise<void> {
  const acknowledged = new Promise<void>((resolve, reject) => {
    const onMessage = (e: MessageEvent<{ type?: string; detail?: string; peer?: string }>) => {
      if (e.data?.type === ok && (peer === undefined || e.data.peer === peer)) {
        h.worker.removeEventListener('message', onMessage);
        resolve();
      }
      if (e.data?.type === 'keyError') {
        h.worker.removeEventListener('message', onMessage);
        reject(new Error(`the worker refused ${String(command.type)}: ${e.data.detail}`));
      }
    };
    h.worker.addEventListener('message', onMessage);
    h.worker.postMessage(command, transfer);
  });
  await Promise.race([
    acknowledged,
    h.dead.then(() => {
      throw new Error(fault ?? 'the encryption worker died');
    }),
  ]);
}

/** Asks the worker for its report and resolves once it answered (or once it is dead). */
export async function askReport(h: WorkerHandle): Promise<void> {
  const answered = new Promise<void>((resolve) => {
    const onReport = (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type !== 'report') return;
      h.worker.removeEventListener('message', onReport);
      resolve();
    };
    h.worker.addEventListener('message', onReport);
  });
  h.worker.postMessage({ type: 'report', tag: 'e2e' });
  // A dead worker never answers: its fault (set by the same event) is then what the page returns.
  await Promise.race([answered, h.dead]);
}

/**
 * One transform of the app's worker. `peer` names the participant a RECEIVER carries the frames of
 * (a group call; the worker opens them with that participant's key) - a 1:1 call names none.
 */
export function transform(
  h: WorkerHandle,
  side: 'sender' | 'receiver',
  kind: 'audio' | 'video',
  peer?: string
) {
  return new RTCRtpScriptTransform(
    h.worker,
    peer === undefined ? { side, kind } : { side, kind, peer }
  );
}

/** What one peer connection's stats say about the leg it carries. */
export interface LegStats {
  connectionState: RTCPeerConnectionState | null;
  /** The inbound audio counters, summed over every inbound audio stream of the connection. */
  inbound: { packetsReceived: number; bytesReceived: number } | null;
  /** The selected candidate pair's types (`relay`, `host`, ...). */
  pair: { local: unknown; localProtocol: unknown; remote: unknown } | null;
  /** Per inbound audio stream: its track identifier and its packets, for a multi-sender connection. */
  inboundByTrack: Record<string, number>;
}

/** Reads `pc`'s stats into what the driver judges a leg on. */
export async function legStats(pc: RTCPeerConnection | null): Promise<LegStats> {
  const out: LegStats = {
    connectionState: pc?.connectionState ?? null,
    inbound: null,
    pair: null,
    inboundByTrack: {},
  };
  if (!pc) return out;
  const stats = await pc.getStats();
  const byId = new Map<string, Record<string, unknown>>();
  stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
  for (const s of byId.values()) {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      const packets = Number(s.packetsReceived ?? 0);
      out.inbound = {
        packetsReceived: (out.inbound?.packetsReceived ?? 0) + packets,
        bytesReceived: (out.inbound?.bytesReceived ?? 0) + Number(s.bytesReceived ?? 0),
      };
      out.inboundByTrack[String(s.trackIdentifier ?? s.id)] = packets;
    }
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      const p = byId.get(String(s.selectedCandidatePairId));
      const local = p && byId.get(String(p.localCandidateId));
      const remote = p && byId.get(String(p.remoteCandidateId));
      out.pair = {
        local: local?.candidateType ?? null,
        localProtocol: local?.protocol ?? null,
        remote: remote?.candidateType ?? null,
      };
    }
  }
  return out;
}
