/**
 * THE THIRD OBSERVER: production's own logs, classified the way the browser's are.
 *
 *   node srvlog.mjs --since 2026-08-14T11:00:00Z    everything since an instant
 *   node srvlog.mjs --since 15m                     everything in the last 15 minutes
 *   node srvlog.mjs --since 15m --raw               every line, unclassified
 *   node srvlog.mjs --since 15m --shapes            distinct unexplained SHAPES, with counts
 *
 * WHY IT EXISTS. The campaign's bar is that every log line is expected - "y compris dans les logs
 * web, mobile, et serveur" - and two of those three had an instrument. `watch.mjs` classifies the
 * browser, `logcatSince` classifies the phone, and the server was read by hand, occasionally, with
 * `docker logs | tail`. A tail answers "what happened last", never "was anything in this window
 * unexpected", and the two questions have different answers on a quiet service: a single ERROR
 * eight hundred lines back is invisible to both.
 *
 * SAME SHAPE AS `report()` ON PURPOSE. Buckets, not a filter: `severe` and `errors` break `clean`,
 * `notable` is reported and does not, and anything matching nothing at all lands in `unexplained` -
 * which breaks `clean` too, because a line nobody has classified is a line whose meaning nobody
 * knows. Widening `BENIGN` after READING a line is the intended fix; never looking is not.
 *
 * It reads `docker logs`, so it sees only what the container has kept - and only containers, so
 * anything nginx terminates before the app is out of scope.
 */
import { pathToFileURL } from 'node:url';
import { ssh } from './ssh.mjs';

/** The application containers. Infrastructure (redis, kafka, postgres, garage) is deliberately out. */
const SERVICES = [
  'chat-gateway',
  'chat-delivery-service',
  'core-service',
  'media-service',
  'social-service',
  'call-service',
  'frontend-ssr',
];

/** Tracing and Nest both colour their output; every pattern below would miss on the escape codes. */
const ANSI = /\[[0-9;]*m/g;

/**
 * Routine traffic. Each entry is one thing the platform does on the happy path of a delivery check,
 * and each is here because it was READ first.
 */
const BENIGN = [
  // The gateway routing one frame to one connected device - three lines per recipient per message,
  // which is most of the volume of any MSG run.
  /\[PubSub\] route kind=/,
  /Looking for connected user:/,
  /\[Gateway\] Message directly routed to/,
  // The delivery service's send and ack traces. `DONE queued=N realtime=N` is the success line.
  /\[SEND\]\[send-[0-9a-f]+\] (START|QUEUED|PUBLISHED|DONE|recipient=)/,
  /\[ACK\]\[ack-[0-9a-f]+\] (START|DONE)/,
  /\[HISTORY\]\[send-[0-9a-f]+\] XADD/,
  /\[GroupsController\] \[GET_GROUP\] .* found=true/,
  // THE LOCK LIFECYCLE, BOTH LOCKS, BOTH ENDS. `[COMMIT] START` and `ACCEPT` are already notable
  // (they move an epoch); the lock lines around them move nothing and are pure bookkeeping - yet
  // `Lock released` was the single most frequent unexplained shape of the TYPE run, a near-miss on
  // a rule that already covered the interesting half. An acquisition that FAILS is a different line
  // and is deliberately not matched here.
  /\[COMMIT\]\[commit-[0-9a-f]+\] Lock released for group=/,
  /\[(ADD_LOCK|RELEASE_LOCK)\] group=\S+ owner=\S+ (acquired|released)=true/,
  // AND THE FAILED ACQUISITION, WHICH THE RULE ABOVE DELIBERATELY LEFT OPEN. Decided here with
  // both ends read rather than by widening that pattern to `(true|false)`, because the two failures
  // are not the same event and only one of them is routine.
  //
  // `acquired=false` IS THE LOCK DOING ITS JOB. `locks.controller.ts` is a plain `SET NX EX`, and
  // its only caller is the pending-invitation sweep (`actions.ts:170`), which on a false logs
  // `lock held by another device - skip` and CONTINUES - no alternative path, no retry storm, the
  // holder completes the Add and the loser picks it up on its next sweep. Every owner runs that
  // sweep on every device it has, so an owner with three devices in one group produces two of these
  // by construction. That is mutual exclusion, not contention to investigate; GRP's window on
  // 2026-08-24 carried three, on three different groups, all from one owner's two web devices.
  //
  // WHAT WOULD BE THE REAL SIGNAL IS A RATE, NOT A LINE: the same group failing to be acquired for
  // longer than the 30 s TTL means the holder died mid-Add. No single line can say that, so nothing
  // here pretends to - it is what the queue-depth report and `[COMMIT]` in NOTABLE are for.
  /\[ADD_LOCK\] group=\S+ owner=\S+ acquired=false ttl=\d+s/,
  // A membership read. It answers a question; it changes nothing.
  /\[MembersController\] \[GET_USER_MEMBERS\] group=\S+ count=\d+/,
  // Presence, which every connected client refreshes continuously. CASE-INSENSITIVE because the
  // gateway writes `[presence]` and the delivery service `[Presence]`, and the capitalised pattern
  // left every one of the gateway's 55 presence lines in `unexplained` for the whole campaign.
  /\[presence\]|presence key|user:online:/i,
  // THE GATEWAY'S CONNECTION AND ROUTING TRACE - one WS frame in, one routing decision out. Between
  // them these are most of the platform's log volume, and all of it is the happy path: a socket
  // opening, a device registering, a typing or disconnect frame arriving, a frame being routed to
  // the members the gateway believes are online.
  /chat_gateway::handlers: Received WS JSON frame from /,
  /\[WS RX\] from=\S+ type=(typing|disconnect|ping|pong|read|presence)\b/,
  /\[ROUTE\] type=(typing|read|presence) group=/,
  /New WebSocket connection: User=/,
  /Registered connection key: /,
  /\[Gateway\] Channel event distributed to connected users/,
  // An ORDERLY close - the client sent a close frame and said why. This is what a disconnection is
  // supposed to look like, and it is the counterpart of the `Connection reset` error below, which
  // is the same event without the courtesy.
  // Both forms: `Some(CloseFrame { … })` when the client said why, `None` when it just went away at
  // the WebSocket layer without one. Neither is the ERROR below - that is the TCP being reset under
  // a live socket, which is a third thing again.
  /Client closed connection: (Some\(CloseFrame|None)/,
  // The membership lookup behind every route and every send. High volume by construction.
  /\[MembersController\] \[GET_MEMBERS\] group=\S+ count=\d+/,
  /\[DevicesController\] \[REGISTER_PREKEYS\] user=/,
  /\[SecurityController\] \[LINK_PREVIEW\] cache (hit|miss) /,
  // The push fan-out succeeding, and the reason a web device gets no push: it has no FCM token, by
  // construction. `failed=` is pinned to zero here so a failure cannot ride in on this pattern - the
  // non-zero form is NOTABLE below.
  //
  // `type=\S+ ` IS NOT OPTIONAL DECORATION - IT IS WHY THIS PATTERN WENT BLIND. The line is
  // `[INTERNAL_PUSH] type=${data.type ?? 'none'} user=...`, so the field is ALWAYS there, and a
  // pattern written before it went from matching every push to matching none. Found on READ's own
  // run, 2026-08-21: four `unexplained` lines on a phase that pushed exactly as it should, two of
  // them this very shape. A stale pattern does not announce itself - it reads as new noise - and the
  // NOTABLE twin below had gone blind in the same edit, which is the half that matters: a push that
  // FAILED would have been filed as unexplained instead of as the thing a reader looks for.
  /\[InternalController\] \[INTERNAL_PUSH\] type=\S+ user=\S+ sent=\d+ failed=0\b/,
  // ONE LOG SITE, SEVERAL CALLERS, AND A RULE THAT KNEW ONLY ONE OF THEM. The line is written once,
  // at `messaging.service.ts:414`, on a push path `makeTraceId` labels after whoever entered it -
  // `send`, `welcome-send`, `reactivate`. This pattern named `send-` alone, so the SAME no-token
  // decision about the SAME kind of device read as benign when a message queued it and as
  // unexplained when a Welcome did. One line of GRP's window on 2026-08-23 was exactly that, a
  // `welcome-send-`. Keyed on the site's own shape now, which is what makes it caller-proof.
  //
  // `device=(web|ios)-` STAYS PINNED, and it is the entire discrimination this rule makes. A web
  // device has no FCM token by construction and no iOS build here has registered one; an ANDROID
  // device with no push token is a phone that cannot be reached, which is the finding COMM exists to
  // make. Widening the prefix must never widen that.
  /\[PUSH_SEND\]\[[\w-]+-[0-9a-f]+\] No push token for user=\S+ device=(web|ios)-/,
  // THE PER-DEVICE HALF OF THE SAME FAN-OUT, and it is LOAD-BEARING rather than merely benign:
  // `comm14.mjs` reads these lines as its instrument - they are how a check knows a push decision
  // was taken and for whom - so they may not be quietened, only classified. One per device that
  // actually received something, and the no-token case beside it for the reason `PUSH_SEND` above
  // gives: a device that never registered a token is a fact about the device, not an event.
  //
  // `sent ` and `No token ` are PINNED, so the three failing shapes of this family cannot ride in
  // here - they are NOTABLE below.
  /\[MessagingService\] \[SOCIAL_PUSH\]\[social-push-[0-9a-f]+\] sent user=\S+ device=\S+/,
  /\[MessagingService\] \[SOCIAL_PUSH\]\[social-push-[0-9a-f]+\] No token for user=\S+/,
  // A DEVICE ROTATING ITS PUSH TOKEN, which is the step that makes it reachable at all - and the
  // only shape `push.controller.ts:376` can write, since the handler rejects a body carrying neither
  // token (`:371`) with a 400 rather than logging. So `fcm=` and `voip=` are never both `false` and
  // there is nothing here for a reader to decide: the write already happened.
  //
  // BENIGN THOUGH IT IS AN FCM FACT, unlike the `PUSH_SEND` pair above, because it says a token was
  // STORED, not that a notification was attempted - `comm14.mjs` reads the sending lines and never
  // this one. It was the fourth shape of GRP's stopped window of 2026-08-25, and the only one the
  // run itself already forgave: it belonged to a third party, so `subjects` partitioned it out and a
  // CLI call with no subjects showed it. Classified rather than left to that partition, because the
  // NEXT one will be OURS - every campaign client that boots after a token rotation writes one.
  /\[PushController\] \[PUSH_REFRESH\] user=\S+ device=\S+ fcm=(true|false) voip=(true|false)$/,
  // Housekeeping and one real user playing the anti-bot minesweeper. Neither is about this campaign.
  /\[AuthSessionsService\] Swept \d+ expired session\(s\)/,
  // A SESSION BEING OPENED, which is what a login IS. Every phase that starts, reloads or reconnects
  // a client mints one, so a campaign window without these would be the surprising result. Benign
  // here does not weaken the security signal: the line that MATTERS on this service is
  // `Refresh token replay detected`, which is in SEVERE and not adjacent to this pattern.
  /\[AuthSessionsService\] Session opened sid=\S+ user=\S+/,
  // AND THE STEP RIGHT AFTER IT: the session being stamped with the device it belongs to, once, the
  // first time that pair is seen. Every login by a client the box has not carried before writes one,
  // so W1 and W2 produce them all through a campaign - and this was the LAST unexplained line in the
  // GRP-6 window of 2026-08-24, dirtying a server verdict on its own.
  //
  // ITS SIBLING IS DELIBERATELY LEFT OUT, and it is the reason this rule is spelt to the sentence
  // rather than the tag. Seven lines above it in the same function, the same service writes
  // `Revoked N unreachable session(s) claiming device ... - kept sid=...` at WARN: a session really
  // being destroyed because two of them claimed one device. That one reaches a reader through the
  // broad `revoke` rule in NOTABLE, and a rule anchored on `AuthSessionsService` would have pulled
  // it down here into the silent bucket instead. The self-test pins the pair for that reason.
  /\[AuthSessionsService\] Session sid=\S+ bound to device \S+$/,
  /\[MinesweeperService\] minesweeper (challenge started|score ok) /,
  // THE CLIENT BOOTSTRAP, server side. Every one of these is a client coming up and asking for what
  // it needs: its groups, one page of each group's history, its pending mailbox, its key package,
  // its invitations. A check that reloads a client (MSG-10) or reconnects one (MSG-9) replays the
  // whole set, and all of them were in `unexplained` on the run of 2026-08-14.
  /\[MembersController\] \[USER_GROUPS\]/,
  /\[MessagingService\] \[HISTORY(_BATCH)?\]/,
  /\[MessagingService\] \[MSG_FETCH\]\[fetch-msg-[0-9a-f]+\] (START|DONE)/,
  /\[DevicesController\] \[REGISTER_DEVICE\]\[[^\]]+\] (START|DONE)/,
  /\[InvitationsController\] \[PENDING\]\[[^\]]+\] (START|DONE)/,
  // THE MIDDLE BRANCH OF THE SAME ENDPOINT, and the fourth near-miss on an existing rule in a row.
  // The pattern above covers `START` and `DONE`; `invitations.controller.ts:249` returns EARLY when
  // the asking device holds no ACTIVE membership in any group, and that early return logs its own
  // line and never reaches `DONE`. Read at the source rather than from its wording: it is the
  // bootstrap of a device that has enrolled but has not yet joined anything, `[]` is the correct
  // answer, and a rule anchored on the two happy-path words could never have covered it.
  /\[InvitationsController\] \[PENDING\]\[[^\]]+\] No active membership for /,
  // THE GRAINE HALF OF THE SAME BOOTSTRAP, and it is the largest single shape in `unexplained`:
  // 294 lines of it on the COMM-17 run of 2026-08-21. A client asks each scope it can see for that
  // scope's key-distribution group when it loads - one read per community and per private salon, on
  // both services, twice per load because two sweeps run. That is one line per SCOPE, by
  // construction, and the count is a statement about how many salons the test accounts are in (the
  // debris `cleanup.mjs` exists to cut), not about the product.
  //
  // `published=true` IS PINNED AND `devices=` DELIBERATELY IS NOT. A read answering
  // `published=false` on a group somebody should already have published is exactly the shape that
  // found the concurrent-join race the same morning - two callers, both reading an unpublished
  // group, both creating it - so that form stays unexplained and visible. `devices=0` is left
  // classified because it is the ORDINARY answer before a first join, and pinning it would bury
  // every legitimate join in this bucket to catch a case the CLIENT already logs and accuses.
  /\[InternalController\] \[DISTRIBUTION_GROUP\] read scope=(workspace|channel):\S+ group=\S+ published=true user=\S+ devices=\d+/,
  /\[ChannelService\] \[CHANNEL_GRAINE\] served channel=\S+ user=\S+ group=\S+ published=true devices=\S+/,
  /\[ChannelService\] \[DISTRIBUTION_GROUP\] served workspace=\S+ user=\S+ group=\S+ published=true devices=\S+/,
  // The live-session census a client asks for when it opens a community. One line per load.
  /\[GRAINE\] liveGraineSessions user=\S+ asked=\d+ live=\d+/,
  // A media upload succeeding. The blob is opaque to the server by construction (the client holds
  // the CEK), so the size is all it can report and there is nothing else to say about it.
  /\[MediaController\] Stored encrypted blob:/,
  // The channel fan-out publishing to Redis. It used to reprint the whole event - ciphertext and
  // the entire recipient list - on every publish; since 2026-08-14 it carries a byte count instead,
  // which is all the line was ever worth. Kept classified either way: it is expected traffic.
  /\[RedisService\] Published to chat:channel_events:/,
  /\[ChannelService\] \[CHANNEL_PUSH\] channel=\S+ message=\S+ recipients=\d+/,
  // NOT OURS, AND ATTRIBUTED RATHER THAN GUESSED. `[404] POST /inform` arrives on the SSR server
  // every ~18 seconds; nothing in the client bundle or the SSR output contains that path, and the
  // nginx log names the caller: `"AirControl Agent v1.0"` from 10.0.0.47 - a Ubiquiti access point
  // on the LAN looking for its UniFi controller, which answers `inform` on that path. It found this
  // host instead.
  //
  // Benign for Canari and a real waste for the operator: ~4 800 requests a day, each answered with a
  // 10 KB SvelteKit error page. The fix is on the access point, not in this repository, so it is
  // classified here rather than left to make every run dirty for ever.
  /^\[404\] POST \/inform$/,
  // A crawler guessing the WordPress/Yoast convention. VERIFIED rather than waved through: this site
  // serves `/sitemap.xml` (200) and has no `/sitemap_index.xml`, so the 404 is the correct answer to
  // a request for something that was never claimed to exist. Deliberately spelt out path by path -
  // a general `[404] GET` rule would forgive a 404 on a route the application really does own, which
  // is the one thing this bucket must never hide.
  /^\[404\] GET \/sitemap_index\.xml$/,
  // The same crawler convention, one guess further: a gzipped sitemap. `/sitemap.xml` is served and
  // no compressed variant was ever advertised, so 404 is again the correct answer to a request for
  // something this site does not claim. Spelt out as its own path for the reason above.
  /^\[404\] GET \/sitemap\.xml\.gz$/,
  // AN AD-TECH CRAWLER ASKING FOR THE IAB CONVENTION FILE. Same family as the two sitemap guesses
  // and verified the same way: `app-ads.txt` declares who may sell an app's ad inventory, Canari
  // carries no advertising at all and has never claimed the path, so 404 is the correct answer.
  // Spelt out per path for its neighbours' reason - a general `[404] GET /*.txt` would forgive
  // `/robots.txt`, which this site really does serve.
  /^\[404\] GET \/app-ads\.txt$/,
  // A VULNERABILITY SCAN PROBING FOR SYMFONY'S DEBUG PROFILER, which exposes configuration and
  // environment to anyone who can reach it. Canari is not PHP and has never routed `/_profiler`, so
  // 404 is the correct answer and there is nothing behind it to protect. Classified rather than
  // silenced: 2 hits in the 24 h to 2026-08-25, which is what an opportunistic scanner looks like
  // and what a defect does not - our own code cannot request a path it never emits.
  /^\[404\] GET \/_profiler\/phpinfo$/,
  // A MALFORMED URI FROM SOMETHING CRAWLING THE PUBLIC SITE - `about:` is a browser SCHEME, not a
  // path, and a client that turns it into one is guessing. VERIFIED before forgiving, because this
  // one is the near-miss the bucket must never hide: `frontend/src/routes/` has no `about` route at
  // all, and nothing in the bundle or the SSR output emits the string, so this is not a broken link
  // of ours arriving one colon wrong. 5 hits in the 24 h to 2026-08-25 - sparse and irregular, where
  // a route the application really owned would fire on every page load.
  /^\[404\] GET \/about:$/,
  // A BROWSER FETCHING THE TAB ICON, and AN iOS DEVICE FETCHING THE HOME-SCREEN ICON. Both files are
  // SERVED now (2026-08-17), which is what makes these rules narrow: only a SUCCESS is benign.
  //
  // They used to forgive any status, because at the time all three convention paths answered 404 and
  // `frontend/static/` held only `favicon.png` / `favicon.svg`. That was the correct classification
  // for the WINDOW - a server answering 404 to a path it does not have is not a server defect - and
  // the missing asset was filed as a P3 rather than merely silenced here. It has since shipped, so
  // the reading inverts: a 404 on either path now means the ASSET IS GONE from the build, which is a
  // defect on the one surface nobody looks at after a deploy. Leaving `\d+` here would have hidden
  // exactly the regression the fix created the opportunity for.
  /^\[(?:200|304)\] GET \/favicon\.ico$/,
  /^\[(?:200|304)\] GET \/apple-touch-icon\.png$/,
  // The precomposed spelling is the one that stays a 404 on purpose: `app.html` declares
  // `apple-touch-icon` explicitly, so Safari has no reason to probe the convention path at all. A
  // request for it comes from something older that guesses, and 404 is the honest answer - Canari
  // never claimed that path and does not need a second copy of the same image to satisfy it.
  /^\[404\] GET \/apple-touch-icon-precomposed\.png$/,
  // The sitemap being built to answer a request for `/sitemap.xml`. Worth one note: the occurrence
  // that first raised this line was the HARNESS - a `curl` run to check whether that route existed
  // at all, while classifying the 404 above. The instrument shows up in the record it is reading,
  // which is a reason to date probes, not a reason to filter them out.
  /^\[SEO\] sitemap: \d+ static/,
  // The public association listing - an ordinary anonymous read of the public site.
  /\[PublicController\] public listAssociations/,
  // The same thing for a published poster, and its service line under it: one anonymous GET, answered
  // successfully, at DEBUG. It arrived mid-run on 2026-08-14 and was the ONLY thing keeping the MSG
  // window dirty - traffic from the live site, which prod being the test server makes routine rather
  // than surprising. Spelt out per endpoint like the 404s above: a blanket `PublicController` rule
  // would forgive a public route failing, which is the one thing this bucket must never hide.
  /\[PublicController\] public getPublishedCarte/,
  /\[PosterService\] getPublished: serving \S+/,
  // And ONE association's public page, by slug - the third endpoint of the same anonymous public
  // site, and the same story one day later. It appeared mid-READ on 2026-08-15 and was, beside the
  // avatar errors, the only thing keeping a five-pass window dirty: a real visitor reading a real
  // association's page while the campaign happened to be running. It carries NO user id, so subject
  // partitioning cannot exonerate it - which is exactly why it needs a rule and not a subject.
  // Spelt per endpoint, for its neighbours' reason: a public route FAILING must stay a finding.
  /\[PublicController\] public getBySlug /,
  // THE REFRESH GRACE WINDOW ACCEPTING A SECOND CALLER - the mechanism succeeding, not a fault.
  //
  // A page load fires several API calls at once; if the access token has expired, more than one hits
  // 401 and refreshes concurrently, presenting the SAME `jti`. The first rotates it. Without a grace
  // window the second would look exactly like a stolen cookie, and `auth-sessions.service.ts` answers
  // theft by DELETING the session - so the line classified here is the one standing between a
  // concurrent refresh and a spurious logout. It is at DEBUG, and it is the good outcome.
  //
  // Spelt out to its exact wording on purpose. The same function logs
  // `Refresh token replay detected sid=... - session revoked` twelve lines further down, which is a
  // session really being destroyed; a rule loose enough to cover both would hide the only one that
  // matters. That one is named in SEVERE below rather than left to `unexplained`.
  /\[AuthSessionsService\] Concurrent refresh accepted sid=\S+ \(grace window\)/,
  // THE GROUP LIFECYCLE, WHICH EVERY CHECK THAT BUILDS A GROUP PRODUCES AND NOTHING CLASSIFIED.
  // Twenty-four unexplained lines from one READ-10 run on 2026-08-21, all of them its own fixture:
  // create, add member, welcome, invitation status. Each is a step reporting that it completed, and
  // the check that asked for it asserts the OUTCOME directly - a group that was not created fails on
  // its own post-condition, not on a missing log line. The failing spellings are elsewhere: a refused
  // membership mutation throws and lands in `errors`, and `SEND ... No message queued` is a warn.
  /\[GroupsController\] \[CREATE_GROUP\]\[create-grp-[0-9a-f]+\] (name=|creator membership set to active|DONE )/,
  /\[MembersController\] \[ADD_MEMBER\]\[add-member-[0-9a-f]+\] (START|DONE) group=/,
  /\[MessagingService\] \[WELCOME\]\[welcome-send-[0-9a-f]+\] (START|QUEUED|DONE) /,
  /\[InvitationsController\] \[INVITATION_STATUS\] device=\S+ user=\S+ group=\S+ newStatus=(active|pending)/,
  // THE INVITE-LINK HALF OF THE SAME LIFECYCLE, unclassified until now because no phase had ever
  // built a group by LINK: GRP is the first, and these were six of its seventeen unexplained lines
  // on 2026-08-23. Minting an invite changes nothing for anybody - it creates a capability and waits
  // - and the preview is the invitation landing page resolving that token to a group name so a
  // visitor can see what they were invited to. Anonymous, read-only, at DEBUG, and the token is
  // already truncated to eight characters where it is logged.
  //
  // `accepted` IS DELIBERATELY NOT HERE. That one is a person becoming a member, and it sits in
  // NOTABLE with the rest of the membership changes.
  /\[InvitationsController\] \[GROUP_INVITE\] created group=\S+ by=\S+$/,
  /\[InternalController\] internal group invite preview token=\S+$/,
  // THE COMMUNITY TWIN OF THE PAIR ABOVE, from a different controller and about a different object -
  // a channel invite rather than a DM group's. `accepted` is likewise NOT here: it is a person
  // becoming a member of a community, and it sits in NOTABLE with `created`.
  /\[InternalInvitesController\] internal channel invite preview token=\S+$/,
  // THE KEY GROUP A NEW COMMUNITY IS GIVEN, printed by the creation that made it. One line per
  // `[WORKSPACE] create`, always, and never on its own - so it is the creation's chatter and the
  // creation is the event, which is in NOTABLE. The OUTCOME this pair leads to,
  // `[DISTRIBUTION_GROUP] published`, is in NOTABLE too; this is the middle of that sentence.
  /\[ChannelService\] \[WORKSPACE\] distribution group workspace=\S+ group=\S+$/,
  // A CLIENT ASKING WHERE A COMMUNITY'S KEYS LIVE - one line per GET, which is one per workspace
  // load and one per join, on every device. Measured: 74 of them in a single COMM run of 2026-08-25.
  //
  // BOTH VALUES OF `published=` ARE ORDINARY, and that is the whole point of not pinning one.
  // `published=false devices=0` is what a community looks like between the row being written and the
  // first client initialising the MLS group - the state BEFORE an answer, not a negative one - and a
  // client that read it as an eviction is the defect fixed on 2026-08-25 (COMM-22). Filing either
  // spelling as unexplained would make the ordinary case dirty and teach a reader to skip the tag.
  //
  // Its FREQUENCY is the thing worth a second look, not its existence, and a rule cannot carry a
  // rate. Nothing here forgives the refusal twin: `[DISTRIBUTION_GROUP] refused` is in NOTABLE.
  /\[ChannelService\] \[DISTRIBUTION_GROUP\] served workspace=\S+ user=\S+ group=\S+ published=(true|false) devices=(\d+|\?)$/,
  // A POLL BEING POSTED AND VOTED IN, which is content and not an event: the send is an ordinary
  // channel message that happens to carry `metadata.poll`, and a vote is a write into it. Every
  // check that produces these asserts the OUTCOME on the two clients' screens, so a missing line
  // here could never be the finding.
  //
  // `options=0` on a vote is a RETRACTION and is deliberately inside the same rule - it is still a
  // vote write, and the campaign's own checks retract on purpose (COMM-15). What is NOT here is the
  // closure: `[POLL] closed` ends the thing early, unpins it, and is in NOTABLE.
  /\[ChannelService\] \[POLL\] created channel=\S+ message=\S+ options=\d+ endsAt=\S+$/,
  /\[ChannelService\] \[POLL\] vote channel=\S+ message=\S+ user=\S+ options=\d+$/,
  // A DEVICE'S MEMBERSHIP GOING ACTIVE - the last step of every join, one line per device. The check
  // that caused it asserts the outcome directly: a device that is not addressable fails on its own
  // post-condition, never on a missing log line.
  //
  // `\[MEMBERSHIP_ACTIVE\] group=` IS THE PIN, and the `$` with it. Twenty lines up the same tag
  // writes `[MEMBERSHIP_ACTIVE] REFUSED group=... reason=...` - identical prefix, opposite outcome -
  // so a rule anchored on the tag alone would have buried the refusal in here. It is in NOTABLE.
  /\[MessagingService\] \[MEMBERSHIP_ACTIVE\] group=\S+ device=\S+$/,
  // THE PER-REQUEST CHATTER OF THE WELCOME PROTOCOL, whose OUTCOMES are all in NOTABLE below. A
  // device that has just been added asks the group for the Welcome that lets it decrypt anything;
  // the service prints the ask, then walks the member list one line at a time. `HISTORY_REQ`, its
  // twin, has neither line - it logs outcomes only - which is why this family needed rules of its
  // own instead of the ones already written next door.
  //
  // `Candidate=` IS LOAD-BEARING RATHER THAN MERELY BENIGN, in the sense the SOCIAL_PUSH fan-out
  // above is: it is the evidence `NO_PEER_ONLINE` rests on, the per-member `online=` saying whether
  // anybody COULD have answered. Classified so a window stays readable, never quietened.
  /\[WELCOME_REQ\]\[welcome-req-[0-9a-f]+\] START group=\S+ requester=\S+ members=\d+$/,
  /\[WELCOME_REQ\]\[welcome-req-[0-9a-f]+\] Candidate=\S+ online=(true|false)$/,
  // A SEND WITH NOBODY TO SEND TO, which during an invite is the ordinary path: the group exists and
  // the invitee has not joined it yet, so there is no other device to queue for. Benign only in THIS
  // spelling - the sibling sentence, every recipient offline on a transport frame, is a rendezvous
  // that will expire unanswered and sits in NOTABLE. The two were one sentence until 2026-08-21.
  /\[SEND\]\[send-[0-9a-f]+\] No message queued after validation - recipients=0 durable=\S+ - the group named no other device/,
  // ASSOCIATION AND PARTNERSHIP MANAGEMENT, which this campaign does not measure and cannot attribute.
  //
  // Not a whitelist of convenience, and the reason is worth reading. `isThirdParty` needs a 64-hex id
  // to tell somebody else's traffic from ours - and social-service logs ids TRUNCATED TO EIGHT, so no
  // line it writes can ever be attributed that way. These two arrived while another contributor was
  // building the shop feature on the same production server, inside our observation window, and read
  // as ours to explain. The board has no row for a partnership card; a campaign whose server verdict
  // turns on one is measuring the wrong thing.
  //
  // Narrow on purpose: `create card` and `added N code(s)`, not `^\[PARTNERSHIP\]`. The claim path
  // (`claim gate`, `claimed`) names a USER and is left alone - it is a real transaction, and the day
  // it appears in one of our windows we want to see it.
  /\[PartnershipsService\] \[PARTNERSHIP\] create card: association=[0-9a-f]{8} mode=\S+/,
  /\[PartnershipsService\] \[PARTNERSHIP\] added \d+ code\(s\) to card=[0-9a-f]{8}/,
  // THE ASSOCIATION CMS BEING USED BY AN ADMIN WHILE THE CAMPAIGN RAN - the same story as the two
  // partnership lines above, one feature further along, and the reason a GRP-6 window was reported
  // NOT CLEAN on five passes out of six on 2026-08-24 while every check inside it passed.
  //
  // ATTRIBUTION IS CERTAIN HERE, WHICH IS WHY THESE ARE ALLOWED AT ALL. Every poster route sits
  // behind `GlobalAdminOrBdeSuperAdminGuard`, so the caller is a global admin or a BDE super-admin,
  // and the campaign owns no such subject and has no row for a poster layout. The shape of the run
  // says the same thing on its own: get, update, get, update, unpublish, publish, inside twenty-one
  // seconds, which is a person in an editor and not a fixture.
  //
  // THEY EXIST BECAUSE PROD IS THE TEST SERVER, and they stop existing when that stops being true:
  // `dev.canari-emse.fr` becomes a real second environment after the campaign (CLAUDE.md, decided
  // 2026-08-17), and this whole block should be DELETED with that move rather than carried across
  // it. It buys a readable server verdict for the campaign running now, and nothing more.
  //
  // NARROW, PER MESSAGE, AND ONLY WHAT WAS READ - the rule this file states about itself. Two
  // spellings of the same family are deliberately absent: `create poster project by <user>` names a
  // subject, and `remove poster project` destroys one. Neither has appeared in a window yet, and the
  // day either does we want to see it.
  /\[AssociationCategoriesService\] list categories$/,
  /\[PosterService\] list poster projects$/,
  /\[PosterService\] (get|update|publish|unpublish) poster project [0-9a-f-]{36}$/,
  // One association's member list being reordered - a mutation, forgiven for its neighbours' reason:
  // it names an ASSOCIATION, never one of our subjects, and no check reads a member order.
  /\[AssociationsService\] reorderMembers: \d+ members reordered in [0-9a-f-]{36}$/,
  // A CONTAINER'S BOOT BANNER - ONE BOOT SAID A HUNDRED AND SIX TIMES.
  //
  // A redeploy landing inside an observation window put 106 unexplained lines into the READ phase on
  // 2026-08-21 and failed its server verdict while all ten checks passed. Every one of them was Nest
  // printing its own route table: 90 `RouterExplorer Mapped`, 14 `RoutesResolver`, the microservice
  // start, and kafkajs joining its consumer group. Not one carries information about the run.
  //
  // SILENT HERE BECAUSE THE BOOT IS ALREADY LOUD SOMEWHERE ELSE. `[NestApplication] Nest application
  // successfully started` is in NOTABLE and stays there, so a restart under a check is still SEEN -
  // once, in one line, which is the whole content of the event. That is the discrimination being
  // made: the fact that a service restarted is worth a line; the identical route table it prints
  // every single time is not. Demoting the announcement and keeping the table would be the exact
  // inversion, and `[CRON] ... scheduled` and `[FIREBASE] Admin SDK initialized` - which DO differ
  // between builds - are deliberately left classified as they were.
  //
  // Shaped tightly enough that only a boot matches. `Mapped {<route>, <VERB>} route` needs both
  // braces and the trailing word; `RoutesResolver` needs a controller name and a mount path. A
  // runtime line cannot accidentally wear either.
  /\[RouterExplorer\] Mapped \{[^}]*\} route/,
  /\[RoutesResolver\] \w+Controller \{[^}]*\}:/,
  /\[NestMicroservice\] Nest microservice successfully started/,
  /\[ServerKafka\] INFO \[ConsumerGroup\] Consumer has joined the group /,
  // THE THREE BOOT LINES THAT COME BEFORE THE ROUTE TABLE, and they were missed for the reason the
  // block above was written at all: the window that produced that rule started mid-deploy, so Nest's
  // FIRST lines were outside it and only its route table was inside. The deploy of 2026-08-24 landed
  // at the top of a window instead, and the same one boot arrived with six more shapes. Same
  // argument, unchanged: `Nest application successfully started` in NOTABLE is how a restart under a
  // check is SEEN, and none of these says anything the boot has not already said once.
  /\[NestFactory\] Starting Nest application\.\.\.$/,
  /\[InstanceLoader\] \w+ dependencies initialized \+\d+ms$/,
  /\[ServerKafka\] INFO \[Consumer\] Starting \{/,
  // A BUG IN KAFKAJS, READ IN KAFKAJS, AND NOT FIXABLE FROM HERE - one Node warning per boot, in
  // three lines because that is how `process.emitWarning` prints.
  //
  //     (node:1) TimeoutNegativeWarning: -1787527257599 is a negative number.
  //     Timeout duration was set to 1.
  //
  // ATTRIBUTED RATHER THAN GUESSED, and the arithmetic is the attribution. `requestQueue/index.js`
  // initialises `this.throttledUntil = -1` (l.57) and schedules its throttle check at
  // `this.throttledUntil - Date.now()` (l.312); with no request pending, nothing clamps it, so the
  // delay IS minus the wall clock. -1787527257599 is `-1 - 1787527257598`, and 1787527257598 is
  // 2026-08-23T23:20:57Z - the second the line was printed. Nothing else could produce that number.
  //
  // Harmless: Node floors the delay at 1 ms, the callback runs `checkPendingRequests()` against an
  // empty queue, and `TimeoutNegativeWarning` is emitted ONCE PER PROCESS by Node itself, so it can
  // never flood a window. Not fixable either - kafkajs 2.2.4 is the project's last release and has
  // been unmaintained since 2023, so there is no version to move to. Classified here for the reason
  // the AirControl 404 above is: the fix is not in this repository, and leaving it would make every
  // window straddling a deploy dirty for ever.
  //
  // THE MAGNITUDE IS THE PIN, because the line does not carry its origin. Node prints the same
  // sentence whoever computed the delay, so a rule on the sentence alone would forgive a negative
  // timeout of OURS - and the only reason this one is forgiven is that somebody read where it came
  // from. What cannot be faked is the number: `-1 - Date.now()` is minus the wall clock, thirteen
  // digits opening `17` today and `18` from 2027-01-15. Our own code computing a delay late would be
  // out by seconds or minutes, never by fifty-six years, so it will not match and will be read.
  //
  // It stops matching around 2033, when the epoch grows a digit. That is the correct failure: the
  // line returns to `unexplained` and somebody reads it again.
  /^\(node:\d+\) TimeoutNegativeWarning: -1[78]\d{11} is a negative number\.$/,
  /^Timeout duration was set to 1\.$/,
  /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/,
  // THE DISMISSAL NO-OPS, whose loud siblings are in NOTABLE above. Asking that a group not be
  // dismissed when it never was is the ordinary path through every re-add, and asking twice from two
  // devices is what one re-add looks like on an account with two. Nothing changed, so nothing is
  // claimed - but the request is still named here rather than dropped from the rules, so that the
  // day these outnumber the lifts by a factor nobody expected, the count is in the window.
  /\[MembersController\] \[(DISMISS|UNDISMISS)\] user=\S+ group=\S+ (recorded|lifted)=0/,
  // A SERVICE THE CAMPAIGN NEVER TOUCHES, ANSWERING SOMEBODY ELSE. `core-service` produced three
  // lines in the whole of GRP's first pass and one of them was this: a DEBUG row count on an
  // internal formations listing, which is the cross-service read the portal makes and which no chat
  // check can cause or prevent. Named rather than dropped, so that the day the count changes shape -
  // an error beside it, or one per second - it is a line in the window and not an absence.
  /\[InternalUsersController\] internal formations listing rows=\d+/,
  // AND THE OTHER PRODUCT ASKING A QUESTION ABOUT OUR USERS. `GET /api/public/cotisant-status` is Le
  // Cercle's INBOUND check - its own wiki names when it fires, "sign-in, and every session
  // rotation" (`le-cercle/src/lib/server/canari/memberships.ts`) - so the caller is a different
  // application on a public endpoint, and no chat check can cause it or prevent it. That is the
  // `internal formations listing` case again, and it earns the same disposition rather than a new
  // argument.
  //
  // It was the ONE unexplained server line in the whole of GRP's first pass on 2026-08-25, and it
  // read as a flake because it appeared in that pass alone - which is exactly what "somebody else's
  // traffic" looks like from inside a five-pass run. Named rather than dropped, for the reason the
  // line above gives: the day it arrives once a second, or with an error beside it, the count is in
  // the window instead of the silence being mistaken for absence.
  //
  // The `sub` is truncated to eight characters where it is logged (`public.controller.ts:179`), so
  // the rule can be written tightly without the pattern itself naming anybody.
  /\[PublicController\] \[CERCLE\] cotisant-status assoSlug=\S+ sub=[0-9a-f]{8}/,
];

/**
 * Reported, never silent, and never fatal on its own - the server equivalent of `NOTABLE`.
 *
 * `FALLBACK_MEMBERS_CACHE` USED TO HEAD THIS LIST, and refusing to file it as routine is what
 * eventually got it read. It fired on every send observed on 2026-08-14, always paired with
 * `recipients=0` in the START line above it, and the reason turned out to be that NO caller has
 * ever populated `recipients`: the branch calling itself a Redis cache miss was the only path the
 * proto send has, for a cache it never consulted (WP-SENDPATH-1a). The line is gone with it.
 *
 * `MEMBERS_CACHE_REPAIRED` replaces it and is deliberately NOT here: it is a warn that fires only
 * when the reconciliation actually added a device to the gateway's routing set, which means an
 * owner did not write and the gateway was silently unable to reach that device. It belongs in
 * `unexplained` so a campaign run stops on it.
 */
const NOTABLE = [
  /welcome_request|history_request|history_bundle|history_digest/i,
  // A USER'S PIN VERIFIER INVALIDATED, ON PURPOSE, ONCE. `legacy=true` says a row existed with a
  // null salt, so the verifier it held was derived from the old predictable one and could never
  // match a verifier derived from the new random salt - the row is replaced and that user re-registers
  // their PIN. Correct, and never routine: it is user-visible, and it is a migration, so the number
  // that matters is per user. ONE line for an account is the migration doing its job; a SECOND for
  // the same account means the row is not sticking and every PIN that account sets is being thrown
  // away, which is a defect and would show here as a repeat rather than as anything louder.
  /\[SecurityController\] \[PIN_SALT\] new salt generated for \S+ \(legacy=(true|false)\)/,
  // A LOCK THAT WAS GONE BEFORE ITS HOLDER RELEASED IT. The other half of the failed-lock split in
  // BENIGN, and the half that is NOT routine: `releaseAddLock`'s Lua script deletes the key only if
  // this device still owns it, so `released=false` means the value changed underneath - the 30 s TTL
  // expired mid-Add, or another device overwrote it. Either way an Add ran longer than the window
  // sized for the worst-case mobile path, which is the shape a stuck or very slow commit takes.
  // Shown, never fatal: one is a slow phone, a run of them on one group is the thing to chase.
  /\[RELEASE_LOCK\] group=\S+ owner=\S+ released=false/,
  // TWO THINGS A BOOT DOES THAT ITS ROUTE TABLE DOES NOT, and they are the reason the banner above
  // was demoted to BENIGN rather than the whole boot being waved through.
  //
  // FIREBASE IS A CAPABILITY DECLARING ITSELF. Real push is the one thing the harness has never
  // proved (COMM-14), so the line that says the Admin SDK came up is the only positive evidence in
  // any window that push COULD have worked. An absence is unnoticeable unless the presence is shown.
  /\[AppController\] \[FIREBASE\] Admin SDK initialized/,
  // A DEVICE TELLING THE SERVER WHICH OF ITS ONE-TIME PREKEYS ARE SPENT, and the count is the
  // point. `pruneOneTimePrekeys` is client-driven: the device names ids it has consumed and the
  // server deletes exactly those (`devices.controller.ts:536`), so the line is expected on a client
  // that has been away and is reconciling - DEL-7's cold start printed `deleted=12`, one per Welcome
  // the phone had processed while it was the only thing running.
  //
  // NOTABLE RATHER THAN BENIGN, because a prekey pool is CONSUMED and must be refilled: the failure
  // this number leads to is a device nobody can add to a group any more, and it arrives as a silence
  // rather than as an error. A prune with no `[REGISTER_PREKEYS]` behind it is the shape of that,
  // and only a reported count lets a reader see the two together.
  /\[DevicesController\] \[PRUNE_PREKEYS\] user=\S+ device=\S+ deleted=\d+/,
  // A DESTRUCTIVE SWEEP RUNNING INSIDE AN OBSERVATION WINDOW. Every container start replays every GC
  // job once, a minute in - message cleanup, soft-deleted group purge, orphaned member rows, stale
  // invitations. Each is age-gated, so a boot-time run deletes only what was already eligible and the
  // behaviour is right: a box that was down for a week catches up instead of waiting for its tick.
  // It is still a deletion pass crossing a measurement, and a check whose fixture vanished deserves
  // to find this in its own window rather than reconstruct it from a deploy timestamp afterwards.
  /\[AppController\] \[CRON\] initial sweep: (running every GC job once|done)/,
  // A RENDEZVOUS NOBODY CAN ANSWER. The other half of the `No message queued` warning: a transport
  // frame is addressed to whoever is online now, expires in 60 s, and had recipients - all offline.
  // Nothing is lost that was durable, and nothing will answer either, so it is shown and never fatal.
  /\[SEND\]\[send-[0-9a-f]+\] No message queued after validation - recipients=[1-9]\d* .* every recipient device is offline/,
  // A CHANNEL'S NOTIFICATION LEVEL CHANGING, which decides whether a push is routed to that user at
  // all. Rare (a person sets it and leaves it), consequential, and exactly what you want in the
  // window when asking why somebody did or did not get notified - so it is reported, never silenced.
  // Nothing had classified it because no check had ever set a level: MENTION-2 and MENTION-3 are the
  // first, and they made a whole phase read SERVER NOT CLEAN for four lines of their own doing
  // (2026-08-22).
  /\[ChannelService\] \[CHANNEL_PUSH\] level set channel=\S+ user=\S+ level=(all|mentions|none)/,
  // A DEVICE REGISTERING ITS PUSH TOKEN, which is what makes it reachable at all. Written on every
  // app START, so a phase that relaunches the phone emits one per launch - MENTION-3 arms it twice
  // and produced exactly two (2026-08-22), which is the shape to expect rather than a surprise.
  // NOTABLE and not benign: it is the row that decides where a push can land, and when a device
  // stops getting notifications this is the first line worth looking for in the window.
  /\[PushController\] \[PUSH_REGISTER\] user=\S+ device=\S+ platform=\S+/,
  // A PERSON'S DISMISSAL MARKER ACTUALLY MOVING. It outlives the group deliberately (it is a fact
  // about what someone chose, not about the group), so it is the one row a group's purge must NOT
  // take - and it is worth seeing whenever it moves. Both directions, because they are opposites.
  //
  // ON THE COUNT, NOT ON THE ENDPOINT, and that is the whole point of the count existing. `POST
  // dismissed-groups` is an upsert and `DELETE` is an ensure-not-dismissed, so both are called on
  // paths where nothing is there to change: every Welcome lifts a dismissal that usually does not
  // exist, once PER DEVICE for a marker that is per USER. Matching the endpoint made a two-device
  // re-add print two notable lines for zero events. `recorded=0` / `lifted=0` are the no-ops and sit
  // in BENIGN; only a marker that moved reaches a reader.
  //
  // VERIFIED AGAINST PRODUCTION 2026-08-22, which is why this is no longer a rule proven only by its
  // own self-test. READ-10 (`--only 10 --destructive`) is the one check that generates dismissal
  // traffic, and one run produced both branches and nothing else: `recorded=1` once, and `lifted=0`
  // TWICE for the same user and group - the per-device lift of a per-user marker this comment
  // predicts, arriving exactly as described. The window classified clean, so each landed in its own
  // bucket rather than in `unexplained`.
  /\[MembersController\] \[(DISMISS|UNDISMISS)\] user=\S+ group=\S+ (recorded|lifted)=[1-9]\d*/,
  /epoch|re-?add|revoke|forget/i,
  /retention|purge|evict/i,
  /queue depth|QUEUE_DEPTH|page capped by bytes/i,
  // THE HOURLY BACKLOG REPORT, WHICH THE RULE ABOVE MISSED BY A SPACE. It logs `reportQueueDepth:`
  // in camelCase, so `queue depth` never matched it and `QUEUE_DEPTH` never matched it either - the
  // report that WP-PENDING-2 exists to be read by was landing in `unexplained` once an hour. It is
  // notable and not benign on purpose: it names the deepest devices on the fleet, and a number that
  // climbs there is the whole point of having written it.
  /\[CRON\] reportQueueDepth:/,
  // THE RECONCILIATION PROTOCOL, SERVER SIDE. The pattern above matches `history_request` with an
  // underscore; the service logs `[HISTORY_REQ]`, so every forwarded and unanswerable history ask
  // was landing in `unexplained` instead of the bucket a reader looks at. `NO_PEER_ONLINE` is the
  // one that matters most: a device asked to be repaired and nobody could answer.
  /\[HISTORY_REQ\]\[history-req-[0-9a-f]+\] (FORWARDED|NO_PEER_ONLINE|DELIVERED|EXPIRED)/,
  // THE OTHER HALF OF THE SAME PROTOCOL, and the same near-miss one more time. The generic rule at
  // the top of this list matches `welcome_request` with an underscore - the payload type - while the
  // service tags its lines `[WELCOME_REQ]`, so every forwarded and every unanswerable ask for a
  // Welcome was landing in `unexplained` for exactly as long as `HISTORY_REQ` did. Same verbs and
  // the same reason: `NO_PEER_ONLINE` is a device asking to be let into a group with nobody able to
  // answer, and until someone comes back it cannot decrypt a single message.
  //
  // THE FALLBACK PAIR IS HERE ON PURPOSE AND IS NOT ROUTINE. `REDIS_EMPTY` says the routing cache
  // answered nothing for a group that has members, and `DB_FALLBACK` is the repair that follows.
  // Reaching either means the primary path failed, so they are reported every time rather than
  // filed away as a path - neither appeared in the window that prompted these rules, and both are
  // classified from the source rather than from a sighting.
  //
  // `Malformed group member entry=` IS DELIBERATELY LEFT UNCLASSIFIED. A member key that does not
  // parse is corruption in the routing set itself, and `unexplained` - which breaks `clean` - is
  // precisely where a run should stop on it.
  /\[WELCOME_REQ\]\[welcome-req-[0-9a-f]+\] (FORWARDED|NO_PEER_ONLINE|REDIS_EMPTY|DB_FALLBACK)/,
  // A MEMBERSHIP BEING DESTROYED, and the two counts that say what the removal actually reached.
  // Unlike the dismissal no-ops in BENIGN, this is never a by-product of another path: somebody
  // asked for a person to be taken out of a group. Both counts at zero is not a quiet success
  // either - it is a removal that found nothing to remove - so the whole shape is reported and no
  // part of it is pinned.
  /\[MembersController\] \[REMOVE_MEMBER\] group=\S+ user=\S+ redisRemoved=\d+ deviceMembershipsDeleted=\d+/,
  // THE MOMENT A PERSON BECOMES A MEMBER, the only line in the invite family that changes who can
  // read a group. `devices=` counts the devices brought in with them, and zero is the shape worth
  // waiting for: a join that admitted nobody.
  /\[InvitationsController\] \[GROUP_INVITE\] accepted group=\S+ user=\S+ devices=\d+/,
  // A KEY-DISTRIBUTION GROUP COMING INTO EXISTENCE, once per community or salon by construction.
  // `notable` rather than `benign` for the reason every line in this list is: a check that creates a
  // community produces exactly one and it is narration, while a check that creates NONE and prints
  // this has had a scope built under it, which is the finding. Its siblings - `published`,
  // `group-info`, `deleted` - are already here; this was the one spelling with no rule at all, and
  // it sat in `unexplained` through all six COMM-18 runs.
  /\[InternalController\] \[DISTRIBUTION_GROUP\] created scope=(?:workspace|channel):\S+ group=\S+/,
  // A DEVICE REFUSED ADDRESSABILITY - the opposite outcome to the BENIGN line it shares a tag with.
  // It carries `reason=`, and it means a device that believes it joined will not be routed to.
  /\[MessagingService\] \[MEMBERSHIP_ACTIVE\] REFUSED group=\S+ device=\S+ reason=/,
  // A GROUP BEING RENAMED - rare, deliberate, and visible to every member at once. Cheap to report,
  // and the kind of thing a reader asking what changed under their run wants named rather than
  // inferred. The new name is user content and is logged in full; `logs/` is gitignored, which is
  // as far as it travels.
  /\[GroupsController\] \[RENAME_GROUP\] group=\S+ newName=/,
  // A send deliberately not persisted because its recipient is offline and its payload would go
  // stale before they returned - the rendezvous TTL. Correct by design, never routine.
  /TRANSPORT_SKIPPED_OFFLINE/,
  // A push that did not reach someone it was meant to reach. `type=\S+ ` for the reason its EXPECTED
  // twin states: the field is always present, so without it this pattern matched NOTHING - between
  // the day `type=` was added and 2026-08-21, a failed push was unexplained rather than notable.
  /\[INTERNAL_PUSH\] type=\S+ user=\S+ sent=\d+ failed=[1-9]/,
  // THE THREE WAYS THE PER-DEVICE PUSH GOES WRONG, each sending its reader somewhere different.
  // `FCM failed` is the send refused. `deleted invalid token` is the server pruning a token the
  // provider called dead, which is worth seeing because it explains a silent device on the NEXT run.
  // `Firebase not initialized` is the whole capability absent, which would turn every push check in
  // the campaign into a vacuous pass. None gates on its own - a stale token is normal after a
  // reinstall - but a window holding one is not a window a reader should have to re-derive.
  /\[SOCIAL_PUSH\]\[social-push-[0-9a-f]+\] FCM failed user=/,
  /\[SOCIAL_PUSH\]\[social-push-[0-9a-f]+\] deleted invalid token user=/,
  /\[SOCIAL_PUSH\] Firebase not initialized/,
  // THE PUSH PATH, WHICH ONLY RUNS WHEN THE SOCKET DID NOT DO THE JOB. `PUSH_DEFERRED` says a frame
  // sat unACKed long enough to fall back to FCM, and `FCM sent` is that fallback leaving. Neither is
  // a defect - it is the outbox working - but both say a device was not keeping up, which is the
  // most useful thing a reader can learn from a window that otherwise looks idle.
  //
  // NARROWED TO THE TWO SENDING SHAPES ON PURPOSE. The first draft matched `[PUSH_SEND]` outright
  // and swallowed `No push token for user=`, which is deliberately BENIGN - a device that never
  // registered one is a fact about the device, not an event in this window. The self-test caught it,
  // which is what it is for: a rule that matches too much moves a real signal into a bucket that
  // does not break `clean`.
  //
  // AND THE TWO RULES BELOW ARE KEYED DIFFERENTLY ON PURPOSE, because the two log sites have a
  // different number of callers - which is the only thing that decides how wide a trace-id key may
  // be. `PUSH_DEFERRED` (`messaging.service.ts:546`) is reached from `scheduleDeferredPush`, whose
  // sole caller is the `send` path, so `send-` IS its site's shape and widening it would forgive a
  // caller that cannot exist. `FCM sent` (`:490`) is `sendFcmForQueued`, reached by FOUR callers -
  // `send`, `send-…-def`, `welcome-send`, `reactivate` - so a key naming one of them makes the SAME
  // push read notable from one entry point and unexplained from another. It did: GRP's window of
  // 2026-08-25 stopped a 5-pass run at pass 1 on thirteen lines, eleven of them `welcome-send-` and
  // one `reactivate-`, every one of them a push that left correctly. The BENIGN twin above had
  // already been widened for this exact reason and this rule was missed in that edit.
  /\[PUSH_DEFERRED\]\[send-/,
  /\[PUSH_SEND\]\[[\w-]+-[0-9a-f]+(?:-def)?\] FCM sent /,
  // THE CATCH-UP A REACTIVATION OWES, and it is notable for the reason `FCM sent` is: nothing here
  // failed, but a device was `pending` while messages arrived and is being re-notified for them, so
  // a reader wants the count. `redelivered=N` is logged only when N > 0 (`:1595`), so the line's
  // existence already means work was done. Its failure twin is a `warn` and is not matched here.
  /\[ACTIVATION_REDELIVER\]\[reactivate-[0-9a-f]+\] group=\S+ device=\S+ redelivered=\d+$/,
  // AN INTERNET SCANNER LOOKING FOR SECRETS ON A PUBLIC HOST - reported, and never a gate.
  //
  // NOTABLE rather than BENIGN, unlike the crawler 404s above, because the answer to "was this site
  // scanned during the run" is worth reading even when the answer to "did it leak" is no. Measured
  // before the rule was written: 9 requests in 24 h of production, ONE burst, all `404`, nothing
  // served - so it gates nothing and hides nothing.
  //
  // WHAT MAKES IT SAFE IS THAT THE APPLICATION CANNOT OWN THESE SHAPES, not that they were the ones
  // seen. A SvelteKit route cannot begin with a dot, `static/` holds no hidden file and no `.js`,
  // and every script this app emits lives under `/_app/immutable/`, hashed.
  //
  // The three bundle guesses are spelt LITERALLY for the reason the sitemap rules are: a general
  // `[404] GET /*.js` would forgive `/service-worker.js`, which SvelteKit really would own if one
  // were ever added - and the bucket that would catch that must not be the bucket that hides it.
  /^\[404\] (GET|HEAD) \/(\.[\w.-]+(\/[\w./-]*)?|(service-account|credentials)\.json|app\.js|bundle\.js|static\/js\/main\.js)$/,
  // THE SAME SCANNER FAMILY, PROBING FOR A CMS THIS SITE DOES NOT RUN - one sweep, 11 paths, four
  // stacks. Measured during the TYPE run of 2026-08-16, every one of them `404`:
  //
  //     Joomla     /administrator/, /administrator/manifests/files/joomla.xml,
  //                /language/en-GB/en-GB.xml, /media/system/js/core.js
  //     WordPress  /wp-login.php, /wp-admin/, /wp-includes/js/wp-emoji.js
  //     Laravel    /_ignition/health-check          (the CVE-2021-3129 RCE probe)
  //     Next.js    /_next/static/, /_next/webpack-hmr
  //     control    /zzx9q7_not_exist_8123x/         (a random path, to fingerprint the 404 itself)
  //
  // NOTABLE for its neighbour's reason: "was this host scanned during the run" is worth reading even
  // when "did anything answer" is no. And the answer must keep being checked - the rule is written
  // so a NON-404 on any of these paths does NOT match it and lands in `unexplained`, which is where
  // a Joomla admin panel answering 200 on a SvelteKit host belongs.
  //
  // KEYED ON THE STACK, NOT ON THE ELEVEN PATHS SEEN. Spelling them out one by one is what the
  // sitemap rules do, and it is right there because those are stable conventions; a scanner's path
  // list is not, so the next sweep would land in `unexplained` and every run would need the same
  // triage again. This is safe for the reason the secret-scan rule is safe: the application CANNOT
  // own these prefixes. Canari is SvelteKit - it has no `/wp-*`, no `/administrator/`, no
  // `/_next/` (that is Next.js; SvelteKit's is `/_app/`), and no `/_ignition/`.
  //
  // THE CONTROL PATH IS DELIBERATELY LEFT OUT. `/zzx9q7_not_exist_8123x/` is random by construction,
  // so no rule can name it - and it should not be named: a 404 on an unrecognised path is precisely
  // what `unexplained` is for, and this file's own sitemap rules say why a blanket `[404] GET` may
  // never exist. Ten of the eleven are classified; the eleventh costs one glance and keeps the
  // bucket honest.
  /^\[404\] (GET|HEAD) \/(wp-[\w./-]*|administrator(\/[\w./-]*)?|_next\/[\w./-]*|_ignition\/[\w./-]*|geoserver(\/[\w./-]*)?|media\/system\/[\w./-]*|language\/[\w-]+\/[\w.-]+)$/,
  // A SIXTH STACK IN THE SAME FAMILY, added 2026-08-25 after `/geoserver/web/` and `/geoserver/wfs`
  // came back 404 inside a COMM window: GeoServer, probed for its well-known unauthenticated RCEs.
  // Keyed on the prefix like its five neighbours, and safe for their reason - Canari is SvelteKit and
  // owns no `/geoserver`.
  //
  // `/api/v1/version`, from the same window, is SPELT LITERALLY instead, and the difference matters.
  // `/api/` IS a namespace this application owns, so a rule shaped like the ones above would forgive
  // a real route of ours answering 404 - which is a defect and belongs in `unexplained`. What the
  // scanner is fingerprinting is a Docker/Kubernetes/Prometheus-style version endpoint; this app has
  // no versioned API prefix at all, and the day it grows one, this pin is the line that has to be
  // re-read rather than the bucket that hides it.
  /^\[404\] (GET|HEAD) \/api\/v1\/version$/,
  // A SERVICE STARTING INSIDE THE WINDOW - which means the window straddles a deploy, and every
  // client-side disconnection in it has an explanation that is not the application's fault. Never
  // benign: a run that does not know it was redeployed under itself will attribute the fallout to
  // whatever it was measuring. Found exactly that way on 2026-08-14 at 12:45:20Z.
  /^Listening on http/,
  /Nest application successfully started/,
  // THE SAME BOOT, THREE LINES FURTHER DOWN - core-service stating what it came up WITH. They reached
  // `unexplained` on 2026-08-24 because DEL-2's window opened seconds after the v0.14.4 deploy, while
  // `Nest application successfully started` beside them was already classified.
  //
  // NOTABLE, AND WITH THE VALUE PINNED TO WHAT WAS READ - which is the whole point and the reason
  // these are not `(yes|no)`. `Lydia configured: no` is LITERALLY the line that changes the day
  // WP-LYDIA-1 lands, and `Stripe configured: yes` is the line that changes if payments quietly lose
  // their configuration on a deploy. A rule spanning both values would forgive the flip along with
  // the boot and delete the only evidence either event ever produces; pinned, the flip lands in
  // `unexplained` where a configuration change belongs. The homologation URL is pinned for the same
  // reason - moving to Lydia's production endpoint is an event, not noise.
  /\[StripePaymentProvider\] Stripe configured: yes$/,
  /\[LydiaPaymentProvider\] Lydia configured: no \(https:\/\/homologation\.lydia-app\.com\)$/,
  // No value to pin: an extension check either reports ready or the service does not start. Its
  // ABSENCE is the finding, and an absence cannot be classified - which is what the boot banner above
  // is for.
  /\[UsersService\] unaccent \+ pg_trgm extensions ready$/,
  // A CHANNEL MESSAGE BEING DESTROYED, WHICH IS THE ONE DELETE IN THE PRODUCT WITH NO TOMBSTONE. A
  // DM delete leaves a row on every device; `ChannelService.deleteChannelMessage` removes the row
  // itself, and the server is the only authority that ever saw it. So this line is the sole surviving
  // record that a specific message ceased to exist, and whether the deleter was its author or a
  // moderator acting on someone else is carried in the same line - which is exactly why the
  // `(moderation)` variant is matched here rather than collapsed into the plain one.
  //
  // It reached `unexplained` on all five passes of MUT's x5 (2026-08-22) because MUT-8 and MUT-9 are
  // the checks that produce it: they are the only rows in the campaign that hard-delete a channel
  // message, and neither had ever run in a window anybody classified. NOTABLE and not BENIGN on
  // purpose: a deletion crossing an observation window is never noise, and a window carrying more of
  // these than the checks in it asked for is the shape a real incident would take.
  // A COMMUNITY COMING INTO EXISTENCE, which is the one line that explains an estate. Everything the
  // campaign later has to sweep - salons, distribution groups, the row each member keeps - descends
  // from here, so a window holding more creations than the checks in it asked for is the shape a
  // debris problem takes, and a window holding none is a phase that never armed.
  //
  // `(requested="...")` IS PART OF THE SHAPE RATHER THAN NOISE: it differs from `slug=` exactly when
  // the slug collided and the service disambiguated, which is a fact about the estate and reads at a
  // glance. `[^"]*` and not `\S+`, because a community name legitimately contains spaces.
  /\[ChannelService\] \[WORKSPACE\] create name="[^"]*" slug="[^"]*" \(requested="[^"]*"\) by=\S+$/,
  // AN INVITE IS A GRANT, AND `replaced=N` SAYS WHAT IT REVOKED. Both lines are membership events -
  // the same reason `[GROUP_INVITE] accepted` is notable while its `created` twin's preview is not -
  // and `accepted` is the moment a second person can read a community's traffic at all.
  //
  // `expiresAt=` and `maxUses=` are matched loosely on purpose: the campaign creates unlimited
  // never-expiring invites, but an invite with a limit is not a different event, and a rule that
  // pinned this run's shape would file the next one as unexplained for being ordinary.
  /\[ChannelService\] \[INVITE\] created workspace=\S+ by=\S+ expiresAt=\S+ maxUses=\S+ replaced=\d+$/,
  /\[ChannelService\] \[INVITE\] accepted workspace=\S+ user=\S+$/,
  // A POLL BEING ENDED, which is destructive in the small: it forces the deadline, unpins the
  // message and makes every further vote a 403. Its `created` and `vote` siblings are BENIGN because
  // they are content; this one is an authority acting on somebody else's message - `closePoll` takes
  // the author OR `channel.moderate` - and it is the event COMM-15 exists to observe.
  /\[ChannelService\] \[POLL\] closed channel=\S+ message=\S+ by=\S+$/,
  // A WHOLE COMMUNITY BEING DESTROYED, for every member at once, and the two lines are one act: the
  // `hard delete` states what went with it, the `delete` states who asked and how many people lost a
  // room. Notable for the reason the message deletion below is - the server is the only authority
  // that saw the ciphertexts, so these lines are the sole surviving record - and doubly so because
  // the campaign's own sweep produces them: a window carrying more than its checks asked for is a
  // sweep that reached something it should not have.
  //
  // THE FOUR REASONS ARE PINNED, and that is the point. `hardDeleteWorkspace` has exactly four
  // callers - an admin deleting it, the last member leaving, the last member being kicked, and an
  // account deletion emptying it - so a fifth spelling means a new caller nobody has classified, and
  // `unexplained` is where that belongs. A rule spanning `reason=\S+` would forgive it silently.
  /\[ChannelService\] \[WORKSPACE\] hard delete workspace=\S+ channels=\d+ privateGroups=\d+ reason=(admin_deleted|last_member_left|last_member_kicked|account_deletion_left_no_members)$/,
  /\[ChannelService\] \[WORKSPACE\] delete workspace=\S+ slug="[^"]*" by=\S+ members=\d+$/,
  /\[ChannelService\] \[CHANNEL\] message deleted channel=\S+ message=\S+ by=\S+( \(moderation\))?$/,
];

/**
 * ERRORS THAT ARE READ, NAMED, AND STILL NOT DEFECTS - the server's `SEVERE_BUT_EXPECTED`.
 *
 * `Connection reset without closing handshake` is the gateway describing a CLIENT that vanished
 * without sending a close frame: a tab closed, a phone suspended, a network dropped, a container
 * torn down under a live socket. The server did nothing wrong and can do nothing about it. It is
 * logged at ERROR anyway, so without this list every reload the campaign performs makes its own
 * window dirty - the instrument reporting about itself again.
 *
 * Forgiven from the GATE, never from the RECORD: these are still counted and still printed.
 */
const EXPECTED_ERRORS = [/WebSocket protocol error: Connection reset without closing handshake/];

/** The server asserting a loss or a failure it could not handle. These break `clean` on their own. */
const SEVERE = [
  /\bpanic(ked)?\b/i,
  /unhandled (rejection|exception)/i,
  /FATAL/,
  /failed to (deliver|persist|publish)/i,
  // A SESSION DESTROYED BECAUSE A REFRESH TOKEN WAS PRESENTED TWICE OUTSIDE THE GRACE WINDOW.
  //
  // Named here rather than left in `unexplained` because the two causes call for opposite responses
  // and the line cannot tell them apart on its own: a cookie really is in two places (the revocation
  // is correct and the incident is a security one), or the grace window is simply too short for a
  // client that refreshed twice slightly too far apart (the revocation is collateral and the user was
  // logged out for nothing). Either way a user lost their session, which is never routine - and the
  // discriminator is whether the benign `Concurrent refresh accepted` line above appears for the same
  // `sid` in the surrounding minutes.
  /\[AuthSessionsService\] Refresh token replay detected sid=/,
];

// THE RULE LISTS ARE EXPORTED SO THEY CAN BE TESTED WITHOUT REACHING PRODUCTION. A pattern that
// cannot match has no symptom on a live window - it just makes the unexplained pile bigger - so the
// only way to catch one is to assert it against a line whose bucket is known. See
// `srvclassify-selftest.mjs`.
export { linesOf as srvLines };

export {
  BENIGN as BENIGN_RULES,
  NOTABLE as NOTABLE_RULES,
  SEVERE as SEVERE_RULES,
  EXPECTED_ERRORS as EXPECTED_ERROR_RULES,
};

/**
 * One service's lines in the window, ANSI stripped and blanks dropped.
 *
 * EXPORTED as `srvLines` because a check that asserts one SPECIFIC server line does not want the
 * whole classified report: COMM-14's subject is `[CHANNEL_PUSH] ... recipients=N`, and the only
 * honest source for it is the service's own log. A second copy of the `docker logs` incantation in a
 * runner would be a second place for the window, the `2>&1` and the ANSI stripping to drift.
 */
function linesOf(service, since) {
  // `2>&1` because Nest logs to stdout and tracing to stderr, and a check that read only one of them
  // would be blind to half the platform. Quoted for `sh -c` on the far side, single quotes only.
  const out = ssh(
    'canari',
    `docker logs --since ${since} infrastructure-${service}-1 2>&1 || true`,
    { timeoutMs: 90_000 }
  );
  return out
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * THE SERVER HALF OF A RUN'S OBSERVATION, as a value - so it can run INSIDE the phase runner.
 *
 * The campaign's bar is that every line is expected "y compris dans les logs web, mobile, et
 * serveur". While this file was a command and nothing else, meeting that bar depended on somebody
 * remembering to type it after each pass, with the right window - and a bar enforced by memory is
 * not enforced. `run.mjs` now calls this at the end of every pass with the pass's own window, so a
 * server-side line nobody has read breaks the run the same way a browser one does.
 *
 * PROD IS SHARED, SO A WINDOW IS NOT A SUBJECT. This reads the whole platform's logs, and the
 * platform serves real people while the campaign runs. On 2026-08-14 two TYPE passes went
 * `NOT CLEAN` on twenty-seven lines that were a STRANGER's Android device climbing the recovery
 * ladder - a `welcome_request`, a re-add, four commits - while the checks were measuring typing
 * indicators between two browsers. Nothing was wrong with the application, the run, or the
 * classifier: the observer simply had no way to say whose traffic it was reading.
 *
 * So a line is partitioned by SUBJECT before it is classified. `subjects` are the campaign's user
 * ids (prefixes are enough - they are 64 hex chars); a line naming none of them and no user at all
 * is infrastructure and stays in scope, a line naming only OTHER users is third-party. Third-party
 * lines are REPORTED and never gate, per the rule that forgiving an event means taking it out of the
 * gate and never out of the record. Passing no `subjects` keeps the old behaviour - everything in
 * scope - because a partition nobody supplied must not silently forgive anything.
 *
 * @param {string} since a docker `--since` value: an ISO instant, or `15m`
 * @param {string[]} [opts.subjects] campaign user-id prefixes; omit to leave the window unpartitioned
 * @returns {{clean: boolean, since: string} & Record<string, object>}
 */
/**
 * The `published=false devices=0` reads that are NARRATION rather than the concurrent-join race.
 *
 * THE PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE, and this
 * is where that gets fixed rather than argued about. A read answering `published=false devices=0` is
 * deliberately NOT in `BENIGN` - see the comment on its `published=true` sibling - because it is the
 * exact shape that found the concurrent-join race, where two callers both read an unpublished group
 * and both go on to create it.
 *
 * But THE RACE IS A PAIR. One such read is the ordinary first look at a group nobody has joined yet,
 * which every check that creates a community produces exactly once. So the per-line rule was
 * reporting the whole population in order to catch the outlier, and COMM-18 carried it as server
 * dirt across all six of its runs.
 *
 * The COUNT decides, per group: exactly one first look is narration and belongs in `notable`, where
 * it stays visible and breaks nothing; two or more for the SAME group stay where the rule put them,
 * which is what it was written for. Nothing it caught is forgiven, and the noise it also caught is
 * gone.
 *
 * SEPARATE FROM `srvReport` ON PURPOSE. That function reaches production and cannot be the thing
 * under test, which is the whole argument of `srvclassify-selftest.mjs`; a count-based rule buried
 * inside it would be the one rule in this file nothing could pin.
 *
 * @param {string[]} unexplained the bucket as the per-line rules left it
 * @returns {string[]} the lines to move to `notable` - singletons only, in input order
 */
export function settleFirstLooks(unexplained) {
  const FIRST_LOOK =
    /\[DISTRIBUTION_GROUP\] read scope=(?:workspace|channel):\S+ group=(\S+) published=false user=\S+ devices=0/;
  const seen = new Map();
  for (const l of unexplained) {
    const m = FIRST_LOOK.exec(l);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return unexplained.filter((l) => {
    const m = FIRST_LOOK.exec(l);
    return !!m && seen.get(m[1]) === 1;
  });
}

export function srvReport(since = '10m', { raw = false, shapes = false, subjects = [] } = {}) {
const result = {};
let clean = true;

/** Every 64-hex user id a line names. Devices carry the id too (`tauri-<id>-...`), so one regex finds both. */
const USER_ID = /[0-9a-f]{64}/g;

/**
 * A user id TRUNCATED TO EIGHT, and only where the line says it is a user.
 *
 * ONE SERVICE LOGS NOTHING BUT PREFIXES, so until 2026-08-21 no line it wrote could ever be
 * attributed: social-service slices every id to eight characters, so `USER_ID` found nothing, and
 * `isThirdParty` read "names nobody - always ours to explain" over another contributor's traffic
 * arriving inside our window.
 *
 * ONLY IN A LABELLED POSITION, and that restriction is the whole safety of it. An eight-hex token on
 * its own is not an identity in this system - a trace id is eight hex (`history-req-dc5922d1`), so is
 * a card id, so is an association id. Attributing on shape would let a run's own trace ids decide
 * whose traffic a line was. `user=`/`userId=`/`claimedByUserId=`/`device=` is the line SAYING what
 * the token is, and nothing else counts.
 */
const LABELLED_USER = /\b(?:user|userId|claimedByUserId|device)=(?:tauri-|web-)?([0-9a-f]{8,})/g;

const isThirdParty = (line) => {
  if (!subjects.length) return false;
  const ids = [...line.matchAll(LABELLED_USER)].map((m) => m[1]);
  ids.push(...(line.match(USER_ID) || []));
  if (!ids.length) return false; // names nobody - infrastructure, cron, startup. Always ours to explain.
  // `startsWith` in BOTH directions: the line may carry a full id and a subject prefix, or an
  // eight-character prefix against a subject spelt out in full. Either way one is a prefix of the
  // other, and a mismatch of eight hex characters is somebody else.
  return !ids.some((id) => subjects.some((s) => id.startsWith(s) || s.startsWith(id)));
};

for (const service of SERVICES) {
  let lines;
  try {
    lines = linesOf(service, since);
  } catch (e) {
    // AN UNREACHABLE SERVICE IS NOT A QUIET ONE. Returning `[]` here would report a torn-down
    // container as a clean window, which is the exact substitution this whole harness exists to
    // refuse: an instrument answering about itself while reading as an answer about the system.
    result[service] = { unreachable: String(e.message || e).slice(0, 200) };
    clean = false;
    continue;
  }

  // PARTITION BEFORE CLASSIFYING. `foreign` is kept whole and reported; only `lines` is judged.
  const foreign = lines.filter(isThirdParty);
  lines = lines.filter((l) => !isThirdParty(l));

  /**
   * A MULTI-LINE DUMP IS ONE EVENT, AND COUNTING ITS LINES BURIES EVERYTHING ELSE.
   *
   * The READ run of 2026-08-15 reported `core-service` NOT CLEAN with **5 540 unexplained lines**.
   * There were ELEVEN events: `[AvatarService] Error fetching avatar`, each followed by axios
   * printing the whole Node socket object - `at internalConnectMultiple`, `Symbol(kCapture): false`,
   * three hundred lines of `},`. Every one of those counted as its own unexplained line, so a single
   * unreachable avatar host made the service's entire window unreadable and would have hidden a real
   * line anywhere inside it. That is rule 11 from the other end: a count that is not a count.
   *
   * A DUMP RUNS UNTIL THE NEXT RECORD STARTS - it is not a set of shapes to enumerate. Listing the
   * shapes was the first attempt and it failed for a reason worth keeping: one `at ...` frame in
   * eleven hundred that the list did not anticipate ended the run, and the ~500 lines after it were
   * counted individually again. A rule that has to predict every line of a `util.inspect` of a TLS
   * socket is a rule that will be wrong on the next library.
   *
   * So the only judgement is `RECORD_START`, and everything between an error and the next record
   * belongs to that error. It covers Nest's prefix, an ISO date or a bare clock, a level token, and
   * a `[UPPER_CASE]` tag - the last because the Rust services log that way, and without it an error
   * in `chat-gateway` would swallow the `[HISTORY_REQ]` lines that followed it.
   *
   * CAPPED AND REPORTED, because absorbing without a bound is how a rule meant to stop noise starts
   * hiding signal: a service whose format is not recognised here would otherwise lose the remainder
   * of its window to its first error. `dumpLinesCollapsed` goes in the result so the collapse is
   * never silent - rule 11 applies to what an instrument removes as much as to what it truncates.
   */
  const RECORD_START = /^\s*(\[Nest\]|\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[[A-Z][A-Z_0-9]*\]|\[?(INFO|WARN|WARNING|ERROR|ERRO|DEBUG|TRACE|FATAL)\b)/;
  const MAX_DUMP = 2000;
  const collapsed = [];
  let dumpRun = 0;
  for (const l of lines) {
    const isErr = /\bERROR\b|\bERRO\b|\bERR!\b/.test(l);
    if (dumpRun > 0 && !RECORD_START.test(l) && dumpRun < MAX_DUMP) {
      dumpRun++;
      continue;
    }
    dumpRun = isErr ? 1 : 0;
    collapsed.push(l);
  }
  const dumpLines = lines.length - collapsed.length;
  lines = collapsed;

  const severe = lines.filter((l) => SEVERE.some((r) => r.test(l)));
  const isError = (l) => /\bERROR\b|\bERRO\b|\bERR!\b/.test(l) && !severe.includes(l);
  const expectedErrors = lines.filter((l) => isError(l) && EXPECTED_ERRORS.some((r) => r.test(l)));
  const errors = lines.filter((l) => isError(l) && !expectedErrors.includes(l));
  const warnings = lines.filter((l) => /\bWARN\b/.test(l));
  const notable = lines.filter((l) => NOTABLE.some((r) => r.test(l)));
  const unexplained = lines.filter(
    (l) =>
      !BENIGN.some((r) => r.test(l)) &&
      !severe.includes(l) &&
      !errors.includes(l) &&
      !expectedErrors.includes(l) &&
      !warnings.includes(l) &&
      !notable.includes(l)
  );

  // A group's FIRST LOOK is narration; a SECOND one is the race. See `settleFirstLooks`.
  for (const l of settleFirstLooks(unexplained)) {
    notable.push(...unexplained.splice(unexplained.indexOf(l), 1));
  }

  const ok = severe.length === 0 && errors.length === 0 && unexplained.length === 0;
  clean &&= ok;
  // EVERY TRUNCATED BUCKET CARRIES ITS OWN COUNT. `errors.slice(0, 40).length` is 40 whether the
  // window held 40 errors or nine hundred, and that number was going into the summary line a reader
  // uses to decide whether to look - a cap reading as a measurement.
  result[service] = {
    lines: lines.length,
    clean: ok,
    // REPORTED, NEVER SILENT: a collapse that is not stated is indistinguishable from a window that
    // was quiet, and the whole point of the rule above is that a suppressed count misleads.
    ...(dumpLines && { dumpLinesCollapsed: dumpLines }),
    ...(severe.length && { severeCount: severe.length, severe: severe.slice(0, 40) }),
    ...(errors.length && { errorCount: errors.length, errors: errors.slice(0, 40) }),
    ...(expectedErrors.length && {
      expectedErrorCount: expectedErrors.length,
      expectedErrors: expectedErrors.slice(0, 10),
    }),
    ...(warnings.length && { warningCount: warnings.length, warnings: warnings.slice(0, 20) }),
    ...(notable.length && {
      notableCount: notable.length,
      notable: notable.slice(0, 10),
      ...(shapes && { notableAll: notable }),
    }),
    ...(unexplained.length && {
      unexplainedCount: unexplained.length,
      unexplained: unexplained.slice(0, 40),
      ...(shapes && { unexplainedAll: unexplained }),
    }),
    // OUT OF THE GATE, NOT OUT OF THE RECORD. A stranger's traffic cannot fail our check, but a
    // window that silently dropped it would hide a platform-wide event behind a green run.
    ...(foreign.length && {
      thirdPartyCount: foreign.length,
      thirdParty: foreign.slice(0, 20),
      ...(shapes && { thirdPartyAll: foreign }),
    }),
    ...(raw && { raw: lines }),
  };
}

return { since, clean, ...result };
}

/**
 * THE SHAPE OF A LINE - its text with every identifier replaced by its kind.
 *
 * WHY TRIAGE NEEDS THIS AND A LIST WILL NOT DO. `unexplained` is truncated at 40 entries, and on a
 * service that writes three lines per routed frame those 40 entries were FOUR distinct sentences
 * repeated with different device ids. Reading a truncated list answers "what did the first 40 lines
 * say", never "how many different things does this window contain" - and only the second question
 * ends a triage. Collapsing to shapes turned chat-gateway's 40 into a handful, each read once.
 */
export function shapeOf(line) {
  // ORDER IS THE WHOLE OF THIS FUNCTION, and both rules below were wrong on the first draft.
  // The device rule must run BEFORE the id rule, or `web-<id>-msglwqh6-vegy` has already stopped
  // being a device by the time the device rule looks. And the id threshold must be low enough to
  // catch a CORRELATION id: at 16 hex characters `send-cd9583ef` stayed verbatim, so 287 copies of
  // one sentence counted as 287 distinct shapes - a summary the same size as what it summarised.
  return line
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\d{2}\/\d{2}\/\d{4},? \d{1,2}:\d{2}:\d{2} [AP]M/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(web|tauri|ios|android)-[\w-]+/gi, '<device>')
    .replace(/\b[0-9a-f]{6,}\b/gi, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Distinct shapes of one bucket per service, most frequent first - the triage worklist itself.
 *
 * `notable` gets the same treatment as `unexplained` and for the same reason: it is the bucket a
 * reader is supposed to READ, and 295 lines is not read by anybody. Collapsed, that window was four
 * sentences.
 */
export function srvShapes(rep, bucket = 'unexplained') {
  const key = `${bucket}All`;
  const out = {};
  for (const [service, v] of Object.entries(rep)) {
    if (!v || typeof v !== 'object' || !v[key]) continue;
    const counts = new Map();
    for (const l of v[key]) {
      const s = shapeOf(l);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    out[service] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([shape, n]) => `${String(n).padStart(5)}x  ${shape.slice(0, 200)}`);
  }
  return out;
}

/** One line per service, for a runner that must not drown the phase table it sits under. */
export function srvSummary(rep) {
  return Object.entries(rep)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([service, v]) =>
      v.unreachable
        ? `  ${service.padEnd(24)} UNREACHABLE - ${v.unreachable}`
        : `  ${service.padEnd(24)} ${v.clean ? 'clean' : 'NOT CLEAN'}  ${v.lines} line(s)` +
          `${v.severeCount ? `  severe=${v.severeCount}` : ''}` +
          `${v.errorCount ? `  errors=${v.errorCount}` : ''}` +
          `${v.expectedErrorCount ? `  expected-errors=${v.expectedErrorCount}` : ''}` +
          `${v.notableCount ? `  notable=${v.notableCount}` : ''}` +
          `${v.unexplainedCount ? `  unexplained=${v.unexplainedCount}` : ''}` +
          `${v.thirdPartyCount ? `  third-party=${v.thirdPartyCount}` : ''}`
    );
}

// CLI only when INVOKED as one - importing this file must not read `process.argv` or print anything.
//
// VIA `pathToFileURL`, NOT STRING SURGERY. Hand-building `file://${argv[1]}` produces `file://C:/…`
// on Windows where `import.meta.url` is `file:///C:/…` - two slashes against three - so the guard
// never matched, the CLI never ran, and `node srvlog.mjs` printed NOTHING and exited 0. A command
// that succeeds silently is worse than one that fails: it reads as "the window was clean".
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = (n, f) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? f : process.argv[i + 1];
  };
  const wantShapes = process.argv.includes('--shapes');
  // `--subjects <prefix,prefix>` partitions the window by user, exactly as `run.mjs` does from the
  // preflight. Omit it and nothing is forgiven - an unpartitioned window judges every line.
  const subjects = String(flag('subjects', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const rep = srvReport(String(flag('since', '10m')), {
    raw: process.argv.includes('--raw'),
    shapes: wantShapes,
    subjects,
  });
  if (wantShapes) {
    for (const bucket of ['unexplained', 'notable', 'thirdParty']) {
      for (const [service, list] of Object.entries(srvShapes(rep, bucket))) {
        console.log(`\n== ${service} - ${list.length} distinct ${bucket} shape(s)`);
        for (const l of list) console.log(l);
      }
    }
    console.log(`\n${srvSummary(rep).join('\n')}`);
  } else console.log(JSON.stringify(rep, null, 1));
  console.log(
    rep.clean
      ? '\nSERVER CLEAN - every line in the window is one we have read and named'
      : '\nSERVER NOT CLEAN - see the buckets above; a line in `unexplained` is triage, not necessarily a defect'
  );
  process.exitCode = rep.clean ? 0 : 1;
}
