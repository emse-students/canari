/**
 * CALL-WEB-1..8 - IN-APP 1:1 AUDIO CALLS BETWEEN TWO BROWSERS (2026-10-26).
 *
 * The rows the stable is gated on for calls: place, ring, accept, audio both ways, mute, a hang-up
 * from either side, decline, a cancel while ringing, a callee with no device online, a second call
 * into a call in progress, and a reload mid-call. W2 (the peer account) calls W4 (the third account)
 * in their DM; W5 (the fourth) is the second caller; W8 is W4's sibling, closed for the offline row
 * so that NO device of the callee answers. Runner `archive/callweb.mjs`; this file is the table, the
 * seat tones, the judges and the narration, all pure.
 *
 * A DISTINCT TONE PER SEAT ({@link SEAT_TONES}). The first reading ran every seat on Chrome's default
 * fake microphone - the SAME beep everywhere - and CALL-WEB-2 failed six times: W2's echo canceller
 * heard W4 play W2's own beep back, learnt it, and after the unmute cancelled W2's microphone (W4
 * heard 9e-6 of the energy it heard before). Each seat now captures its own frequency, so a seat's
 * capture never matches what it plays.
 *
 * ROUNDS, NOT CLOCKS. Every wait is a count of 500 ms rounds on a fact. The one window a row must
 * outlast is the SERVER's ring window (`CALL_RING_TIMEOUT_SEC = 60`, chat-delivery `calls.service.ts`):
 * the unanswered rows wait {@link UNANSWERED_ROUNDS} rounds for it, so the window closes before the
 * rig would - the first offline reading hung up at 60.0 s and measured its own hang-up.
 */
import { atLevels } from './watch.mjs';

export const ROUND_MS = 500;
/** Rounds a ring, a connection or an end is waited for. */
export const WAIT_ROUNDS = 60;
/** Rounds an unanswered call is waited for: past the server's 60 s ring window (90 s). */
export const UNANSWERED_ROUNDS = 180;
/** Seconds of audio sampled per measurement window. */
export const FLOW_SECONDS = 5;

/** Each seat's own fake-microphone tone, in Hz - never two seats on one frequency. */
export const SEAT_TONES = { W2: 440, W4: 660, W5: 880 };

/** The DM a row calls in, by account role: the caller seat and the callee's display-name role. */
const CALLEE = 'third';

/** The rows `archive/callweb.mjs` plays. `restart` lists the seats closed during the row and reopened. */
export const CALL_WEB_ROWS = {
  'CALL-WEB-1': { scenario: 'basic', devices: ['W2', 'W4'], callee: CALLEE, what: 'W2 calls W4, W4 accepts: connected, audio both ways (bytes and heard energy), W2 hangs up, both ends end' },
  'CALL-WEB-2': { scenario: 'mute', devices: ['W2', 'W4'], callee: CALLEE, what: "W2 mutes and unmutes mid-call: muted, W2's track is disabled and W4 hears under 1 % of what it heard; unmuted, at least 20 % again" },
  'CALL-WEB-3': { scenario: 'callee-hangup', devices: ['W2', 'W4'], callee: CALLEE, what: 'the callee hangs up a connected call: both ends end' },
  'CALL-WEB-4': { scenario: 'decline', devices: ['W2', 'W4'], callee: CALLEE, what: 'W4 declines while ringing: both ends end, the call never connects' },
  'CALL-WEB-5': { scenario: 'cancel', devices: ['W2', 'W4'], callee: CALLEE, what: "W2 hangs up while W4 rings: W4's ring stops, W2 ends" },
  'CALL-WEB-6': { scenario: 'offline', devices: ['W2'], closed: ['W4', 'W8'], callee: CALLEE, what: "every device of the callee closed: W2 rings until the server's 60 s window closes, then ends" },
  'CALL-WEB-7': { scenario: 'busy', devices: ['W2', 'W4', 'W5'], callee: CALLEE, what: 'W5 calls W4 while W4 is in a call with W2: W4 does not ring over it, the call in progress keeps flowing, W5 ends at its window' },
  'CALL-WEB-8': { scenario: 'reload', devices: ['W2', 'W4'], callee: CALLEE, what: "W4's page reloads mid-call: W2's call ends" },
};

/** Audio flowing both ways in a window: connected on both seats, packets and bytes in and out. */
export const bothWays = (flow) => Object.values(flow).every((s) => s.state === 'connected' && s.recv > 0 && s.bytes > 0 && s.sent > 0);

/**
 * One row's verdict from what it measured: `{ ok, failures }`. Each judge names its own failures, so a
 * FAIL says which fact did not hold; `null` rounds mean the fact never happened within its bound.
 */
export const CALL_JUDGES = {
  basic: (m) => [
    [m.rang !== null, 'W4 never rang'],
    [m.up.W2 !== null && m.up.W4 !== null, 'the call never connected on both seats'],
    [bothWays(m.flow), 'audio did not flow both ways'],
    [m.flow.W2.heard > 0 && m.flow.W4.heard > 0, 'a seat heard no audio energy'],
    [m.down.W2 !== null && m.down.W4 !== null, 'the hang-up did not end both seats'],
  ],
  mute: (m) => [
    [m.rang !== null, 'W4 never rang'],
    [bothWays(m.before) && m.before.W4.heard > 0, 'no audio before the mute'],
    [m.senderAtMute?.enabled === false, "W2's audio track was not disabled by the mute"],
    [m.muted.W4.heard < 0.01 * m.before.W4.heard, 'W4 still heard W2 while muted'],
    [m.senderAtUnmute?.enabled === true, "W2's audio track was not enabled again by the unmute"],
    [m.after.W4.heard > 0.2 * m.before.W4.heard, 'W4 did not hear W2 again after the unmute'],
    [m.down.W2 !== null && m.down.W4 !== null, 'the hang-up did not end both seats'],
  ],
  'callee-hangup': (m) => [
    [m.rang !== null, 'W4 never rang'],
    [bothWays(m.flow), 'audio did not flow both ways'],
    [m.down.W2 !== null && m.down.W4 !== null, "the callee's hang-up did not end both seats"],
  ],
  decline: (m) => [
    [m.rang !== null, 'W4 never rang'],
    [m.down.W2 !== null && m.down.W4 !== null, 'the decline did not end both seats'],
    [m.neverConnected, 'the declined call connected'],
  ],
  cancel: (m) => [
    [m.rang !== null, 'W4 never rang'],
    [m.ringStopped !== null, "W4's ring did not stop after the caller hung up"],
    [m.down.W2 !== null, "the caller's call did not end"],
  ],
  offline: (m) => [[m.ended !== null, `the caller's call did not end within ${UNANSWERED_ROUNDS} rounds of an unanswered ring`]],
  busy: (m) => [
    [m.rang !== null, 'W4 never rang for the first call'],
    [m.secondRing === null, "W4 rang for the second call over the call in progress"],
    [bothWays(m.flow), 'the call in progress stopped flowing during the second call'],
    [m.secondEnded !== null, "the second caller's call did not end within its window"],
    [m.down.W2 !== null && m.down.W4 !== null, 'the hang-up did not end both seats'],
  ],
  reload: (m) => [
    [bothWays(m.flow), 'audio did not flow both ways before the reload'],
    [m.callerEnded !== null, "the caller's call did not end after the callee's page went away"],
  ],
};

/** `{ verdict: 'PASS'|'FAIL', failures }` for a row's scenario and measurement. */
export function callOwn(scenario, measured) {
  const failures = CALL_JUDGES[scenario](measured)
    .filter(([ok]) => !ok)
    .map(([, why]) => why);
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}

/**
 * A 16-bit mono PCM WAV of a pure tone, for `--use-file-for-fake-audio-capture` (Chrome loops it).
 *
 * @param {number} hz
 * @param {number} [seconds]
 * @param {number} [rate]
 * @returns {Buffer}
 */
export function toneWav(hz, seconds = 4, rate = 48_000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.3 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── narration ─────────────────────────────────────────────────────────────────────────────────────
//
// EVERY LINE BELOW IS THE CALL PATH NARRATING ITSELF (`CallService.ts`, `CallOverlay.svelte`,
// `callReport.ts`, the E2E worker), read on the first reading's twelve calls. They are forgiven only
// in a CALL-WEB row, only on the seat whose ROLE prints them, and only at `log` (the app's level for
// them) - the same words at `warn` or `error` stay dirt. A line of one role on the other (an `offer`
// on the callee) stays dirt, and so does every line of a connected call in a row whose call never
// connects (`decline`, `cancel`, `offline`).

const L = ['log'];
const H = String.raw`[0-9a-f]{8}(?:…|\.\.\.)`;
const N = String.raw`\d+`;
const at = (levels, s) => atLevels(levels, new RegExp(`^${s}$`));

/** A seat setting up its side of a call: keys, ICE servers, signalling - caller or callee. */
const SETUP = [
  at(L, String.raw`\[Call\] fetching ICE servers for group=${H}`),
  at(L, String.raw`\[Call\] ${N} ICE server\(s\) \(direct first, TURN relay last\): .+`),
  at(L, String.raw`\[Call\] micro: echo=(true|false) noise=(true|false) agc=(true|false) rate=${N}Hz ch=${N}`),
  at(L, String.raw`\[Call\] connecting signalling WebSocket \(token in query\)`),
  at(L, String.raw`\[Call\] signalling connected, joining p2p room\.\.\.`),
  at(L, String.raw`\[Call\] p2p room ready \(${H}\)`),
  at(L, String.raw`\[Call\] E2E worker holds the call keys`),
  at(L, String.raw`\[Call\] media keys derived from MLS \(role=(caller|callee) send_fp=[0-9a-f]+ recv_fp=[0-9a-f]+, sha256\)`),
  at(L, String.raw`\[LEAF_REFRESH\] ${H} held \(call\)`),
  at(L, String.raw`\[LEAF_REFRESH\] ${H} hold released \(call\)`),
  at(L, String.raw`\[Call\] signal from ${H} in ${H} call=${H}`),
  at(L, String.raw`\[CALL_REPORT\] call=${H} phase=(tick|end) .+ e2e=on.*`),
];

/** A call that CONNECTED: the peer connection, both transforms, the voice playing. */
const CONNECTED = [
  at(L, String.raw`\[Call\] creating PeerConnection \(policy=all, ${N} ICE server\(s\)\)`),
  at(L, String.raw`\[Call\] adding ${N} local track\(s\) to PeerConnection`),
  at(L, String.raw`\[Call\] E2E (sender|receiver) transform attached \(audio\)`),
  at(L, String.raw`\[Call\] E2E (sender|receiver) transformer #${N} \(${N} (sender|receiver) in this worker\): first frame audio mime=audio/opus pt=${N}`),
  at(L, String.raw`\[Call\] E2E (encrypting|decrypting) audio \(${N} frame\(s\)\)`),
  at(L, String.raw`\[Call\] E2E proven: this device encrypted a frame and decrypted one from the peer`),
  at(L, String.raw`\[Call\] E2E sender audio #${N}: ${N} frame\(s\), not-opus=0 repeated-ts=0 own-iv=0 .+`),
  // `decrypt-failed=0` and `no-key=0` ARE THE ASSERTION: a report with a failure stays dirt.
  at(L, String.raw`\[Call\] E2E worker report \((${N} s after connected|call end, call=${H})\): .+ decrypt-failed=0 short=${N} \(empty ${N}\) no-key=0 .+`),
  at(L, String.raw`\[Call\] E2E path check \(${N} s after connected\): no media around the transform \(packets sent audio=${N} video=0 received audio=${N} video=0\)`),
  at(L, String.raw`\[Call\] ICE gathering complete \(host=${N} srflx=${N} relay=${N} ice=connected\)`),
  at(L, String.raw`\[Call\] (iceGatheringState=(gathering|complete)|iceConnectionState=(checking|connected)|connectionState=(connecting|connected))`),
  at(L, String.raw`\[Call\] signalingState=(have-local-offer|have-remote-offer|stable)`),
  at(L, String.raw`\[Call\] remote ICE end-of-candidates`),
  at(L, String.raw`\[Call\] audio send=audio/opus .+`),
  at(L, String.raw`\[Call\] selected path pair=\S+ relayed=(no|yes) rtt_ms=${N}`),
  at(L, String.raw`\[Call\] remote track kind=audio id=${H} readyState=live muted=(true|false)`),
  at(L, String.raw`\[Call\] remote track (unmuted|ended) kind=audio`),
  at(L, String.raw`\[Call\] voice playing \(stream arrived\)`),
];

const CALLER = [
  at(L, String.raw`\[Call\] server ring sent - answer window open`),
  at(L, String.raw`\[Call\] peer ready - this side is initiator \(pairing ${N}\)`),
  at(L, String.raw`\[Call\] offer #${N} \(${N} bytes\) -> peer`),
  at(L, String.raw`\[Call\] peer -> Answer \(signaling=have-local-offer\)`),
];
const CALLEE_RINGS = [
  at(L, String.raw`\[NOTIF\] incoming call in ${H} rings in-app - no OS notification while the app is on screen`),
  at(['debug'], String.raw`\[AUDIO\] opening the tone output for incoming-call ring`),
  // The block check every incoming signal is read against; `blocked:true` would refuse the call, so
  // only `false` is forgiven.
  at(['debug'], String.raw`\[blocks\.isBlockedWith\] \{"userId":"${H}","blocked":false\}`),
];
const CALLEE_ANSWERS = [
  at(L, String.raw`\[Call\] accepted from the full-screen ring`),
  at(L, String.raw`\[Call\] peer ready - this side is polite \(pairing ${N}\)`),
  at(L, String.raw`\[Call\] peer -> Offer \(signaling=stable\)`),
  at(L, String.raw`\[Call\] answer to offer #${N} \(${N} bytes\) -> peer`),
];
const HUNG_UP = at(L, String.raw`\[Call\] hung up from the full screen`);
const UNANSWERED = at(L, String.raw`\[Call\] ring window \(60000 ms\) closed unanswered - call=${H}`);
// THE PRIMING play() OF A RING SCREEN THAT LEFT BEFORE ANY STREAM: `primeVoice` logs its rejection
// on purpose ("expected and only logged"); this is the rejection of an element unmounted under it,
// which only a call that never connected does. In a connected row it stays dirt.
const PRIMED_AWAY = at(L, String.raw`\[Call\] voice primed \((mounted within the dialling tap|tap while ringing)\): AbortError: The play\(\) request was interrupted because the media was removed from the document\. https://goo\.gl/\S+`);

/**
 * The narration a seat is given in a CALL-WEB row: by row, by seat, by role - and nothing else.
 *
 * @param {string} row a `CALL_WEB_ROWS` id
 * @param {string} seat
 */
export function callNarration(row, seat) {
  const scenario = CALL_WEB_ROWS[row]?.scenario;
  if (!scenario) return [];
  const connects = !['decline', 'cancel', 'offline'].includes(scenario);
  if (seat === 'W2') {
    const caller = [...SETUP, ...CALLER, ...(connects ? CONNECTED : [])];
    if (scenario === 'offline') return [...caller, UNANSWERED];
    if (scenario === 'reload') return [...caller, at(L, String.raw`\[Call\] the other party left the call room`)];
    if (['basic', 'mute', 'cancel', 'busy'].includes(scenario)) return [...caller, HUNG_UP];
    return caller;
  }
  if (seat === 'W4') {
    const callee = [...SETUP, ...CALLEE_RINGS];
    if (scenario === 'decline') return [...callee, at(L, String.raw`\[Call\] declined from the full screen`), PRIMED_AWAY];
    if (scenario === 'cancel') return [...callee, PRIMED_AWAY];
    const answered = [...callee, ...CALLEE_ANSWERS, ...CONNECTED];
    if (scenario === 'callee-hangup') return [...answered, HUNG_UP];
    if (scenario === 'busy') return [...answered, at(L, String.raw`\[Call\] invite ${H} in ${H} not rung - busy \(state=incall call=${H}\)`)];
    if (scenario === 'reload')
      return [...answered, at(['debug'], String.raw`\[CallView\] minimised to the top banner`), at(L, String.raw`\[Call\] top bar up - above every covering layer`)];
    return answered;
  }
  if (seat === 'W5' && scenario === 'busy') return [...SETUP, at(L, String.raw`\[Call\] server ring sent - answer window open`), UNANSWERED, HUNG_UP, PRIMED_AWAY];
  return [];
}
