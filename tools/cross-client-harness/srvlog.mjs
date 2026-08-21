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
  /\[PUSH_SEND\]\[send-[0-9a-f]+\] No push token for user=\S+ device=(web|ios)-/,
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
  // Housekeeping and one real user playing the anti-bot minesweeper. Neither is about this campaign.
  /\[AuthSessionsService\] Swept \d+ expired session\(s\)/,
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
  /\[PUSH_DEFERRED\]\[send-/,
  /\[PUSH_SEND\]\[send-[0-9a-f-]+(?:-def)?\] FCM sent /,
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
  /^\[404\] (GET|HEAD) \/(wp-[\w./-]*|administrator(\/[\w./-]*)?|_next\/[\w./-]*|_ignition\/[\w./-]*|media\/system\/[\w./-]*|language\/[\w-]+\/[\w.-]+)$/,
  // A SERVICE STARTING INSIDE THE WINDOW - which means the window straddles a deploy, and every
  // client-side disconnection in it has an explanation that is not the application's fault. Never
  // benign: a run that does not know it was redeployed under itself will attribute the fallout to
  // whatever it was measuring. Found exactly that way on 2026-08-14 at 12:45:20Z.
  /^Listening on http/,
  /Nest application successfully started/,
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
export function srvReport(since = '10m', { raw = false, shapes = false, subjects = [] } = {}) {
const result = {};
let clean = true;

/** Every 64-hex user id a line names. Devices carry the id too (`tauri-<id>-...`), so one regex finds both. */
const USER_ID = /[0-9a-f]{64}/g;
const isThirdParty = (line) => {
  if (!subjects.length) return false;
  const ids = line.match(USER_ID);
  if (!ids) return false; // names nobody - infrastructure, cron, startup. Always ours to explain.
  return !ids.some((id) => subjects.some((s) => id.startsWith(s)));
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
