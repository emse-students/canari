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
  // The two withdrawal branches, pinned TOGETHER because the risk in classifying them is that one
  // rule swallows both: they share a prefix, an id and the word "withdrawn", and they mean opposite
  // things about what the peers hold. Landed in `unexplained` on MUT-19's first green run.
  ['log', '[11:11:10] [OUTBOX] a721e695… withdrawn from the queue before it was ever sent', 'benign'],
  [
    'log',
    '[11:11:10] [OUTBOX] a721e695… withdrawn while it was already being sent - the peers will have it, so the delete has to travel as an event',
    'notable',
  ],
  ['log', '[14:24:06] [MLS] Frames are being lost in 642f389a… - reconciling this conversation', 'notable'],
  // THE THREE MUTATION REFUSALS, one fixture each because the three mean different things: a peer
  // sending a frame it had no right to send, two edits crossing, and an edit landing on a tombstone.
  // The middle one is verbatim from the first MUT-18 run after the convergence fix shipped, where it
  // landed in `unexplained` and turned a PASS into PASS-DIRTY - the correct place for a line nobody
  // had classified, and the reason this fixture exists.
  [
    'log',
    '[03:52:42] [MLS] Dropped an edit of ad2d5d3b dated 1787363560648 - the row already holds a later one',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Dropped an edit of ad2d5d3b - the message is deleted and a tombstone is final',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Refused an edit of a message owned by a1b2c3d4 from e5f6a7b8 - only the author may mutate it',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Refused a delete of a message owned by a1b2c3d4 from e5f6a7b8 - only the author may mutate it',
    'notable',
  ],
  ['log', '[14:24:09] [HISTORY_REQ] 642f389a... same state as d82cd226… (7e5952f8…) - nothing to do', 'notable'],
  ['log', '[14:26:02] [SYNC] WASM purge skipped - server list unreliable (fetchOk=false, 9 group(s))', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=false).', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=true).', 'benign'],
  ['log', '[14:24:06] [HISTORY_STATE] From b78568a3… for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  ['log', '[14:24:06] [HISTORY_STATE] Sent for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  // The one that must NEVER be demoted: a real loss, timestamped exactly as the app writes it.
  ['log', "[14:24:06] [MLS] LOST frame for 642f389a… from d82cd226…: generation consumed but this frame was never processed - the sender's ratchet rewound (SecretReuseError, frame 5p:kq68gk)", 'severe'],
  // GROUP MEMBERSHIP, added 2026-08-23 with the rules themselves. Every `benign` line below is one
  // GRP produced on a healthy add, rename or departure; every `unexplained` line below is the SAME
  // gesture failing, and is here because the risk in classifying a success is a prefix that forgives
  // its failure too.
  ['log', '[14:08:26] [GROUP] My other devices: 3 (tauri-x-y, web-x-z, web-x-w)', 'benign'],
  [
    'log',
    '[14:08:26] [GROUP] addMembersBulk result: welcome=true (2115 bytes), added=3 (tauri-x-y, web-x-z, web-x-w)',
    'benign',
  ],
  ['log', '[14:08:26] [GROUP] Welcome -> d82cd226…:web-d82cd226…-mq6xoj9k-b6wr OK', 'benign'],
  // THE FAILURE OF THE LINE ABOVE, which no rule may forgive - this is what an undelivered Welcome
  // looks like, and the whole GRP phase exists to see it.
  ['log', '[14:08:26] [GROUP] Welcome -> d82cd226…:web-d82cd226…-mq6xoj9k-b6wr FAILED', 'unexplained'],
  ['log', '[14:08:39] Inviting 1 member(s): b78568a3…', 'benign'],
  ['log', '[14:08:40] [OK] Added: b78568a3… (1 device(s)). (1 user(s) delivered)', 'benign'],
  ['log', '[14:08:40] [SYNC] Members added: b78568a3… (1/1 delivered)', 'benign'],
  ['log', '[14:10:28] b78568a3… retire du groupe.', 'benign'],
  ['log', '[14:12:38] Groupe renomme en "GRP5-mt5rospko89-R"', 'benign'],
  ['log', '[14:08:40] [WELCOME] Group ee6ba569… ready', 'benign'],
  [
    'log',
    '[14:15:47] [WELCOME] 110280b7… already held - redelivered Welcome ignored (idempotent)',
    'benign',
  ],
  // THE TWO HALVES OF THE LINE THAT USED TO BE ONE. The commit form is the ordinary outcome of
  // every membership change; the other form is a frame nobody could decrypt and must keep breaking
  // `clean`. Pinned together because a single rule over the shared prefix would forgive both.
  [
    'log',
    '[14:32:47] [MLS] No application payload for 4ad03375… - commit applied, none expected',
    // `stateChanges`, not `benign`: an epoch moved, which is worth SEEING and is not a defect.
    // `unexplained` excludes `stateChanges`, so it does not break `clean` - and unlike a BENIGN
    // entry it stays in a bucket a reader looks at.
    'stateChanges',
  ],
  [
    'log',
    '[14:32:47] [MLS] No application payload for 4ad03375… - not a commit: stale commit already applied, or a frame older than the kept ratchet window',
    'unexplained',
  ],
  // AND THE TWO EVICTION LINES THAT MUST NOT BE CLASSIFIED. Both are real defects GRP-3 and GRP-8
  // found on 2026-08-23: a removed member's pipeline attempting recovery on a group it was
  // legitimately evicted from, and its outbox retrying an encrypt that can never succeed. Pinned
  // here so a later triage pass cannot quietly forgive them.
  ['log', '[14:10:28] [PIPELINE] Recovery attempt finished for 4ca35caf…', 'unexplained'],
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… transient failure (attempt 1): Crypto/OpenMLS error: Encrypt error: GroupStateError(UseAfterEviction)',
    'unexplained',
  ],
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
  // THE `removed` GUARD FIRING, AND ITS FIVE SIBLINGS NOT BEING SWALLOWED WITH IT. Every one of
  // these lines is the SAME log statement in `discoverMissingGroups`; only the reducer's reason
  // separates a designed keep from a keep taken because the client could not read the server. A
  // rule on `kept - ` alone would silence the second kind, so both are pinned here: READ-10 came
  // back PASS-DIRTY on the first, and would come back clean on the second if this ever regressed.
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "READ10-mt3a2434" kept - already removed, awaiting a manual deletion',
    'benign',
  ],
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "Equipe" kept - server status uncertain (network)',
    'unexplained',
  ],
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "Equipe" kept - members unavailable (doubt)',
    'unexplained',
  ],
  // And the dismissal that ends that row's life, which READ-10 now performs itself.
  ['log', '[20:24:01] [DELETE_LOCAL] Local conversation deleted: 642f389a…', 'notable'],
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
