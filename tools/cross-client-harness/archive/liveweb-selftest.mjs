/**
 * THE LIVE ROWS' OWN JUDGEMENTS AND NARRATION, PINNED (`liverows.mjs`).
 *
 * L-F1's order judge on a viewer that adapts, one that never adapts and one that stalls after it
 * adapted; the row judge on a clean measurement and broken one fact at a time; each narration set
 * forgiving its own line on its own role and NOT on the other (the counter-cases); the server rules
 * inside a LIVE row and outside it. Pure: no rig, no browser, no `names.mjs`.
 *
 *   bun archive/liveweb-selftest.mjs
 */
import { PHASES, devicesFor } from '../checks.mjs';
import { LIVE_ROWS, liveNarration, liveOwn, liveRefusals, stallFacts, stallsOf } from '../liverows.mjs';
import { rowVerdict } from '../srvlog.mjs';
import { ignoringExpectedLog, ignoringExpectedRefusal } from '../watch.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const S = 'd8de628a…';
const JOINED = `[00:16:17.719] [LIVE] viewer joined ${S} at segment 1`;
const STALL = `[00:16:17.720] [LIVE] viewer ${S} stalled at 2.01`;
const STALL_T = `[00:16:21.720] [LIVE] viewer ${S} stalled at 6.01 (target 2000 ms)`;
const SEEK = `[00:16:18.931] [LIVE] viewer ${S}: seek to the live edge (stall) at 5.98`;
const GAP = (gap, target) => `[00:16:20.100] [LIVE] viewer ${S}: a delivery gap of ${gap} ms - target buffer now ${target} ms`;
const WAITING = `[00:16:20.200] [LIVE] viewer ${S}: waiting while seeking`;

// ── the order of a viewer's lines ────────────────────────────────────────────────────────────────
console.log('the order of a viewer\'s lines (L-F1)');
const adapted = stallsOf([JOINED, STALL, SEEK, GAP(3960, 4500), WAITING]);
ok('a stall before the first gap counts BEFORE, and the target is recorded', adapted.joined && adapted.stallsBefore === 1 && adapted.stallSeeksBefore === 1 && adapted.stallsAfter === 0 && adapted.targets.join() === '4500' && adapted.gaps.join() === '3960');
ok('... and passes L-F1', stallFacts('W2', adapted).every(([o]) => o));
const relapsed = stallsOf([JOINED, GAP(3960, 4500), STALL_T, SEEK]);
ok('a stall AFTER the first gap counts after, the "(target N ms)" spelling included', relapsed.stallsAfter === 1 && relapsed.stallSeeksAfter === 1);
ok('... and fails L-F1', !stallFacts('W2', relapsed)[0][0]);
const never = stallsOf([JOINED, STALL, SEEK, STALL, SEEK]);
ok('stalls with no gap ever named fail: the target buffer never moved (the build without the fix)', never.gaps.length === 0 && !stallFacts('W4', never)[1][0]);
const quiet = stallsOf([JOINED]);
ok('no stall and no gap passes: nothing to adapt to', stallFacts('W4', quiet).every(([o]) => o));
ok('two gaps record both targets, in order', stallsOf([GAP(3900, 4400), GAP(4100, 4600)]).targets.join() === '4400,4600');
ok('another viewer line is neither a stall nor a gap', Object.values(stallsOf([`[LIVE] viewer ${S}: seek to the live edge (join) at 3.97`])).every((v) => v === false || v === 0 || (Array.isArray(v) && !v.length)));

// ── the row judge ────────────────────────────────────────────────────────────────────────────────
console.log('the row judge');
const vid = (t) => ({ t, paused: false, w: 720, h: 1280 });
const CLEAN = {
  onAir: 3,
  card: { W2: 2, W4: 2 },
  join: { W2: 5, W4: 6 },
  play: { W2: { a: vid(1), b: vid(59) }, W4: { a: vid(1), b: vid(58) } },
  watchedMs: 60_000,
  count: 1,
  ended: 2,
  seenEnded: { W2: 2, W4: 3 },
  stalls: { W2: adapted, W4: quiet },
};
ok('a clean minute passes', liveOwn('LIVE-STALL-1', CLEAN).verdict === 'PASS');
const broken = (patch, label) => {
  const r = liveOwn('LIVE-STALL-1', { ...CLEAN, ...patch });
  ok(label, r.verdict === 'FAIL' && r.failures.length >= 1);
};
broken({ onAir: null }, 'a broadcaster never on air fails');
broken({ card: { W2: 2, W4: null } }, 'a viewer that never saw the card fails');
broken({ join: { W2: 5, W4: null } }, 'a viewer that never played fails');
broken({ play: { ...CLEAN.play, W4: { a: vid(1), b: vid(20) } } }, 'a video that advanced 19 s in 60 s fails (a freeze the lines did not name)');
broken({ play: { ...CLEAN.play, W4: { a: vid(1), b: { ...vid(59), paused: true } } } }, 'a paused video fails');
broken({ count: null }, 'a viewer count that never reached the viewers fails');
broken({ ended: null }, 'a broadcaster that never ended fails');
broken({ seenEnded: { W2: 2, W4: null } }, 'a viewer that never saw the end fails');
broken({ stalls: { W2: relapsed, W4: quiet } }, 'a stall after the first gap fails the row');
broken({ stalls: { W2: never, W4: quiet } }, 'stalls with no gap fail the row');

// ── the table and its preflight ──────────────────────────────────────────────────────────────────
console.log('the table');
ok('every row is broadcast by A1 and names it, so the preflight arms the phone', Object.values(LIVE_ROWS).every((r) => r.by === 'A1' && r.devices.includes('A1') && r.viewers.every((v) => r.devices.includes(v))));
ok('LIVE-STALL-1 watches for a minute', LIVE_ROWS['LIVE-STALL-1'].watchRounds * 500 === 60_000);
ok('run.mjs --file liveweb.mjs --row LIVE-STALL-1 preflights A1, W2 and W4', ['A1', 'W2', 'W4'].every((d) => devicesFor('liveweb.mjs', ['--row', 'LIVE-STALL-1']).devices.includes(d)));
ok('the LIVEWEB phase plays every row', Object.keys(LIVE_ROWS).every((r) => PHASES.LIVEWEB.scripts.includes(`liveweb.mjs --row ${r}`)));

// ── the narration ────────────────────────────────────────────────────────────────────────────────
console.log('the narration');
const rep = (lines) => ({ errors: [], warnings: [], unexplained: lines, badHttp: [], exceptions: [], severe: [], wsEvents: [] });
const forgiven = (row, seat, line) => ignoringExpectedLog(rep([line]), liveNarration(row, seat)).unexplained.length === 0;
const ENDED_OK = `log: [00:16:25.573] [LIVE-BROADCAST] ${S} ended (broadcaster) after 15 s: 8 segments, 0 dropped, 0 off a keyframe`;
const ENDED_DROP = `log: [00:16:25.573] [LIVE-BROADCAST] ${S} ended (broadcaster) after 15 s: 8 segments, 2 dropped, 0 off a keyframe`;
const SEAL = 'debug: [00:16:16.332] [2026-10-26T23:16:16.332Z] [LiveCrypto] {"op":"seal","index":0,"plainBytes":74616}';
const VJOIN = `log: ${JOINED}`;
const VSTALL = `debug: ${STALL}`;
const VGAP = `debug: ${GAP(3960, 4500)}`;
ok("the broadcaster's clean end is forgiven on A1", forgiven('LIVE-STALL-1', 'A1', ENDED_OK));
ok('... an end that DROPPED segments is not', !forgiven('LIVE-STALL-1', 'A1', ENDED_DROP));
ok('a seal is forgiven on the broadcaster, NOT on a viewer', forgiven('LIVE-WEB-2', 'A1', SEAL) && !forgiven('LIVE-WEB-2', 'W2', SEAL));
ok('a viewer join, stall and gap are forgiven on a viewer', forgiven('LIVE-STALL-1', 'W2', VJOIN) && forgiven('LIVE-STALL-1', 'W4', VSTALL) && forgiven('LIVE-STALL-1', 'W2', VGAP));
ok('... NOT on the broadcaster', !forgiven('LIVE-STALL-1', 'A1', VJOIN) && !forgiven('LIVE-STALL-1', 'A1', VSTALL));
ok('... and NOT on a seat outside the row', !forgiven('LIVE-STALL-1', 'W5', VJOIN));
ok('... and NOT outside a LIVE row', liveNarration('CALL-WEB-1', 'W2').length === 0);
ok('a viewer stall at warn stays dirt', !forgiven('LIVE-STALL-1', 'W2', `warn: ${STALL}`));
ok('an append failure stays dirt', !forgiven('LIVE-STALL-1', 'W2', `error: [LIVE] viewer ${S}: append failed (1 in a row)`));

console.log('the refusals');
const http = (line) => ({ ...rep([]), badHttp: [line] });
const MANIFEST = 'GET https://dev.canari-emse.fr/api/lives/59bc51fe-bf10-4d49-8bed-27cc25833021/manifest?from=7&chat=1&messagesAfter=0&reactionsAfter=0 -> 404';
const SEGMENT = 'GET https://dev.canari-emse.fr/api/media/public/live/59bc51fe-bf10-4d49-8bed-27cc25833021/957e4ec4-396f-4720-9077-3d061656c351 -> 404';
const left = (seat, line) => ignoringExpectedRefusal(http(line), liveRefusals('LIVE-STALL-1', seat)).badHttp.length;
ok("the ended live's manifest 404 is forgiven on a viewer", left('W2', MANIFEST) === 0);
ok('... NOT on the broadcaster', left('A1', MANIFEST) === 1);
ok("... and a manifest 500 is not", left('W2', MANIFEST.replace('-> 404', '-> 500')) === 1);
ok('a purged SEGMENT 404 stays dirt on a viewer', left('W2', SEGMENT) === 1);

// ── the server rules ─────────────────────────────────────────────────────────────────────────────
console.log('the server rules');
const L = '59bc51fe-bf10-4d49-8bed-27cc25833021';
const N2 = '957e4ec4-396f-4720-9077-3d061656c351';
const NEST = (lvl, ctx) => `[Nest] 1  - 10/27/2026, 11:16:10 PM   ${lvl} [${ctx}] `;
const expectedIn = (line, row) => rowVerdict(line, row)?.expected === true;
const LIVE_LINES = [
  `${NEST('DEBUG', 'LivesService')}[LIVE] start asked by f7a9bb80`,
  `${NEST('DEBUG', 'LivesService')}[LIVE] f7a9bb80 accepted the live rules v2`,
  `${NEST('LOG', 'LivesService')}[LIVE] ${L} started by f7a9bb80`,
  `${NEST('DEBUG', 'LivesService')}[LIVE] segment 3 of ${L} reserved as ${N2}`,
  `${NEST('DEBUG', 'LivesService')}[LIVE] segment 3 of ${L} stored (52342 B)`,
  `${NEST('DEBUG', 'LivesService')}[LIVE] ${L} claimed for its announcement`,
  `${NEST('LOG', 'LivesService')}[LIVE] ${L} ended by its broadcaster`,
  `${NEST('DEBUG', 'LiveSeats')}[LIVE_SEAT] ${L}: seat held, 1 on this live, 1/24 seated`,
  `${NEST('DEBUG', 'LiveSeats')}[LIVE_SEAT] ${L}: 2 watching (broadcaster's read)`,
  `${NEST('DEBUG', 'LiveSeats')}[LIVE_SEAT] ${L}: seat released (held=true)`,
  `${NEST('DEBUG', 'LiveSeats')}[LIVE_SEAT] ${L}: ended, 2 seat(s) given back`,
  `${NEST('DEBUG', 'HttpLiveSegmentStore')}[LIVE] storing segment ${N2} of live ${L} (52342 B)`,
  `${NEST('DEBUG', 'HttpLiveSegmentStore')}[LIVE] purging the segments of live ${L}`,
  `${NEST('DEBUG', 'InternalLivesModeController')}[LIVE] lives_mode relayed to media-service: on`,
  `${NEST('LOG', 'LiveAnnouncer')}[LIVE_ANNOUNCE] ${L} by f7a9bb80 kind=member followers=1`,
  `${NEST('DEBUG', 'LiveSegmentsService')}[LIVE] storing live/${L}/${N2} (52342 B)`,
  `${NEST('DEBUG', 'MediaController')}[LIVE] segment ${L}/${N2} served to the edge cache (52342 B)`,
];
ok('every line of a live is expected in a LIVE row', LIVE_LINES.every((l) => expectedIn(l, 'LIVE-STALL-1') && expectedIn(l, 'LIVE-WEB-2')));
ok('... and none of them outside a LIVE row', LIVE_LINES.every((l) => !expectedIn(l, 'CALL-WEB-1') && !expectedIn(l, 'TOK-3')));
ok('a refused start stays dirt in a LIVE row', !expectedIn(`${NEST('DEBUG', 'LivesService')}[LIVE] start refused: f7a9bb80 already has an open live`, 'LIVE-STALL-1'));
ok('a segment out of order stays dirt in a LIVE row', !expectedIn(`${NEST('DEBUG', 'LivesService')}[LIVE] segment 4 of ${L} out of order (expected 3)`, 'LIVE-STALL-1'));
ok('a full live stays dirt in a LIVE row', !expectedIn(`${NEST('LOG', 'LiveSeats')}[LIVE_SEAT] ${L}: FULL, 24/24 seated - refused`, 'LIVE-STALL-1'));
ok('a seat released that was never held stays dirt', !expectedIn(`${NEST('DEBUG', 'LiveSeats')}[LIVE_SEAT] ${L}: seat released (held=false)`, 'LIVE-STALL-1'));
ok('a live ended by max_duration stays dirt', !expectedIn(`${NEST('LOG', 'LivesService')}[LIVE] ${L} ended: max_duration (reached at segment 900)`, 'LIVE-STALL-1'));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
