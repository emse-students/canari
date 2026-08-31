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
  settleFirstLooks,
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
  // THE SAME TWO ENDPOINTS WITH NOTHING TO DO. Siblings of the NOTABLE_CASES pair below, and the
  // reason the rule reads the count instead of the endpoint name.
  `${NEST}[MembersController] [DISMISS] user=aaaaaaaa group=g recorded=0`,
  `${NEST}[MembersController] [UNDISMISS] user=aaaaaaaa group=g lifted=0`,
  // A CONTAINER'S BOOT BANNER, both remaining spellings. Silent because the boot itself is announced
  // once in NOTABLE - see the `Nest application successfully started` case below, which is the
  // sibling that makes this silence safe rather than a hole. The microservice and Kafka spellings
  // left this list on 2026-08-31 with the transport that printed them; they are asserted
  // UNEXPLAINED further down, which is what makes their return a finding.
  `${NEST}[RouterExplorer] Mapped {/api/mls/groups/:groupId, DELETE} route +0ms`,
  `${NEST}[RoutesResolver] MembersController {/api}: +0ms`,
  // THE GROUP LIFECYCLE, which every check that builds a group produces and nothing classified until
  // 2026-08-21 - twenty-four unexplained lines from one READ-10 run, all of them its own fixture.
  `${NEST}[GroupsController] [CREATE_GROUP][create-grp-6126d2fe] name="READ10-mt3bjpjl" createdBy=aaaaaaaa isGroup=true creatorDevice=web-a-b groupId=g`,
  `${NEST}[GroupsController] [CREATE_GROUP][create-grp-6126d2fe] creator membership set to active`,
  `${NEST}[GroupsController] [CREATE_GROUP][create-grp-6126d2fe] DONE groupId=g`,
  `${NEST}[MembersController] [ADD_MEMBER][add-member-29ebc748] START group=g user=aaaaaaaa`,
  `${NEST}[MembersController] [ADD_MEMBER][add-member-29ebc748] DONE group=g user=aaaaaaaa devices=1`,
  `${NEST}[MessagingService] [WELCOME][welcome-send-ea3ef295] QUEUED id=q recipient=aaaaaaaa:web-a-b group=g`,
  `${NEST}[InvitationsController] [INVITATION_STATUS] device=web-a-b user=aaaaaaaa group=g newStatus=active`,
  // A SEND WITH NOBODY TO SEND TO. Benign in THIS spelling only; its sibling is in NOTABLE_CASES,
  // and the two were one indistinguishable sentence until the discriminator was added.
  `${NEST}[MessagingService] [SEND][send-65d68721] No message queued after validation - recipients=0 durable=true - the group named no other device, so there was nobody to queue for`,
  // ANOTHER CONTRIBUTOR'S SHOP WORK, on the same production server, inside our window. The claim path
  // is deliberately NOT covered by that rule and appears in UNEXPLAINED_CASES below.
  `${NEST}[PartnershipsService] [PARTNERSHIP] create card: association=d1f769ce mode=text`,
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
  // COPIED FROM PRODUCTION, not remembered. This fixture used to read `[INTERNAL_PUSH] user=...`
  // with no `type=`, which is a shape the service has not emitted since `type=` was added - so the
  // self-test AGREED with a rule that had gone blind, and both said the same wrong thing. That is
  // how four correctly-pushed lines reached `unexplained` on READ's run of 2026-08-21 with every
  // gate green. A fixture invented from memory can only ever confirm the rule it was written beside.
  `${NEST}[InternalController] [INTERNAL_PUSH] type=channel user=aaaaaaaaaaaaaaaa sent=1 failed=0`,
  // The device-count question social-service asks before a direct invitation. Shape copied from
  // COMM-4's window of 2026-08-26, where it was the run's single `unexplained`; the id is truncated
  // to eight characters there because the log site truncates it, not because this fixture does.
  `${NEST}[InternalController] [INTERNAL_MLS_DEVICES] user=aaaaaaaa count=1`,
  `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a] No push token for user=a device=web-a-b`,
  // The per-device half of the same fan-out, which `comm14.mjs` reads as its instrument.
  `${NEST}[MessagingService] [SOCIAL_PUSH][social-push-5a2f8d1a] sent user=aaaaaaaaaaaaaaaa device=tauri-aaaa-b-c`,
  `${NEST}[MessagingService] [SOCIAL_PUSH][social-push-5a2f8d1a] No token for user=aaaaaaaaaaaaaaaa`,
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
  // A FAILED ACQUISITION, WHICH IS THE LOCK WORKING. Its only caller skips and retries on the next
  // sweep, and every owner sweeps on every device it owns, so an owner with two devices in a group
  // produces one of these by construction. Three landed in GRP's window on 2026-08-24 from one
  // owner's two web devices. The NOTABLE case below is its twin and must NOT match here.
  `${NEST}[LocksController] [ADD_LOCK] group=00000000-0000-4000-8000-000000000001 owner=a:web-a-b acquired=false ttl=30s`,
  // A LOGIN. Every phase that starts, reloads or reconnects a client mints one; the security signal
  // on this service is `Refresh token replay detected`, which is SEVERE and asserted apart.
  `${NEST}[AuthSessionsService] Session opened sid=00000000-0000-4000-8000-000000000001 user=aaaaaaaaaaaaaaaa`,
  `${NEST}[MembersController] [GET_USER_MEMBERS] group=00000000-0000-4000-8000-000000000001 count=5`,
  // The two icons that are SERVED. Both statuses need a fixture: a conditional request answers 304
  // and a rule matching only 200 would break a clean window on a second visit.
  '[200] GET /favicon.ico',
  '[304] GET /favicon.ico',
  '[200] GET /apple-touch-icon.png',
  '[304] GET /apple-touch-icon.png',
  `${NEST}[InvitationsController] [PENDING][pending-0a1b2c3d] No active membership for 00000000-0000-4000-8000-000000000001:web-a-b`,
  // The precomposed spelling is the one Canari deliberately does not serve, so its 404 stays benign.
  '[404] GET /apple-touch-icon-precomposed.png',
];
for (const l of BENIGN_CASES) {
  const ok = matches(BENIGN_RULES, l) && !matches(NOTABLE_RULES, l);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} benign       ${l.slice(-72)}`);
}

const NOTABLE_CASES = [
  // THE FAILED RELEASE, WHICH IS NOT THE FAILED ACQUISITION. The Lua script deletes the key only if
  // this device still owns it, so a false means the value changed underneath - the 30 s TTL expired
  // mid-Add, or another device took it. That is a slow or stuck commit, and it must not ride into
  // BENIGN on the back of its `acquired=false` twin: the two share a tag and nothing else.
  `${NEST}[LocksController] [RELEASE_LOCK] group=00000000-0000-4000-8000-000000000001 owner=a:web-a-b released=false`,
  // THE TWO BOOT LINES THAT ARE NOT THE ROUTE TABLE: a capability whose absence nothing else would
  // reveal, and a deletion pass crossing whatever window it lands in.
  `${NEST}[AppController] [FIREBASE] Admin SDK initialized`,
  `${NEST}[AppController] [CRON] initial sweep: running every GC job once`,
  `${NEST}[AppController] [CRON] initial sweep: done`,
  // THE ONE LINE A RESTART IS WORTH. Its 106 companions are BENIGN above; if this ever moved with
  // them, a service could restart under a check and no bucket would say so.
  `${NEST}[NestApplication] Nest application successfully started +1ms`,
  // THE REST OF THAT BOOT - core-service saying what it came up WITH. Notable for the restart line's
  // reason and dirty until 2026-08-24, when the v0.14.4 deploy landed seconds before DEL-2's window.
  `${NEST}[StripePaymentProvider] Stripe configured: yes`,
  `${NEST}[LydiaPaymentProvider] Lydia configured: no (https://homologation.lydia-app.com)`,
  `${NEST}[UsersService] unaccent + pg_trgm extensions ready`,
  // THE OTHER HALF of the `No message queued` warning: recipients existed and every one was offline,
  // so a 60-second rendezvous will expire with nothing answering it. Shown, never fatal.
  `${NEST}[MessagingService] [SEND][send-65d68721] No message queued after validation - recipients=2 durable=false - every recipient device is offline and this frame is transport-only`,
  // A DISMISSAL MARKER MOVING. It is the one row a group's purge must not take, so both directions
  // are visible whenever they happen - and ONLY when they happen. The no-op spellings are in
  // BENIGN_CASES; separating them is what stopped a two-device re-add claiming two events.
  `${NEST}[MembersController] [DISMISS] user=aaaaaaaa group=g recorded=1`,
  `${NEST}[MembersController] [UNDISMISS] user=aaaaaaaa group=g lifted=1`,
  `${NEST}[MessagingService] [HISTORY_REQ][history-req-fcd21c9c] FORWARDED target=a:web-a-b group=g requester=c:web-c-d`,
  `${NEST}[MessagingService] [HISTORY_REQ][history-req-13bea09c] NO_PEER_ONLINE group=g requester=a:web-a-b`,
  `${NEST}[MessagingService] [SEND][send-85d25af2] TRANSPORT_SKIPPED_OFFLINE count=1 group=g - no row, no push: the rendezvous would expire first`,
  'Listening on http://0.0.0.0:3000',
  // The same boot, in the shape media-service prints. It is a separate case because it is a
  // separate rule: the line above is anchored at `Listening on http` and cannot match a bare port.
  '[media-service] Listening on :3011',
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
  // THE CMS SWEEP, verbatim from the TYPE run of 2026-08-16 - four stacks in one burst, all 404.
  // One fixture per stack, because the rule is one alternation and a stack with no fixture is a
  // branch that can rot.
  '[404] GET /administrator/manifests/files/joomla.xml',
  '[404] HEAD /wp-login.php',
  '[404] HEAD /_ignition/health-check',
  '[404] HEAD /_next/webpack-hmr',
  '[404] GET /media/system/js/core.js',
  '[404] GET /language/en-GB/en-GB.xml',
  // THE ONE DELETE IN THE PRODUCT THAT LEAVES NO TOMBSTONE, both of its forms. MUT-8 produces the
  // plain one and MUT-9 the moderated one, and the two are separate fixtures because the difference
  // between them - who destroyed whose message - is the whole value of the line.
  `${NEST}[ChannelService] [CHANNEL] message deleted channel=00000000-0000-4000-8000-000000000001 message=00000000-0000-4000-8000-000000000002 by=a1b2c3d4`,
  `${NEST}[ChannelService] [CHANNEL] message deleted channel=00000000-0000-4000-8000-000000000001 message=00000000-0000-4000-8000-000000000002 by=a1b2c3d4 (moderation)`,
  // ALL THREE LEVELS, because the rule names them and a fourth would be a product change this must
  // notice rather than absorb. MENTION-2 and MENTION-3 set these, and until they ran no check ever
  // had - which is why an entire phase read SERVER NOT CLEAN for its own four lines.
  `${NEST}[ChannelService] [CHANNEL_PUSH] level set channel=00000000-0000-4000-8000-000000000001 user=a1b2c3d4 level=mentions`,
  `${NEST}[ChannelService] [CHANNEL_PUSH] level set channel=00000000-0000-4000-8000-000000000001 user=a1b2c3d4 level=none`,
  `${NEST}[ChannelService] [CHANNEL_PUSH] level set channel=00000000-0000-4000-8000-000000000001 user=a1b2c3d4 level=all`,
  // THE RECOVERY THAT LETS A PRIVATE SALON WITH AN EMPTY ALLOWLIST BE REPAIRED. It is the one line
  // saying the read was served to someone the allowlist does not hold, so it must never be silent -
  // a fallback whose rate cannot be measured is a fallback nobody knows is load-bearing. COMM-23
  // flips a public salon private, which is the gesture that produces it.
  `${NEST}[ChannelService] [CHANNEL_ACCESS] settings served to manager a1b2c3d4 outside the allowlist of 00000000-0000-4000-8000-000000000001`,
  // ONE PER APP START, so any phase that relaunches the phone emits them - MENTION-3 arms it
  // twice and produced exactly two. It is the row that decides where a push can land.
  `${NEST}[PushController] [PUSH_REGISTER] user=a1b2c3d4 device=tauri-a1b2c3d4-0000 platform=android`,
];
for (const l of NOTABLE_CASES) {
  const ok = matches(NOTABLE_RULES, l);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} notable      ${l.slice(-72)}`);
}

// A CONFIGURATION THAT FLIPPED IS NOT THE BOOT THAT ANNOUNCED IT, and this is the assertion those
// three rules exist to survive. Each pins the VALUE it was read with, so the boot is forgiven and a
// CHANGE of it is not: `Lydia configured: yes` is the event WP-LYDIA-1 consists of, and `Stripe
// configured: no` is payments silently losing their configuration across a deploy. Both are announced
// exactly once per restart, in one line, with no other record anywhere - so a rule spanning both
// values would delete the only evidence either event will ever produce. Asserted in both directions
// because the comment on the rule claims it, and a claim in a comment is not a property of the code.
for (const [what, line] of [
  ['a payment provider that lost its configuration', `${NEST}[StripePaymentProvider] Stripe configured: no`],
  ['the Lydia flip this repo is waiting for', `${NEST}[LydiaPaymentProvider] Lydia configured: yes (https://lydia-app.com)`],
  ['the same flip still on homologation', `${NEST}[LydiaPaymentProvider] Lydia configured: yes (https://homologation.lydia-app.com)`],
]) {
  const ok = !matches(NOTABLE_RULES, line) && !matches(BENIGN_RULES, line);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} unexplained  ${what} is not the boot that announced the old value`);
}

// A SCANNER PATH THAT ANSWERED IS NOT A SCANNER PATH THAT 404ed, and the rule's whole safety
// argument rests on that. `/administrator/` returning 200 on a SvelteKit host would mean something
// is serving a Joomla admin panel from this domain - the single most serious thing this family of
// lines could ever say - so it must fall through to `unexplained` rather than be forgiven as "the
// usual scan". Asserted here because the comment on the rule claims it, and a claim in a comment is
// not a property of the code.
const servedScan = '[200] GET /administrator/';
const scanOk = !matches(NOTABLE_RULES, servedScan) && !matches(BENIGN_RULES, servedScan);
if (!scanOk) failures++;
console.log(`${scanOk ? 'ok  ' : 'FAIL'} unexplained a scanner path that ANSWERED is not the 404 that ignored it`);

// THE ONE THAT MUST NOT BE FORGIVEN BY THE PATTERN THAT FORGIVES ITS SIBLING.
const failedPush = `${NEST}[InternalController] [INTERNAL_PUSH] type=channel user=aaaaaaaaaaaaaaaa sent=0 failed=2`;
const pushOk = !matches(BENIGN_RULES, failedPush) && matches(NOTABLE_RULES, failedPush);
if (!pushOk) failures++;
console.log(`${pushOk ? 'ok  ' : 'FAIL'} notable      a push that FAILED is not the push that succeeded`);

// THE SAME SEPARATION ON THE DEVICE-COUNT QUESTION, and zero is the only value that means anything:
// the caller compares against it and nothing else. A membership still lands, and the key DM behind it
// has nowhere to go - an invitee inside a community whose history they cannot read. Asserted both
// ways because the benign rule pins `count=[1-9]`, and a rule written `count=\d+` would have read
// that outcome as routine.
const noDevices = `${NEST}[InternalController] [INTERNAL_MLS_DEVICES] user=aaaaaaaa count=0`;
const devicesOk = !matches(BENIGN_RULES, noDevices) && matches(NOTABLE_RULES, noDevices);
if (!devicesOk) failures++;
console.log(`${devicesOk ? 'ok  ' : 'FAIL'} notable      an invitee with NO reachable device is not one with devices`);

// A PRIVATE SALON BECOMING PUBLIC, the four lines COMM-24 exists to produce, taken verbatim from its
// window of 2026-08-26. Asserted `notable` and never benign in either direction: the retirement of a
// salon's key group and a change to who may read or write it are the loudest quiet events in this
// service, and a rule that made them benign would erase the only record either leaves.
for (const [what, line] of [
  ['a key group appearing', `${NEST}[ChannelService] [CHANNEL_GRAINE] group ready channel=aaaaaaaa group=bbbbbbbb`],
  ['the same group retired for going public', `${NEST}[ChannelService] [CHANNEL_GRAINE] group retired channel=aaaaaaaa group=bbbbbbbb reason=made_public`],
  ['the access that opened it', `${NEST}[ChannelService] [CHANNEL] access granted channel=aaaaaaaa private=false announced=2`],
  ['the policy it settled on', `${NEST}[ChannelService] [CHANNEL] access updated channel=aaaaaaaa private=false writePolicy=everyone audience=2 mayWrite=2`],
]) {
  const ok = !matches(BENIGN_RULES, line) && matches(NOTABLE_RULES, line);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} notable      ${what} is reported, never waved through`);
}

// AND THE REASON IS PINNED, because `made_public` is the only one a caller writes today. A salon
// losing its key group for a reason this rig has never seen must arrive under its own name rather
// than pre-forgiven by the rule written for the transition COMM-24 drives.
const retiredOther = `${NEST}[ChannelService] [CHANNEL_GRAINE] group retired channel=aaaaaaaa group=bbbbbbbb reason=members_gone`;
const retiredOk = !matches(BENIGN_RULES, retiredOther) && !matches(NOTABLE_RULES, retiredOther);
if (!retiredOk) failures++;
console.log(`${retiredOk ? 'ok  ' : 'FAIL'} unexplained  a retirement for an UNKNOWN reason is not the one going public`);

// THE ONE THAT STAYS UNEXPLAINED ON PURPOSE, and this assertion is what keeps it that way. COMM-24's
// window carries `served ... published=false base=none active=0 devices=0` one second after its salon
// was created, where nothing has published yet and the answer is ordinary. Pinning that exact shape
// would have closed the row's last dirt - and would also have forgiven the concurrent-join race,
// whose two callers BOTH read an unpublished group and so produce the identical sentence. There is no
// text separating the two, so the shape keeps costing COMM-24 a PASS-DIRTY rather than costing the
// rig the only detector it has for the race.
const servedFresh = `${NEST}[ChannelService] [CHANNEL_GRAINE] served channel=aaaaaaaa user=bbbbbbbb group=cccccccc published=false base=none active=0 devices=0`;
const freshOk = !matches(BENIGN_RULES, servedFresh) && !matches(NOTABLE_RULES, servedFresh);
if (!freshOk) failures++;
console.log(`${freshOk ? 'ok  ' : 'FAIL'} unexplained  an UNPUBLISHED graine read stays visible, race or not`);

// THE SAME SEPARATION ON THE PER-DEVICE HALF, and it needs asserting three times because the family
// fails three different ways and the benign rule pins only the two success words. `sent ` forgives a
// delivery; it must forgive nothing that says the delivery did not happen, the token was dead, or
// the whole capability is absent - the last of which would make every push row in the campaign a
// vacuous pass while every gate stayed green.
for (const [what, line] of [
  ['the send refused', `${NEST}[MessagingService] [SOCIAL_PUSH][social-push-5a2f8d1a] FCM failed user=a device=tauri-a-b-c err=Error`],
  ['a token the provider called dead', `${NEST}[MessagingService] [SOCIAL_PUSH][social-push-5a2f8d1a] deleted invalid token user=a device=tauri-a-b-c`],
  ['the capability absent entirely', `${NEST}[MessagingService] [SOCIAL_PUSH] Firebase not initialized - nothing sent`],
]) {
  const ok = !matches(BENIGN_RULES, line) && matches(NOTABLE_RULES, line);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} notable      ${what} is not the per-device push that worked`);
}

// SAME SHAPE, ON THE PUBLIC ROUTES. `serving` is the success word and the rule carries it; a public
// read that did NOT serve must stay unexplained, or the bucket that exists to catch a broken public
// page is the bucket that hides it.
const posterMiss = `${NEST}[PosterService] getPublished: no published carte for 00000000-0000-4000-8000-000000000001`;
const posterOk = !matches(BENIGN_RULES, posterMiss);
if (!posterOk) failures++;
console.log(`${posterOk ? 'ok  ' : 'FAIL'} unexplained  a public read that served NOTHING is not the one that served`);

// AND THE SAME SHAPE ON THE 404s. Each guessed path is forgiven by name; a 404 on a route this site
// really does own must stay unexplained, or the bucket that would catch a broken page hides it.
// The two icons joined that list on 2026-08-17, and they are the reason it is worth re-reading when
// an asset ships: their rules used to forgive ANY status because nothing was served at either path.
// Now that both are, a 404 means the file fell out of the build, and forgiving it would silence the
// only evidence of that - on the one surface (a home screen, a tab) nobody checks after a deploy.
for (const ownedMiss of [
  '[404] GET /sitemap.xml',
  '[404] GET /robots.txt',
  '[404] GET /favicon.ico',
  '[404] GET /apple-touch-icon.png',
]) {
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

// A REPAIR OF THE SAME FAMILY, and the reason it gets no rule either. `kick-stale-device` resets a
// device's membership to pending because its leaf is in the MLS tree and its local state is gone -
// the client only calls it on a DuplicateSignature. GRP's first pass of 2026-08-24 produced exactly
// one, for W2's own device, and no runner claims to arm that shape: until a row names it as its
// subject, it is a loss the server had to repair and it must keep stopping the run. Forgiving it here
// is how it would become invisible.
const kicked = `${NEST}[InvitationsController] [KICK] Reset device web-aaaaaaaaaaaaaaaa-msglwqh6-vegy of user aaaaaaaaaaaaaaaa in group 00000000-0000-4000-8000-000000000001 to pending`;
const kickedOk = !matches(BENIGN_RULES, kicked) && !matches(NOTABLE_RULES, kicked);
if (!kickedOk) failures++;
console.log(`${kickedOk ? 'ok  ' : 'FAIL'} unexplained  a stale leaf the server HAD to kick is forgiven by nothing`);

// A PIN VERIFIER THROWN AWAY ON PURPOSE, WHICH IS STILL NOT A THING TO HIDE. The legacy salt
// migration is correct and it costs the user a re-registration, so it is reported; what a rule cannot
// do is make the SECOND one for an account look like the first, which is why the pattern keeps the
// account in the line rather than collapsing to the sentence.
const pinSalt = `${NEST}[SecurityController] [PIN_SALT] new salt generated for aaaaaaaaaaaaaaaa (legacy=true)`;
const pinOk = matches(NOTABLE_RULES, pinSalt) && !matches(BENIGN_RULES, pinSalt);
if (!pinOk) failures++;
console.log(`${pinOk ? 'ok  ' : 'FAIL'} notable      a legacy PIN salt migration is reported, never waved through`);

// AND THE ONE SERVICE THE CAMPAIGN CANNOT CAUSE. Filed benign because no chat check reaches it, but
// filed at all so a change in its shape is a line somebody reads.
const formations = `[Nest] 1  - 08/14/2026, 12:43:51 PM   DEBUG [InternalUsersController] internal formations listing rows=3`;
const formationsOk = matches(BENIGN_RULES, formations) && !matches(NOTABLE_RULES, formations);
if (!formationsOk) failures++;
console.log(`${formationsOk ? 'ok  ' : 'FAIL'} benign       an internal listing from a service no check touches`);

// AND THE SAME DISPOSITION FOR A DIFFERENT PRODUCT'S QUESTION. Le Cercle asks Canari whether a user
// is a cotisant on every sign-in and session rotation; the campaign neither causes it nor can stop
// it. Pinned as benign - and pinned as NOT notable, because a rule keyed on `[CERCLE]` rather than
// on this sentence would also forgive whatever else that integration ever logs.
const cercle = `${NEST}[PublicController] [CERCLE] cotisant-status assoSlug=cercle sub=aaaaaaaa`;
const cercleOk = matches(BENIGN_RULES, cercle) && !matches(NOTABLE_RULES, cercle);
if (!cercleOk) failures++;
console.log(`${cercleOk ? 'ok  ' : 'FAIL'} benign       another product's inbound cotisant check`);

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

// THE SAME LOG SITE, FOUR CALLERS, AND THE RULE HAD NAMED ONE. `sendFcmForQueued`
// (`messaging.service.ts:490`) is entered from `send`, from its own deferred retry (`send-…-def`),
// from a Welcome (`welcome-send`) and from a reactivation catch-up (`reactivate`) - so a key spelt
// `send-` made the SAME successful push notable from one entry point and unexplained from three.
// It cost a 5-pass GRP run its first pass on 2026-08-25: thirteen unexplained lines, eleven
// `welcome-send-` and one `reactivate-`, none of them a defect. The BENIGN twin below had already
// been widened for this reason, in an edit that missed this one - which is why the pins are here and
// not in a comment: the live window cannot show it, a caller nobody exercised just never appears.
const fcmCallers = [
  ['a push from a message send', `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a] FCM sent user=aaaaaaaa device=tauri-a-b platform=android inlineProto=true`, 'notable'],
  ['a push from its own deferred retry', `${NEST}[MessagingService] [PUSH_SEND][send-33f8f65a-def] FCM sent user=aaaaaaaa device=tauri-a-b platform=android inlineProto=true`, 'notable'],
  ['a push from a Welcome', `${NEST}[MessagingService] [PUSH_SEND][welcome-send-33f8f65a] FCM sent user=aaaaaaaa device=tauri-a-b platform=android inlineProto=true`, 'notable'],
  ['a push from a reactivation catch-up', `${NEST}[MessagingService] [PUSH_SEND][reactivate-33f8f65a] FCM sent user=aaaaaaaa device=tauri-a-b platform=android inlineProto=true`, 'notable'],
  // THE CATCH-UP'S OWN OUTCOME LINE, logged only when it moved something (`:1595`).
  ['a reactivation that re-notified is reported with its count', `${NEST}[MessagingService] [ACTIVATION_REDELIVER][reactivate-33f8f65a] group=00000000-0000-4000-8000-000000000001 device=aaaaaaaa:tauri-a-b redelivered=1`, 'notable'],
  // AND ITS FAILURE TWIN, which wears the SAME tag, carries NO trace id and is a `warn` - so it must
  // not ride in on the rule above. A catch-up that threw is a device left un-notified.
  ['a reactivation that threw is forgiven by nothing', `${NEST}[MessagingService] [ACTIVATION_REDELIVER] group=00000000-0000-4000-8000-000000000001 device=aaaaaaaa:tauri-a-b FAILED: boom`, 'unexplained'],
  // A TOKEN BEING STORED IS NOT A NOTIFICATION BEING SENT. The handler 400s when the body carries
  // neither token, so this line always means a write happened and there is nothing to decide.
  ['a device rotating its push token is routine', `${NEST}[PushController] [PUSH_REFRESH] user=aaaaaaaa device=tauri-a-b fcm=true voip=false`, 'benign'],
];
for (const [name, line, want] of fcmCallers) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}

// THE INVITE-AND-JOIN FAMILY, seventeen unexplained lines on GRP's window of 2026-08-23 and the
// first phase in the campaign to build a group by LINK. Every pair below is one tag whose two
// spellings must land in opposite buckets - which is the only thing that can go wrong here, and it
// cannot be seen on a live window: a swallowed refusal just makes the pile SMALLER.
const invite = [
  // The capability is minted, and nothing has changed for anybody yet.
  ['an invite created is not an invite accepted', `${NEST}[InvitationsController] [GROUP_INVITE] created group=00000000-0000-4000-8000-000000000001 by=aaaaaaaa`, 'benign'],
  // Somebody became a member. This is the line that changes who can read the group.
  ['a join admits a person and says how many devices came with them', `${NEST}[InvitationsController] [GROUP_INVITE] accepted group=00000000-0000-4000-8000-000000000001 user=aaaaaaaa devices=2`, 'notable'],
  // The landing page resolving a token to a group name, anonymous and read-only, at DEBUG.
  ['an anonymous invite preview is a read', `[Nest] 1  - 08/14/2026, 12:43:51 PM   DEBUG [InternalController] internal group invite preview token=fVcgu-Y-`, 'benign'],
  // The last step of a join...
  ['a membership going active is the end of a join', `${NEST}[MessagingService] [MEMBERSHIP_ACTIVE] group=00000000-0000-4000-8000-000000000001 device=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy`, 'benign'],
  // ...and the branch twenty lines above it in the same function, which wears the SAME tag and means
  // a device that believes it joined will never be routed to.
  ['a membership REFUSED is not a membership active', `${NEST}[MessagingService] [MEMBERSHIP_ACTIVE] REFUSED group=00000000-0000-4000-8000-000000000001 device=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy reason=no_key_package`, 'notable'],
  // A membership destroyed. Both counts at zero is a removal that found nothing, not a quiet success.
  ['a member removed is reported whatever the counts say', `${NEST}[MembersController] [REMOVE_MEMBER] group=00000000-0000-4000-8000-000000000001 user=aaaaaaaa redisRemoved=0 deviceMembershipsDeleted=0`, 'notable'],
  // Rare, deliberate, and visible to every member at once.
  ['a rename is a change every member sees', `${NEST}[GroupsController] [RENAME_GROUP] group=00000000-0000-4000-8000-000000000001 newName="a name"`, 'notable'],
  // THE WELCOME PROTOCOL: the ask and the per-member walk are chatter...
  ['a welcome request arriving is not an outcome', `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] START group=00000000-0000-4000-8000-000000000001 requester=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy members=3`, 'benign'],
  ['a candidate being weighed is not an outcome', `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] Candidate=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy online=false`, 'benign'],
  // ...and the four outcomes are not. `NO_PEER_ONLINE` is a device that cannot decrypt anything
  // until somebody comes back; `REDIS_EMPTY`/`DB_FALLBACK` are the primary path having failed.
  ['a welcome forwarded is an outcome', `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] FORWARDED target=bbbbbbbb:web-bbbbbbbb-msglwqh6-vegy group=00000000-0000-4000-8000-000000000001 requester=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy`, 'notable'],
  ['a welcome nobody can answer is an outcome', `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] NO_PEER_ONLINE group=00000000-0000-4000-8000-000000000001 requester=aaaaaaaa:web-aaaaaaaa-msglwqh6-vegy - stored in Redis, FCM sent to peers`, 'notable'],
  ['the routing cache answering nothing is a fallback, not a path', `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] REDIS_EMPTY - falling back to DB for group=00000000-0000-4000-8000-000000000001`, 'notable'],
  // THE PREKEY POOL, BOTH DIRECTIONS, AND THEY ARE NOT THE SAME KIND OF EVENT. Publishing refills
  // the pool and is high-volume chatter; pruning EMPTIES it, one id per Welcome the device consumed,
  // and the failure it leads to - a device nobody can add to a group any more - arrives as a
  // silence. DEL-7's cold start printed `deleted=12` and it was the only unexplained line in the
  // window, 2026-08-24.
  ['refilling the prekey pool is chatter', `${NEST}[DevicesController] [REGISTER_PREKEYS] user=aaaaaaaa device=web-aaaaaaaa-msglwqh6-vegy count=50`, 'benign'],
  ['spending the prekey pool is reported, with its count', `${NEST}[DevicesController] [PRUNE_PREKEYS] user=aaaaaaaa device=tauri-aaaaaaaa-msglwqh6-vegy deleted=12`, 'notable'],
  // A prune that deleted NOTHING is still the shape worth seeing: the device named ids the server
  // did not have, which is the two sides disagreeing about what was spent.
  ['a prune that found nothing is reported too', `${NEST}[DevicesController] [PRUNE_PREKEYS] user=aaaaaaaa device=tauri-aaaaaaaa-msglwqh6-vegy deleted=0`, 'notable'],
];
for (const [name, line, want] of invite) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}

// AND THE ONE THIS FAMILY DELIBERATELY LEAVES ALONE. A member key that does not parse is corruption
// in the routing set itself; `unexplained` breaks `clean`, which is exactly where a run should stop.
const malformed = `${NEST}[MessagingService] [WELCOME_REQ][welcome-req-81fb5450] Malformed group member entry='nonsense' group=00000000-0000-4000-8000-000000000001`;
const malformedOk = !matches(BENIGN_RULES, malformed) && !matches(NOTABLE_RULES, malformed);
if (!malformedOk) failures++;
console.log(`${malformedOk ? 'ok  ' : 'FAIL'} unexplained a malformed member entry is forgiven by nothing`);

// THE NO-TOKEN RULE IS KEYED ON ITS LOG SITE, NOT ON ONE CALLER - and the pin that survives it.
// `messaging.service.ts:414` is reached by `send-`, `welcome-send-` and `reactivate-`; the rule
// named `send-` alone, so the same decision about the same device read benign from one caller and
// unexplained from another. Widening the prefix must not widen `device=(web|ios)-`: a WEB device
// has no FCM token by construction, an ANDROID one that has none is a phone nobody can reach.
const welcomeNoToken = `${NEST}[MessagingService] [PUSH_SEND][welcome-send-81fb5450] No push token for user=aaaaaaaa device=web-aaaaaaaa-msglwqh6-vegy`;
const androidNoToken = `${NEST}[MessagingService] [PUSH_SEND][welcome-send-81fb5450] No push token for user=aaaaaaaa device=tauri-aaaaaaaa-msglwqh6-vegy`;
const prefixOk =
  matches(BENIGN_RULES, welcomeNoToken) &&
  !matches(BENIGN_RULES, androidNoToken) &&
  !matches(NOTABLE_RULES, androidNoToken);
if (!prefixOk) failures++;
console.log(`${prefixOk ? 'ok  ' : 'FAIL'} benign       any caller may lack a web token, no android device may`);

// THE REST OF A BOOT, and the third-party warning that rides in with it. The route table was
// classified from a window that started mid-deploy; the deploy of 2026-08-24 landed at the top of
// one instead and the same single boot arrived with six shapes nobody had seen.
const boot = [
  ['nest announcing itself', `${NEST}[NestFactory] Starting Nest application...`, 'benign'],
  ['a module finishing its wiring', `${NEST}[InstanceLoader] TypeOrmCoreModule dependencies initialized +38ms`, 'benign'],
  // EVERY KAFKA SPELLING IS UNEXPLAINED NOW, AND THAT IS THE POINT. These six lines were forgiven
  // while chat-delivery connected a Kafka transport and chat-gateway consumed `post.created`. Both
  // went on 2026-08-31 along with the broker, so no service can print any of them: a rule still
  // forgiving them would forgive whatever RE-INTRODUCED a transport, silently, in a window nobody
  // reads twice. The kafkajs warning goes with them - the package is in no `package.json` at all.
  ['a microservice starting where none should', `${NEST}[NestMicroservice] Nest microservice successfully started +1ms`, 'unexplained'],
  ['a consumer group being joined', `${NEST}[ServerKafka] INFO [ConsumerGroup] Consumer has joined the group {"timestamp":"2026-08-21T20:06:21.247Z","groupId":"chat-delivery-consumer-server"}`, 'unexplained'],
  ['a kafka consumer coming up', `${NEST}[ServerKafka] INFO [Consumer] Starting {"timestamp":"2026-08-23T23:20:57.602Z","logger":"kafkajs","groupId":"chat-delivery-consumer-server"}`, 'unexplained'],
  // kafkajs 2.2.4 scheduled its throttle check at `this.throttledUntil - Date.now()` with
  // `throttledUntil = -1`, so the delay was minus the wall clock. Three lines, once per process.
  ["kafkajs's negative throttle timer", '(node:1) TimeoutNegativeWarning: -1787527257599 is a negative number.', 'unexplained'],
  ['the clamp it reports', 'Timeout duration was set to 1.', 'unexplained'],
  ['the hint Node prints after it', '(Use `node --trace-warnings ...` to show where the warning was created)', 'unexplained'],
  // A negative timeout of OUR OWN making was never forgiven either, and its case is kept because it
  // is the one this family could still plausibly produce.
  ['a negative timeout that is not the wall clock', '(node:1) TimeoutNegativeWarning: -4200 is a negative number.', 'unexplained'],
];
for (const [name, line, want] of boot) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}

// And a line nobody has classified must match nothing at all, or `unexplained` can never fill.
const stranger = `${NEST}[SomethingService] a sentence no rule has ever seen`;
const strangerOk =
  !matches(BENIGN_RULES, stranger) &&
  !matches(NOTABLE_RULES, stranger) &&
  !matches(EXPECTED_ERROR_RULES, stranger);
if (!strangerOk) failures++;
console.log(`${strangerOk ? 'ok  ' : 'FAIL'} unexplained an unknown line matches no rule`);

// THE ASSOCIATION CMS, twenty-three unexplained lines across a GRP-6 window on 2026-08-24 and the
// reason its server verdict was dirty on five passes out of six while every check inside it passed.
// The rules that forgive them are admitted only because prod is the test server, and the pairs below
// are what keeps that admission narrow: the two spellings that must stay UNEXPLAINED cannot be
// caught on a live window, because a rule grown too wide only makes the pile SMALLER.
const cms = [
  // Reads by an admin, at DEBUG, on routes the campaign owns no subject for.
  ['listing categories is a read', `${NEST}[AssociationCategoriesService] list categories`, 'benign'],
  ['listing poster projects is a read', `${NEST}[PosterService] list poster projects`, 'benign'],
  ['loading one poster layout is a read', `${NEST}[PosterService] get poster project a533b4f1-9c08-48e6-9a23-488be49207b2`, 'benign'],
  // Edits to the same layout. Forgiven because they name a poster, never one of our subjects.
  ['editing a poster layout changes nothing we measure', `${NEST}[PosterService] update poster project a533b4f1-9c08-48e6-9a23-488be49207b2`, 'benign'],
  ['publishing one is the same', `${NEST}[PosterService] publish poster project a533b4f1-9c08-48e6-9a23-488be49207b2`, 'benign'],
  ['and so is withdrawing it', `${NEST}[PosterService] unpublish poster project a533b4f1-9c08-48e6-9a23-488be49207b2`, 'benign'],
  ['reordering an association members is a mutation on an association', `${NEST}[AssociationsService] reorderMembers: 3 members reordered in bcdac607-eed0-4d94-b4f3-f44882897f52`, 'benign'],
  // THE TWO NEAR-MISSES, and the point of this table. `create` names a SUBJECT and `remove` destroys
  // one; both share every other word with the six lines above, so a rule anchored on the service
  // rather than the sentence would have swallowed them silently. Neither has appeared in a window
  // yet, and the day either does it must be a finding and not a forgiven line.
  ['creating a poster names the person who did it', `${NEST}[PosterService] create poster project by aaaaaaaa`, 'unexplained'],
  ['destroying one is never routine', `${NEST}[PosterService] remove poster project a533b4f1-9c08-48e6-9a23-488be49207b2`, 'unexplained'],
];

// THE SESSION/DEVICE PAIR, one function in `auth-sessions.service.ts` writing both, seven lines
// apart, and they must NOT share a bucket. The DEBUG one is the ordinary end of a login and was the
// last unexplained line in the GRP-6 window of 2026-08-24. The WARN one is sessions being DESTROYED
// because two of them claimed one device, and it reaches a reader through the broad `revoke` rule in
// NOTABLE - which is where this pair earns its keep: the new benign rule is spelt to the sentence,
// so widening it to the service would have moved a real revocation into the silent bucket and left
// only the harmless half visible.
const sessionDevice = [
  ['a session learning its device is the end of a login', `${NEST}[AuthSessionsService] Session sid=5d3174de-c729-40f1-8239-8b5005af27f7 bound to device web-aaaaaaaa-msg9s7q3-pvaj`, 'benign'],
  ['a session revoked for claiming a device reaches a reader', `${NEST}[AuthSessionsService] Revoked 2 unreachable session(s) claiming device web-aaaaaaaa-msg9s7q3-pvaj for user=aaaaaaaa - kept sid=5d3174de-c729-40f1-8239-8b5005af27f7`, 'notable'],
];
for (const [name, line, want] of sessionDevice) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}
for (const [name, line, want] of cms) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}

// THE COMMUNITY SURFACE, twelve unexplained lines on every COMM window until 2026-08-25 - the whole
// phase's server traffic, unclassified, because no earlier rung creates a community, invites anybody
// into one, polls in it or deletes it. Read once, named here, and pinned for the two ways it can rot:
// a spelling nobody re-reads, and a rule widened past the sentence it was written for.
const comm = [
  // THE ESTATE. A creation is the line every later sweep descends from; the group it is given is that
  // creation's own chatter, and the read a client does afterwards is one line per workspace load.
  ['a community coming into existence is the line an estate descends from', `${NEST}[ChannelService] [WORKSPACE] create name="A Name With Spaces" slug="a-name" (requested="a-name") by=aaaaaaaa`, 'notable'],
  ['the key group a creation is given is that creation talking', `${NEST}[ChannelService] [WORKSPACE] distribution group workspace=00000000-0000-4000-8000-000000000001 group=00000000-0000-4000-8000-000000000002`, 'benign'],
  // BOTH SPELLINGS OF `published=`, because the unpublished one is the state BEFORE an answer and
  // filing it as dirty would make the ordinary case break `clean` (COMM-22, 74 of them in one run).
  //
  // AND THE EPOCH PAIR THE SERVER ADDED AFTER THESE FIXTURES WERE TAKEN, which is the reason this
  // block is being rewritten rather than extended. The lines here were copied verbatim from
  // production on 2026-08-14; the server started printing `base=` and `active=` later, and because
  // the FIXTURE and the RULE both spoke the old dialect the self-test stayed green while every real
  // seed read on prod fell into `unexplained`. A fixture is only evidence for the sentence the
  // server is actually writing TODAY, so a rule change here is a fixture change too - always.
  ['an unpublished group with no devices is the ordinary state before an answer', `${NEST}[ChannelService] [DISTRIBUTION_GROUP] served workspace=00000000-0000-4000-8000-000000000001 user=aaaaaaaa group=00000000-0000-4000-8000-000000000002 published=false base=none active=4 devices=0`, 'benign'],
  ['and so is a published one with a roster', `${NEST}[ChannelService] [DISTRIBUTION_GROUP] served workspace=00000000-0000-4000-8000-000000000001 user=aaaaaaaa group=00000000-0000-4000-8000-000000000002 published=true base=4 active=4 devices=3`, 'benign'],
  // THE STALE BASE ITSELF, which is what the epochs were printed FOR: `published=true` says a seed
  // exists, `base < active` says the commit gate will refuse it every time (COMM-8). Forgiving this
  // alongside its healthy twin is the exact way a rule "matches too much", so it is pinned in the
  // one bucket that breaks `clean`.
  ['a published seed BEHIND the active epoch is the defect, not the ordinary case', `${NEST}[ChannelService] [DISTRIBUTION_GROUP] served workspace=00000000-0000-4000-8000-000000000001 user=aaaaaaaa group=00000000-0000-4000-8000-000000000002 published=true base=3 active=4 devices=3`, 'unexplained'],
  ['the graine half of the same read is forgiven only when its epochs agree', `${NEST}[ChannelService] [CHANNEL_GRAINE] served channel=00000000-0000-4000-8000-000000000001 user=aaaaaaaa group=00000000-0000-4000-8000-000000000002 published=true base=7 active=7 devices=2`, 'benign'],
  ['and stays visible when they do not', `${NEST}[ChannelService] [CHANNEL_GRAINE] served channel=00000000-0000-4000-8000-000000000001 user=aaaaaaaa group=00000000-0000-4000-8000-000000000002 published=true base=6 active=7 devices=2`, 'unexplained'],
  // THE DELIVERY-SIDE TWIN, a different service and a different field order. It carries `user=` and
  // `devices=` AFTER the epochs, so one regex could never have covered both and the pair has to be
  // pinned separately or half of it rots unnoticed - which is what happened.
  ['the internal read is the same sentence from the other service', `${NEST}[InternalController] [DISTRIBUTION_GROUP] read scope=channel:00000000-0000-4000-8000-000000000001 group=00000000-0000-4000-8000-000000000002 published=true base=9 active=9 user=aaaaaaaa devices=1`, 'benign'],
  ['and it is not forgiven with a base behind the active epoch either', `${NEST}[InternalController] [DISTRIBUTION_GROUP] read scope=channel:00000000-0000-4000-8000-000000000001 group=00000000-0000-4000-8000-000000000002 published=true base=8 active=9 user=aaaaaaaa devices=1`, 'unexplained'],
  // THE GRANT PAIR, the community twin of `[GROUP_INVITE]` above and split the same way: the preview
  // is an anonymous read, the acceptance is a person who can now read the community's traffic.
  ['a channel invite preview is a read', `[Nest] 1  - 08/14/2026, 12:43:51 PM   DEBUG [InternalInvitesController] internal channel invite preview token=fVcgu-Y-`, 'benign'],
  ['an invite minted says what it revoked', `${NEST}[ChannelService] [INVITE] created workspace=00000000-0000-4000-8000-000000000001 by=aaaaaaaa expiresAt=never maxUses=unlimited replaced=0`, 'notable'],
  ['an invite with a limit is the same event, not a new one', `${NEST}[ChannelService] [INVITE] created workspace=00000000-0000-4000-8000-000000000001 by=aaaaaaaa expiresAt=2026-09-01T00:00:00.000Z maxUses=5 replaced=2`, 'notable'],
  ['a join admits a person to everything the community says', `${NEST}[ChannelService] [INVITE] accepted workspace=00000000-0000-4000-8000-000000000001 user=aaaaaaaa`, 'notable'],
  // THE POLL TRIPLET. Two are content; the third ends the thing and turns every further vote into a
  // 403, which is the whole subject of COMM-15.
  ['posting a poll is content', `${NEST}[ChannelService] [POLL] created channel=00000000-0000-4000-8000-000000000003 message=00000000-0000-4000-8000-000000000004 options=3 endsAt=none`, 'benign'],
  ['voting in one is a write into that content', `${NEST}[ChannelService] [POLL] vote channel=00000000-0000-4000-8000-000000000003 message=00000000-0000-4000-8000-000000000004 user=aaaaaaaa options=1`, 'benign'],
  ['retracting a vote is still a vote', `${NEST}[ChannelService] [POLL] vote channel=00000000-0000-4000-8000-000000000003 message=00000000-0000-4000-8000-000000000004 user=aaaaaaaa options=0`, 'benign'],
  ['closing one is an authority acting on a message', `${NEST}[ChannelService] [POLL] closed channel=00000000-0000-4000-8000-000000000003 message=00000000-0000-4000-8000-000000000004 by=aaaaaaaa`, 'notable'],
  // THE DESTRUCTION PAIR, and the reason the four reasons are spelt out rather than matched loosely.
  ['a community destroyed states what went with it', `${NEST}[ChannelService] [WORKSPACE] hard delete workspace=00000000-0000-4000-8000-000000000001 channels=2 privateGroups=0 reason=admin_deleted`, 'notable'],
  ['the last member leaving destroys it too', `${NEST}[ChannelService] [WORKSPACE] hard delete workspace=00000000-0000-4000-8000-000000000001 channels=2 privateGroups=1 reason=last_member_left`, 'notable'],
  // A FIFTH REASON WOULD BE A NEW CALLER NOBODY HAS CLASSIFIED, and that is a finding, not noise.
  ['a reason no caller writes is unexplained on purpose', `${NEST}[ChannelService] [WORKSPACE] hard delete workspace=00000000-0000-4000-8000-000000000001 channels=2 privateGroups=0 reason=something_new`, 'unexplained'],
  ['and the act names who asked and how many lost a room', `${NEST}[ChannelService] [WORKSPACE] delete workspace=00000000-0000-4000-8000-000000000001 slug="a-name" by=aaaaaaaa members=2`, 'notable'],
  // THE TWO SCANNER FAMILIES ADDED WITH THEM, and the near-miss that keeps the second one honest:
  // `/api/` is a namespace this application OWNS, so only the fingerprinted path itself is forgiven.
  ['a GeoServer probe is a scanner, like its five neighbours', '[404] GET /geoserver/web/', 'notable'],
  ['so is the version endpoint it tries next', '[404] GET /api/v1/version', 'notable'],
  ['but a 404 anywhere else under /api is ours to explain', '[404] GET /api/v1/channels', 'unexplained'],
  ['and a 200 on a scanned path is not a scanner finding nothing', '[200] GET /geoserver/web/', 'unexplained'],
];
for (const [name, line, want] of comm) {
  const got = matches(NOTABLE_RULES, line) ? 'notable' : matches(BENIGN_RULES, line) ? 'benign' : 'unexplained';
  check(`${want.padEnd(11)}  ${name}`, got, want);
}

// --- settleFirstLooks: the rule whose predicate is a COUNT, not a line ------------------------
// The one rule in this file that no per-line list can express, and therefore the one that would
// otherwise be untestable. Both directions are pinned, because forgiving the singleton is worthless
// if it also forgives the pair - that pair is the concurrent-join race, and the ONLY thing that has
// ever caught it.
const READ = (g) =>
  `${NEST}[InternalController] [DISTRIBUTION_GROUP] read scope=workspace:00000000-0000-4000-8000-000000000001 group=${g} published=false base=none active=1 user=aaaaaaaa devices=0`;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const OTHER = `${NEST}[MessagingService] something nobody has classified`;

check('one first look per group is narration', settleFirstLooks([READ(G1)]), [READ(G1)]);
check('two groups looked at once are two narrations, not a race', settleFirstLooks([READ(G1), READ(G2)]), [
  READ(G1),
  READ(G2),
]);
// THE WHOLE POINT. Two reads of the SAME group is the shape the rule exists for, and it has to
// survive its own relaxation.
check('TWO first looks at the SAME group is the race, and stays', settleFirstLooks([READ(G1), READ(G1)]), []);
check('the race is not forgiven by a third party being present', settleFirstLooks([READ(G1), READ(G1), READ(G2)]), [
  READ(G2),
]);
// A count-based rule that swept up its neighbours would be worse than the noise it removes.
check('it touches nothing else in the bucket', settleFirstLooks([OTHER]), []);
check('a published=true read is not its business', settleFirstLooks([READ(G1).replace('published=false', 'published=true')]), []);
// `devices=0` is load-bearing: a read reporting devices means somebody has already joined, which is
// a different sentence and not this rule's to move.
check('nor is a read that found devices', settleFirstLooks([READ(G1).replace('devices=0', 'devices=2')]), []);
// THE FIELDS THE SERVER ADDED BETWEEN `published=` AND `user=`. This predicate is anchored on both
// sides of them, so it stopped matching the moment they appeared and settled nothing at all - and a
// count-based rule fails SILENTLY in a way a per-line rule does not, because there is no bucket left
// holding its population to look wrong. Pinned so the next field lands as a red line here.
check(
  'a read written in the pre-epoch dialect is no longer the sentence the server writes',
  settleFirstLooks([READ(G1).replace(' base=none active=1', '')]),
  []
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
