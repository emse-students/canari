/**
 * THE SERVER CLASSIFIER AND ITS NORMALISER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN.
 *
 *   node srvclassify-selftest.mjs
 *
 * Same argument as `classify-selftest.mjs`, on the half of the observation that had no test at all.
 * `srvlog.mjs` grew twenty rules on 2026-08-14, and the two ways that goes wrong are both silent:
 *
 *   - a rule that CANNOT match. `/\[Presence\]/` was capitalised while the gateway writes
 *     `[presence]`, so all 55 of its presence lines sat in `unexplained` for the whole campaign and
 *     nothing said so - the reader just saw a bigger pile;
 *   - a rule that matches TOO MUCH, moving a real signal into a bucket that does not break `clean`.
 *     `[INTERNAL_PUSH] ... failed=0` is the shape of that risk: written carelessly it forgives
 *     `failed=7` as well, and then a push failure ships as a clean window.
 *
 * `shapeOf` is tested for the same reason and it is not cosmetic: it decides how big the triage
 * worklist LOOKS. Its first draft reported 287 distinct shapes for 287 copies of one sentence, which
 * is a summary the same size as the thing it summarises - unreadable, so unread.
 *
 * Every line below was taken verbatim from production on 2026-08-14, with the identifiers replaced.
 */
// `srvReport` reaches production, so it cannot be the thing under test here. What IS under test is
// everything that decides its answer offline: `shapeOf`, and the rule lists themselves. The bucket
// arithmetic around them is exercised on a real window by `run.mjs`, once per pass.
import {
  shapeOf,
  BENIGN_RULES,
  NOTABLE_RULES,
  SEVERE_RULES,
  EXPECTED_ERROR_RULES,
} from './srvlog.mjs';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`
  );
};

const GW = '2026-08-14T12:22:33.133033Z  INFO chat_gateway::handlers: ';
const NEST = '[Nest] 1  - 08/14/2026, 12:43:51 PM     LOG ';

// --- shapeOf: different instances of one sentence must collapse to ONE shape ------------------
const sameShape = (name, a, b) => check(name, shapeOf(a) === shapeOf(b), true);

sameShape(
  'two correlation ids collapse',
  `${NEST}[MessagingService] [SEND][send-cd9583ef] QUEUED count=3`,
  `${NEST}[MessagingService] [SEND][send-33f8f65a] QUEUED count=9`
);
sameShape(
  'an all-digit correlation id collapses with a hex one',
  `${NEST}[MessagingService] [SEND][send-12345678] X`,
  `${NEST}[MessagingService] [SEND][send-abcdef01] X`
);
sameShape(
  'two devices of different platforms collapse',
  `${GW}[WS RX] from=aaaaaaaaaaaaaaaa:web-aaaaaaaaaaaaaaaa-msglwqh6-vegy type=typing group=00000000-0000-4000-8000-000000000001 rawBytes=82`,
  `${GW}[WS RX] from=bbbbbbbbbbbbbbbb:tauri-bbbbbbbbbbbbbbbb-msgnk8nf-gyb2 type=typing group=00000000-0000-4000-8000-000000000002 rawBytes=81`
);
// THE ORDERING BUG, PINNED. The device rule must run before the id rule or `web-<id>-suffix` has
// already stopped looking like a device by the time the device rule is applied.
check(
  'a device is one token, not an id wearing a prefix',
  shapeOf(`${GW}Device=web-aaaaaaaaaaaaaaaa-msglwqh6-vegy`).includes('<device>'),
  true
);
check(
  'and no id survives inside it',
  /web-<id>/.test(shapeOf(`${GW}Device=web-aaaaaaaaaaaaaaaa-msglwqh6-vegy`)),
  false
);
// And the other direction: genuinely different sentences must NOT collapse, or the worklist hides
// things instead of shortening.
check(
  'different sentences stay different',
  shapeOf(`${NEST}[MessagingService] [HISTORY_REQ][history-req-aaaaaa] FORWARDED`) ===
    shapeOf(`${NEST}[MessagingService] [HISTORY_REQ][history-req-bbbbbb] NO_PEER_ONLINE`),
  false
);

// --- the rules, applied to lines whose bucket is known ----------------------------------------
// Asserted through the live report is impossible offline, so the rule LISTS are exercised by the
// one property that was broken: a line the campaign saw must not be `unexplained`. `srvReport`
// against production is what proves the arithmetic; this proves the patterns can match at all.
const matches = (rules, l) => rules.some((r) => r.test(l));

const BENIGN_CASES = [
  `${GW}[presence] Online: aaaaaaaaaaaaaaaa:web-aaaaaaaaaaaaaaaa-msglwqh6-vegy (TTL=20s)`,
  `${GW}[presence] DEL aaaaaaaaaaaaaaaa:web-aaaaaaaaaaaaaaaa-msglwqh6-vegy ok (attempt 1)`,
  `${GW}Received WS JSON frame from aaaaaaaaaaaaaaaa (21 bytes)`,
  `${GW}[WS RX] from=aaaaaaaaaaaaaaaa:web-a-b type=typing group=g rawBytes=82`,
  `${GW}[WS RX] from=aaaaaaaaaaaaaaaa:web-a-b type=disconnect group=<none> rawBytes=21`,
  `${GW}[ROUTE] type=typing group=g from=aaaaaaaaaaaaaaaa:web-a-b | members: x [ONLINE]`,
  `${GW}New WebSocket connection: User=aaaaaaaaaaaaaaaa, Device=web-a-b`,
  `${GW}Registered connection key: aaaaaaaaaaaaaaaa:web-a-b (conn_id=759, 1 active)`,
  `${GW}Client closed connection: Some(CloseFrame { code: 1000, reason: Utf8Bytes(Utf8Bytes(b"harness cut")) })`,
  `${GW}Client closed connection: None`,
  '[404] GET /sitemap_index.xml',
  '[404] GET /sitemap.xml.gz',
  // The IAB advertising convention file, on a site that carries no advertising. Raised the pass-5
  // window of the TYPE x5 re-run of 2026-08-15 and nothing else in it.
  '[404] GET /app-ads.txt',
  '2026-08-14T12:22:33Z  INFO chat_gateway::subscribers: [Gateway] Channel event distributed to connected users (targets=2).',
  `${NEST}[MembersController] [GET_MEMBERS] group=00000000-0000-4000-8000-000000000001 count=3`,
  `${NEST}[DevicesController] [REGISTER_PREKEYS] user=aaaaaaaaaaaaaaaa device=web-a-b count=50`,
  `${NEST}[SecurityController] [LINK_PREVIEW] cache hit fr.wikipedia.org ok=true`,
  `${NEST}[InternalController] [INTERNAL_PUSH] user=aaaaaaaaaaaaaaaa sent=1 failed=0`,
  `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a] No push token for user=a device=web-a-b`,
  `${NEST}[AuthSessionsService] Swept 4 expired session(s)`,
  `${NEST}[MinesweeperService] minesweeper challenge started user=a id=b`,
  `${NEST}[PublicController] public getPublishedCarte`,
  `${NEST}[PosterService] getPublished: serving 00000000-0000-4000-8000-000000000001`,
  // The refresh grace window accepting a second concurrent caller - the mechanism working. Raised
  // the pass-4 window of the MSG x5 of 2026-08-14 and nothing else in it.
  `${NEST}[AuthSessionsService] Concurrent refresh accepted sid=00000000-0000-4000-8000-000000000001 (grace window)`,
  // THE LOCK LIFECYCLE. Bookkeeping around a commit, not the commit itself - and `Lock released` was
  // the most frequent unexplained shape of the TYPE run of 2026-08-14, a near-miss on the rule that
  // already made `[COMMIT] START` and `ACCEPT` notable.
  `${NEST}[MessagingService] [COMMIT][commit-789135f0] Lock released for group=00000000-0000-4000-8000-000000000001`,
  `${NEST}[LocksController] [ADD_LOCK] group=00000000-0000-4000-8000-000000000001 owner=a:web-a-b acquired=true ttl=30s`,
  `${NEST}[LocksController] [RELEASE_LOCK] group=00000000-0000-4000-8000-000000000001 owner=a:web-a-b released=true`,
  `${NEST}[MembersController] [GET_USER_MEMBERS] group=00000000-0000-4000-8000-000000000001 count=5`,
  '[3] GET /favicon.ico',
];
for (const l of BENIGN_CASES) {
  const ok = matches(BENIGN_RULES, l) && !matches(NOTABLE_RULES, l);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} benign       ${l.slice(-72)}`);
}

const NOTABLE_CASES = [
  `${NEST}[MessagingService] [HISTORY_REQ][history-req-fcd21c9c] FORWARDED target=a:web-a-b group=g requester=c:web-c-d`,
  `${NEST}[MessagingService] [HISTORY_REQ][history-req-13bea09c] NO_PEER_ONLINE group=g requester=a:web-a-b`,
  `${NEST}[MessagingService] [SEND][send-85d25af2] TRANSPORT_SKIPPED_OFFLINE count=1 group=g - no row, no push: the rendezvous would expire first`,
  'Listening on http://0.0.0.0:3000',
  // The hourly backlog report. Its identifiers are anonymised here for the same reason as every
  // other case in this file: the real line names real devices, and this file is committed.
  `${NEST}[AppController] [CRON] reportQueueDepth: 1078 frame(s) queued, heaviest 5: web-a-b=189/0.2MB web-c-d=86/0.4MB`,
  // THE SECRET SCAN. Notable and not benign: whether the public host was scanned during a run is
  // worth reading, even though every one of these was answered `404` and nothing was served.
  // Verbatim from the pass-2 window of the MSG x5 of 2026-08-15, which is the run they made dirty.
  '[404] GET /.env',
  '[404] GET /.env.production',
  '[404] GET /.git/HEAD',
  '[404] GET /credentials.json',
  '[404] GET /service-account.json',
  '[404] GET /bundle.js',
  '[404] GET /static/js/main.js',
];
for (const l of NOTABLE_CASES) {
  const ok = matches(NOTABLE_RULES, l);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} notable      ${l.slice(-72)}`);
}

// THE ONE THAT MUST NOT BE FORGIVEN BY THE PATTERN THAT FORGIVES ITS SIBLING.
const failedPush = `${NEST}[InternalController] [INTERNAL_PUSH] user=aaaaaaaaaaaaaaaa sent=0 failed=2`;
const pushOk = !matches(BENIGN_RULES, failedPush) && matches(NOTABLE_RULES, failedPush);
if (!pushOk) failures++;
console.log(`${pushOk ? 'ok  ' : 'FAIL'} notable      a push that FAILED is not the push that succeeded`);

// SAME SHAPE, ON THE PUBLIC ROUTES. `serving` is the success word and the rule carries it; a public
// read that did NOT serve must stay unexplained, or the bucket that exists to catch a broken public
// page is the bucket that hides it.
const posterMiss = `${NEST}[PosterService] getPublished: no published carte for 00000000-0000-4000-8000-000000000001`;
const posterOk = !matches(BENIGN_RULES, posterMiss);
if (!posterOk) failures++;
console.log(`${posterOk ? 'ok  ' : 'FAIL'} unexplained  a public read that served NOTHING is not the one that served`);

// AND THE SAME SHAPE ON THE 404s. Each guessed path is forgiven by name; a 404 on a route this site
// really does own must stay unexplained, or the bucket that would catch a broken page hides it.
for (const ownedMiss of ['[404] GET /sitemap.xml', '[404] GET /robots.txt']) {
  const ownedOk = !matches(BENIGN_RULES, ownedMiss);
  if (!ownedOk) failures++;
  console.log(
    `${ownedOk ? 'ok  ' : 'FAIL'} unexplained  a 404 on a route we DO serve is not a crawler's guess  ${ownedMiss}`
  );
}

// AND THE SCANNER RULE AGAINST THE TWO THINGS IT MUST NOT REACH. `/service-worker.js` is the exact
// path a general `[404] GET /*.js` would have forgiven and SvelteKit really would own it, so it is
// the reason the three bundle guesses are spelt literally; `/chat` is an ordinary route of this
// application, and a 404 on one is the finding this bucket exists to surface.
for (const owned of ['[404] GET /service-worker.js', '[404] GET /chat']) {
  const ok = !matches(BENIGN_RULES, owned) && !matches(NOTABLE_RULES, owned);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} unexplained  a 404 on a path we could own is not a scanner's guess  ${owned}`);
}

// THE LINE THAT REPLACED THE ONE THIS FILE USED TO PIN. `FALLBACK_MEMBERS_CACHE` was kept out of
// BENIGN because it fired on 100 % of sends and nobody had said that was the design; it wasn't -
// no caller has ever populated `recipients`, so the branch calling itself a cache miss was the
// only path a proto send has (WP-SENDPATH-1a). `MEMBERS_CACHE_REPAIRED` is what remains, and it
// fires ONLY when the reconciliation really added a device the gateway could not reach. It gets no
// rule at all: a defect report that a bucket forgives is a defect report nobody reads.
const repaired = `${NEST}[MessagingService] [SEND][send-33f8f65a] MEMBERS_CACHE_REPAIRED group=00000000-0000-4000-8000-000000000001 added=2 of=5 - these active devices were absent from the gateway routing set and unreachable by it`;
const repairedOk = !matches(BENIGN_RULES, repaired) && !matches(NOTABLE_RULES, repaired);
if (!repairedOk) failures++;
console.log(`${repairedOk ? 'ok  ' : 'FAIL'} unexplained  a routing set that HAD to be repaired is forgiven by nothing`);

// AND THE SHARPEST OF THEM ALL, because the two lines come out of the SAME function twelve lines
// apart and differ only in wording. One says a concurrent refresh was tolerated; the other says a
// session was DELETED. A rule written to the service name rather than to the sentence would forgive
// both, and the forgiven one would be a user silently logged out - or a stolen cookie.
const replay = `${NEST}[AuthSessionsService] Refresh token replay detected sid=00000000-0000-4000-8000-000000000001 user=aaaaaaaaaaaaaaaa - session revoked`;
const replayOk = !matches(BENIGN_RULES, replay) && matches(SEVERE_RULES, replay);
if (!replayOk) failures++;
console.log(`${replayOk ? 'ok  ' : 'FAIL'} severe       a revoked session is not the grace window that avoided one`);

// An expected error is still an error - forgiven from the gate, never from the record.
const reset =
  '2026-08-14T12:45:19.892060Z ERROR chat_gateway::handlers: WebSocket Error from aaaaaaaaaaaaaaaa: WebSocket protocol error: Connection reset without closing handshake';
const resetOk = matches(EXPECTED_ERROR_RULES, reset) && !matches(BENIGN_RULES, reset);
if (!resetOk) failures++;
console.log(`${resetOk ? 'ok  ' : 'FAIL'} expected-err an abrupt client disconnection is named, not silenced`);

// THE PUSH FALLBACK IS NOTABLE, AND THE LINE NEXT TO IT IS NOT. `FCM sent` and `PUSH_DEFERRED` say
// a device was not keeping up; `No push token` says a device never registered one. The first draft
// of the rule matched the bare tag and swallowed both, which is how a real signal ends up in a
// bucket that does not break `clean`.
const fcmSent = `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a] FCM sent user=a device=tauri-a-b platform=android inlineProto=true`;
const noToken = `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a] No push token for user=a device=web-a-b`;
const pushSplitOk =
  matches(NOTABLE_RULES, fcmSent) && !matches(NOTABLE_RULES, noToken) && matches(BENIGN_RULES, noToken);
if (!pushSplitOk) failures++;
console.log(`${pushSplitOk ? 'ok  ' : 'FAIL'} notable      the FCM fallback is notable, a missing token is not`);

// And a line nobody has classified must match nothing at all, or `unexplained` can never fill.
const stranger = `${NEST}[SomethingService] a sentence no rule has ever seen`;
const strangerOk =
  !matches(BENIGN_RULES, stranger) &&
  !matches(NOTABLE_RULES, stranger) &&
  !matches(EXPECTED_ERROR_RULES, stranger);
if (!strangerOk) failures++;
console.log(`${strangerOk ? 'ok  ' : 'FAIL'} unexplained an unknown line matches no rule`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
