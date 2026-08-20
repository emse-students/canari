/**
 * Continuous observation of a client while a check runs: console, page errors, HTTP, WebSocket.
 *
 * WHY THIS IS PART OF EVERY CHECK, not a debugging aid. A check that only asserts its own outcome
 * answers "did the message arrive", never "did it arrive for the right reasons". A pass sitting on
 * top of a swallowed exception, a 4xx nobody reads, a request that should not have been made or a
 * silent ACK is worth nothing - WP-LOSS-1 is precisely a green-looking path with a dropped message
 * underneath it. So every runner attaches this, and reports the noise next to the verdict.
 *
 * Anything not on the expected list is surfaced verbatim rather than summarised: the whole point is
 * to see what was not predicted.
 */
import { evaluate } from './cdp.mjs';

/** Console text that is normal traffic on this app and carries no signal on its own. */
const BENIGN = [
  /^\[API\] (→|←)/,
  /^\[WS (RCV|SND)\]/,
  /^\[QUEUE\] (Drain (start|complete)|Processing message|messageCallback)/,
  // The barrier waiting out ANOTHER group's catch-up (2026-08-16). Benign by construction - it is
  // the barrier doing exactly its job - and added here deliberately rather than left to surface as
  // unexplained, because it replaces a refusal that WAS a defect and the two must not be confused.
  // It stays visible in the capture: only the `unexplained` bucket is what this list empties.
  /^\[QUEUE\] mailbox barrier for ".*" waited \d+ms behind/,
  /^\[OUTBOX\] (Queued|Flushing|[0-9a-f]{8}… sent)/,
  // GRAINE, ON EVERY COMMUNITY AND EVERY PRIVATE SALON THE CLIENT OPENS (2026-08-20). Three
  // routine lines, all of which fire on a perfectly healthy client and all of which landed in
  // `unexplained`, so the first COMM check to touch a private salon reported dirt on a run where
  // nothing was wrong.
  //
  // The reconciliation reporting NOTHING TO REMOVE is the whole mechanism working: it compares the
  // group's tree against the scope's roster on every open and says so. Its SIBLING - the line that
  // says members are being removed - is deliberately NOT matched here: that one means a departure
  // is being enforced, which is a finding in any check that was not about a departure.
  //
  // THIS COMMENT USED TO SAY THE SIBLING WAS CAUGHT BY THE `re-?add|epoch` RULE IN NOTABLE. It was
  // not, and COMM-3 proved it on 2026-08-20 by making a real member leave: the line reads
  // "N member(s) left but still hold a leaf - removing", which contains none of those words, so the
  // single loudest signal Graine emits was landing in `unexplained`. A rule that claims another rule
  // covers something has to be checked against the text, not against the intent - the sibling now
  // has its own entry in NOTABLE, named.
  /^\[GRAINE\] .+ distribution group agrees with its roster - \d+ leaf\/leaves, nobody to remove$/,
  // The FIRST device into a salon's group initialises it - exactly once per salon, by construction,
  // and every COMM check that creates a private salon produces it.
  /^\[GRAINE\] no base published for .+ - creating group [0-9a-f]{8}\.\.\.$/,
  // A SEED ARRIVING, which is what every salon with two people in it does on every message. It was
  // landing in `unexplained` on runs where nothing was wrong, and a verdict that is PASS-DIRTY for a
  // healthy salon is a verdict nobody reads twice.
  //
  // IT IS CLASSIFIED HERE AND STILL ASSERTED THERE. This line arriving on a device that should NOT
  // be in a salon is the loudest possible statement of the defect COMM-8/9 exist for - so those
  // rows must assert its ABSENCE on the excluded client by name, rather than lean on `clean` to
  // notice it. A global classification cannot make that distinction: the same text is routine on a
  // member and damning on a non-member, and only the check knows which one it is looking at.
  /^\[GRAINE\] seed \S+ from \S+ for channel [0-9a-f]{8}$/,
  // The app narrating a community or channel the CHECK itself just created. Routine, and it is
  // the COMM phase's own vocabulary - every check in it creates something.
  /^(Channel|Community) created: /,
  // AND THE SAME VOCABULARY FOR DESTRUCTION, which COMM-16 needed and nothing had classified: five
  // lines, all of them the app reporting an operation the check asked for, and each one the LAST
  // thing that will ever name what it removes. `Channel deleted.` became literally true on
  // 2026-08-20 - it announced an archive until then, which is the defect that row found.
  //
  // The three `[GRAINE]` lines are the client releasing what it held: the distribution groups it
  // has left, the community's seeds dropped, and - on a community with one member - the
  // reconciliation reporting that there was nobody to ask rather than that asking failed. Their
  // ABSENCE would be the finding: a client that deletes a community and says nothing about its
  // seeds is a client still holding them.
  /^(Channel|Community) deleted\.$/,
  /^\[GRAINE\] left \d+ distribution group\(s\) of community /,
  /^\[GRAINE\] community \S+ forgotten - \d+ seed\(s\)/,
  /^\[GRAINE\] community \S+ has no other member to ask for history/,
  // AND WHAT A JOIN CORRECTLY SAYS, which COMM-2 needed. Three lines, one per layer, all on the
  // path of somebody accepting an invitation:
  //
  //  - the app naming the channel the joiner landed in;
  //  - Graine asking an existing member for the community's past. This is the ONLY way a newcomer
  //    can read anything written before they arrived - the server holds no seed - so its absence
  //    would mean `historyVisibility: shared` silently delivers nothing. The SIBLING line, where
  //    there is nobody to ask, is two entries up;
  //  - the deep-link landing announcing where it is sending them. Not a fallback: `/communities` is
  //    the only route that can display a channel, and `openInvitedChannel` publishes the target
  //    precisely so this effect routes to it once the router is up.
  /^Joined channel #\S+$/,
  /^\[GRAINE\] asked \S+ for the history of community [0-9a-f]+$/,
  // ...and the other end of that exchange: an existing member ANSWERING it. Zero of zero is the
  // ordinary case in this phase, where the community was created seconds earlier and holds no seed
  // yet - the count is what makes the line worth keeping rather than silencing.
  /^\[GRAINE\] sending \d+ of \d+ held seed\(s\) as history to \S+$/,
  // THE SEED-REPAIR EXCHANGE, BOTH ENDS (WP-33). A device that was offline when a seed went out,
  // or that joined a salon later, meets messages it cannot open and asks ONE named member for those
  // sessions by id. It is the ordinary repair, not a fault - a fault would be the request going out
  // and nothing coming back, which is `no reachable holder` in NOTABLE, or the ask never happening
  // at all, which is a permanently blank salon and has no line of its own.
  //
  // KEPT WITH THEIR COUNTS on purpose. These two lines were `unexplained` on 2026-08-20 and that is
  // how COMM-12 found the twentieth defect: a community set to `joined` refused the history bundle
  // in one line and answered the same past, seed by seed, in the next.
  /^\[GRAINE\] asked \S+ for \d+ seed\(s\) in community [0-9a-f]+$/,
  /^\[GRAINE\] answered \S+ with \d+ seed\(s\)(, declining \d+)?$/,
  // THE THIRD SIDE OF THAT EXCHANGE, added 2026-08-20 because it was missing from the product.
  // `asked` and `answered` were both audible and the ABSORB was not, so a repair that worked and a
  // repair whose seeds were all refused produced identical logs - COMM-8 found it by asserting a
  // line that only the single-seed path prints. Read the two counts together: `answered N` upstream
  // against `absorbed 0/N` here is an answer that repaired nothing.
  /^\[GRAINE\] absorbed \d+\/\d+ seed\(s\) from \S+ in community [0-9a-f]{8} - salon\(s\) .+$/,
  // ...AND THE TWO REFUSALS THAT FIX PUT THERE. Both are the history rule working, and both are
  // silence on the wire, so the line IS the evidence: nothing else would ever say that a seed was
  // deliberately not handed over. They appear only under `historyVisibility: 'joined'`, so in every
  // other check their absence is the expected state.
  /^\[GRAINE\] withholding \d+ seed\(s\) from \S+: community [0-9a-f]+ is set to 'joined'/,
  /^\[GRAINE\] not asking for \d+ seed\(s\) of channel [0-9a-f]+: community [0-9a-f]+ is set to 'joined'/,
  // The bundle refused whole, which is the same rule read at join time. Its sibling - the bundle
  // being SENT - is two entries up, and the pair is what separates "the rule applied" from "history
  // never works here".
  /^\[GRAINE\] not sending history to \S+: community [0-9a-f]+ is set to 'joined'$/,
  // THE ADMIN SETTING THE RULE, from the community panel - the gesture COMM-12 performs before it
  // measures anything. It carries the value the server ACCEPTED rather than the one that was
  // clicked, which is why it is worth a line: the two differ whenever the save failed.
  /^\[CHANNEL\] history visibility set to (shared|joined)$/,
  // THE ONE SEAM THAT USED TO BE SILENT. Every other message kind logs its arrival; a system event
  // logged nothing, so an invitation that reached the invitee's device and produced nothing left no
  // trace on any machine (COMM-4, 2026-08-20). The dispatch line is expected on both sides of every
  // system event, and the `[CHANNEL_INVITE]` pair is the invitation actually being written - so an
  // arrival with no card is now a dispatch line with no card line, which is a location.
  /^\[MLS\] System event '\S*' from [0-9a-f]+ in [0-9a-f]+…$/,
  /^\[CHANNEL_INVITE\] invited to [0-9a-f]+ by [0-9a-f]+ - card channel-invite:\S+ into [0-9a-f]+…$/,
  /^\[CHANNEL_INVITE\] our own invitation of [0-9a-f]+ to [0-9a-f]+, seen from another device - card /,
  // The two silent returns on the inbound path, now audible. A duplicate is ordinary; a
  // conversation that VANISHED between buffering and flush is not, and it is NOTABLE rather than
  // benign - see the rules below.
  /^\[ADD_MSG\] Duplicate ignored during a bulk ingest id=/,
  // The buffered path's success line, added 2026-08-20 - it was the only inbound path that said
  // nothing at all, which is what made an invitation card that never appeared unreadable in a log.
  /^\[ADD_MSG\] Batch into "[^"]*": \d+ added, \d+ upgraded/,
  /^\[ADD_MSG\] Batch into "[^"]*": \d+ message\(s\), all already held$/,
  // The salon's own row changed under this client: a rename, or the server's verdict on whether it
  // may still post here. Both are a sidebar update and neither is a fault.
  /^\[CHANNEL\] #\S+ updated - canWrite=(true|false|unchanged)$/,
  // THE READ RECEIPT LEAVING THIS DEVICE, added 2026-08-20. It fires whenever a salon with a foreign
  // message is opened, which every check that reads one does - COMM-7, COMM-11, COMM-21. Its ABSENCE
  // is the finding it exists for: a notification still lit on a phone has no other witness.
  /^\[CHANNEL_READ\] signalled [0-9a-f]{8} to this account's other devices$/,
  // A role's permissions changed somewhere in the community, and every open grid is told. Routine:
  // COMM-6 and COMM-20 both produce it deliberately, and so does any administrator using the panel.
  /^\[ROLE\] [0-9a-f]+ now grants \d+ permission\(s\)$/,
  // A ROLE CHANGE ARRIVING LIVE, which is what this line means and what it did not do until
  // 2026-08-20: `workspace.role.changed` was dropped by both socket clients. COMM-5 asserts
  // its ARRIVAL itself (`capabilityIsLive`), so classifying it here loses nothing.
  /^\[WORKSPACE\] my role in [0-9a-f]{8} is now "[^"]+" \(canManage=(true|false)\)$/,
  // THIS CLIENT WAS REMOVED FROM A SALON, narrated by the app as it purges it. It is the CORRECT
  // outcome of a removal and every check that performs one produces it - COMM-9, COMM-11, COMM-21.
  // A removal nobody asked for would be a finding, and it is the CHECK that knows which it is
  // looking at: COMM-21 asserts this line's consequences (the row gone, the conversation closed, a
  // 403 on the next write), so its presence proves the purge ran rather than hiding that it did not.
  /^Removed from channel #\S+$/,
  // The permission grid saying a cell was cycled, and the panel saying it is saving that cell.
  // `Log.d` renders its payload as `Object` in a console tail, so these two say WHICH gesture ran
  // and nothing about what it carried - which is all a check needs from them: they appear only when
  // something toggled a permission, so their presence outside a check that toggled one is the
  // finding, not their content.
  /^\[PermissionGrid\.cycleCell\]/,
  /^\[handleRolePermissionToggle\]/,
  // The inviter's own confirmation of an action they just took, from the community panel.
  /^Member invited to channel \((member|moderator|admin)\): /,
  /^\[notifNav\] routing to \S+ for pending conversation \S+$/,
  // The landing refetching ONCE before it selects. A just-accepted invitation is never in the
  // conversation list the client already holds, which is what this branch exists for; the two
  // sentences that mean it gave up - "not on this device" and "still unknown after refresh" - are
  // not matched here, and land in `unexplained` where a landing that never arrived belongs.
  /^\[notifNav\] channel \S+ unknown - refreshing communities before selecting$/,
  // LEAVING, from the leaver's own side. The client purges a community it left and a community it
  // was removed from through the same path, so it says "removed from" for both - the discriminator
  // is the payload, not the sentence (see `memberRemoval.ts`). Both lines are the departure the
  // check asked for; their absence would mean a leaver kept the community on screen.
  /^\[Channel Event\] removed from community [0-9a-f]+$/,
  /^You have left the community\.$/,
  // THE SAME EVENT FROM THE OTHER CAUSE. `handleWorkspaceDeleted` and `handleRemovedFromWorkspace`
  // both purge the workspace locally, and only the first was classified - so COMM-12, which deletes
  // the two communities it created, came back `PASS-DIRTY` on a broadcast it had asked for itself.
  // Kept as its own line rather than widened into the rule above: the two sentences name two
  // different server decisions, and a reader of the dirt has to be able to tell them apart.
  /^\[Channel Event\] community [0-9a-f]{8} deleted by an admin$/,
  // THE PRUNE DECLINING TO DELETE WHAT DID NOT EXIST WHEN IT ASKED. Benign because it is the
  // fix of 2026-08-20 doing its work: a workspace listing that went out before a community was
  // created cannot be evidence that the community is gone, and the load now says which ones it
  // spared instead of deleting them in silence. It is EXPECTED here specifically - COMM-12 builds
  // two communities back to back, which is the race - and its absence proves nothing either way,
  // since a run where no listing happened to be in flight is a run with nothing to spare.
  /^\[WORKSPACE-LOAD\] kept \d+ (community\(ies\)|salon\(s\)) created after this listing was requested/,
  // THE SWEEP SPARING A KEY-DISTRIBUTION GROUP, which is the fix WP-GRAINE-1 and the 2026-08-20
  // discriminator repair both landed. Its ABSENCE is what would be the signal: a boot where these
  // do not appear is a boot where the sweep deleted the group and sending stops working.
  /^\[(SYNC|DISCOVERY)\] (WASM kept|MLS state kept for) [0-9a-f]{8}… - .*key-distribution group/,
  // A DELETE THAT CAUGHT ITS MESSAGE STILL IN THE QUEUE (2026-08-16, MUT-19's fix). This is the
  // cancellation succeeding: the frame never left, so no peer has it and no `delete_message` event
  // is owed. Deliberately NOT written as a `^\[OUTBOX\] \S+ withdrawn` prefix - the sibling branch
  // one `if` above it in `outbox.ts` fires when the send was already in flight, means the opposite
  // (the peers DO have it), and sits in `NOTABLE`. A prefix rule would silence that one too.
  /^\[OUTBOX\] [0-9a-f]{8}… withdrawn from the queue before it was ever sent$/,
  /^\[MLS\] (Disk writes deferred|Bulk ingest done|Encrypted state checkpoint persisted)/,
  // A resume finding a socket that BOTH answers agree is alive - a tab hidden and shown again, which
  // every check that touches visibility produces. The disagreeing spelling is in `NOTABLE`, and the
  // separation is the point of the line: see the note there.
  /^\[LIFECYCLE\] Resume: already connected \(flag=true, socket=true\)\.$/,
  /\[Channel Event\] typing/,
  /^\[RUST::INFO\]/,
  /^\[INIT\]/,
  /^\[PRESENCE\]/,
  /Loading\/Creating clean state/,
  /WasmMlsClient::new called/,
  /^\[SEND\] (handleSendChat|convo:|sendChatMessage)/,
  // The outbox accepting a message locally, and the key-package top-up every boot performs. Both are
  // the success path of checks that already assert their outcome directly.
  /^\[SEND\] [0-9a-f]{8}\S* (queued|sent)/,
  /generateKeyPackage|KeyPackage published/,
  /^\[ADD_MSG\] . Message added/,
  /^\[Channel Event\] channel\.(typing|message\.created|message\.updated|read)/,
  /^\[PENDING\] No pending MLS messages/,
  /^\[HISTORY\]/,
  /^\[READ\]/,
  /^\[appLink\] In-app navigation/,
  // A message being decrypted and handed to the chat is the SUCCESS path of every check in this
  // campaign, and it was landing in `unexplained` - so a clean run reported dirt and every verdict
  // came back PASS-DIRTY. Dirt that is always present is dirt nobody reads, which is worse than
  // none: the observation half of the rule ("a verdict is PASS only if the run is clean") stops
  // discriminating. NOT widened to all of `[MLS]`, because a decrypt FAILURE must still surface -
  // `NOTABLE` catches those, and it is evaluated first.
  /^\[MLS\] Message decrypted for [0-9a-f]{8}/,
  // pdf.js says this for any PDF without a cross-reference table. It is a property of the fixture,
  // not of the application, and it fires on every MSG-4 run.
  /Indexing all PDF objects/,
  // THE APP STARTING UP. Any check that reloads a client - MSG-10 reloads its sender by design, to
  // prove the message survived on disk and not merely in memory - replays this whole sequence, and
  // every line of it landed in `unexplained` on the run of 2026-08-14. They are the boot narrating
  // itself in order: auth, WASM, the vault key path, IndexedDB, push, the catch-up, the tab lock.
  // None is a decision, none can fail silently (each failure path logs at `error` and is caught
  // above), and a check that deliberately reloads must not be permanently dirty for doing so.
  /^\[A\] (token→refresh|refresh→|ws\+|refresh✓)/,
  /^Initialised in (WEB|TAURI) mode/,
  /^(Verifying PIN\.\.\.|Local database initialised\.)/,
  /^(MLS state loaded from IndexedDB|Initialising MLS \(vault device key path\)|MLS identity initialised)/,
  /^\[DB\] Using IndexedDB storage/,
  /^\[Push\] startPushService noop|^\[PUSH\] Push token registration complete/,
  /^\[CATCHUP\] batch history:/,
  /^\[WORKSPACE-LOAD\] communities\/channels loaded/,
  /^\[TAB\] Leadership acquired/,
  /^\[WS\] Opening connection →/,
  // The pending mailbox being drained on connect. `[PENDING] No pending MLS messages` was already
  // here for the empty case; the non-empty one is the same event with something in it, and a check
  // that reconnects a client (MSG-9, MSG-10) provokes it by construction.
  /^\[PENDING\] Fetched \d+ pending messages/,
  // The media cache clock being refreshed on a HIT rather than only on a server download - the
  // deliberate behaviour recorded in the storage forecast. Fires whenever a rendered conversation
  // holds cached media, which after MSG-4 is every subsequent check.
  /^\[MEDIA_TOUCH\] \d+ cached media reported as used/,
  // Cloudflare Page Shield "Script Monitor" injects its OWN report-only policy
  // (`script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; report-uri
  // .../cdn-cgi/script_monitor/report`) on top of ours, so EVERY fetch and the pdf.js worker log a
  // violation. Established 2026-08-06 from `securitypolicyviolation.originalPolicy`, after the
  // repo turned up no `Report-Only` anywhere - it is not ours and it enforces nothing. It leaks no
  // path Cloudflare does not already see: it is the TLS terminator for this site.
  // The ENFORCED policy is the one in the `content-security-policy` header, and it is sane.
  /violates the following Content Security Policy directive/,
  // A COLD START, WHICH THE CAMPAIGN'S OTHER CHECKS NEVER OBSERVE. They attach to a session that has
  // been up for a while; `burn.mjs` reloads on purpose and so watches the app come up from nothing.
  // These three are what that looks like on native, and each is a step announcing that it completed:
  // the deep-link handler is installed, the WebView cookie jar is flushed after the token refresh
  // (WP-COOKIE-1's own line), and the device key is restored from the PIN vault so the session
  // resumes without asking again. Named individually rather than by a `startup` catch-all - a step
  // that FAILS to complete has to stay visible, and only its success is being forgiven here.
  /^\[hooks\] Deep-link listener registered$/,
  /^\[Cookies\] flushed after refresh$/,
  /^\[PIN\] Device key restored from PinVault - auto-login/,
  // The rest of the same cold start, on the native side. `MLS state loaded from mls.bin` is the one
  // worth reading twice: it is the SUCCESS of the load this whole area is about, and its absence -
  // not its presence - is what would matter. Kept as three narrow rules for the reason above: a
  // storage backend that failed to open, or a push service that did not start, must not be forgiven
  // by a rule written for the ones that did.
  /^MLS state loaded from mls\.bin \(native\)\.$/,
  /^\[DB\] Using SQLite storage \(Tauri\)$/,
  /^\[Push\] startPushService device=\S+ \(platform will be confirmed by FCM token\)$/,
  // The rest of the native push registration narrating itself, found by `burn.mjs` on 2026-08-15:
  // a reload on A1 left these three in `unexplained` and nothing else, so a PASS reported dirt.
  //
  // ANCHORED ONE BY ONE RATHER THAN AS `^\[Push\]`, for the reason two entries up: every failure in
  // `PushNotificationService.ts` is a `console.warn` or `console.error` ("No FCM token available",
  // "FCM token registration failed", "exhausted retries without successful registration"), and a
  // prefix rule would forgive whichever of them arrives next. These three are `console.info` and
  // are the only `info` lines that file emits, so naming them exactly cannot silence a failure -
  // the level buckets would catch one even if it did.
  /^\[Push\] registerPushToken start$/,
  /^\[Push\] Token unchanged, skip backend registration$/,
  /^\[Push\] startPushService re-check \(possible token rotation\)$/,
];

/**
 * Failures that are understood and carry no signal, so a NEW one stands out.
 *
 * A PATH IS NOT ENOUGH - THE STATUS IS PART OF WHAT IS FORGIVEN. This used to be a bare list of
 * paths, and that forgives every way an endpoint can fail rather than the one that was understood.
 * `avatar.service.ts` proves it matters: it answers 404 only when the upstream gallery answers 404
 * (the user genuinely has no avatar, which is the benign case), and answers **502** when the
 * outbound fetch times out - measured on prod 2026-08-13, seventeen `[AvatarService] Error fetching
 * avatar` blocks in one five-minute run. A path-only rule filed that server fault as routine.
 *
 * The 404 itself carries a JSON body and `nosniff`, which Chrome's Opaque Response Blocking then
 * refuses to hand to the `<img>` that asked for it - hence 404, ERR_BLOCKED_BY_ORB and ERR_ABORTED
 * all naming the same URL. The UI falls back to initials, so nothing is broken. It is listed rather
 * than ignored so it still shows up under `knownBadHttp`.
 */
const BENIGN_HTTP = [{ path: /\/api\/users\/[0-9a-f]{64}\/avatar$/, status: [404] }];

/** True when this exact (path, status) pair is one of the understood failures. */
const isBenignFailure = (pathname, status) =>
  BENIGN_HTTP.some((b) => b.path.test(pathname) && b.status.includes(Number(status)));

/**
 * Lines that are NOT errors but must never be filed as routine, because they mean the client
 * changed state under the check's feet - a reconnect mid-measurement can explain a latency, a
 * missing frame, or a "pass" that only happened on the second try.
 */
const STATE_CHANGE = [
  /Connecting to Gateway|Connected to Chat Gateway|Connected to network|Disconnected|reconnect/i,
  /token refresh|refreshed|logged out|session/i,
  // The app's own connectivity verdict and its retry ladder. Not errors, and not routine either:
  // either one appearing in a check that cut NOTHING means the link moved under the measurement.
  /^\[CONNECTIVITY\]|Connection lost\. Retrying/,
  // THE RECONCILIATION EXCHANGE ITSELF, once something has already triggered it. The trigger is in
  // `NOTABLE` (`[HISTORY_RECONCILE]`, `history_request`) and stays there - that is where the finding
  // is. These two are the devices then comparing what they hold, one line per peer plus one for the
  // answer sent back, and reporting the conversation as a finding on top of its own trigger buries
  // the trigger under its consequences. A `[HISTORY_STATE]` with NO trigger above it would be the
  // interesting case, and `stateChanges` is exactly where a reader looks for that.
  /^\[HISTORY_STATE\] (From|Sent) /,
];

/**
 * NOTABLE LINES THAT ARE DEFECTS, not merely events - these break `clean`.
 *
 * `notable` was reported next to the verdict and counted for nothing, and on 2026-08-13 that cost
 * two runs: MSG-6 recorded `PASS` with `receiverClean: true` while its own record carried
 * `Ciphertext generation out of bounds 296 / SecretReuseError / [MLS] LOST frame`. A LOST FRAME is
 * the single most serious thing this campaign can see - it is the entire subject of WP-LOSS-1 and
 * WP-FALSELOSS-1 - and it read as a clean pass twice before a run happened to lose the message the
 * check was actually measuring.
 *
 * Kept separate from `errors` because these arrive as ordinary `console.log` at whatever level the
 * app chose; severity here is about WHAT THE LINE SAYS, not how it was printed. Everything else in
 * `NOTABLE` stays informational: an epoch change or a `welcome_request` is the protocol working.
 */
/**
 * THE VERDICT IS THE CLASSIFIER'S LINE, NOT THE RAW FAILURE UNDER IT.
 *
 * `mls-core` reports the decrypt failure (`Ciphertext generation out of bounds N`,
 * `SecretReuseError`, `MLS decryption failed: ...`) BELOW the layer entitled to say what it means.
 * The TS side then classifies it, and every branch of that classification logs: a duplicate the
 * ledger recognises, a frame nobody has read, a generation gap, or a fall-through to a re-add. So
 * the raw line is EVIDENCE and the line after it is the finding - matching the evidence made the
 * gate fire on the benign case, which is how a rule stops being read.
 *
 * This list is therefore the app asserting a loss, in the app's own words.
 */
const SEVERE = [
  /\[MLS\] LOST frame/i,
  /\[MLS\] Decryption error/i,
  /\[History\] frame never read here and unreadable for good/i,
  /\[History\] permanently undecryptable/i,
];

/** The raw, lower-layer decrypt failure - evidence for a finding, never a finding by itself. */
const RAW_DECRYPT_FAILURE = /SecretReuse|generation out of bounds|MLS decryption failed/i;

/**
 * Lines proving the classifier ran and reached a conclusion about a failed decrypt.
 *
 * WITHOUT THIS THE DEMOTION ABOVE WOULD BE A HOLE. If a decrypt failure ever arrives that nothing
 * classifies - a new error string, a branch that returns without logging - it would land in
 * `notable`, which does not break `clean`, and the run would go green over an unexplained failure.
 * So a raw failure with NO classification anywhere in the window is severe on its own: the evidence
 * is only demoted while something is shown to have judged it.
 */
const DECRYPT_CLASSIFIED = [
  /\[MLS\] (LOST frame|Duplicate delivery|Decryption error|No application payload)/i,
  /\[History\] (frame never read here|permanently undecryptable|retryable)/i,
  /\[GAP\]/i,
];

/**
 * Decrypt failures that are the PROTOCOL, not a defect.
 *
 * `CannotDecryptOwnMessage` is RFC 9420 working: a member cannot decrypt its own application
 * message, which is exactly why the sender's optimistic render is that message's only writer
 * (the whole subject of WP-ECHO-1). Leaving it inside `SEVERE` marked every media check dirty on
 * the first run the gate existed - a rule that fires on the normal path teaches its reader to
 * ignore it.
 *
 * THIS COMMENT USED TO SAY IT WAS LOGGED AT `RUST::DEBUG` ON EVERY SEND. Both halves were wrong,
 * and measuring them is what found the defect underneath (2026-08-15):
 *
 *  - NOT on every send. The gateway's fanout already excludes the sender's own devices, so nobody
 *    receives their own frame live. It comes from the HISTORY REPLAY reading our own mailbox back -
 *    opening the DM on two peers with no send at all produced it once on each, and opening a
 *    channel produced none.
 *  - NOT `DEBUG` at the source. `mls-core` logged it at `error!` and TWO web-only shims rewrote the
 *    level by re-matching the marker in the text. Native had neither, so the phone logged a real
 *    ERROR per own frame - and, because `decrypt_kind` had no arm for it either, queued that frame
 *    in `pending_mls_messages` for three retries it could never pass.
 *
 * It is now classified at the throw and logged at DEBUG on every platform, so nothing emits the raw
 * line on a current bundle. THE RULE STAYS ANYWAY, and not for the mixed fleet: `setupMessageHandler`
 * logs `[WELCOME] CannotDecryptOwnMessage … - ACK silencieux` from the TS side, on every platform, for
 * a Welcome addressed to another device - a live, permanent, deliberate emitter that has nothing to
 * do with the fix above. That line does not match `SEVERE` or `RAW_DECRYPT_FAILURE` and so would not
 * break `clean` on its own; what this rule does is keep it out of `classified` too, so it can never
 * stand in as proof that the classifier ran over a decrypt failure it never saw.
 *
 * The retiring condition is therefore NOT "the fleet is up to date" - it is that emitter being gone.
 * Check it before deleting this, and do not restate the fleet argument: it was written here once, on
 * the assumption that A1's older APK still produced the raw line, and A1's Rust log goes to logcat
 * rather than to the console it is observed through. One grep refuted it.
 */
const SEVERE_BUT_EXPECTED = /CannotDecryptOwnMessage/i;

/** Console text that must be reported even though it is not an error - it means something happened. */
const NOTABLE = [
  /SecretReuse|out of bounds|Duplicate|silent ACK|ACK silencieux/i,
  // A FRAME NOBODY HANDLED, on a group whose whole point is that its frames are handled. The app
  // logs this to announce VERSION SKEW, and on 2026-08-20 it was printing it between two clients
  // running the same bundle - because the history reconciliation was probing distribution groups as
  // though they were conversations. It sat in `unexplained` for one run, which is one run too many:
  // the line is rare, it names a cause, and a named cause is a claim worth checking every time.
  /distribution frame of kind .* is not handled by this client/i,
  /epoch|GAP|out-?of-?sync|re-?add|welcome_request/i,
  // PEER RECONCILIATION, WHICH IS NOT THE SAME THING AS READING THE MAILBOX. `GET
  // /api/mls/history/<groupId>` is a client fetching its OWN ciphertexts from the server and happens
  // on every conversation open; `history_request` is a client asking ANOTHER DEVICE to resend what
  // it is missing, and it only ever fires on a manifest desync - an unreadable frame, a replay that
  // gave up, a retention gap, a returning peer, the one-shot audit. None of those is part of sending
  // and receiving a message, so in a delivery check its presence is itself the finding: something
  // decided this device was out of sync. Never `clean`-breaking (a legitimate trigger must not fail
  // an unrelated check) but never silent either.
  //
  // The PROTOCOL's own five frame names, not the `[SYNC]` tag they are logged under: that tag also
  // carries group creation, bulk member addition and the WASM purge, so matching it would report
  // routine group work as a reconciliation and the signal would stop being read within one run.
  /history_(request|bundle|digest|digest_request|pull)|\[HISTORY_RECONCILE\]/i,
  // A reconciliation that actually DELIVERED something, which the line above does not cover: that one
  // says a device decided it was out of sync, this one says a peer answered and the gap closed. It
  // was landing in `unexplained`, and it is the opposite of unexplained - it is the repair reporting
  // success, and in a delivery check its presence means something was already missing before the
  // check started.
  /message\(s\) caught up/i,
  // A CONVERSATION THAT DISAPPEARED BETWEEN A MESSAGE BEING BUFFERED AND THE BUFFER BEING FLUSHED.
  // The messages were accepted - the conversation was in the map when they arrived - and are then
  // dropped without being rendered or persisted, so nothing else will ever mention them. Notable and
  // not benign: whatever else a run is measuring, this line means it lost something.
  /vanished between buffering and flush/i,
  // A LIVE MESSAGE ARRIVING FOR A CHANNEL THIS DEVICE HAS NOT LOADED. `channelEventHandler` only
  // opens a bubble for a channel already in `conversations`, so the row is dropped from the LIVE
  // path and appears on the next history load instead. That is the design, and it is why this is
  // not a failure - but it is also exactly what a lost message looks like from the outside, so it
  // is never silent: a check that asserts a live arrival and prints this instead has its answer.
  // Seen on W2 during COMM-12, for the arm's other community, while its channel was not selected.
  /Message received for an unknown channel/i,
  /forget|revoke|reset|corrupt/i,
  // THE SWEEP ACTUALLY DESTROYING SOMETHING. `[SYNC] WASM kept ...` is routine and sits in
  // `BENIGN`; this is its opposite branch, and the two must never share a rule. It fires when the
  // server confirms a group is a conversation row this device holds no membership in - correct
  // after a real exclusion or a retired salon group, and the single loudest symptom of
  // WP-GRAINE-1, where the same line deleted the key-distribution group on every connection.
  // Never `clean`-breaking, because a legitimate one must not fail an unrelated check - but
  // never silent: in a check that excluded nobody, its presence IS the finding.
  /^\[(SYNC|DISCOVERY)\] (WASM|MLS state) removed/,
  // THE CRYPTOGRAPHIC HALF OF A REVOCATION ACTUALLY FIRING - a remaining member's device finding
  // leaves in the tree that the roster no longer names, and committing them out. It is the whole of
  // WP-GRAINE-2 working, so it never breaks `clean`; but in a check that removed NOBODY its presence
  // means somebody was removed anyway, which is as serious as this campaign gets. It sat in
  // `unexplained` until COMM-3 made a real member leave, because the `BENIGN` entry for its quiet
  // sibling claimed another rule already covered it and no rule did.
  //
  // WRITTEN AGAINST `scopeLabel`, NOT AGAINST ONE SIGHTING. It produces exactly two forms -
  // `community <id>` and `salon <id> of <id>` - and the first spelling of this rule was
  // `\S+ [0-9a-f]+:`, which matches the community one and not the salon one. COMM-11 made a real
  // member lose a real salon and the line went straight back to `unexplained`, one commit after
  // this entry was added to stop exactly that. The quiet sibling in BENIGN has used `.+` all along.
  /^\[GRAINE\] (community|salon) .+: \d+ member\(s\) left but still hold a leaf - removing/,
  // A COMMIT BEING APPLIED - the group's membership moved, which is the one thing this campaign
  // watches hardest. `[QUEUE] Processing message` is routine and sits in BENIGN; a Commit is not the
  // same claim and must never share its rule. Never `clean`-breaking, because a join or a departure
  // legitimately produces one - but in a check that moved nobody, its presence IS the finding.
  /^\[QUEUE\] Processing Commit group=/,
  /decrypt(ion)? (error|failed)/i,
  // AN OUTBOX THAT DID NOT EMPTY. `[OUTBOX] Queued` and `Flushing` are routine and sit in `BENIGN`;
  // this line is the flush REPORTING LEFTOVERS, and the two are not the same claim. It fired once in
  // thirteen checks on 2026-08-14, inside MSG-7's thirty-message burst, where a transient backlog is
  // expected - so it is reported and does not break `clean`. It must never be filed as routine: an
  // outbox that stays non-empty is exactly how a message is lost without anything else complaining.
  /^\[OUTBOX\] \d+ entr(y|ies) still queued/,
  // THE DELETE THAT ARRIVED ONE INSTANT TOO LATE - the sibling of the `BENIGN` withdrawal line. The
  // entry was already in flight, so the peers will have the text and the delete has to travel as a
  // `delete_message` event instead. NOTABLE rather than benign because it is the race MUT-19 exists
  // to bound: the cancellation and the broadcast are two different mechanisms, and which one ran
  // decides what the peer sees. It does not break `clean` - losing that race is a legitimate
  // outcome, correctly handled - but a run must never report it as the cancellation.
  /^\[OUTBOX\] [0-9a-f]{8}… withdrawn while it was already being sent/,
  // THE APP DECLARING A LOSS, which is a different claim from the frame that failed to open. The
  // `[MLS] LOST frame` line is `SEVERE` and breaks `clean` on its own; this one is the decision that
  // followed it, and it is kept visible because a reconciliation with no lost frame above it would
  // mean something else entirely triggered a repair.
  /^\[MLS\] Frames are being lost in /,
  // THE SEND RATCHET BEING REPAIRED AT LOAD - the burn. It says this device came back on a snapshot
  // that predated frames it had already put on the wire, and that the generations were made up
  // before anything could send. NOTABLE and not benign, for two reasons that pull the same way: it
  // proves the reload landed inside the checkpoint window, which is the premise `burn.mjs` needs and
  // cannot otherwise observe; and OUTSIDE a deliberate reload, a device repairing its own ratchet is
  // a device that was killed mid-checkpoint, which is worth seeing. `clean` is untouched - the repair
  // succeeding is not a fault, and the fault it prevents (`[MLS] LOST frame`) is SEVERE on its own.
  /^\[MLS\] Restored state for \S+ was \d+ generation\(s\) behind/,
  // The same repair reporting that it could NOT run for a group, or that the count it was given is
  // impossible. Separated from the line above because they call for opposite readings: one is the
  // mechanism working, these are it declining to, and a run should never mistake the second for the
  // first. Neither breaks `clean` - a group this device has left is an ordinary entry to find in the
  // ledger - but both must be read.
  /^\[MLS\] Could not burn \d+ generation\(s\) for /,
  /^\[MLS\] Send ledger for \S+ claims more than \d+ unpersisted frames/,
  // The reconciliation ANSWERING. `same state ... nothing to do` is the good outcome and it is still
  // notable, because in a delivery check the exchange should not have been needed at all - a run
  // full of these is a run where something keeps deciding it is out of sync (WP-FALSELOSS-2).
  /^\[HISTORY_REQ\] .* (same state as|nothing to do)/,
  // A DESTRUCTIVE ACTION CORRECTLY REFUSED - the durable rule working, not a fault. The purge is
  // gated on knowing the server list is trustworthy, and `fetchOk=false` says it is not, so nothing
  // is deleted. Reported rather than silenced: outside a deliberate cut, a client that cannot fetch
  // its own group list is a finding, and `ignoringOfflineCut` is what forgives it inside one.
  /^\[SYNC\] WASM purge skipped - server list unreliable/,
  // THE FALSE-LOSS RACE HAPPENING AND BEING HANDLED. A history page is assembled by checking each
  // row against `seenCipherHashes` and only THEN decrypted; live delivery can read one of those very
  // frames in between. This line is the re-ask at the verdict catching exactly that, and saying so:
  // "not a loss". It is the SUCCESS path of the fix that closed WP-FALSELOSS-1 (`2ff864f9`), so it
  // must never break `clean` - but it is not routine either, because it needs a real race to fire,
  // and seeing it is how we know the fix is live on the device that logged it.
  //
  // NOT widened to `^\[History\]`: the sibling verdict of the SAME branch - "frame never read here
  // and unreadable for good" - is SEVERE, and a prefix rule would forgive the loss along with the
  // non-loss. The two are one `if` apart in `history.ts` and opposite in meaning.
  /^\[History\] frame already read live while this page was decrypting/,
  // AN OUTBOX FLUSH SKIPPED BECAUSE LEADERSHIP WAS NOT DECIDED YET - see backlog, P2. `isTabLeader`
  // is `false` until the Web Lock resolves, and `runFlush` reads that as "another tab is the
  // leader", so a flush in the boot gap is delegated to a leader that may not exist and nothing is
  // rescheduled. Observed on A1 (2026-08-15, after a reload) and on W1 (READ pass 4, at its `goto`).
  //
  // FORGIVING THIS DOES NOT FORGIVE A GENUINE LEADERSHIP FAILURE, which was the stated reason for
  // leaving it unclassified after the first sighting. A tab that really lost the election also emits
  // `[TAB] Another tab is active`, `[TAB] Race election` or `[TAB] Promoted to leader` - none of them
  // classified anywhere here, so all three still land in `unexplained` and break `clean`. The
  // absence of those lines beside this one is precisely what identified the boot gap.
  /^\[OUTBOX\] Flush skipped - follower tab/,
  // THE RESUME DECLINING ON A SOCKET THAT DISAGREES WITH OUR FLAG - and ONLY then. Both answering
  // `true` is the ordinary case (a tab hidden and shown again over a live socket) and sits in
  // `BENIGN`; `socket=false` or `socket=null` beside `flag=true` means our own state lagged the
  // socket's, and a resume that declines to reconnect on stale state is how a client sits offline
  // while believing otherwise. The two spellings are one line apart in the log and a world apart in
  // meaning, which is the whole reason it prints both answers (WP-RECONNECT-2).
  /^\[LIFECYCLE\] Resume: already connected \(flag=true, socket=(false|null)\)/,
  // A GOVERNANCE REFUSAL, in the app's own words - the community would be left with no
  // administrator. NOTABLE rather than BENIGN and rather than an error: it is the rule working, so
  // it must not break `clean` in the check that provokes it (COMM-19), and it must never be silent
  // anywhere else, because an unprovoked one means somebody tried to leave and could not.
  //
  // Matched on the distinctive half of the sentence rather than the whole, which is prose the
  // product may reword; the CODE behind it (`WORKSPACE_WOULD_HAVE_NO_ADMIN`) never reaches the log.
  /se retrouverait sans administrateur|would be left with no administrator/i,
];

/**
 * Attaches every observation domain. Call before the action, not after.
 *
 * `Page` is enabled for one reason: `Page.frameNavigated` on the main frame is the only DOCUMENT
 * REPLACEMENT event that arrives exactly once per navigation, and {@link ignoringNavigation} needs
 * to count them. `Runtime.executionContextsCleared` looks like the same thing and is not - measured
 * on 2026-08-15, three navigations produced three `frameNavigated` and SIX `executionContextsCleared`.
 */
export async function watch(cx, label) {
  await cx.send('Runtime.enable');
  await cx.send('Log.enable');
  await cx.send('Network.enable');
  await cx.send('Page.enable');
  cx.events.length = 0;
  // THE ARCHIVE `report` FILLS AS IT DRAINS. Classifying consumes `cx.events` on purpose - a
  // second report must cover only what happened since the first - but the RAW log has to survive
  // it, or `consoleLines` answers nothing to whoever asks after the verdict. COMM-25 printed
  // "0 console lines" for a run that had driven W1 through four navigations, because it prints
  // the log after gating and every other runner happens to print it before.
  cx.consumed = [];
  return { cx, label, since: Date.now() };
}

/**
 * EVERY console line the page emitted since `watch()`, unfiltered and unclassified.
 *
 * This exists as a shared export because its absence produced a false observation on 2026-08-11: a
 * probe reached for `report(...).lines`, which `report` has never returned - it returns `notable`,
 * `warnings`, `errors`, `unexplained`, never `lines`. The filter therefore ran over `undefined`,
 * reported "0 history lines", and was nearly written up as a fact about the application.
 * `heal-w2.mjs` had the correct implementation all along, privately, where nothing else could
 * reach it.
 *
 * Use this whenever a verdict needs the RAW log. `report` is the CLASSIFIER; a verdict must never
 * be computed over a projection of its own evidence.
 */
export function consoleLines(cx) {
  return (cx.consumed ?? []).concat(cx.events)
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
    .map((e) =>
      (e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      ).slice(0, 260)
    );
}

/**
 * Waits, within a bound, for the client to SAY something.
 *
 * READING `consoleLines` THE INSTANT A GESTURE RETURNS IS A RACE, and COMM-19 lost it: a refusal
 * travels to the server and back AFTER the click that provoked it, so the sentence explaining it
 * lands a few hundred milliseconds later. The check read once, found nothing, and recorded "the
 * refusal was never explained" about a client whose log carried the explanation - and the record
 * proved it, because `badHttp` held the 400 the sentence was about.
 *
 * The bound is the point. An ABSENCE is only a finding against a window a reader can argue with,
 * which is the same rule the campaign applies to a message that did not arrive.
 *
 * @returns the first matching line, or null once the window closes - both are assertable
 */
export async function awaitLine(cx, needle, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = consoleLines(cx).find((l) => l.includes(needle));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Drains what was observed and classifies it. */
export async function report(w) {
  const { cx, label } = w;
  const reqs = new Map();
  /** `Network.loadingFailed` events for a requestId this window never saw start - see the case. */
  let untrackedFailures = 0;
  const console_ = [];
  const ws = [];
  const exceptions = [];
  /** epoch_ms - monotonic_ms, read off the one event carrying both clocks. Null until one is seen. */
  let monoToWallOffset = null;
  /** Top-level documents replaced during the window - i.e. navigations. See {@link ignoringNavigation}. */
  let documentsReplaced = 0;

  for (const e of cx.events) {
    const p = e.params;
    switch (e.method) {
      case 'Page.frameNavigated':
        // Main frame only: an iframe navigating replaces no document this check's socket belongs to.
        if (!p.frame.parentId) documentsReplaced++;
        break;
      case 'Network.requestWillBeSent':
        reqs.set(p.requestId, { url: p.request.url, method: p.request.method });
        if (monoToWallOffset === null && p.wallTime && p.timestamp)
          monoToWallOffset = p.wallTime * 1000 - p.timestamp * 1000;
        break;
      // A RESPONSE WHOSE REQUEST WAS NEVER SEEN IS STILL AN ANSWER, and `if (r)` threw it away.
      //
      // MUT-11/channel's first run is the proof: `dirt_W1.errors` carried "the server responded with
      // a status of 415" and `badHttp` was EMPTY, so the one bucket built to name the URL said
      // nothing while the console shouted the status. Any request whose `requestWillBeSent` fell
      // outside this window - armed late, retried by a worker, replayed from cache - lands here with
      // an id `reqs` never heard of, and was silently dropped. `p.response.url` carries the URL, so
      // there is no reason at all not to record it; `seenRequest: false` keeps it distinguishable
      // from a normally-tracked one rather than pretending the pair was complete.
      case 'Network.responseReceived': {
        const r = reqs.get(p.requestId);
        if (r) r.status = p.response.status;
        else
          reqs.set(p.requestId, {
            url: p.response.url,
            method: p.response.requestHeaders?.[':method'] ?? '???',
            status: p.response.status,
            seenRequest: false,
          });
        break;
      }
      // Nothing equivalent is possible for a failure: `Network.loadingFailed` carries no URL at all,
      // so an untracked one can only be COUNTED - reported below, and deliberately outside `clean`,
      // because a number with no URL cannot be classified and a gate that cannot be acted on is a
      // gate that gets ignored. It is there to say the window has a blind spot, not to fail a run.
      case 'Network.loadingFailed': {
        const r = reqs.get(p.requestId);
        if (r) r.failed = p.errorText;
        else untrackedFailures++;
        break;
      }
      case 'Network.webSocketFrameError':
      case 'Network.webSocketClosed':
        ws.push({ mono: p.timestamp, text: `${e.method} ${JSON.stringify(p).slice(0, 140)}` });
        break;
      case 'Runtime.exceptionThrown': {
        // WHERE IT WAS THROWN IS PART OF THE REPORT. `description` carries a stack only when the
        // thrown value is an Error with one; an exception raised from a script the native side
        // evaluated has neither, and A1's `Cannot read properties of undefined (reading
        // 'runCallback')` (MUT-18, 2026-08-16) was therefore three sightings of a line that could
        // not be attributed to any script at all. The frame says whether it is the app's bundle or
        // something injected into the page, which is the whole question.
        const d = p.exceptionDetails ?? {};
        const frame = d.stackTrace?.callFrames?.[0];
        const where = frame
          ? `${frame.functionName || '(anonymous)'} @ ${frame.url || '(no url)'}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
          : d.url
            ? `${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}`
            : 'no script frame - evaluated into the page from outside it';
        exceptions.push(
          `${String(d.exception?.description || d.text).slice(0, 300)} [${where}]`
        );
        break;
      }
      case 'Runtime.consoleAPICalled':
        console_.push({ at: p.timestamp, level: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
        break;
      case 'Log.entryAdded':
        // Keep `url`: a browser "Failed to load resource" line names the status but not the
        // resource, so without it a benign avatar 404 is indistinguishable from a real one.
        console_.push({ at: p.entry.timestamp, level: p.entry.level, text: p.entry.text.slice(0, 300), url: p.entry.url });
        break;
    }
  }
  // Archived rather than discarded, so the raw log outlives its own classification. Concatenated
  // rather than spread: a long run holds tens of thousands of events and `push(...events)` is an
  // argument list, which is a stack overflow waiting for the busiest run of the campaign.
  cx.consumed = (cx.consumed ?? []).concat(cx.events);
  cx.events.length = 0;

  // MONOTONIC -> WALL, so a socket event can be dated at all. Network events carry CDP's
  // `MonotonicTime` (seconds from an arbitrary origin) while console events carry epoch
  // milliseconds, and `requestWillBeSent` is the only event that carries BOTH - so it is the only
  // place the offset can be read. Without this, `Network.webSocketClosed` has no wall time and the
  // instant a socket died cannot be compared to anything the app said about it.
  const monoRef = monoToWallOffset;
  const wall = (mono) => (monoRef === null || mono === undefined ? null : mono * 1000 + monoRef);
  for (const w of ws) w.at = wall(w.mono);

  // De-duplicate: Log.entryAdded and consoleAPICalled surface the same line twice.
  const seen = new Set();
  const lines = console_.filter((l) => {
    const k = `${l.level}|${l.text.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  /**
   * The clock a line was stamped with, removed - so an `^`-anchored pattern matches the SENTENCE.
   *
   * TWO STAMPS, AND ONLY ONE WAS REMOVED. The app writes both: `[HH:MM:SS]` from the in-app log
   * panel and a full ISO instant from `Log.d`. Every `^`-anchored rule silently failed against the
   * second kind, which is the same class of silence the comment on `t` was written about - one list
   * matched a different text than the others. Found on 2026-08-20, when
   * `[CHANNEL] history visibility set to joined` stayed `unexplained` with a rule in `BENIGN` that
   * named it exactly, and turned a COMM-12 run where all ten assertions held into PASS-DIRTY.
   */
  const strip = (t) =>
    t
      .replace(/^\[\d\d:\d\d:\d\d\]\s*/, '')
      .replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\s*/, '');
  /**
   * A console line about a request whose failure is understood - path AND status both.
   *
   * The status has to be read out of the TEXT here, because a `Log.entryAdded` carries the url as a
   * field and the status only inside "the server responded with a status of 404". The blocked and
   * aborted variants carry no status at all: they are Chrome's own reaction to the 404 body being
   * `nosniff`, so they are forgiven on the same path - and nothing else is. A 502 from the same
   * endpoint reads as an error, which is the point of the change.
   */
  const isBenignUrl = (u, text = '') => {
    if (!u) return false;
    try {
      const { pathname } = new URL(u);
      return BENIGN_HTTP.some(
        (b) =>
          b.path.test(pathname) &&
          (b.status.some((s) => text.includes(String(s))) ||
            /ERR_BLOCKED_BY_ORB|ERR_ABORTED/.test(text))
      );
    } catch {
      return false;
    }
  };
  const errors = lines.filter(
    (l) => (l.level === 'error' || l.level === 'assert') && !isBenignUrl(l.url, l.text)
  );
  /**
   * EVERY LIST IS TESTED AGAINST THE SAME TEXT, and it used not to be.
   *
   * `BENIGN` was matched on `strip(l.text)` while `NOTABLE`, `SEVERE`, `DECRYPT_CLASSIFIED` and
   * `STATE_CHANGE` were matched on the raw line - so every `^`-anchored pattern in those four lists
   * silently never matched a line the app had timestamped, which is most of them.
   * `/^\[OUTBOX\] \d+ entr(y|ies) still queued/` had been in `NOTABLE` since it was written and
   * landed in `unexplained` on all three passes of 2026-08-14 for exactly this reason. The same
   * silence in `SEVERE` would be a lost frame nobody classified, which is the one thing this file
   * exists to prevent.
   */
  const t = (l) => strip(l.text);
  const warnings = lines.filter((l) => l.level === 'warning' || l.level === 'warn');
  const notable = lines.filter((l) => NOTABLE.some((r) => r.test(t(l))));
  const classified = lines.filter(
    (l) => DECRYPT_CLASSIFIED.some((r) => r.test(t(l))) && !SEVERE_BUT_EXPECTED.test(t(l))
  );
  const severe = lines.filter(
    (l) =>
      !SEVERE_BUT_EXPECTED.test(t(l)) &&
      (SEVERE.some((r) => r.test(t(l))) ||
        // A raw failure nothing judged. See DECRYPT_CLASSIFIED: the demotion holds only while the
        // classifier is shown to be running, or the gate would go quiet on the one case it is for.
        (classified.length === 0 && RAW_DECRYPT_FAILURE.test(t(l))))
  );
  const stateChanges = lines.filter((l) => STATE_CHANGE.some((r) => r.test(t(l))) && !notable.includes(l));
  const unexplained = lines.filter(
    (l) =>
      !BENIGN.some((r) => r.test(t(l))) &&
      !isBenignUrl(l.url, l.text) &&
      !errors.includes(l) &&
      !warnings.includes(l) &&
      !notable.includes(l) &&
      !stateChanges.includes(l)
  );

  const http = [...reqs.values()].filter((r) => !/\.(js|css|woff2?|png|svg|jpg|jpeg|ico|webp)(\?|$)/.test(r.url) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  // A STATUS IS AN ANSWER, AND A REQUEST THAT GOT ONE IS JUDGED ON IT - which is what the comment
  // below has always claimed and what this line did not do: `r.failed ||` short-circuited before the
  // status was ever consulted, so a response that ARRIVED and whose body load was then cancelled was
  // filed as a failure. It reported `GET /api/users/<id>/avatar -> 200` in `badHttp` and broke
  // MSG-7's fifth pass on 2026-08-14 - a 200 called bad by the instrument, the whole run non-zero
  // behind it. `r.failed` still counts for a request that never got a status at all.
  const failing = http.filter((r) => (r.status ? r.status >= 400 : r.failed));
  // A transport failure (`r.failed`, no status) on a benign path is Chrome's ORB refusing the 404
  // body it was handed; anything carrying a status is judged on that status, so a 502 from the same
  // endpoint goes to `badHttp` where a path-only rule used to swallow it.
  const badHttp = failing.filter(
    (r) => !isBenignFailure(new URL(r.url).pathname, r.status ?? 404)
  );
  const knownBadHttp = failing.filter((r) => !badHttp.includes(r));

  // A NAVIGATION'S OWN SOCKET TEARDOWN IS FORGIVEN HERE, NOT AT THE CALL SITE. See
  // {@link ignoringNavigation} for the mechanism and the proof of its bound; what belongs in THIS
  // comment is why it is the default rather than an opt-in like `ignoringOfflineCut`.
  //
  // The two are not the same kind of correction. An offline cut is something only the CHECK knows it
  // did - `report` sees a dead socket and cannot tell a deliberate cut from a real one, so it must be
  // told. A navigation is different: `Page.frameNavigated` is IN THIS WINDOW's own event stream, so
  // `report` counts it itself and needs nothing from the caller. A correction derivable from the
  // evidence should not depend on the caller remembering to ask for it.
  //
  // Measured 2026-08-15: of 39 scripts that navigate inside a watch window, exactly ONE (read.mjs)
  // asked. MSG and TYPE came out clean only because their windows happen to OPEN AFTER the
  // navigation - a property of how they were written, not a rule anyone stated - while `fwd.mjs`
  // watches first and collected one `webSocketClosed` per run for doing what the check told it to.
  // Leaving this opt-in means every future check re-learns that by being wrong once.
  //
  // The bound is unchanged, so nothing is weakened: closes beyond `documentsReplaced` still break
  // `clean`, which is WP-RECONNECT-2's shape.
  return applyNavigationForgiveness({
    label,
    // `unexplained` BREAKS CLEAN, and that is the campaign's actual bar rather than a stricter one:
    // "tout doit etre explique, limite tu devrais savoir exactement avant de le voir". A line nobody
    // has classified is by definition a line whose meaning nobody knows, so a verdict formed over it
    // is a verdict formed over an unknown - and the two defects this gate exists to catch (WP-LOSS-1,
    // WP-FALSELOSS-2) both sat in a bucket that was printed and counted for nothing.
    //
    // It is not a trap for new app logs either: the fix for a line landing here is to READ it once
    // and put it in `BENIGN` with the reason, which is the triage this campaign is for. What it
    // forbids is doing that implicitly, by never looking.
    clean:
      errors.length === 0 &&
      badHttp.length === 0 &&
      exceptions.length === 0 &&
      ws.length === 0 &&
      severe.length === 0 &&
      unexplained.length === 0,
    severe: severe.map((l) => l.text),
    errors: errors.map((l) => l.text),
    exceptions,
    badHttp: badHttp.map((r) => `${r.method} ${r.url.replace('https://canari-emse.fr', '')} -> ${r.status ?? r.failed}`),
    knownBadHttp: knownBadHttp.map((r) => `${r.method} ${r.url.replace('https://canari-emse.fr', '')} -> ${r.status ?? r.failed}`),
    ...(untrackedFailures ? { untrackedFailures } : {}),
    wsEvents: ws.map((w) => `${hhmmss(w.at)} ${w.text}`),
    documentsReplaced,
    warnings: warnings.map((l) => l.text),
    notable: notable.map((l) => l.text),
    stateChanges: stateChanges.map((l) => l.text),
    unexplained: unexplained.map((l) => `${l.level}: ${l.text}`),
    httpCount: http.length,
    consoleCount: lines.length,
    // EVERY line and every socket event, in one sequence, each DATED. See {@link timelineOf}.
    //
    // BUILT FROM `console_`, NOT FROM `lines` - the de-duplicated copy. The dedup exists so a line
    // surfaced twice by `Log.entryAdded` and `consoleAPICalled` is classified once, and it strips
    // the `[HH:MM:SS]` prefix before comparing, so it also collapses the SAME line emitted at two
    // DIFFERENT times. That is fatal here: WP-OUTBOX-1 turns on whether `[OUTBOX] Flush skipped -
    // offline` fired a second time ten seconds after the first, and the classifier had thrown the
    // second one away as a duplicate of the first. A repeat is not noise - it is often the entire
    // finding.
    timeline: timelineOf(console_, ws),
  });
}

/** `HH:MM:SS.mmm` of an epoch instant, or `--:--:--.---` when the event carried no usable clock. */
export function hhmmss(at) {
  if (!at) return '--:--:--.---';
  const d = new Date(at);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * THE ONE SEQUENCE, DATED - console lines and socket events interleaved in the order they happened.
 *
 * Written after WP-RECONNECT-2 could not be read from its own capture on 2026-08-14. The record held
 * a 98-second hole between `[WS] Disconnected. Code: 1006` and `Connection lost. Retrying in 1s...`,
 * and NEITHER end of it could be dated:
 *
 *   - the app timestamps its `appendLog` lines and NOT its `console.warn` ones, so `[WS] Disconnected`
 *     carried no clock and had to be placed by bucket order - which is an inference, not a
 *     measurement, and it flipped the diagnosis when questioned. Whether the close arrived at the
 *     START of the hole or at its END is the whole question, and the log could not say;
 *   - `Network.webSocketClosed` DOES date it, authoritatively and independently of anything the app
 *     believes - and `ignoringOfflineCut` deleted the entire `wsEvents` bucket as "the cut". The one
 *     event that answered the question was discarded by the classifier for being expected.
 *
 * CDP has carried both clocks all along. Console events are epoch milliseconds; network events are
 * monotonic seconds, converted through the offset read off `requestWillBeSent`. Nothing here is new
 * evidence - it is evidence that was already arriving and was being thrown away.
 */
export function timelineOf(lines, ws) {
  const merged = [
    ...lines.map((l) => ({ at: l.at ?? null, kind: l.level, text: l.text })),
    ...ws.map((w) => ({ at: w.at ?? null, kind: 'ws', text: w.text })),
  ].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  /**
   * COLLAPSE THE DOUBLE-SURFACING, KEEP THE GENUINE REPEAT - and the difference between them is
   * TIME, not text. `Log.entryAdded` and `Runtime.consoleAPICalled` report one `console.log` twice,
   * within a millisecond of each other; the same line emitted again ten seconds later is a second
   * event and is frequently the whole finding (WP-OUTBOX-1). The classifier's own dedup cannot tell
   * them apart because it compares text with the clock stripped off, which is why the timeline does
   * its own.
   */
  const SAME_EVENT_MS = 250;
  const lastSeen = new Map();
  const out = [];
  for (const e of merged) {
    const key = `${e.kind}|${String(e.text).replace(/^\[\d\d:\d\d:\d\d\]\s*/, '')}`;
    const prev = lastSeen.get(key);
    if (prev !== undefined && e.at !== null && e.at - prev < SAME_EVENT_MS) continue;
    if (e.at !== null) lastSeen.set(key, e.at);
    out.push(`${hhmmss(e.at)} [${e.kind}] ${e.text}`);
  }
  return out;
}

/**
 * The longest interval in a timeline during which the client said NOTHING, and what bracketed it.
 *
 * A hole is the shape a stalled recovery makes: the app is not failing, not retrying and not
 * logging, and no bucket of a classifier can show that because a hole is made of absent lines. This
 * turns it into a value a check can assert on.
 */
export function longestSilence(timeline) {
  const dated = timeline
    .map((t) => ({ at: Date.parse(`1970-01-01T${t.slice(0, 12)}Z`), text: t }))
    .filter((t) => Number.isFinite(t.at));
  let worst = { ms: 0, after: null, before: null };
  for (let i = 1; i < dated.length; i++) {
    const ms = dated[i].at - dated[i - 1].at;
    if (ms > worst.ms) worst = { ms, after: dated[i - 1].text, before: dated[i].text };
  }
  return worst;
}

/**
 * THE TAG WHITELIST IS GONE, AND IT WAS HIDING THE CAMPAIGN'S OWN PRIMARY EVIDENCE.
 *
 * This used to pass `*:S` plus nineteen literal tags, with a comment stating exactly the risk it was
 * running: *"a tag missing here is a line that can never arrive - and a check whose verdict lives on
 * that line can never pass"*. It was right, and it was describing itself.
 *
 * `adb`'s tag filters are EQUALITIES, not prefixes, and the Rust half of this application does not
 * log under `CanariRust` at all - the logger emits the MODULE PATH as the tag. Measured 2026-08-16
 * against a stored capture: `mines_app_lib::commands::mls`, `mls_core::state`, `mls_core::messaging`,
 * `openmls::schedule`, `openmls::tree::sender_ratchet`, `openmls::framing::private_message_in` and a
 * dozen more were all being silenced, because `mines_app_lib:D` matches the tag `mines_app_lib` and
 * nothing else. Among the silenced lines, in that one capture:
 *
 *     E/openmls::framing::private_message_in   SecretReuseError                          x3
 *     E/openmls::framing::private_message_in   Ciphertext generation out of bounds 280   x1
 *     E/openmls::framing::private_message_in   Ciphertext generation out of bounds 281   x2
 *
 * which are the two markers of the false-loss class this whole campaign exists to detect - named
 * verbatim in `logcatNotable`'s own predicate, on a tag that predicate could never be handed. So the
 * phone was blind to its own MLS core on every check that read it, and the web half's CDP console
 * cannot cover it: the Rust log does not go there. (Those particular sightings pre-date the fix and
 * are not a live defect. The blind spot was.)
 *
 * CAPTURE WIDE, CLASSIFY PRECISELY - the same shape the server observer already has. A whitelist
 * decides what may be seen BEFORE anything is known about it, which is the wrong end: `logcatReport`
 * partitions by ownership afterwards, where a Rust module path is recognisable by its shape and
 * everything else is counted rather than judged. Nothing can be silenced by an omission any more.
 */

/**
 * The phone's adb serial, RESOLVED rather than hard-coded.
 *
 * Its DHCP lease changes between sessions (it has already moved subnet once), so a literal address
 * turns every logcat call into `LOGCAT UNAVAILABLE` - and a check whose verdict lives on a logcat
 * line then fails for a reason that has nothing to do with the app. The wireless entry is preferred
 * because USB drops on this device mid-capture; USB is only the fallback that lets a run start.
 */
import { execFileSync as execSync_ } from 'node:child_process';

function resolveSerial() {
  try {
    const lines = execSync_('adb', ['devices'], { encoding: 'utf8', timeout: 10000 })
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[1] === 'device')
      .map((p) => p[0]);
    return lines.find((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) ?? lines[0] ?? null;
  } catch {
    return null;
  }
}

export const A1_SERIAL = resolveSerial();

export async function logcatSince(sinceMs) {
  const { execFileSync } = await import('node:child_process');
  if (!A1_SERIAL) return ['LOGCAT UNAVAILABLE: no adb device attached'];
  // logcat -T wants "MM-DD hh:mm:ss.mmm" in the DEVICE's local time, not ISO and not UTC.
  const d = new Date(sinceMs - 1500);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.000`;
  try {
    // No tag filter, and a buffer sized for it: an unfiltered window over a long check runs to tens
    // of thousands of lines (28 464 in the capture this was measured against), and `execFileSync`
    // does not truncate on overflow - it THROWS, which this function reports as `LOGCAT UNAVAILABLE`.
    // A silent instrument would have been bad; one that fails loudly at a size it should handle is
    // just a wrong constant.
    const out = execFileSync('adb', ['-s', A1_SERIAL, 'logcat', '-d', '-T', stamp], {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 128 * 1024 * 1024,
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('---------'));
  } catch (e) {
    return [`LOGCAT UNAVAILABLE: ${String(e.message).slice(0, 160)}`];
  }
}

// `logcatNotable` LIVED HERE AND IS DELETED - the keyword filter every phone check used to call.
//
// It answered "does this line contain a scary word", which is not the question: a line is either
// EXPECTED AND NAMED or it is a finding, and a filter can only ever produce a subset of the first
// kind. Measured against a real 2 627-line capture, its predicate marked 43 lines that are not this
// application at all - 39 from the WebView's Chrome-Sync subsystem, four from a DIFFERENT app's
// WorkManager - while the six that mattered (`SecretReuseError` x3, `Ciphertext generation out of
// bounds` x3) were unreachable behind the tag whitelist above it. Wrong in both directions at once.
//
// Its five call sites now use {@link logcatReport}. Deleted rather than deprecated: a filter left
// exported is a filter the next phone check will reach for, and it reads as an alternative to the
// classifier rather than as the thing the classifier replaced.

/** What a DELIBERATE network cut makes a healthy client say. Nothing here is a defect on its own. */
const OFFLINE_NOISE =
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|Failed to fetch|NetworkError|server unreachable \(transport failure\)/i;

/**
 * The app's OWN reaction to a cut, which is a different set of lines from the browser's.
 *
 * A client whose socket has just died retries, and the retry fails while the emulation is on: that
 * is the reconnect logic working exactly as designed. These are forgiven only under
 * {@link ignoringOfflineCut} - outside a deliberate cut, `[WS] Gateway connection failed` is one of
 * the more serious things this campaign can see, and it must stay an error there.
 */
// NOT anchored on the word "failed": that line carries the whole socket URL, token included, and
// `report` truncates at 300 characters - so the verb never survives to be matched. Matching the
// SUBJECT instead is both shorter and immune to the truncation.
const CUT_REACTION =
  /WebSocket connection to '?wss?:|\[WS\] WebSocket error|\[WS\] Gateway connection failed|Connection lost\. Retrying|\[OUTBOX\] \S+ transient failure|Gateway inaccessible: WebSocket connection failed/i;

/**
 * THE PHONE'S NATIVE HALF, CLASSIFIED - the third surface, which had a `grep` where the other two
 * have classifiers.
 *
 * It replaces `logcatNotable`, a keyword filter, and a filter is not an observation: it answered
 * "does this line contain a scary word", never "is every line here expected". Measured 2026-08-16
 * against a real 2 627-line capture, that predicate marked 43 lines that are not this app at all - 39
 * from the WebView's own Chrome-Sync subsystem (`get_updates_processor.cc`, `syncer_proto_util.cc`)
 * and four `Could not create Worker com.linkedin.android.litrackingcomponent...`, which is A DIFFERENT
 * APP's WorkManager job landing in the same buffer. Gating a verdict on that would have made the
 * phone permanently dirty, and dirt that is always there is dirt nobody reads.
 *
 * SO THE PARTITION IS BY OWNERSHIP FIRST, SEVERITY SECOND. Only lines this application emitted can
 * break `clean`; everything else is COUNTED by tag, so the blind spot is visible in the record
 * instead of being silently forgiven. A number beside a tag says "this is here and it is not ours";
 * dropping it entirely would say nothing at all.
 *
 * `Tauri/Console` IS DELIBERATELY EXCLUDED, and counted so the exclusion is legible. Those lines are
 * the app's TypeScript console, which `watch(a1)` already captures over CDP with a stack frame and
 * the network events around it - strictly more than logcat's flattened copy. Classifying them twice
 * would double every web-side finding and let the two halves disagree. What CDP CANNOT see is the
 * native side - `CanariRust`, `CanariFCM`, the keystores, the workers, a `AndroidRuntime` crash -
 * which is exactly what this covers, and the reason a phone check that only watched CDP had observed
 * half its client.
 *
 * The `EXPLAINED` list is measured, not imagined: every entry was read off a real capture, and
 * anything native that matches none of them lands in `unexplained` verbatim, which breaks `clean`.
 * That is the same contract as the server observer - a line is either expected AND named here, or it
 * is a finding.
 *
 * @param {string[]} lines raw logcat, as {@link logcatSince} returns it
 * @param {string} label which client this is, for the record
 */
export function logcatReport(lines, label = 'A1') {
  /**
   * Tags this application's own code writes - Kotlin by NAME, Rust by SHAPE.
   *
   * The Kotlin half is a list because it is one. The Rust half cannot be: `env_logger` emits the
   * MODULE PATH as the tag, so the set is every module of this binary and of every crate it links -
   * `openmls::tree::sender_ratchet`, `mls_core::state`, `hyper_util::client::legacy::connect::http`.
   * Enumerating that is a list that goes stale on a `cargo update`, which is how the old tag
   * whitelist silenced the MLS core for months.
   *
   * `::` IS THE DISCRIMINATOR, and it was checked against the population rather than assumed: over a
   * 28 464-line unfiltered capture of the whole device, no Android tag contains `::` and every tag
   * that does belongs to this binary. Bare snake_case is deliberately NOT used even though
   * `tokio_tungstenite` wants it - `audio_hw`, `usf_sensor_hal`, `wpa_supplicant` and `word_detector_0`
   * are all platform tags of the same shape, and a discriminator that cannot separate them would
   * hand this app the platform's failures.
   */
  const OURS_BY_NAME =
    /^(CanariRust|CanariFCM|CanariWorker|CanariApp|CanariBoot|CanariNotifAction|CanariOutboxRetry|MlsDeviceKeyStore|PushSecretKeystore|KeyboardMedia|MainActivity|mines_app_lib|tokio_tungstenite|RustStdoutStderr|Tauri\/Plugin)$/;
  const RUST_MODULE = /^[a-z][a-z0-9_]*(::[a-z0-9_]+)+$/;
  const isOurs = (tag) => OURS_BY_NAME.test(tag) || RUST_MODULE.test(tag);

  /**
   * Every native shape seen on a healthy run, each named. Ordered only for readability - the first
   * match wins, and none of these overlap.
   */
  const EXPLAINED = [
    ['lifecycle', /^(onPause|onResume|onCreate|onDestroy|onNewIntent): /],
    ['keystore-read', /^retrieve: success alias=/],
    ['keystore-health', /^checkKeystoreHealth: Keystore operational/],
    ['push-secret', /^processPendingPushSecret: /],
    ['installer', /^recordInstallerPackage: /],
    ['fcm-token', /^FCM token synced/],
    ['fcm-received', /^onMessageReceived: type=/],
    ['fcm-foreground-skip', /^App in foreground -> MLS handled by the foreground/],
    ['fcm-decrypt', /^(tryDecrypt|decryptProto): (MLS state loaded|success)/],
    ['fcm-notify', /^(showNotification|refreshBadgeSummary|thread): /],
    ['fcm-cache', /^(writeFcmCache|fetchAvatar): /],
    ['outbox-drain', /^(drainOutboxBackground|sendQueuedMessagePush): /],
    ['worker-flag', /^resetFailureFlag: flag reset/],
    ['paths', /^\[mines_app_lib\] \[Path\] /],
    // ── the Rust half, silenced by the old tag whitelist and therefore never classified before ──
    // Each of these was read off a real capture; the module path is already in the tag, so matching
    // the bracketed prefix the logger repeats would only restate it.
    ['mls-benign-drop', /^\[mls_core::messaging\] Benign /],
    ['mls-state', /^\[mls_core::(state|messaging)\] /],
    ['mls-commands', /^\[mines_app_lib::commands::mls\] /],
    ['push-commands', /^\[mines_app_lib::commands::push\] /],
    ['storage-commands', /^\[mines_app_lib::commands::(storage|cookies)\] /],
    ['background-send', /^\[mines_app_lib::mobile::background\] /],
    // openmls at DEBUG is the key schedule narrating itself - one line per derivation, several per
    // frame. It is loud and it is not a signal; an ERROR from the same module is not covered here
    // and cannot be, because the `E` branch above returns before any rule is consulted.
    ['openmls-debug', /^\[openmls::(schedule|tree::secret_tree|tree::sender_ratchet|framing::private_message)/],
    ['sql', /^\[sqlx::query\] /],
    ['http-pool', /^\[(hyper_util|reqwest)::/],
    ['websocket', /^\[(tokio_tungstenite|tungstenite)(::[a-z_:]+)?\]/],
    ['tauri-asset', /^\[tauri::manager\] Asset/],
    ['jni-attach', /^\[jni::wrapper::java_vm::vm\] /],
    ['tauri-plugin', /^Tauri plugin: /],
    // Rust's stdout capture relays the WebView's own startup chatter under an app tag. It is the
    // engine's line wearing our tag, so it is named rather than left to read as ours.
    ['webview-stdout-relay', /^\[\d{4}\/\d{6}|^\[(INFO|WARNING|ERROR):/],
  ];

  const parsed = [];
  const skipped = { unparsed: 0, tauriConsole: 0 };
  const foreign = {};

  for (const raw of lines) {
    if (!raw || raw.startsWith('---------')) continue;
    // TWO FORMATS, because two producers. `logcatSince` takes adb's default (`threadtime`:
    // `MM-DD hh:mm:ss.mmm PID TID L Tag: msg`) while the captures `verify-on-device.py` left on disk are
    // `brief` with a time column (`MM-DD hh:mm:ss.mmm L/Tag(PID): msg`). A parser that knew one of
    // them would classify a whole capture as `unparsed` and report it as a blind spot rather than a
    // population - which is how a measurement gets made against nothing.
    // THE TAG ENDS AT THE FIRST COLON-SPACE, NOT THE FIRST COLON - and getting that wrong silenced
    // the Rust half a second time, in this parser, one layer below the adb whitelist that had just
    // been removed for the same reason. `([^\s:]+)` reads `mls_core::state` as the tag `mls_core`,
    // which carries no `::` and is therefore filed as somebody else's line. The stored captures did
    // not catch it because they are in adb's `brief` format, where `(pid)` delimits the tag; the
    // threadtime branch is the one `logcatSince` actually produces, so the fix would have been inert
    // in the field and green on the bench. `logcatclassify-selftest.mjs` is what found it.
    const tt = /^(\d{2}-\d{2} [\d:.]+)\s+(\d+)\s+\d+\s+([VDIWEF])\s+(\S+?):\s(.*)$/.exec(raw);
    const br = tt ? null : /^(\d{2}-\d{2} [\d:.]+)\s+([VDIWEF])\/(.+?)\(\s*(\d+)\):\s?(.*)$/.exec(raw);
    if (!tt && !br) {
      // `LOGCAT UNAVAILABLE: ...` is `logcatSince` reporting it could not read the device at all,
      // and an unreadable surface is NOT a clean one - it goes straight to `errors`.
      if (/^LOGCAT UNAVAILABLE/.test(raw))
        parsed.push({ at: null, pid: null, sev: 'E', tag: 'adb', msg: raw, ours: true });
      else skipped.unparsed++;
      continue;
    }
    const [at, pid, sev, tag, msg] = tt
      ? [tt[1], tt[2], tt[3], tt[4], tt[5]]
      : [br[1], br[4], br[2], br[3], br[5]];
    parsed.push({ at, pid, sev, tag: tag.trim(), msg, ours: isOurs(tag.trim()) });
  }

  const errors = [];
  const severe = [];
  const notable = [];
  const unexplained = [];
  const explainedBy = {};
  const pids = new Set();

  for (const l of parsed) {
    if (l.tag === 'Tauri/Console') {
      skipped.tauriConsole++;
      continue;
    }
    // WorkManager and the crash handler carry BOTH owners' lines on one tag, so ownership is read
    // from the payload rather than the tag. `com.linkedin.android...` on `WM-WorkerWrapper` is the
    // measured case: judging it by tag alone put another app's failure in this app's record.
    const ours =
      l.ours ||
      ((l.tag === 'WM-WorkerWrapper' || l.tag === 'AndroidRuntime' || l.tag === 'System.err') &&
        /fr\.emse\.canari|CanariRust|mines_app_lib/.test(l.msg));
    if (!ours) {
      foreign[`${l.sev}/${l.tag}`] = (foreign[`${l.sev}/${l.tag}`] || 0) + 1;
      continue;
    }
    // THE PIDS OUR LINES CAME FROM, so the ownership rule above can be REFUTED rather than trusted.
    // `::` is a shape argument, and a shape argument holds until some other Rust binary on the device
    // writes one; a tag attributed to this app from a pid the app never had is that refutation, and
    // without this the claim would be unfalsifiable. It also dates the restarts a check performed:
    // `am kill` gives the next launch a new pid, so a NOTIF or LIFE window legitimately holds two.
    if (l.pid) pids.add(l.pid);

    const text = `${l.at ?? ''} ${l.sev}/${l.tag}: ${l.msg}`.trim();
    const MARKERS = /FATAL EXCEPTION|AndroidRuntime|panic|SecretReuse|LOST frame|out of bounds/i;

    // SEVERITY IS READ FROM THE LEVEL FIRST, AND A RULE MAY NEVER EXPLAIN AWAY AN `E`.
    if (l.sev === 'F' || (l.sev === 'E' && MARKERS.test(l.msg))) {
      severe.push(text);
      continue;
    }
    if (l.sev === 'E') {
      errors.push(text);
      continue;
    }

    // THE APP'S OWN CLASSIFICATION OUTRANKS THE OBSERVER'S SUBSTRING, and getting this backwards was
    // measured here rather than argued: `D/mls_core::messaging  Benign same-epoch ratchet frame
    // dropped: group=... reason=SecretReuseError` is the application stating, at DEBUG, that it
    // recognised the condition and handled it - and the marker test above it read the word
    // `SecretReuseError` inside that sentence and filed the line as `severe`. Three of the nine
    // severe lines in the capture this was built against were that exact self-report.
    //
    // This is the campaign's own "classify at the THROW, never on an error MESSAGE" rule seen from
    // the observing end: where the code has already decided, the observer's job is to honour the
    // decision, not to re-derive it from prose. Restricted to D/I/W/V precisely so it cannot become
    // a way to silence a real failure - an `E` never reaches this point.
    const hit = EXPLAINED.find(([, re]) => re.test(l.msg));
    if (hit) {
      explainedBy[hit[0]] = (explainedBy[hit[0]] || 0) + 1;
      // Explained AND worth seeing: an epoch gap or a re-enrolment is normal traffic and still the
      // first thing a reader wants beside a delivery verdict.
      if (/epoch|GAP|welcome|revoke|forget|out-of-sync/i.test(l.msg)) notable.push(text);
      continue;
    }
    // An UNCLASSIFIED line carrying a marker still escalates: the rules above are what is known to be
    // benign, and a line nobody has named is not covered by any of them.
    if (MARKERS.test(l.msg)) {
      severe.push(text);
      continue;
    }
    // A FALLBACK IS A SIGNAL, NEVER A PATH - so it breaks `clean` from whatever level it was logged
    // at. `CanariFirebaseMessagingService` renders "Nouveau message de X" when background MLS
    // decryption failed, and says so: `Log.w(TAG, "Fallback notification: $it")`. At `W` it would
    // have landed in `notable`, which does not gate, and the phone would keep reporting PASS while
    // every notification it raised was undecrypted - which is exactly what was asked about NOTIF-10
    // on 2026-08-16 and exactly what no check could answer.
    //
    // The ONE case where this is the correct behaviour is a notification for a message in an epoch
    // the background context cannot reach (NOTIF-2). That check must forgive this line EXPLICITLY,
    // the way `ignoringOfflineCut` forgives a cut it performed - never by lowering the bar here.
    if (/Fallback notification:|generic fallback/i.test(l.msg)) {
      errors.push(text);
      continue;
    }
    if (l.sev === 'W') {
      // A WARNING THIS APP EMITTED IS NOT AUTOMATICALLY BENIGN, but it does not break `clean` on its
      // own - same rule the web report applies - so it is surfaced rather than judged.
      notable.push(text);
      continue;
    }
    unexplained.push(text);
  }

  return {
    label,
    // The same six buckets `dirtOf` reads, so a phone report drops into `gate()` unchanged. The two
    // that cannot exist here are present and empty on purpose: an absent key would read as "this
    // instrument does not check that", which is a different claim from "it found none".
    errors,
    severe,
    exceptions: [],
    badHttp: [],
    wsEvents: [],
    unexplained,
    notable,
    clean: errors.length === 0 && severe.length === 0 && unexplained.length === 0,
    /**
     * Counted, never judged: the WebView engine, the ART runtime, and every other app on the device.
     *
     * SUMMARISED, because the window is now unfiltered and a whole-device capture carries several
     * HUNDRED distinct foreign tags - a record that inlined them all would be unreadable and would
     * bury the six buckets above it. The total is what says "this window was wide"; the busiest few
     * are what a reader needs if a foreign subsystem ever turns out to matter, and the full dump is
     * one re-run of `scratch/logcatpop.mjs` away.
     */
    foreign: {
      lines: Object.values(foreign).reduce((a, b) => a + b, 0),
      tags: Object.keys(foreign).length,
      busiest: Object.fromEntries(
        Object.entries(foreign)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
      ),
    },
    /** `Tauri/Console` belongs to the CDP watcher; `unparsed` is this parser's own blind spot. */
    skipped,
    explainedBy,
    /**
     * Every rule this classifier declares, matched or not - so `logcatclassify-selftest.mjs` can
     * assert that each one is exercised by a fixture. `explainedBy` only ever names the rules that
     * FIRED, which cannot distinguish "no such line in this window" from "this rule stopped
     * matching when the message was reworded".
     */
    ruleNames: EXPLAINED.map(([n]) => n),
    /** Distinct pids our own lines came from - see the note where they are collected. */
    pids: [...pids],
    linesSeen: parsed.length,
  };
}

/**
 * WHY a report is not clean, as one object - and `{}` when it is clean.
 *
 * A RECORD SAYING `clean: false` AND NOTHING ELSE IS THE INSTRUMENT REFUSING TO ANSWER. MSG-10
 * reported a dirty sender on 2026-08-14 with `senderSevere: []` and `senderErrors: []` beside it,
 * because the two buckets it happened to keep were not the two that had broken the verdict - so the
 * only way to learn what it saw was to re-run it, which is the definition of a result that cannot be
 * believed. Every bucket that can break `clean` belongs in the record, and each check listing them by
 * hand is how they drift apart, so they are listed HERE, once, next to the definition of `clean`.
 *
 * Only the non-empty ones: a clean run records `{}` rather than five empty arrays nobody reads.
 */
export function dirtOf(rep) {
  const out = {};
  for (const bucket of ['severe', 'errors', 'exceptions', 'badHttp', 'wsEvents', 'unexplained'])
    if (rep?.[bucket]?.length) out[bucket] = rep[bucket];
  return out;
}

/**
 * THE VERDICT, GATED ON CLEANLINESS - one definition, for every check.
 *
 * The campaign's rule is that a verdict is PASS only if the assertions hold AND the run is clean, and
 * every script was applying it by hand or not at all. Both halves of that cost something measurable:
 *
 *   - MSG-2 and FWD-3/4/5 attached watchers, printed their lines, and formed the verdict without
 *     ever consulting them. The observation ran and decided nothing, which is the same as not
 *     observing while looking like the opposite;
 *   - the ones that DID gate spelt the outcome differently - `PASS-WITH-NOISE` in MSG-5,
 *     `PASS-DIRTY` in MSG-10 - so the dashboard could not count "how many runs were dirty" without
 *     knowing which script wrote the row. Two names for one state is one name too many.
 *
 * A FAILING ASSERTION IS NEVER DEMOTED TO DIRT. Dirt only ever turns a PASS into `PASS-DIRTY`; a
 * FAIL, a SLOW or an INVALID stands as it is, and carries its dirt in the record either way, because
 * the noise beside a failure is usually what explains it.
 *
 * THE LINES, NOT A BOOLEAN. `senderClean: false` sends its reader back to a stdout dump that a
 * twelve-script run has long scrolled past; the campaign's rule is that a check which is not a clean
 * PASS earns a Work Package WITH ITS CAPTURED LOG, and the record is the only thing that survives
 * the session. So the dirt goes in as `dirtOf`, per client, named.
 *
 * @param {string} verdict the assertion outcome, as the check computed it
 * @param {Record<string, object>} reports label -> the `report()` of that client
 * @returns {{verdict: string, detail: object}} the gated verdict, and the per-client dirt to record
 */
export function gate(verdict, reports) {
  const entries = Object.entries(reports).filter(([, r]) => r);
  const dirty = entries.filter(([, r]) => !r.clean);
  const detail = { clean: dirty.length === 0 };
  // `{}` for a clean client, so the record shows WHO was dirty without five empty objects around it.
  for (const [label, r] of dirty) detail[`dirt_${label}`] = dirtOf(r);
  return { verdict: verdict === 'PASS' && dirty.length ? 'PASS-DIRTY' : verdict, detail };
}

/**
 * The same report with a refusal the check DELIBERATELY PROVOKED removed, and `clean` recomputed.
 *
 * THE SIBLING OF {@link ignoringOfflineCut}, and forgiven for the same reason: `report` sees a 403
 * and cannot tell a rule refusing a real reader from an endpoint that is broken, so it must be told.
 * A check that asks "does this refuse me?" MUST make a request that is refused - COMM-3 on a dead
 * invite link, COMM-7 on a salon it may not write to, COMM-8 on a private salon it is not in - and
 * the refusal is the measurement, not noise. Left in, every such check is permanently dirty, and
 * dirt that is always there is dirt nobody reads.
 *
 * NARROW ON PURPOSE: a pair, not a path and not a status. Forgiving the path alone would swallow a
 * 500 from the endpoint under test, and forgiving the status alone would swallow a 403 from anywhere
 * else on the page - both of which are exactly what this check would otherwise be the one to catch.
 *
 * `unexplained`, `severe`, `exceptions` and `notable` are NOT touched. A provoked refusal explains
 * one status on one path and nothing else; a line nobody classified is no more explained beside it.
 *
 * @param rep the `report()` of the client that made the request
 * @param expected `[{ path: RegExp, status: number[] }]` - what this check went and asked for
 */
export function ignoringExpectedRefusal(rep, expected) {
  // Matched against the RENDERED bucket line, which is `METHOD /path -> status`: that is the only
  // form the report keeps, and re-deriving it here would be a second spelling of one format.
  const forgiven = (line) =>
    expected.some(({ path, status }) => {
      const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)$/.exec(line);
      return !!m && path.test(m[2]) && status.includes(Number(m[3]));
    });
  // The console line Chrome writes ALONGSIDE the failed request - "Failed to load resource: the
  // server responded with a status of 403" - carries no url of its own in the text, so it is
  // matched on the status only, and only for statuses this check actually expected. Without it the
  // request is forgiven and its echo is not, which forgives nothing at all.
  const statuses = new Set(expected.flatMap((e) => e.status));
  const echo = (line) =>
    statuses.size > 0 &&
    /Failed to load resource: the server responded with a status of (\d+)/.test(line) &&
    statuses.has(Number(/status of (\d+)/.exec(line)[1]));

  const badHttp = rep.badHttp.filter((l) => !forgiven(l));
  const errors = rep.errors.filter((l) => !echo(l));
  return {
    ...rep,
    badHttp,
    errors,
    clean:
      errors.length === 0 &&
      badHttp.length === 0 &&
      rep.exceptions.length === 0 &&
      rep.severe.length === 0 &&
      rep.unexplained.length === 0,
    ignoredAsExpectedRefusal: {
      badHttp: rep.badHttp.length - badHttp.length,
      errors: rep.errors.length - errors.length,
    },
  };
}

/**
 * The same report with the CUT's own consequences removed, and `clean` recomputed over the rest.
 *
 * ONLY for a client this check deliberately took offline, and only over the window in which it was.
 * MSG-9 and MSG-10 cut a client on purpose; the disconnected fetches, the closed socket and the
 * app's own "server unreachable" line that follow are the cut working, not the app failing. Left in,
 * they made those two checks permanently dirty - and dirt that is always there is dirt nobody reads,
 * which is how the observation half of the campaign's rule stops discriminating.
 *
 * `exceptions` are NOT forgiven: a network cut is a condition the app is required to handle, and an
 * unhandled rejection during one is a real defect. Nor is anything in `notable`.
 *
 * `unexplained` IS narrowed by the cut - and only by it. The lines removed are the ones this check
 * itself caused; whatever remains still breaks `clean`, because a line nobody classified is no more
 * explained during an outage than outside one.
 */
export function ignoringOfflineCut(rep) {
  const expected = (t) => OFFLINE_NOISE.test(t) || CUT_REACTION.test(t);
  const errors = rep.errors.filter((t) => !expected(t));
  const badHttp = rep.badHttp.filter((t) => !expected(t));
  // `warnings` never broke `clean` and still does not; `unexplained` now does, so this filter is the
  // difference between a check that cuts the link on purpose and one that cannot pass at all. A
  // reader is supposed to be able to say what every line is BEFORE seeing it, and thirty lines of
  // "Failed to fetch" from a cut this check performed is the fastest way to make that impossible.
  const warnings = rep.warnings.filter((t) => !expected(t));
  const unexplained = rep.unexplained.filter((t) => !expected(t));
  return {
    ...rep,
    errors,
    badHttp,
    warnings,
    unexplained,
    wsEvents: [],
    // FORGIVEN, NOT DELETED. A cut closes a socket, so `wsEvents` may not break `clean` here - but
    // the close is also the only DATED record of the instant the link actually died, and wiping the
    // bucket is what left WP-RECONNECT-2 unreadable. Kept under its own name, out of the gate.
    wsEventsDuringCut: rep.wsEvents,
    // `severe` is NOT forgiven by a cut either: a lost frame is a lost frame whatever the link did.
    clean:
      errors.length === 0 &&
      badHttp.length === 0 &&
      rep.exceptions.length === 0 &&
      rep.severe.length === 0 &&
      unexplained.length === 0,
    ignoredAsTheCut: {
      errors: rep.errors.length - errors.length,
      badHttp: rep.badHttp.length - badHttp.length,
      warnings: rep.warnings.length - warnings.length,
      unexplained: rep.unexplained.length - unexplained.length,
      wsEvents: rep.wsEvents.length,
    },
  };
}

/**
 * The same report with the NAVIGATION's own socket teardown removed, and `clean` recomputed.
 *
 * A NAVIGATION IS A DISCONNECTION. `Page.navigate` destroys the top-level document, and a socket
 * cannot outlive the document that opened it - so every `goto`, and therefore every `openDM` and
 * `openChannel`, closes the gateway socket and opens a new one. From inside the tab that looks like
 * `[WS] Disconnected. Code: 1006, Reason: no reason`: nobody sent a close frame, because a page
 * being torn down cannot.
 *
 * THIS COST THREE RUNS. READ-1, READ-2 and READ-4 opened their window and then called `openDM` on
 * the observed client, so each collected exactly one `Network.webSocketClosed` and read `PASS-DIRTY`
 * for doing what the check told it to do. The first attempt at a fix - `gotoWatched`, which delayed
 * the window until the new page's handshake - was aimed at the wrong navigation and changed nothing;
 * it is deleted in favour of this, because a window that OPENS LATE is a window that cannot see the
 * boot it skipped.
 *
 * WHY THE COUNT IS A PROOF AND NOT A GUESS. Measured on 2026-08-15 (`navclose.mjs`, W1): three
 * navigations produced three main-frame `Page.frameNavigated`, three `webSocketCreated`, three
 * `webSocketClosed` and three 1006 lines. One document replacement, one close. So closes UP TO
 * `documentsReplaced` are accounted for, and the (N+1)th is not - it is a live socket dying, which
 * is exactly WP-RECONNECT-2's shape and stays dirt. The alternative rule, "forgive a close whose
 * open I never saw", would have silenced that class outright.
 *
 * `webSocketFrameError` is NEVER forgiven: a protocol error on a frame is not a teardown, and a page
 * being replaced does not produce one.
 *
 * Nothing else needs a special case - `[WS] Disconnected` is a warning and a state change (neither
 * breaks `clean`), and the new page's `[TAB] Leadership acquired` / `[WS] Opening connection` are
 * already BENIGN as the boot narrating itself.
 */
export function applyNavigationForgiveness(rep) {
  // ALREADY APPLIED - RETURN IT UNTOUCHED. This is not defensive tidiness, it is the one way this
  // can go wrong: the forgiveness is NOT idempotent. A second pass would see `documentsReplaced`
  // navigations of budget again, against a `wsEvents` the first pass had already stripped, and spend
  // that budget on the closes the first pass deliberately KEPT - the (N+1)th and beyond, which are
  // live sockets dying and the entire signal this bound exists to protect. `report` now applies it
  // once, and the call sites that still ask are answered with what they already have.
  if (rep.wsEventsAtNavigation !== undefined) return rep;

  const budget = rep.documentsReplaced ?? 0;
  const kept = [];
  const forgiven = [];
  for (const e of rep.wsEvents) {
    if (/Network\.webSocketClosed/.test(e) && forgiven.length < budget) forgiven.push(e);
    else kept.push(e);
  }
  return {
    ...rep,
    wsEvents: kept,
    // FORGIVEN, NOT DELETED - for `ignoringOfflineCut`'s reason: the close is the only DATED record
    // of when the link went, and wiping the bucket is what left WP-RECONNECT-2 unreadable.
    wsEventsAtNavigation: forgiven,
    clean:
      rep.errors.length === 0 &&
      rep.badHttp.length === 0 &&
      rep.exceptions.length === 0 &&
      rep.severe.length === 0 &&
      rep.unexplained.length === 0 &&
      kept.length === 0,
  };
}

/**
 * Kept as the name the checks already call, now that `report` applies it for them.
 *
 * It is a no-op on any report `report` produced, and it stays exported rather than being deleted
 * from the six call sites in `read.mjs`: those calls state, at the point of reading, that the check
 * KNOWS it navigates inside its window, and that is worth keeping visible even once the instrument
 * handles it. A future report built by hand still gets the correction.
 */
export function ignoringNavigation(rep) {
  return applyNavigationForgiveness(rep);
}

/** True when the page is in a state where a check's result would be meaningless. */
export async function sanity(cx) {
  return JSON.parse(
    await evaluate(
      cx,
      `JSON.stringify({
        visibility: document.visibilityState,
        online: navigator.onLine,
        locked: document.body.innerText.indexOf('PIN de chiffrement') !== -1,
        offlineBanner: document.body.innerText.indexOf('Hors-ligne') !== -1,
        url: location.pathname
      })`,
    ),
  );
}
