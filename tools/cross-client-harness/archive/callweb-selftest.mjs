/**
 * THE CALL-WEB ROWS' OWN JUDGEMENTS AND NARRATION, PINNED (`callrows.mjs`).
 *
 * Each scenario's judge on a clean measurement and broken one fact at a time; each narration set
 * forgiving its own line in its own row and seat and NOT in another (the counter-cases); the seat
 * tones distinct; the WAV header readable. Pure: no rig, no browser, no `names.mjs`.
 *
 *   bun archive/callweb-selftest.mjs
 */
import { BUSY_ROUNDS, CALL_JUDGES, CALL_WEB_ROWS, PULSE_ON_MS, PULSE_PERIOD_MS, RECORD_SEATS, ROUND_MS, SEAT_TONES, UNANSWERED_ROUNDS, callNarration, callOwn, recordForm, toneWav } from '../callrows.mjs';
import { captionWith } from '../messages.mjs';
import { rowVerdict } from '../srvlog.mjs';
import { forgivingSocketCloses, ignoringExpectedLog } from '../watch.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── the table ────────────────────────────────────────────────────────────────────────────────────
console.log('the table');
ok('eight rows, each a judged scenario', Object.keys(CALL_WEB_ROWS).length === 8 && Object.values(CALL_WEB_ROWS).every((r) => CALL_JUDGES[r.scenario]));
ok('every row opens W2, the caller', Object.values(CALL_WEB_ROWS).every((r) => r.devices[0] === 'W2'));
ok('the offline row opens no device of the callee and closes both', !CALL_WEB_ROWS['CALL-WEB-6'].devices.includes('W4') && CALL_WEB_ROWS['CALL-WEB-6'].closed.join() === 'W4,W8');
ok('every opened seat has a tone, and no two seats share one', Object.values(CALL_WEB_ROWS).every((r) => r.devices.every((d) => SEAT_TONES[d])) && new Set(Object.values(SEAT_TONES)).size === Object.keys(SEAT_TONES).length);
ok('the unanswered wait outlasts the 60 s ring window by 30 s', UNANSWERED_ROUNDS * ROUND_MS === 90_000);

// ── the judges ───────────────────────────────────────────────────────────────────────────────────
console.log('the judges');
const side = (heard = 1) => ({ state: 'connected', recv: 250, bytes: 9000, sent: 250, heard });
const flow = (h2 = 1, h4 = 1) => ({ W2: side(h2), W4: side(h4) });
const both = { W2: 3, W4: 4 };
// THE APP'S OWN RECORDS, rendered from its message file as it renders them.
const LASTED = captionWith('chat_system_call_ended', { starter: 'Ana', duration: '1 minute' });
const STARTED = captionWith('chat_system_call_started', { starter: 'Ana' });
const MISSED = captionWith('chat_system_call_missed', { caller: 'Ana' });
const recs = (scenario, text) => Object.fromEntries(Object.keys(RECORD_SEATS[scenario]).map((s) => [s, text]));
const CLEAN = {
  basic: { rang: 2, up: both, flow: flow(), down: both, records: recs('basic', LASTED) },
  mute: { rang: 2, before: flow(1, 1), senderAtMute: { enabled: false }, muted: flow(1, 0.001), senderAtUnmute: { enabled: true }, after: flow(1, 0.5), down: both },
  'callee-hangup': { rang: 2, flow: flow(), down: both },
  decline: { rang: 2, down: both, neverConnected: true, records: recs('decline', MISSED) },
  cancel: { rang: 2, ringStopped: 1, down: { W2: 2 }, records: recs('cancel', MISSED) },
  offline: { ended: 122, records: recs('offline', MISSED) },
  busy: { rang: 2, secondRing: null, flow: flow(), secondEnded: 3, down: both, records: recs('busy', MISSED) },
  reload: { flow: flow(), callerEnded: 6 },
};
for (const [scenario, m] of Object.entries(CLEAN)) ok(`${scenario}: a clean measurement passes`, callOwn(scenario, m).verdict === 'PASS');
const broken = (scenario, over, why) => {
  const r = callOwn(scenario, { ...CLEAN[scenario], ...over });
  ok(`${scenario}: ${why}`, r.verdict === 'FAIL' && r.failures.length === 1);
};
broken('basic', { rang: null }, 'no ring fails, one failure');
broken('basic', { flow: flow(0, 1) }, 'a seat that heard no energy fails');
broken('basic', { down: { W2: 3, W4: null } }, 'one end left up fails');
broken('mute', { muted: flow(1, 0.5) }, 'W4 still hearing W2 while muted fails');
broken('mute', { after: flow(1, 0.1) }, 'W4 hearing under 20 % after the unmute fails');
broken('mute', { senderAtMute: { enabled: true } }, 'a track left enabled by the mute fails');
broken('decline', { neverConnected: false }, 'a declined call that connected fails');
broken('cancel', { ringStopped: null }, 'a ring that never stopped fails');
broken('offline', { ended: null }, 'a caller still ringing after 90 s fails');
broken('busy', { secondRing: true }, 'the callee rung over its call fails');
broken('busy', { flow: { W2: { ...side(), recv: 0 }, W4: side() } }, 'the call in progress interrupted fails');
broken('reload', { callerEnded: null }, "a caller left in a call with a reloaded page fails");

// B15 and B16: the record of the call, and a busy callee's answer.
console.log('the record of the call');
ok('a record that lasted reads as a duration', recordForm(LASTED) === 'duration');
ok('a record begun and never finalised reads as started', recordForm(STARTED) === 'started');
ok('a missed call reads as other', recordForm(MISSED) === 'other');
ok('no record reads as null', recordForm(null) === null && recordForm('') === null);
broken('basic', { records: recs('basic', MISSED) }, 'an answered call not recorded as one that lasted fails');
broken('basic', { records: {} }, 'a reader that found no record on any seat fails the positive control');
for (const sc of ['decline', 'cancel', 'offline', 'busy']) {
  broken(sc, { records: recs(sc, LASTED) }, 'an unanswered call recorded as one that lasted fails (B15)');
  broken(sc, { records: { ...recs(sc, MISSED), [Object.keys(RECORD_SEATS[sc])[0]]: null } }, 'an end with no record at all fails');
  broken(sc, { records: recs(sc, STARTED) }, 'a record never finalised fails');
}
broken('busy', { secondEnded: 121 }, 'a second caller told nothing until the 60 s window fails (B16)');
ok(`... and the bound is ${BUSY_ROUNDS} rounds, a sixth of that window`, BUSY_ROUNDS * ROUND_MS === 10_000);
ok('the offline row reads the caller only - every device of the callee is closed', Object.keys(RECORD_SEATS.offline).join() === 'W2');
ok("the busy row reads W5's DM on both of its ends", RECORD_SEATS.busy.W5 === 'W4' && RECORD_SEATS.busy.W4 === 'W5');

// ── the narration ────────────────────────────────────────────────────────────────────────────────
console.log('the narration');
const rep = (lines) => ({ errors: [], warnings: [], unexplained: lines, badHttp: [], exceptions: [], severe: [], wsEvents: [] });
const left = (row, seat, line) => ignoringExpectedLog(rep([line]), callNarration(row, seat)).unexplained.length;
const forgiven = (row, seat, line) => left(row, seat, line) === 0;
const H = 'abcdef12…';
const HUNG = 'log: [Call] hung up from the full screen';
const RINGS = `log: [NOTIF] incoming call in ${H} rings in-app - no OS notification while the app is on screen`;
const OFFER = 'log: [Call] offer #1 (812 bytes) -> peer';
const UNANS = `log: [Call] ring window (60000 ms) closed unanswered - call=${H}`;
const PRIMED = 'log: [Call] voice primed (tap while ringing): AbortError: The play() request was interrupted because the media was removed from the document. https://goo.gl/LdLk22';
const E2E_OK = `log: [Call] E2E worker report (5 s after connected): frames=250 decrypt-failed=0 short=0 (empty 0) no-key=0 ok`;
const E2E_BAD = `log: [Call] E2E worker report (5 s after connected): frames=250 decrypt-failed=3 short=0 (empty 0) no-key=0 ok`;
const BUSY = `log: [Call] invite ${H} in ${H} not rung - busy (state=incall call=${H})`;

ok("the caller's hang-up is forgiven on W2 in CALL-WEB-1", forgiven('CALL-WEB-1', 'W2', HUNG));
ok('... and NOT on W4 there, which did not hang up', !forgiven('CALL-WEB-1', 'W4', HUNG));
ok("the callee's hang-up is forgiven on W4 in CALL-WEB-3", forgiven('CALL-WEB-3', 'W4', HUNG));
ok('the in-app ring is forgiven on the callee', forgiven('CALL-WEB-1', 'W4', RINGS));
ok('... and NOT on the caller', !forgiven('CALL-WEB-1', 'W2', RINGS));
ok("the caller's offer is forgiven on W2", forgiven('CALL-WEB-1', 'W2', OFFER));
ok('... and NOT on the callee, the polite side', !forgiven('CALL-WEB-1', 'W4', OFFER));
ok('an unanswered ring is forgiven on W2 in CALL-WEB-6', forgiven('CALL-WEB-6', 'W2', UNANS));
ok('... on W5 in CALL-WEB-7', forgiven('CALL-WEB-7', 'W5', UNANS));
ok('... and NOT in CALL-WEB-1, which was answered', !forgiven('CALL-WEB-1', 'W2', UNANS));
ok('a ring screen primed away is forgiven on W4 in CALL-WEB-4 (declined)', forgiven('CALL-WEB-4', 'W4', PRIMED));
ok('... and NOT in CALL-WEB-1, which connected', !forgiven('CALL-WEB-1', 'W4', PRIMED));
ok('a clean E2E report is forgiven in a connected row', forgiven('CALL-WEB-1', 'W2', E2E_OK));
ok('... a report with a decrypt failure is NOT', !forgiven('CALL-WEB-1', 'W2', E2E_BAD));
ok('... nor is a clean report in a row that never connects', !forgiven('CALL-WEB-4', 'W2', E2E_OK));
ok('the callee not rung while busy is forgiven on W4 in CALL-WEB-7', forgiven('CALL-WEB-7', 'W4', BUSY));
ok('... and NOT in CALL-WEB-1', !forgiven('CALL-WEB-1', 'W4', BUSY));
ok('a call line at another level stays dirt', !forgiven('CALL-WEB-1', 'W2', HUNG.replace(/^log/, 'warning')));
ok('a seat the row does not name gets nothing', callNarration('CALL-WEB-1', 'W5').length === 0 && callNarration('NOT-A-ROW', 'W2').length === 0);

// ── the dirt CALL-WEB-2 met on 2026-10-27, each scoped, each with its counter-case ─────────────────
console.log('the dirt, scoped');
const ICE = (state) => `log: [11:22:14.415] [Call] ICE gathering complete (host=8 srflx=1 relay=4 ice=${state})`;
ok('ICE gathering ending while the checks run is forgiven on the caller', forgiven('CALL-WEB-2', 'W2', ICE('checking')));
ok('... and once connected', forgiven('CALL-WEB-2', 'W2', ICE('connected')));
ok('... but NOT when ICE failed - a call in trouble', !forgiven('CALL-WEB-2', 'W2', ICE('failed')));
ok('... nor disconnected', !forgiven('CALL-WEB-2', 'W2', ICE('disconnected')));

const U64 = 'c71e1a5b3b2963b5878b585eaac179a69727003158736487e857e6f700cc2aef';
const G = 'e6af86b3-099d-4a49-9b6e-2b05e5f2b75e';
const C = '1eaf9bb0-8be6-4aba-a9c2-ec4ecb219fb1';
const NEST = (lvl) => `[Nest] 1  - 10/27/2026, 10:22:10 AM   ${lvl} [CallsService] `;
const RING = (r, n) => `${NEST('LOG')}[ring] call=${C} group=${G} rang=${r}/${n} devices`;
const expectedIn = (line, row) => rowVerdict(line, row)?.expected === true;
ok('a ring that reached every device it tried is expected in a CALL row', expectedIn(RING(0, 0), 'CALL-WEB-2') && expectedIn(RING(2, 2), 'CALL-WEB-1'));
ok('... a ring that reached FEWER than it tried is not', !expectedIn(RING(0, 2), 'CALL-WEB-2') && !expectedIn(RING(1, 2), 'CALL-WEB-1'));
ok('the ring entry is expected in a CALL row', expectedIn(`${NEST('DEBUG')}[ring] ringGroup caller=${U64} group=${G} call=${C}`, 'CALL-WEB-2'));
ok('the call presence is expected in a CALL row', expectedIn(`${NEST('DEBUG')}[calls] presence active user=${U64} device=web-${U64}-mvn2mrrz-j6mu call=${C}`, 'CALL-WEB-2'));
ok('the room token request and its grant are expected in a CALL row', expectedIn(`${NEST('DEBUG')}[calls] requestRoomToken user=${U64} group=${G} room=${C}`, 'CALL-WEB-2') && expectedIn(`${NEST('LOG')}[call] join-token room=${C} user=${U64} group=${G}`, 'CALL-WEB-2'));
ok('... and none of them outside a CALL row', !expectedIn(RING(0, 0), 'COMM-1') && !expectedIn(`${NEST('LOG')}[call] join-token room=${C} user=${U64} group=${G}`, 'TOK-3'));

const sock = (path) => `11:22:34.120 Network.webSocketClosed {"requestId":"41580.3295","timestamp":86276.016738}${path ? ` path=${path}` : ''}`;
const repOf = (wsEvents) => ({ errors: [], warnings: [], unexplained: [], badHttp: [], exceptions: [], severe: [], wsEvents, clean: false });
const callClosed = forgivingSocketCloses(repOf([sock('/api/call')]), ['/api/call']);
ok("the call socket's own close is forgiven, kept aside, and the seat is clean", callClosed.clean && callClosed.wsEvents.length === 0 && callClosed.wsEventsForgiven.length === 1);
ok('the chat gateway closing during a call is NOT', !forgivingSocketCloses(repOf([sock('/ws')]), ['/api/call']).clean);
ok('a close whose socket was never seen open is NOT', !forgivingSocketCloses(repOf([sock(null)]), ['/api/call']).clean);
ok('a path that only starts with the call path is NOT', !forgivingSocketCloses(repOf([sock('/api/call-other')]), ['/api/call']).clean);

// ── the tone file ────────────────────────────────────────────────────────────────────────────────
console.log('the tone file');
const wav = toneWav(SEAT_TONES.W2, 1, 48_000);
ok('a RIFF/WAVE header with a PCM fmt chunk', wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' && wav.readUInt16LE(20) === 1);
ok('mono, 48 kHz, 16-bit', wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 48_000 && wav.readUInt16LE(34) === 16);
ok('the sizes agree with the samples', wav.readUInt32LE(40) === 48_000 * 2 && wav.length === 44 + 48_000 * 2 && wav.readUInt32LE(4) === wav.length - 8);
const at = (i) => wav.readInt16LE(44 + i * 2);
let crossings = 0;
for (let i = 1; i < 48_000; i++) if (at(i - 1) < 0 && at(i) >= 0) crossings++;
const duty = PULSE_ON_MS / PULSE_PERIOD_MS;
ok(`one second of ${SEAT_TONES.W2} Hz pulsed at ${duty * 100} % crosses zero upward about ${SEAT_TONES.W2 * duty} times (+-4)`, Math.abs(crossings - SEAT_TONES.W2 * duty) <= 4);
const peakIn = (fromMs, toMs) => {
  let p = 0;
  for (let i = (fromMs * 48); i < toMs * 48; i++) p = Math.max(p, Math.abs(at(i)));
  return p;
};
ok('loud inside a pulse', peakIn(50, 200) > 0.25 * 32767);
ok('silent between pulses - the swing the rig reads to tell pulsed from steady', peakIn(PULSE_ON_MS + 1, PULSE_PERIOD_MS - 1) === 0);
ok('each pulse fades in rather than clicking on', Math.abs(at(1)) < 0.01 * 32767);

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
