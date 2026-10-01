/**
 * THE iPHONE ADAPTER KEEPS THE ANDROID PHONE'S CONTRACT - pinned with no phone, no WDA and no names.mjs.
 *
 * `phone-ios.mjs` stands in for `phone.mjs` under `CANARI_PHONE=ios` (`phone-any.mjs`). A row written
 * against one is run against the other, so three things are asserted here:
 *
 *   1. EVERY NAME `phone.mjs` EXPORTS, `phone-ios.mjs` EXPORTS, WITH THE SAME SYNC/ASYNC SHAPE. Read
 *      out of `phone.mjs`'s SOURCE, because importing it reaches the gitignored `names.mjs`. The shape
 *      matters more than the name: rows write `if (phone.pid() === null)`, and an async `pid()` returns
 *      a Promise - never null - so every death would read as a live process, with no error anywhere.
 *   2. EVERY DECISION THE ADAPTER TAKES, driven through injected transports: the state ladder of
 *      `pid`/`procState`, the kill-and-prove loop, the Notification Center freshness floor, the
 *      three outcomes of `tapNotification`, `ensure`'s refusals, the syslog mark.
 *   3. THE iPHONE'S CONSOLE REACHES THE CLASSIFIER (`webkit-console.mjs`): a WebKit error line makes
 *      the window NOT clean. Without it every iPhone window would be clean by construction.
 *   4. THE PARSERS against the shapes they expect. Those shapes are the EXPECTED ones - nothing here
 *      has read a live iPhone yet - and the first live read re-pins them (docs/wiki/cross-client-ios.md).
 */
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// The capture file is read at import: point it into a scratch directory first.
const SCRATCH = mkdtempSync(join(tmpdir(), 'phone-ios-selftest-'));
process.env.IOS_SYSLOG_FILE = join(SCRATCH, 'syslog.log');

const ios = await import('../phone-ios.mjs');
const { phonePlatform, isIosName } = await import('../phone-platform.mjs');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
}

// --- 1. The contract ------------------------------------------------------------------------------

/** `name -> 'async' | 'sync' | 'value'` for every export of a module, read from its source. */
function exportsOf(file, seen = new Set()) {
  const src = readFileSync(file, 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/^export (async )?function (\w+)/gm)) out.set(m[2], m[1] ? 'async' : 'sync');
  // `(?!\()`: `= (() => ...)()` is an IIFE, whose RESULT is the export - a value, not a function.
  for (const m of src.matchAll(/^export (?:const|let) (\w+) = (async )?(\((?!\()|\w+ =>|function)?/gm)) {
    out.set(m[1], m[3] ? (m[2] ? 'async' : 'sync') : 'value');
  }
  // `export { a, b }` - the kind comes from wherever the name was imported from.
  for (const m of src.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const from = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '(\\./[^']+)'`).exec(src);
      if (from && !seen.has(from[1])) {
        const kinds = exportsOf(resolve(dirname(file), from[1]), new Set([...seen, from[1]]));
        out.set(name, kinds.get(name) ?? 'value');
      } else out.set(name, 'value');
    }
  }
  return out;
}

const kindOf = (v) =>
  typeof v !== 'function' ? 'value' : v.constructor.name === 'AsyncFunction' ? 'async' : 'sync';

const android = exportsOf(join(ROOT, 'phone.mjs'));
check(`phone.mjs exports were read (${android.size})`, android.size >= 35, `only ${android.size}`);
for (const [name, kind] of android) {
  if (!(name in ios)) {
    check(`phone-ios exports ${name}`, false, 'missing - a row calling it would die at the call');
    continue;
  }
  const got = kindOf(ios[name]);
  // A class is a function to `typeof`; none of phone.mjs's exports is one, so `value` vs `sync` only
  // ever means a constant on one side and a function on the other.
  check(`${name}: ${kind} on both`, got === kind, `Android ${kind}, iPhone ${got}`);
}

// --- 2. The platform switch -------------------------------------------------------------------------

check('CANARI_PHONE unset is android', phonePlatform(undefined) === 'android');
check('CANARI_PHONE empty is android', phonePlatform('') === 'android');
check('CANARI_PHONE=IOS is ios', phonePlatform('IOS') === 'ios');
let refused = null;
try {
  phonePlatform('iphone');
} catch (e) {
  refused = e.message;
}
check('an unknown platform is REFUSED, never read as android', /names no phone platform/.test(refused ?? ''));
check('I1 is an iPhone name, A1 and W1 are not', isIosName('I1') && !isIosName('A1') && !isIosName('W1'));

// --- 3. Transports, faked ---------------------------------------------------------------------------

/** A scripted iPhone: answers `ios.mjs` commands from mutable state, and records every call. */
function fakePhone(init = {}) {
  const s = { state: 4, active: { bundleId: ios.PKG, pid: 4242 }, locked: false, flat: [], calls: [], clock: 1_000, targets: [], ...init };
  const restore = ios.__setIo({
    ios(args) {
      s.calls.push(args.join(' '));
      switch (args[0]) {
        case 'state':
          return String(s.state);
        case 'active':
          return JSON.stringify(s.state === 4 ? s.active : { bundleId: 'com.apple.springboard', pid: 1 });
        case 'locked':
          if (s.locked === 'error') throw new Error('WDA down');
          return JSON.stringify(s.locked);
        case 'unlock':
          s.locked = false;
          return '';
        case 'button':
          if (s.state === 4) s.state = 3;
          return '';
        case 'launch':
          s.state = 4;
          return '';
        case 'terminate':
          s.state = 1;
          return '';
        case 'size':
          return JSON.stringify({ width: 390, height: 844 });
        case 'flat':
          if (s.flat === 'error') throw new Error('source failed');
          return JSON.stringify(typeof s.flat === 'function' ? s.flat() : s.flat);
        default:
          return '';
      }
    },
    http: () => JSON.stringify(s.targets),
    now: () => s.clock,
    sleepSync: () => {},
    sleep: async (ms) => {
      s.clock += ms;
      // iOS suspends a backgrounded app after a while.
      if (s.state === 3) s.state = 2;
    },
    startCapture: () => 99999,
    alive: () => false,
  });
  return { s, restore };
}

{
  const { s, restore } = fakePhone({ state: 1 });
  check('pid: a dead app is null', ios.pid() === null);
  s.state = 4;
  check('pid: the app in front is its real pid', ios.pid() === '4242');
  s.state = 2;
  check('pid: a suspended app is alive and says why it has no number', ios.pid() === 'ios-state-2');
  check('procState: suspended is the cached analogue', ios.procState() === 'IOS_SUSPENDED');
  s.state = 1;
  check('procState: dead is null, as on Android', ios.procState() === null);
  restore();
}
{
  const restore = ios.__setIo({
    ios() {
      throw new Error('WDA down');
    },
  });
  check('pid: WDA unreachable is null, never a live process', ios.pid() === null);
  check('deviceLocked: WDA unreachable is null - "do not know", never "unlocked"', ios.deviceLocked() === null);
  restore();
}
{
  const { s, restore } = fakePhone({ state: 4 });
  const r = await ios.killAndProveDead();
  check('killAndProveDead: kills FROM SUSPENDED, by terminate, and proves it', r.stateAtKill === 'IOS_SUSPENDED' && s.state === 1, JSON.stringify(r));
  check('killAndProveDead: never the switcher swipe', !s.calls.some((c) => c.startsWith('swipe')));
  restore();
}

// --- 4. Notification Center ------------------------------------------------------------------------

const rect = (y) => ({ x: 8, y, width: 374, height: 80 });
const OLD = { type: 'XCUIElementTypeButton', text: 'Canari, Paul Peer, an old one OLD-1, il y a 5 min | Canari, Paul Peer, an old one OLD-1, il y a 5 min', rect: rect(120) };
const NEW = { type: 'XCUIElementTypeButton', text: 'Canari, Paul Peer, hello NEW-7, maintenant', rect: rect(220) };
const OTHER = { type: 'XCUIElementTypeButton', text: 'Messages, Bob, NEW-7 is in another app, now', rect: rect(320) };
const GENERIC = { type: 'XCUIElementTypeButton', text: 'Canari, Canari, Nouveau message de Paul, maintenant', rect: rect(420) };

{
  const parsed = ios.parseNotificationCenter([OLD, NEW, OTHER, { text: 'Canari, now, Owner, a, b, c', rect: rect(9) }]);
  check('parse: only Canari notifications, each once', parsed.length === 3, JSON.stringify(parsed.map((p) => p.full)));
  check('parse: the time is dropped wherever it sits', parsed[1].title === 'Paul Peer' && parsed[1].body === 'hello NEW-7');
  check('parse: a body with commas stays whole', parsed[2].title === 'Owner' && parsed[2].body === 'a, b, c');
  check('parse: the record has phone.mjs fields', ['full', 'text', 'title', 'body', 'channel', 'key', 'updatedAt'].every((k) => k in parsed[0]));
  check('bodyIsDrawn: the tree IS the screen', ios.bodyIsDrawn(parsed[0]) === true);
}
{
  const { s, restore } = fakePhone({ state: 1, flat: [OLD] });
  const floor = ios.deviceNowMs();
  check('deviceNowMs: the host clock', floor === 1_000);
  check('deviceNowMs: opens and closes the centre', s.calls.filter((c) => c.startsWith('swipe')).length === 2);
  check('awaitNotification: a notification already there does not count', (await ios.awaitNotification('OLD-1', 10_000, floor)) === null);
  let n = 0;
  s.flat = () => (++n >= 3 ? [OLD, NEW] : [OLD]);
  const took = await ios.awaitNotification('NEW-7', 45_000, floor);
  check('awaitNotification: a new one counts, with the time it took', typeof took === 'number' && took > 0, String(took));
  check('awaitNotification: the app was never launched by reading the centre', !s.calls.some((c) => c.startsWith('launch')));
  restore();
}
{
  const { s, restore } = fakePhone({ state: 1, flat: [OLD, NEW] });
  const t = ios.tapNotification('NEW-7');
  check('tapNotification: taps the centre of the element, in points', t.ok && s.calls.includes('tap 195,260'), JSON.stringify(t));
  const miss = ios.tapNotification('ABSENT');
  check('tapNotification: absent is found:false, an ANSWER', miss.ok === false && miss.dumped === true && miss.found === false);
  s.flat = 'error';
  const blind = ios.tapNotification('NEW-7');
  check('tapNotification: an unreadable tree is dumped:false, an instrument fault', blind.ok === false && blind.dumped === false);
  s.flat = [GENERIC, NEW];
  check('undecryptedInShade: the fallback body by PATTERN, never the line', JSON.stringify(ios.undecryptedInShade()) === JSON.stringify([String(ios.GENERIC_BODIES[0])]));
  restore();
}

// --- 5. ensure -------------------------------------------------------------------------------------

{
  const { restore } = fakePhone({ locked: 'error' });
  const r = await ios.ensure({ port: 9444 });
  check('ensure: WDA down is a reason, not a throw', r.ok === false && /wda-daemon/.test(r.reason), JSON.stringify(r));
  restore();
}
{
  const { s, restore } = fakePhone({ state: 1, locked: true, targets: [] });
  const r = await ios.ensure({ port: 9444, timeoutMs: 3_000 });
  check('ensure: no inspector page is NOT ok, and says so', r.ok === false && /inspector bridge on 9444/.test(r.reason), JSON.stringify(r));
  s.targets = [{ url: 'tauri://localhost/chat', webSocketDebuggerUrl: 'ws://x' }];
  const ok = await ios.ensure({ port: 9444, timeoutMs: 3_000 });
  check('ensure: awake, launched, in front, listed', ok.ok === true && ok.pid === '4242' && s.state === 4, JSON.stringify(ok));
  s.targets = [{ url: 'http://tauri.localhost/chat' }];
  let threw = '';
  try {
    ios.forwardDevtools(9444);
  } catch (e) {
    threw = e.message;
  }
  check("forwardDevtools: Android's origin is not the iPhone's page", /lists no tauri:\/\/localhost page/.test(threw), threw);
  restore();
}

// --- 6. What has no counterpart throws, naming the counterpart --------------------------------------

for (const name of ['sh', 'adb', 'killAdbServer', 'fcmSocket']) {
  let err = null;
  try {
    ios[name]('x');
  } catch (e) {
    err = e;
  }
  check(`${name}: NotOnIos with the equivalent`, err instanceof ios.NotOnIos && err.equivalent.length > 20);
}
{
  let err = null;
  await ios.refreshFcmLink().catch((e) => (err = e));
  check('refreshFcmLink: NotOnIos, pointing at the per-row APNs proof', err instanceof ios.NotOnIos && /PUSH_SEND/.test(err.equivalent));
}
check('the native readers report a BLIND instrument, never an empty device', ['nativeResidue', 'nativeFootprint', 'graineMirrorSessions', 'forgetGraineMirror'].every((n) => /App Group/.test(ios[n]('x')?.error ?? '')));

// --- 7. The syslog --------------------------------------------------------------------------------

{
  const line = '2026-10-01 10:00:00.123456 canari{libtauri}[812] <Notice>: [MLS] ready';
  const p = ios.parseSyslogLine(`\x1b[32m${line}\x1b[0m`);
  check('syslog: a line parses, colour codes stripped', p?.process === 'canari' && p.pid === 812 && p.level === 'Notice' && p.message === '[MLS] ready', JSON.stringify(p));
  check('syslog: a continuation is not a line', ios.parseSyslogLine('    at frame 3') === null);
  const { restore } = fakePhone();
  writeFileSync(process.env.IOS_SYSLOG_FILE, `${line}\n2026-10-01 10:00:01.000000 apsd[90] <Notice>: Received message for enabled topic\n`);
  ios.clearLogcat();
  appendFileSync(
    process.env.IOS_SYSLOG_FILE,
    '2026-10-01 10:00:05.000000 canari{libtauri}[812] <Error>: after the mark\n2026-10-01 10:00:06.000000 SpringBoard[60] <Notice>: other\n',
  );
  check('console_: the app lines after the mark only', JSON.stringify(ios.console_()) === JSON.stringify(['after the mark']), JSON.stringify(ios.console_()));
  // 1.5 s of slack before the floor, as `logcatSince` has: 10:00:06 counts for a 10:00:07 floor, 10:00:05 does not.
  check('syslogSince: every process, by device time, 1.5 s slack', ios.syslogSince(new Date('2026-10-01T10:00:07').getTime()).length === 1);
  appendFileSync(
    process.env.IOS_SYSLOG_FILE,
    "2026-10-01 10:00:08.000000 apsd[90] <Notice>: Received message for enabled topic 'fr.emse.canari'\n2026-10-01 10:00:08.500000 apsd[90] <Notice>: Received message for enabled topic 'com.apple.news'\n",
  );
  check('apnsReceipts: apsd lines about THIS app only', ios.apnsReceipts(new Date('2026-10-01T10:00:07').getTime()).length === 1);
  restore();
}

// --- 8. The iPhone's console reaches the classifier -------------------------------------------------

{
  const { fromWebKit, isWebKitAgent } = await import('../webkit-console.mjs');
  const { report } = await import('../watch.mjs');
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const CHROME = 'Mozilla/5.0 (Linux; Android 11; Mi 9T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
  check('isWebKitAgent: the iPhone WebView is WebKit', isWebKitAgent(IPHONE));
  check('isWebKitAgent: a Chromium WebView is not, though it says AppleWebKit', !isWebKitAgent(CHROME));
  const log = { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'x' } } };
  check('fromWebKit: a CDP event passes through untouched', fromWebKit(log) === log);
  const err = { method: 'Console.messageAdded', params: { message: { source: 'console-api', level: 'error', text: '[MLS] decrypt failed for a test', url: 'tauri://localhost/_app/x.js', line: 12, timestamp: 1_759_300_000 } } };
  const t = fromWebKit(err);
  check('fromWebKit: an error line becomes a Log error, epoch ms', t.method === 'Log.entryAdded' && t.params.entry.level === 'error' && t.params.entry.timestamp === 1_759_300_000_000, JSON.stringify(t));
  const net = fromWebKit({ method: 'Console.messageAdded', params: { message: { source: 'network', level: 'error', text: 'Failed to load resource: 404', networkRequestId: '7' } } });
  check('fromWebKit: a network line keeps its request join', net.params.entry.source === 'network' && net.params.entry.networkRequestId === '7');
  const cx = { events: [err], consumed: [] };
  const rep = await report({ cx, label: 'I1', since: 0, home: new Set(['tauri://localhost']) });
  check('report: a WebKit error line makes the iPhone window NOT clean', rep.clean === false, JSON.stringify({ clean: rep.clean, errors: rep.errors }));
}

console.log(failures ? `\n${failures} FAILED` : '\nphone-ios selftest OK');
process.exit(failures ? 1 : 0);
