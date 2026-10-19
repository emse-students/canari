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
  /** e.g. `Chrome/152`, `Safari/26`, or `?` - the major version only. */
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

/** The engine's name and MAJOR version from a user agent (no device or build detail). */
export function engineFromUserAgent(ua: string): string {
  const chrome = /\b(?:Chrome|Chromium)\/(\d+)/.exec(ua);
  if (chrome) return `Chrome/${chrome[1]}`;
  const webkit = /\bVersion\/(\d+)[^ ]* .*Safari\//.exec(ua) ?? /\bOS (\d+)_\d+/.exec(ua);
  if (webkit) return `WebKit/${webkit[1]}`;
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

/**
 * The diagnosis a report carries, or `null` when the transform is plainly in the path. Read at
 * 5 s after `connected` and at the end: by then each side has seen hundreds of audio frames.
 */
export function diagnoseE2eReport(r: E2eWorkerReport, facts: E2eEngineFacts): string | null {
  const sender = r.framesIn.sender ?? 0;
  const receiver = r.framesIn.receiver ?? 0;
  if (facts.senderAttr === 'absent' || facts.receiverAttr === 'absent') {
    return 'this engine has no native transform attribute: media bypasses the worker (clear out, ciphertext in)';
  }
  if (!r.transformers.sender || !r.transformers.receiver) {
    return 'the engine never handed the worker a transformer for one side';
  }
  if (sender === 0 && receiver === 0) {
    return 'no frame reached either transform: the media bypasses or stalls before the worker';
  }
  if (sender === 0) return 'no frame reached the SENDER transform';
  if (receiver === 0) return 'no frame reached the RECEIVER transform';
  if (r.opusInvalid.sender || r.opusInvalid.receiver || r.doubleEncrypted) {
    return 'non-Opus audio crossed the transform';
  }
  return null;
}

/** The report as ONE log line; `ERROR` leads it when `diagnoseE2eReport` names a fault. */
export function describeE2eReport(r: E2eWorkerReport, facts: E2eEngineFacts): string {
  const fault = diagnoseE2eReport(r, facts);
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
    (fault ? ` - ${fault}` : '')
  );
}
