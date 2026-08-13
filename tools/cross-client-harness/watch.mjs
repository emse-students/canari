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
  // The outbox accepting a message locally, and the key-package top-up every boot performs. Both are
  // the success path of checks that already assert their outcome directly.
  /^\[SEND\] [0-9a-f]{8}\S* (queued|sent)/,
  /generateKeyPackage|KeyPackage published/,
  /^\[ADD_MSG\] . Message added/,
  /^\[Channel Event\] channel\.(typing|message\.created|message\.updated|read)/,
  /^\[PENDING\] No pending MLS messages/,
  /^\[HISTORY\]/,
  /^\[READ\]/,
  /^\[appLink\] In-app navigation/,
  // A message being decrypted and handed to the chat is the SUCCESS path of every check in this
  // campaign, and it was landing in `unexplained` - so a clean run reported dirt and every verdict
  // came back PASS-DIRTY. Dirt that is always present is dirt nobody reads, which is worse than
  // none: the observation half of the rule ("a verdict is PASS only if the run is clean") stops
  // discriminating. NOT widened to all of `[MLS]`, because a decrypt FAILURE must still surface -
  // `NOTABLE` catches those, and it is evaluated first.
  /^\[MLS\] Message decrypted for [0-9a-f]{8}/,
  // pdf.js says this for any PDF without a cross-reference table. It is a property of the fixture,
  // not of the application, and it fires on every MSG-4 run.
  /Indexing all PDF objects/,
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
 * Failures that are understood and carry no signal, so a NEW one stands out.
 *
 * A PATH IS NOT ENOUGH - THE STATUS IS PART OF WHAT IS FORGIVEN. This used to be a bare list of
 * paths, and that forgives every way an endpoint can fail rather than the one that was understood.
 * `avatar.service.ts` proves it matters: it answers 404 only when the upstream gallery answers 404
 * (the user genuinely has no avatar, which is the benign case), and answers **502** when the
 * outbound fetch times out - measured on prod 2026-08-13, seventeen `[AvatarService] Error fetching
 * avatar` blocks in one five-minute run. A path-only rule filed that server fault as routine.
 *
 * The 404 itself carries a JSON body and `nosniff`, which Chrome's Opaque Response Blocking then
 * refuses to hand to the `<img>` that asked for it - hence 404, ERR_BLOCKED_BY_ORB and ERR_ABORTED
 * all naming the same URL. The UI falls back to initials, so nothing is broken. It is listed rather
 * than ignored so it still shows up under `knownBadHttp`.
 */
const BENIGN_HTTP = [{ path: /\/api\/users\/[0-9a-f]{64}\/avatar$/, status: [404] }];

/** True when this exact (path, status) pair is one of the understood failures. */
const isBenignFailure = (pathname, status) =>
  BENIGN_HTTP.some((b) => b.path.test(pathname) && b.status.includes(Number(status)));

/**
 * Lines that are NOT errors but must never be filed as routine, because they mean the client
 * changed state under the check's feet - a reconnect mid-measurement can explain a latency, a
 * missing frame, or a "pass" that only happened on the second try.
 */
const STATE_CHANGE = [
  /Connecting to Gateway|Connected to Chat Gateway|Connected to network|Disconnected|reconnect/i,
  /token refresh|refreshed|logged out|session/i,
  // The app's own connectivity verdict and its retry ladder. Not errors, and not routine either:
  // either one appearing in a check that cut NOTHING means the link moved under the measurement.
  /^\[CONNECTIVITY\]|Connection lost\. Retrying/,
];

/**
 * NOTABLE LINES THAT ARE DEFECTS, not merely events - these break `clean`.
 *
 * `notable` was reported next to the verdict and counted for nothing, and on 2026-08-13 that cost
 * two runs: MSG-6 recorded `PASS` with `receiverClean: true` while its own record carried
 * `Ciphertext generation out of bounds 296 / SecretReuseError / [MLS] LOST frame`. A LOST FRAME is
 * the single most serious thing this campaign can see - it is the entire subject of WP-LOSS-1 and
 * WP-FALSELOSS-1 - and it read as a clean pass twice before a run happened to lose the message the
 * check was actually measuring.
 *
 * Kept separate from `errors` because these arrive as ordinary `console.log` at whatever level the
 * app chose; severity here is about WHAT THE LINE SAYS, not how it was printed. Everything else in
 * `NOTABLE` stays informational: an epoch change or a `welcome_request` is the protocol working.
 */
/**
 * THE VERDICT IS THE CLASSIFIER'S LINE, NOT THE RAW FAILURE UNDER IT.
 *
 * `mls-core` reports the decrypt failure (`Ciphertext generation out of bounds N`,
 * `SecretReuseError`, `MLS decryption failed: ...`) BELOW the layer entitled to say what it means.
 * The TS side then classifies it, and every branch of that classification logs: a duplicate the
 * ledger recognises, a frame nobody has read, a generation gap, or a fall-through to a re-add. So
 * the raw line is EVIDENCE and the line after it is the finding - matching the evidence made the
 * gate fire on the benign case, which is how a rule stops being read.
 *
 * This list is therefore the app asserting a loss, in the app's own words.
 */
const SEVERE = [
  /\[MLS\] LOST frame/i,
  /\[MLS\] Decryption error/i,
  /\[History\] frame never read here and unreadable for good/i,
  /\[History\] permanently undecryptable/i,
];

/** The raw, lower-layer decrypt failure - evidence for a finding, never a finding by itself. */
const RAW_DECRYPT_FAILURE = /SecretReuse|generation out of bounds|MLS decryption failed/i;

/**
 * Lines proving the classifier ran and reached a conclusion about a failed decrypt.
 *
 * WITHOUT THIS THE DEMOTION ABOVE WOULD BE A HOLE. If a decrypt failure ever arrives that nothing
 * classifies - a new error string, a branch that returns without logging - it would land in
 * `notable`, which does not break `clean`, and the run would go green over an unexplained failure.
 * So a raw failure with NO classification anywhere in the window is severe on its own: the evidence
 * is only demoted while something is shown to have judged it.
 */
const DECRYPT_CLASSIFIED = [
  /\[MLS\] (LOST frame|Duplicate delivery|Decryption error|No application payload)/i,
  /\[History\] (frame never read here|permanently undecryptable|retryable)/i,
  /\[GAP\]/i,
];

/**
 * Decrypt failures that are the PROTOCOL, not a defect.
 *
 * `CannotDecryptOwnMessage` is RFC 9420 working: a member cannot decrypt its own application
 * message, which is exactly why the sender's optimistic render is that message's only writer
 * (the whole subject of WP-ECHO-1). It is logged at `RUST::DEBUG` on every single send, so leaving
 * it inside `SEVERE` marked every media check dirty on the first run the gate existed - a rule that
 * fires on the normal path teaches its reader to ignore it.
 */
const SEVERE_BUT_EXPECTED = /CannotDecryptOwnMessage/i;

/** Console text that must be reported even though it is not an error - it means something happened. */
const NOTABLE = [
  /SecretReuse|out of bounds|Duplicate|silent ACK|ACK silencieux/i,
  /epoch|GAP|out-?of-?sync|re-?add|welcome_request/i,
  // PEER RECONCILIATION, WHICH IS NOT THE SAME THING AS READING THE MAILBOX. `GET
  // /api/mls/history/<groupId>` is a client fetching its OWN ciphertexts from the server and happens
  // on every conversation open; `history_request` is a client asking ANOTHER DEVICE to resend what
  // it is missing, and it only ever fires on a manifest desync - an unreadable frame, a replay that
  // gave up, a retention gap, a returning peer, the one-shot audit. None of those is part of sending
  // and receiving a message, so in a delivery check its presence is itself the finding: something
  // decided this device was out of sync. Never `clean`-breaking (a legitimate trigger must not fail
  // an unrelated check) but never silent either.
  //
  // The PROTOCOL's own five frame names, not the `[SYNC]` tag they are logged under: that tag also
  // carries group creation, bulk member addition and the WASM purge, so matching it would report
  // routine group work as a reconciliation and the signal would stop being read within one run.
  /history_(request|bundle|digest|digest_request|pull)|\[HISTORY_RECONCILE\]/i,
  // A reconciliation that actually DELIVERED something, which the line above does not cover: that one
  // says a device decided it was out of sync, this one says a peer answered and the gap closed. It
  // was landing in `unexplained`, and it is the opposite of unexplained - it is the repair reporting
  // success, and in a delivery check its presence means something was already missing before the
  // check started.
  /message\(s\) caught up/i,
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

/**
 * EVERY console line the page emitted since `watch()`, unfiltered and unclassified.
 *
 * This exists as a shared export because its absence produced a false observation on 2026-08-11: a
 * probe reached for `report(...).lines`, which `report` has never returned - it returns `notable`,
 * `warnings`, `errors`, `unexplained`, never `lines`. The filter therefore ran over `undefined`,
 * reported "0 history lines", and was nearly written up as a fact about the application.
 * `heal-w2.mjs` had the correct implementation all along, privately, where nothing else could
 * reach it.
 *
 * Use this whenever a verdict needs the RAW log. `report` is the CLASSIFIER; a verdict must never
 * be computed over a projection of its own evidence.
 */
export function consoleLines(cx) {
  return cx.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    .map((e) =>
      (e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      ).slice(0, 260)
    );
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
  /**
   * A console line about a request whose failure is understood - path AND status both.
   *
   * The status has to be read out of the TEXT here, because a `Log.entryAdded` carries the url as a
   * field and the status only inside "the server responded with a status of 404". The blocked and
   * aborted variants carry no status at all: they are Chrome's own reaction to the 404 body being
   * `nosniff`, so they are forgiven on the same path - and nothing else is. A 502 from the same
   * endpoint reads as an error, which is the point of the change.
   */
  const isBenignUrl = (u, text = '') => {
    if (!u) return false;
    try {
      const { pathname } = new URL(u);
      return BENIGN_HTTP.some(
        (b) =>
          b.path.test(pathname) &&
          (b.status.some((s) => text.includes(String(s))) ||
            /ERR_BLOCKED_BY_ORB|ERR_ABORTED/.test(text))
      );
    } catch {
      return false;
    }
  };
  const errors = lines.filter(
    (l) => (l.level === 'error' || l.level === 'assert') && !isBenignUrl(l.url, l.text)
  );
  const warnings = lines.filter((l) => l.level === 'warning' || l.level === 'warn');
  const notable = lines.filter((l) => NOTABLE.some((r) => r.test(l.text)));
  const classified = lines.filter(
    (l) => DECRYPT_CLASSIFIED.some((r) => r.test(l.text)) && !SEVERE_BUT_EXPECTED.test(l.text)
  );
  const severe = lines.filter(
    (l) =>
      !SEVERE_BUT_EXPECTED.test(l.text) &&
      (SEVERE.some((r) => r.test(l.text)) ||
        // A raw failure nothing judged. See DECRYPT_CLASSIFIED: the demotion holds only while the
        // classifier is shown to be running, or the gate would go quiet on the one case it is for.
        (classified.length === 0 && RAW_DECRYPT_FAILURE.test(l.text)))
  );
  const stateChanges = lines.filter((l) => STATE_CHANGE.some((r) => r.test(l.text)) && !notable.includes(l));
  const unexplained = lines.filter(
    (l) =>
      !BENIGN.some((r) => r.test(strip(l.text))) &&
      !isBenignUrl(l.url, l.text) &&
      !errors.includes(l) &&
      !warnings.includes(l) &&
      !notable.includes(l) &&
      !stateChanges.includes(l)
  );

  const http = [...reqs.values()].filter((r) => !/\.(js|css|woff2?|png|svg|jpg|jpeg|ico|webp)(\?|$)/.test(r.url) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const failing = http.filter((r) => r.failed || (r.status && r.status >= 400));
  // A transport failure (`r.failed`, no status) on a benign path is Chrome's ORB refusing the 404
  // body it was handed; anything carrying a status is judged on that status, so a 502 from the same
  // endpoint goes to `badHttp` where a path-only rule used to swallow it.
  const badHttp = failing.filter(
    (r) => !isBenignFailure(new URL(r.url).pathname, r.status ?? 404)
  );
  const knownBadHttp = failing.filter((r) => !badHttp.includes(r));

  return {
    label,
    clean:
      errors.length === 0 &&
      badHttp.length === 0 &&
      exceptions.length === 0 &&
      ws.length === 0 &&
      severe.length === 0,
    severe: severe.map((l) => l.text),
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

/** What a DELIBERATE network cut makes a healthy client say. Nothing here is a defect on its own. */
const OFFLINE_NOISE =
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|Failed to fetch|NetworkError|server unreachable \(transport failure\)/i;

/**
 * The app's OWN reaction to a cut, which is a different set of lines from the browser's.
 *
 * A client whose socket has just died retries, and the retry fails while the emulation is on: that
 * is the reconnect logic working exactly as designed. These are forgiven only under
 * {@link ignoringOfflineCut} - outside a deliberate cut, `[WS] Gateway connection failed` is one of
 * the more serious things this campaign can see, and it must stay an error there.
 */
// NOT anchored on the word "failed": that line carries the whole socket URL, token included, and
// `report` truncates at 300 characters - so the verb never survives to be matched. Matching the
// SUBJECT instead is both shorter and immune to the truncation.
const CUT_REACTION =
  /WebSocket connection to '?wss?:|\[WS\] WebSocket error|\[WS\] Gateway connection failed|Connection lost\. Retrying|\[OUTBOX\] \S+ transient failure/i;

/**
 * WHY a report is not clean, as one object - and `{}` when it is clean.
 *
 * A RECORD SAYING `clean: false` AND NOTHING ELSE IS THE INSTRUMENT REFUSING TO ANSWER. MSG-10
 * reported a dirty sender on 2026-08-14 with `senderSevere: []` and `senderErrors: []` beside it,
 * because the two buckets it happened to keep were not the two that had broken the verdict - so the
 * only way to learn what it saw was to re-run it, which is the definition of a result that cannot be
 * believed. Every bucket that can break `clean` belongs in the record, and each check listing them by
 * hand is how they drift apart, so they are listed HERE, once, next to the definition of `clean`.
 *
 * Only the non-empty ones: a clean run records `{}` rather than five empty arrays nobody reads.
 */
export function dirtOf(rep) {
  const out = {};
  for (const bucket of ['severe', 'errors', 'exceptions', 'badHttp', 'wsEvents'])
    if (rep?.[bucket]?.length) out[bucket] = rep[bucket];
  return out;
}

/**
 * The same report with the CUT's own consequences removed, and `clean` recomputed over the rest.
 *
 * ONLY for a client this check deliberately took offline, and only over the window in which it was.
 * MSG-9 and MSG-10 cut a client on purpose; the disconnected fetches, the closed socket and the
 * app's own "server unreachable" line that follow are the cut working, not the app failing. Left in,
 * they made those two checks permanently dirty - and dirt that is always there is dirt nobody reads,
 * which is how the observation half of the campaign's rule stops discriminating.
 *
 * `exceptions` are NOT forgiven: a network cut is a condition the app is required to handle, and an
 * unhandled rejection during one is a real defect. Nor is anything in `notable` or `unexplained`.
 */
export function ignoringOfflineCut(rep) {
  const expected = (t) => OFFLINE_NOISE.test(t) || CUT_REACTION.test(t);
  const errors = rep.errors.filter((t) => !expected(t));
  const badHttp = rep.badHttp.filter((t) => !expected(t));
  // `warnings` and `unexplained` are filtered too, though neither breaks `clean`: a reader is
  // supposed to be able to say what every line is BEFORE seeing it, and thirty lines of "Failed to
  // fetch" from a cut this check performed is the fastest way to make that impossible.
  const warnings = rep.warnings.filter((t) => !expected(t));
  const unexplained = rep.unexplained.filter((t) => !expected(t));
  return {
    ...rep,
    errors,
    badHttp,
    warnings,
    unexplained,
    wsEvents: [],
    // `severe` is NOT forgiven by a cut either: a lost frame is a lost frame whatever the link did.
    clean:
      errors.length === 0 &&
      badHttp.length === 0 &&
      rep.exceptions.length === 0 &&
      rep.severe.length === 0,
    ignoredAsTheCut: {
      errors: rep.errors.length - errors.length,
      badHttp: rep.badHttp.length - badHttp.length,
      warnings: rep.warnings.length - warnings.length,
      unexplained: rep.unexplained.length - unexplained.length,
      wsEvents: rep.wsEvents.length,
    },
  };
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
