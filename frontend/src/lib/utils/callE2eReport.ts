/**
 * The E2E worker's report, as one call-log line (2026-10-19).
 *
 * WHY: on a Mi 9T (Android WebView 152) five calls logged the main thread's `transform attached`
 * lines and NOTHING from the worker - no first-frame `encrypting`/`decrypting` line - while the
 * iPhone's audio reached it as noise. Silence from the worker is three different facts: the
 * messages never reach the main thread, the engine never handed the worker a transformer, or it
 * handed one and never fed it a frame. `CallService` ASKS the worker for its counters 5 s after
 * `connected` and at the end of the call; this module turns the answer into a line that names
 * which of the three it is, and records the engine facts the answer has to be read against.
 */

/** What `encryption.worker.ts` answers to `{ type: 'report' }`. */
export interface E2eWorkerReport {
  tag: string;
  transformers: Record<string, number>;
  framesIn: Record<string, number>;
  /** Frames per peer connection, side and kind, keyed `<epoch>|<side>|<kind>` (`framesFor`). */
  framesInBy?: Record<string, number>;
  encrypted: { audio: number; video: number };
  decrypted: { audio: number; video: number };
  decryptFailures: number;
  /** Receiver frames shorter than an IV, dropped; `tooShortEmpty` of them were empty. */
  tooShort: number;
  tooShortEmpty: number;
  droppedNoKey: number;
  opusInvalid: { sender: number; receiver: number };
  doubleEncrypted: number;
}

/** The engine facts a report is read against, gathered once on the main thread. */
export interface E2eEngineFacts {
  /**
   * e.g. `Chrome/152`, `iOS/27` (the OS version a WKWebView names), `Safari/26` (the browser's
   * own version), or `?`. Never a WebKit BUILD number: those (`AppleWebKit/605.1.15`) are frozen
   * and compare to nothing.
   */
  engine: string;
  /** Whether `RTCRtpSender.prototype` / `RTCRtpReceiver.prototype` define `transform` natively. */
  senderAttr: 'native' | 'absent';
  receiverAttr: 'native' | 'absent';
}

/**
 * `native` when `proto` (or its chain) defines `transform` as an accessor. An engine without it
 * still accepts `sender.transform = x` - as a plain expando property that changes nothing, so the
 * media would flow around the worker without one error anywhere.
 */
export function transformAttribute(proto: object | undefined): 'native' | 'absent' {
  for (let p = proto; p; p = Object.getPrototypeOf(p) as object | undefined) {
    const d = Object.getOwnPropertyDescriptor(p, 'transform');
    if (d) return typeof d.get === 'function' ? 'native' : 'absent';
  }
  return 'absent';
}

/**
 * The engine's name and MAJOR version from a user agent (no device or build detail). A WKWebView's
 * agent carries no browser version, only the OS's, so it reads `iOS/N`; Safari reads `Safari/N`.
 */
export function engineFromUserAgent(ua: string): string {
  const chrome = /\b(?:Chrome|Chromium)\/(\d+)/.exec(ua);
  if (chrome) return `Chrome/${chrome[1]}`;
  const safari = /\bVersion\/(\d+)[^ ]* .*Safari\//.exec(ua);
  if (safari) return `Safari/${safari[1]}`;
  const ios = /\bOS (\d+)_\d+/.exec(ua);
  if (ios) return `iOS/${ios[1]}`;
  const firefox = /\bFirefox\/(\d+)/.exec(ua);
  if (firefox) return `Firefox/${firefox[1]}`;
  return '?';
}

/** Reads the engine facts from the running page. */
export function readE2eEngineFacts(): E2eEngineFacts {
  return {
    engine: typeof navigator === 'undefined' ? '?' : engineFromUserAgent(navigator.userAgent),
    senderAttr: transformAttribute(
      typeof RTCRtpSender === 'undefined' ? undefined : RTCRtpSender.prototype
    ),
    receiverAttr: transformAttribute(
      typeof RTCRtpReceiver === 'undefined' ? undefined : RTCRtpReceiver.prototype
    ),
  };
}

/** What a report says beyond its counts: a FAULT leads the line with `ERROR`, a NOTE does not. */
export interface E2eDiagnosis {
  level: 'fault' | 'note';
  text: string;
}

/**
 * The diagnosis a report carries, or `null` when the transform is plainly in the path.
 *
 * `judgeFrames` says whether a side with NO frame is a fault. It is, 5 s after `connected`: by
 * then each side has seen hundreds of audio frames. At the end of a call it is only when that 5 s
 * report was taken - a call hung up a second after connecting may legitimately have received
 * nothing, and its end report then states counts without accusing anything. Decided by WHICH
 * report ran, never by a clock.
 *
 * A missing native `transform` attribute is a fact about the engine; it is a fault only together
 * with a side that saw no frame. Fed transforms on such an engine are a note, not a verdict.
 */
export function diagnoseE2eReport(
  r: E2eWorkerReport,
  facts: E2eEngineFacts,
  judgeFrames = true
): E2eDiagnosis | null {
  const sender = r.framesIn.sender ?? 0;
  const receiver = r.framesIn.receiver ?? 0;
  const attrAbsent = facts.senderAttr === 'absent' || facts.receiverAttr === 'absent';
  if (!r.transformers.sender || !r.transformers.receiver) {
    return {
      level: 'fault',
      text: 'the engine never handed the worker a transformer for one side',
    };
  }
  if (r.opusInvalid.sender || r.opusInvalid.receiver || r.doubleEncrypted) {
    return { level: 'fault', text: 'non-Opus audio crossed the transform' };
  }
  const unfed =
    sender === 0 && receiver === 0
      ? 'no frame reached either transform'
      : sender === 0
        ? 'no frame reached the SENDER transform'
        : receiver === 0
          ? 'no frame reached the RECEIVER transform'
          : null;
  if (unfed && judgeFrames) {
    return {
      level: 'fault',
      text: attrAbsent
        ? `${unfed}, and this engine has no native transform attribute: the media may flow around the worker`
        : unfed,
    };
  }
  if (attrAbsent) {
    return {
      level: 'note',
      text:
        sender > 0 && receiver > 0
          ? 'this engine has no native transform attribute, yet both transforms were fed'
          : 'this engine has no native transform attribute',
    };
  }
  return null;
}

/**
 * The report as ONE log line; `ERROR` leads it when `diagnoseE2eReport` names a fault, and a
 * note is appended without it. `judgeFrames` as in `diagnoseE2eReport`.
 */
export function describeE2eReport(
  r: E2eWorkerReport,
  facts: E2eEngineFacts,
  judgeFrames = true
): string {
  const d = diagnoseE2eReport(r, facts, judgeFrames);
  const fault = d?.level === 'fault';
  const t = r.transformers;
  const f = r.framesIn;
  return (
    `[Call] ${fault ? 'ERROR ' : ''}E2E worker report (${r.tag}): ` +
    `transformers sender=${t.sender ?? 0} receiver=${t.receiver ?? 0} | ` +
    `frames in sender=${f.sender ?? 0} receiver=${f.receiver ?? 0} | ` +
    `encrypted audio=${r.encrypted.audio} video=${r.encrypted.video} | ` +
    `decrypted audio=${r.decrypted.audio} video=${r.decrypted.video} | ` +
    `decrypt-failed=${r.decryptFailures} short=${r.tooShort} (empty ${r.tooShortEmpty}) no-key=${r.droppedNoKey} ` +
    `not-opus sender=${r.opusInvalid.sender} receiver=${r.opusInvalid.receiver} double=${r.doubleEncrypted} | ` +
    `engine=${facts.engine} attr sender=${facts.senderAttr} receiver=${facts.receiverAttr}` +
    (d ? ` - ${d.text}` : '')
  );
}

/** The media kinds a call carries, each judged on its own (`e2eBypassedSides`). */
export type CallMediaKind = 'audio' | 'video';

/** One way media can miss the worker: a side and a kind, e.g. `sender:video`. */
export type E2eBypass = `${'sender' | 'receiver'}:${CallMediaKind}`;

/** RTP packets this peer connection sent and received, per media kind (`rtpPacketCounts`). */
export interface RtpPacketCounts {
  sent: Record<CallMediaKind, number>;
  received: Record<CallMediaKind, number>;
}

/** Sums `packetsSent` over the outbound RTP streams and `packetsReceived` over the inbound ones, per kind. */
export function rtpPacketCounts(stats: RTCStatsReport): RtpPacketCounts {
  const counts: RtpPacketCounts = {
    sent: { audio: 0, video: 0 },
    received: { audio: 0, video: 0 },
  };
  stats.forEach(
    (s: { type?: string; kind?: string; packetsSent?: number; packetsReceived?: number }) => {
      if (s.kind !== 'audio' && s.kind !== 'video') return;
      if (s.type === 'outbound-rtp') counts.sent[s.kind] += s.packetsSent ?? 0;
      if (s.type === 'inbound-rtp') counts.received[s.kind] += s.packetsReceived ?? 0;
    }
  );
  return counts;
}

/**
 * The frames the worker counted for ONE peer connection (`epoch`), one side and one kind - the
 * worker's `framesInBy`, keyed `<epoch>|<side>|<kind>` by `encryption.worker.ts`.
 */
export function framesFor(
  r: E2eWorkerReport,
  epoch: number,
  side: 'sender' | 'receiver',
  kind: CallMediaKind
): number {
  return r.framesInBy?.[`${epoch}|${side}|${kind}`] ?? 0;
}

/**
 * The side/kind pairs whose media crossed the network AROUND the E2E transform on the peer
 * connection `epoch`: packets of that kind went out while no sender transform of that peer
 * connection was handed a frame of it (clear media sent), or came in while no receiver transform
 * was (the other party's ciphertext fed to the decoder). Empty when every flowing kind went through
 * the worker, or when nothing flowed (nothing to prove either way).
 *
 * A PROOF from two counters, never a timeout - provided the packets were read BEFORE the frames:
 * a frame passes the sender transform before its packet leaves, and a received packet reaches the
 * receiver transform after it was counted, so frames read later can only be ahead. On Chromium a
 * short-circuited transform keeps its transformer and is simply never fed (CALL-E2E-BYPASS-MI9T,
 * 2026-10-20, measured on the Mi 9T's WebView 152 and desktop Chrome 155). Per KIND because a
 * camera added mid-call is its own sender, and can be short-circuited while the audio is not.
 */
export function e2eBypassedSides(
  r: E2eWorkerReport,
  packets: RtpPacketCounts,
  epoch: number
): E2eBypass[] {
  const out: E2eBypass[] = [];
  for (const kind of ['audio', 'video'] as const) {
    if (packets.sent[kind] > 0 && framesFor(r, epoch, 'sender', kind) === 0) {
      out.push(`sender:${kind}`);
    }
    if (packets.received[kind] > 0 && framesFor(r, epoch, 'receiver', kind) === 0) {
      out.push(`receiver:${kind}`);
    }
  }
  return out;
}
