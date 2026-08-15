/**
 * THE CLASSIFIER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN.
 *
 *   node classify-selftest.mjs
 *
 * `report()` decides what breaks `clean`, and every triage this campaign does is an edit to it. Two
 * ways that goes wrong, both met on 2026-08-14:
 *
 *   - a pattern that cannot match. `NOTABLE`, `SEVERE`, `DECRYPT_CLASSIFIED` and `STATE_CHANGE` were
 *     tested against the RAW line while `BENIGN` was tested against the stripped one, so every
 *     `^`-anchored pattern in those four lists silently never matched a line the app had
 *     timestamped. `/^\[OUTBOX\] \d+ entr(y|ies) still queued/` had been in `NOTABLE` since it was
 *     written and still landed in `unexplained` on all three passes;
 *   - a pattern that matches too much, quietly moving a real signal into a bucket that does not
 *     break `clean`. That one has no symptom at all until a defect ships.
 *
 * Neither is visible from a passing run, so they are asserted here instead. Every line below is one
 * this campaign actually saw, kept verbatim WITH its `[HH:MM:SS]` prefix, because the prefix is what
 * the first bug turned on.
 */
import { report } from './watch.mjs';

/** A fake CDP buffer: one `Runtime.consoleAPICalled` per line, dated so the timeline is orderable. */
function cxOf(entries) {
  return {
    events: entries.map(([level, text], i) => ({
      method: 'Runtime.consoleAPICalled',
      params: { type: level, timestamp: 1_786_710_000_000 + i * 1000, args: [{ value: text }] },
    })),
  };
}

const CASES = [
  // [level, line, expected bucket]
  ['log', '[14:24:25] [OUTBOX] 1 entry still queued', 'notable'],
  ['log', '[14:24:25] [OUTBOX] 12 entries still queued', 'notable'],
  ['log', '[14:24:06] [MLS] Frames are being lost in 642f389a… - reconciling this conversation', 'notable'],
  ['log', '[14:24:09] [HISTORY_REQ] 642f389a... same state as d82cd226… (7e5952f8…) - nothing to do', 'notable'],
  ['log', '[14:26:02] [SYNC] WASM purge skipped - server list unreliable (fetchOk=false, 9 group(s))', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=false).', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=true).', 'benign'],
  ['log', '[14:24:06] [HISTORY_STATE] From b78568a3… for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  ['log', '[14:24:06] [HISTORY_STATE] Sent for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  // The one that must NEVER be demoted: a real loss, timestamped exactly as the app writes it.
  ['log', "[14:24:06] [MLS] LOST frame for 642f389a… from d82cd226…: generation consumed but this frame was never processed - the sender's ratchet rewound (SecretReuseError, frame 5p:kq68gk)", 'severe'],
  // And one nobody has ever classified, which must land in `unexplained` and break `clean`.
  ['log', '[14:24:06] [SOMETHING] a line no rule has ever seen', 'unexplained'],
  // THE BURN, which is the repair succeeding and must be visible without failing anything. A run that
  // reloaded inside the checkpoint window has this line and a run that missed the window does not,
  // which is the only way `burn.mjs` can tell a real pass from an experiment that never happened.
  [
    'log',
    "[14:24:06] [MLS] Restored state for 642f389a… was 2 generation(s) behind this device's own sends - burnt, no frame will re-use a spent generation",
    'notable',
  ],
  ['log', '[14:24:06] [MLS] Could not burn 2 generation(s) for 642f389a…: GroupNotFound', 'notable'],
  // The cold start, which only a check that reloads on purpose ever sees. Each is a step reporting
  // that it completed; a step that fails says something else and must stay unexplained.
  ['log', '[hooks] Deep-link listener registered', 'benign'],
  ['debug', '[Cookies] flushed after refresh', 'benign'],
  ['log', '[21:31:56] [PIN] Device key restored from PinVault - auto-login…', 'benign'],
  ['log', '[21:36:45] MLS state loaded from mls.bin (native).', 'benign'],
  ['log', '[DB] Using SQLite storage (Tauri)', 'benign'],
  [
    'info',
    '[Push] startPushService device=tauri-aaaaaaaa…-bbbbbbbb-cccc (platform will be confirmed by FCM token)',
    'benign',
  ],
];

let failures = 0;
for (const [level, text, want] of CASES) {
  const rep = await report({ cx: cxOf([[level, text]]), label: 'selftest' });
  const buckets = ['severe', 'errors', 'notable', 'stateChanges', 'unexplained'];
  const landed = buckets.filter((b) => rep[b].some((l) => String(l).includes(text.slice(11, 60))));
  // `benign` is not a bucket - it is the absence of every other one.
  const got = landed.length === 0 ? 'benign' : landed.join('+');
  /**
   * MEMBERSHIP, NOT EXCLUSIVITY - the buckets overlap by design and demanding one was the test
   * being wrong rather than the classifier. `[MLS] LOST frame` is `severe` AND `notable`: it is a
   * defect that breaks `clean` and it is also something a reader must see in the noise summary.
   * What must hold is that the bucket which DECIDES is present, and that nothing expected elsewhere
   * silently also sits in `unexplained` - the two failures worth catching.
   */
  const ok =
    want === 'benign'
      ? landed.length === 0
      : landed.includes(want) && (want === 'unexplained' || !landed.includes('unexplained'));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(12)} ${text.slice(0, 78)}`);
  if (!ok) console.log(`       landed in: ${got}`);
}

// `clean` must be false for the unexplained line and true for the benign one - the gate itself,
// not just the sorting.
const dirty = await report({ cx: cxOf([['log', '[14:24:06] [SOMETHING] a line no rule has ever seen']]), label: 's' });
const clean = await report({ cx: cxOf([['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=true).']]), label: 's' });
if (dirty.clean !== false) { failures++; console.log('FAIL an unclassified line must break clean'); }
else console.log('ok   gate         an unclassified line breaks clean');
if (clean.clean !== true) { failures++; console.log('FAIL a benign line must not break clean'); }
else console.log('ok   gate         a benign line does not break clean');

/**
 * THE HTTP HALF OF THE SAME GATE, which had no case here at all and needed one.
 *
 * `badHttp` breaks `clean` exactly like `unexplained`, and it was deciding on `r.failed` BEFORE
 * consulting the status - so a response that ARRIVED with a 200 and whose body load was then
 * cancelled was filed as a failure. It reported `GET /api/users/<id>/avatar -> 200` and broke
 * MSG-7's fifth pass on 2026-08-14. A status is an answer; a request that got one is judged on it.
 */
function netOf(reqs) {
  const events = [];
  reqs.forEach(([url, status, failed], i) => {
    const requestId = `r${i}`;
    events.push({
      method: 'Network.requestWillBeSent',
      params: {
        requestId,
        request: { url, method: 'GET' },
        timestamp: 1000 + i,
        wallTime: 1_786_710 + i,
      },
    });
    if (status !== null)
      events.push({
        method: 'Network.responseReceived',
        params: { requestId, response: { status } },
      });
    if (failed)
      events.push({ method: 'Network.loadingFailed', params: { requestId, errorText: failed } });
  });
  return { events };
}

const SITE = 'https://canari-emse.fr';
const HTTP_CASES = [
  // [what it is, url, status, failed, must it break clean]
  ['a 200 whose body load was cancelled', `${SITE}/api/users/aaaa/avatar`, 200, 'net::ERR_ABORTED', false],
  ['a 200 that simply completed', `${SITE}/api/presence`, 200, null, false],
  ['a 502 on that same endpoint', `${SITE}/api/users/aaaa/avatar`, 502, null, true],
  ['a request that never got a status', `${SITE}/api/mls/send`, null, 'net::ERR_CONNECTION_REFUSED', true],
];
for (const [what, url, status, failed, shouldBreak] of HTTP_CASES) {
  const rep = await report({ cx: netOf([[url, status, failed]]), label: 'selftest' });
  const ok = rep.badHttp.length > 0 === shouldBreak && rep.clean === !shouldBreak;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${(shouldBreak ? 'badHttp' : 'ok-http').padEnd(12)} ${what}`);
  if (!ok) console.log(`       badHttp=${JSON.stringify(rep.badHttp)} clean=${rep.clean}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
