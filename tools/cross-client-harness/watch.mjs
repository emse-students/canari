/**
 * Continuous observation of a client while a check runs: console, page errors, HTTP, WebSocket.
 *
 * WHY THIS IS PART OF EVERY CHECK, not a debugging aid. A check that only asserts its own outcome
 * answers "did the message arrive", never "did it arrive for the right reasons". A pass sitting on
 * top of a swallowed exception, a 4xx nobody reads, a request that should not have been made or a
 * silent ACK is worth nothing - WP-LOSS-1 is precisely a green-looking path with a dropped message
 * underneath it. So every runner attaches this, and reports the noise next to the verdict.
 *
 * Anything not on the expected list is surfaced verbatim rather than summarised: the whole point is
 * to see what was not predicted.
 */
import { evaluate } from './cdp.mjs';

/** Console text that is normal traffic on this app and carries no signal on its own. */
const BENIGN = [
  /^\[API\] (→|←)/,
  /^\[WS (RCV|SND)\]/,
  /^\[QUEUE\] (Drain (start|complete)|Processing message|messageCallback)/,
  /^\[OUTBOX\] (Queued|Flushing|[0-9a-f]{8}… sent)/,
  /^\[MLS\] (Disk writes deferred|Bulk ingest done|Encrypted state checkpoint persisted)/,
  /\[Channel Event\] typing/,
  /^\[RUST::INFO\]/,
  /^\[INIT\]/,
  /^\[PRESENCE\]/,
  /Loading\/Creating clean state/,
  /WasmMlsClient::new called/,
  /^\[SEND\] (handleSendChat|convo:|sendChatMessage)/,
  /^\[ADD_MSG\] . Message added/,
  /^\[Channel Event\] channel\.(typing|message\.created|message\.updated|read)/,
  /^\[PENDING\] No pending MLS messages/,
  /^\[HISTORY\]/,
  /^\[READ\]/,
  /^\[appLink\] In-app navigation/,
  // Cloudflare Page Shield "Script Monitor" injects its OWN report-only policy
  // (`script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; report-uri
  // .../cdn-cgi/script_monitor/report`) on top of ours, so EVERY fetch and the pdf.js worker log a
  // violation. Established 2026-08-06 from `securitypolicyviolation.originalPolicy`, after the
  // repo turned up no `Report-Only` anywhere - it is not ours and it enforces nothing. It leaks no
  // path Cloudflare does not already see: it is the TLS terminator for this site.
  // The ENFORCED policy is the one in the `content-security-policy` header, and it is sane.
  /violates the following Content Security Policy directive/,
];

/**
 * Requests whose failure is understood and carries no signal, so a NEW 4xx stands out.
 *
 * The avatar endpoint answers 404 with a JSON body and `nosniff`, which Chrome's Opaque Response
 * Blocking then refuses to hand to the `<img>` that asked for it - hence 404, ERR_BLOCKED_BY_ORB
 * and ERR_ABORTED all naming the same URL. The UI falls back to initials, so nothing is broken; it
 * is listed rather than ignored so that the day a DIFFERENT endpoint 4xxes, the run goes dirty.
 */
const BENIGN_HTTP = [/\/api\/users\/[0-9a-f]{64}\/avatar$/];

/**
 * Lines that are NOT errors but must never be filed as routine, because they mean the client
 * changed state under the check's feet - a reconnect mid-measurement can explain a latency, a
 * missing frame, or a "pass" that only happened on the second try.
 */
const STATE_CHANGE = [
  /Connecting to Gateway|Connected to Chat Gateway|Connected to network|Disconnected|reconnect/i,
  /token refresh|refreshed|logged out|session/i,
];

/** Console text that must be reported even though it is not an error - it means something happened. */
const NOTABLE = [
  /SecretReuse|out of bounds|Duplicate|silent ACK|ACK silencieux/i,
  /epoch|GAP|out-?of-?sync|re-?add|welcome_request/i,
  /forget|revoke|reset|corrupt/i,
  /decrypt(ion)? (error|failed)/i,
];

/** Attaches every observation domain. Call before the action, not after. */
export async function watch(cx, label) {
  await cx.send('Runtime.enable');
  await cx.send('Log.enable');
  await cx.send('Network.enable');
  cx.events.length = 0;
  return { cx, label, since: Date.now() };
}

/** Drains what was observed and classifies it. */
export async function report(w) {
  const { cx, label } = w;
  const reqs = new Map();
  const console_ = [];
  const ws = [];
  const exceptions = [];

  for (const e of cx.events) {
    const p = e.params;
    switch (e.method) {
      case 'Network.requestWillBeSent':
        reqs.set(p.requestId, { url: p.request.url, method: p.request.method });
        break;
      case 'Network.responseReceived': {
        const r = reqs.get(p.requestId);
        if (r) r.status = p.response.status;
        break;
      }
      case 'Network.loadingFailed': {
        const r = reqs.get(p.requestId);
        if (r) r.failed = p.errorText;
        break;
      }
      case 'Network.webSocketFrameError':
      case 'Network.webSocketClosed':
        ws.push(`${e.method} ${JSON.stringify(p).slice(0, 140)}`);
        break;
      case 'Runtime.exceptionThrown':
        exceptions.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 300));
        break;
      case 'Runtime.consoleAPICalled':
        console_.push({ level: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
        break;
      case 'Log.entryAdded':
        // Keep `url`: a browser "Failed to load resource" line names the status but not the
        // resource, so without it a benign avatar 404 is indistinguishable from a real one.
        console_.push({ level: p.entry.level, text: p.entry.text.slice(0, 300), url: p.entry.url });
        break;
    }
  }
  cx.events.length = 0;

  // De-duplicate: Log.entryAdded and consoleAPICalled surface the same line twice.
  const seen = new Set();
  const lines = console_.filter((l) => {
    const k = `${l.level}|${l.text.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const strip = (t) => t.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '');
  const isBenignUrl = (u) => {
    if (!u) return false;
    try {
      return BENIGN_HTTP.some((re) => re.test(new URL(u).pathname));
    } catch {
      return false;
    }
  };
  const errors = lines.filter(
    (l) => (l.level === 'error' || l.level === 'assert') && !isBenignUrl(l.url)
  );
  const warnings = lines.filter((l) => l.level === 'warning' || l.level === 'warn');
  const notable = lines.filter((l) => NOTABLE.some((r) => r.test(l.text)));
  const stateChanges = lines.filter((l) => STATE_CHANGE.some((r) => r.test(l.text)) && !notable.includes(l));
  const unexplained = lines.filter(
    (l) =>
      !BENIGN.some((r) => r.test(strip(l.text))) &&
      !isBenignUrl(l.url) &&
      !errors.includes(l) &&
      !warnings.includes(l) &&
      !notable.includes(l) &&
      !stateChanges.includes(l)
  );

  const http = [...reqs.values()].filter((r) => !/\.(js|css|woff2?|png|svg|jpg|jpeg|ico|webp)(\?|$)/.test(r.url) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const failing = http.filter((r) => r.failed || (r.status && r.status >= 400));
  const badHttp = failing.filter((r) => !BENIGN_HTTP.some((re) => re.test(new URL(r.url).pathname)));
  const knownBadHttp = failing.filter((r) => !badHttp.includes(r));

  return {
    label,
    clean: errors.length === 0 && badHttp.length === 0 && exceptions.length === 0 && ws.length === 0,
    errors: errors.map((l) => l.text),
    exceptions,
    badHttp: badHttp.map((r) => `${r.method} ${r.url.replace('https://canari-emse.fr', '')} -> ${r.status ?? r.failed}`),
    knownBadHttp: knownBadHttp.map((r) => `${r.method} ${r.url.replace('https://canari-emse.fr', '')} -> ${r.status ?? r.failed}`),
    wsEvents: ws,
    warnings: warnings.map((l) => l.text),
    notable: notable.map((l) => l.text),
    stateChanges: stateChanges.map((l) => l.text),
    unexplained: unexplained.map((l) => `${l.level}: ${l.text}`),
    httpCount: http.length,
    consoleCount: lines.length,
  };
}

/**
 * The phone's logcat since a wall-clock instant, over the SAME 19-tag whitelist as `test_adb.py`.
 *
 * The tag list is not decoration: `*:S` silences everything else, so a tag missing here is a line
 * that can never arrive - and a check whose verdict lives on that line can never pass. Kept in sync
 * with `docs/wiki/device-verification.md`.
 */
const LOGCAT_TAGS = [
  'mines_app_lib:D', 'CanariRust:D', 'CanariFCM:D', 'CanariWorker:D', 'CanariApp:D', 'CanariBoot:D',
  'CanariNotifAction:D', 'CanariOutboxRetry:D', 'MlsDeviceKeyStore:D', 'PushSecretKeystore:D',
  'KeyboardMedia:D', 'fr.emse.canari:D', 'chromium:I', 'Tauri/Console:V', 'MainActivity:D',
  'FirebaseMessaging:W', 'WM-WorkerWrapper:W', 'AndroidRuntime:E', 'System.err:W',
];

/**
 * The phone's adb serial, RESOLVED rather than hard-coded.
 *
 * Its DHCP lease changes between sessions (it has already moved subnet once), so a literal address
 * turns every logcat call into `LOGCAT UNAVAILABLE` - and a check whose verdict lives on a logcat
 * line then fails for a reason that has nothing to do with the app. The wireless entry is preferred
 * because USB drops on this device mid-capture; USB is only the fallback that lets a run start.
 */
import { execFileSync as execSync_ } from 'node:child_process';

function resolveSerial() {
  try {
    const lines = execSync_('adb', ['devices'], { encoding: 'utf8', timeout: 10000 })
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[1] === 'device')
      .map((p) => p[0]);
    return lines.find((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) ?? lines[0] ?? null;
  } catch {
    return null;
  }
}

export const A1_SERIAL = resolveSerial();

export async function logcatSince(sinceMs) {
  const { execFileSync } = await import('node:child_process');
  if (!A1_SERIAL) return ['LOGCAT UNAVAILABLE: no adb device attached'];
  // logcat -T wants "MM-DD hh:mm:ss.mmm" in the DEVICE's local time, not ISO and not UTC.
  const d = new Date(sinceMs - 1500);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.000`;
  try {
    const out = execFileSync('adb', ['-s', A1_SERIAL, 'logcat', '-d', '-T', stamp, '*:S', ...LOGCAT_TAGS], {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('---------'));
  } catch (e) {
    return [`LOGCAT UNAVAILABLE: ${String(e.message).slice(0, 160)}`];
  }
}

/** Logcat lines that are a real signal rather than routine chatter. */
export function logcatNotable(lines) {
  // A bare /E/i would match almost every line - logcat's severity column is a lone letter,
  // so it has to be anchored as a word.
  return lines.filter((l) =>
    /\bE\b|FATAL|Exception|panic|SecretReuse|out of bounds|epoch|GAP|decrypt|fail|error/i.test(l)
  );
}

/** True when the page is in a state where a check's result would be meaningless. */
export async function sanity(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify({
        visibility: document.visibilityState,
        online: navigator.onLine,
        locked: document.body.innerText.indexOf('PIN de chiffrement') !== -1,
        offlineBanner: document.body.innerText.indexOf('Hors-ligne') !== -1,
        url: location.pathname
      })`,
    ),
  );
}
