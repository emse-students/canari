# Durable rules - what this codebase has cost to learn

Every line here was written after something broke, and each one names the page that carries the
reasoning. It is an INDEX of hard-won constraints, not a style guide: nothing is here because it
sounded sensible, and nothing should be added without an incident behind it.

**How to use it.** Read the section that matches what you are about to touch, then open the page it
points at before writing anything. The rules are deliberately blunt one-liners - they exist to make
you stop, not to explain. The explanation is always one link away.

**Where this came from.** These rules were extracted verbatim out of `CLAUDE.md` on 2026-08-11,
where they had grown to 560 lines - more than half the file an agent reads at the start of every
session, and most of it irrelevant to any one task. Nothing was reworded in the move; only the link
paths were rewritten to be relative to this directory.

**What still lives in `CLAUDE.md`** is the handful of rules that apply to EVERY task regardless of
area, plus the pointer to this page. If you find yourself adding a rule there, ask first whether it
belongs in one of the sections below.

**How to add one.** One line per rule, naming the page that carries its reasoning. If a rule needs a
paragraph, the paragraph belongs in the topical page the section points at - put it there and leave
the one-liner here.

---

## MLS state and keys -> [mls-protocol](protocols/mls-protocol.md), [auth](frontend/modules/auth.md)

Everything that touches the device key, the PIN, `mls.bin` or an unlock path is on those two pages.
The four traps worth seeing without opening one:

- **NO STATE REPLACEMENT MAY REWIND THIS DEVICE'S OWN SEND RATCHET, AND AN EPOCH CANNOT SEE THAT
  IT DID.** Every seam that swaps the live MLS client (off-thread catch-up, native resume reload)
  needs TWO guards: epoch-monotonic, and not-overtaken-by-a-local-send. A send moves a GENERATION
  INSIDE one epoch, so the epoch guard reports no regression while the ratchet goes back, and the
  next frame re-issues a spent generation the peer refuses as `SecretReuseError`. Web had the second
  guard for a month while the native resume had only the first - and the comment saying "keep the
  two in sync" was itself only about the first. See
  [mls-desync-prevention](protocols/mls-desync-prevention.md).
- **A RULE THAT EACH CALL SITE MUST REMEMBER IS A RULE THE NEXT CALL SITE WILL NOT.** The outbound
  checkpoint lived at 2 of the 18 call sites that reach a send; the other 16 advanced the ratchet and
  persisted nothing. It is now in `BaseMlsService.sendMessage`, which is concrete for exactly this
  reason - a platform supplies only `encryptForSend`, and cannot opt out of the invariants.

- **A CALL SITE THAT HAS TO KNOW WHICH PLATFORM IT IS ON IN ORDER TO PERSIST IS A CALL SITE THAT WILL
  GET IT WRONG.** `saveState` does not mean the same thing on both: on web it returns bytes that
  still have to be stored, on native it has already written `mls.bin` when it answers. The checkpoint
  path did both and so wrote the phone's state file TWICE with the same bytes - 2.0 s of a 3.7 s
  checkpoint, nearly all of it re-marshalling the snapshot through IPC as a `number[]`. The fact was
  already in the codebase on one method; a second call site had its own copy of the answer. One seam
  (`IMlsService.persistCheckpoint`), every checkpoint through it.
- **AN INVARIANT IS NOT ITS FIRST IMPLEMENTATION - RE-READ WHAT IT ACTUALLY DEMANDS BEFORE PAYING FOR
  IT.** *`mls.bin` is never behind a frame that has already left the device* was read as "the send
  must wait for the disk", priced at 1.7 s per message on a phone, and nearly abandoned as
  unaffordable. It never demanded durability AT SEND TIME - only that a state restored behind one be
  recognised and repaired, which is a counter outside the snapshot plus a burn at load, and costs a
  `localStorage` write. The expensive reading survived two design rounds because nobody asked what
  the sentence required as opposed to what the obvious mechanism provided.
- **WHEN A REPAIR CAN ONLY BE WRONG IN ONE DIRECTION, FIND OUT WHICH AND LEAN ON IT.** The burn's
  count is read before a checkpoint and committed after, so a send landing during the write is
  counted twice - deliberately. Over-shooting costs a peer a few unused keys (it ratchets forward and
  keeps what it skips, up to `maximum_forward_distance`); under-shooting re-issues a spent generation
  and the frame is refused. Establishing the asymmetry FIRST, in the dependency's source, is what
  removed the need for any atomicity between the counter and the snapshot - and a test pins it, so
  the day it stops holding, the design's foundation fails out loud instead of silently.
- **PRICE BOTH HALVES BEFORE CHOOSING BETWEEN THEM - AN UNPRINTED METRIC IS A GUESS.** The decision
  "may a send WAIT for durability" turned on the cost of the save alone; the metric existed
  (`recordMlsSaveStateMs`) and had never been logged, so the number was estimated at ~80 ms and was
  really 1.7 s. Splitting the log did not just correct the estimate, it exposed the duplicate write
  above - which no amount of reasoning about the code had found.
- An at-rest envelope change needs a reader for the previous format in the SAME commit - and that
  reader only buys the FORWARD direction. Backwards is a separate promise nobody makes by default:
  once a device has saved in the new format, every build older than that commit is a total loss of
  identity and groups for it. Say so at the commit, or a routine rollback destroys users. **The
  frontend must not be rolled back past `01bc0a13`** (`mls.bin` byte-string encoding, WP-ANR-1).
- **serde HAS NO `Vec<u8>`**: the derived impls take the generic sequence path, so a `Vec<u8>` field
  is written as an array of integers and read back one CBOR header per byte - x45 slower and x2
  larger, measured. `mls-core/src/byte_compat.rs` is the fix; any NEW byte field must use it.
- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout.
- A status code is an ANSWER, a transport failure is not: only a 401/403 may log a user out, and
  `navigator.onLine` alone never proves reachability (a captive portal reports `true`).
- Offline unlock is only ever the paths that ALREADY skip the server check online (biometrics,
  vault); widening it to the PIN is a security change wearing a UX hat.

## Community channels -> [chat](frontend/modules/chat.md), [social-service](services/social-service.md)

Deep links, system events, rosters and the channel/DM asymmetry are all on those two pages. The
four that must be seen without opening one:

- **AN ACTION MAY ONLY MUTATE STATE AT ITS OWN SCOPE.** Membership is stored per COMMUNITY, so a
  public channel - readable by every member - has no row naming anyone, and "leave this public
  channel" is not an operation the model can express. `leaveChannel` deleted the community
  membership row to fake one, which put a user outside a community their client still displayed:
  the sidebar is local until the next refetch, so every workspace-scoped call then answered
  `Not a member of this workspace` - "leave the community" included. **Unmanageable is worse than
  gone**, and the wider rule is the one that made it invisible: an operation that cannot be
  expressed must be REFUSED, never approximated with the neighbouring scope's write. A
  `{ success: true }` that removed nothing is a lie the next refetch exposes.
- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- "A refresh ran" and "the list is current" are two different facts; a loader that conflates them
  empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth.

## MLS membership and routing -> [mls-protocol](protocols/mls-protocol.md), [chat-delivery](services/chat-delivery.md)

- **A permission check that runs where the action is OFFERED is not a check.** `isOwnMessage` hid the
  edit/delete buttons, and both handlers then applied `delete_message` / `edit_message` by message id
  alone - so any member could rewrite any other member's message on every device in the group. Where
  the server cannot read the content it cannot police it either, so the RECEIVER enforces it, against
  the identity MLS authenticated for the frame: a member can lie about the id, never about who it is.
  Consume the event and log the refusal; do not re-queue it.
- **AN ANSWER BROADCAST TO A GROUP IS READ BY EVERY MEMBER, SO IT MUST NAME THE ONE IT ANSWERS.**
  Every leg of the history exchange is a group frame; `history_pull` had carried a `to` from the
  start and `history_bundle` had not, so one repair between two peers discharged the
  awaiting-history marker of every other member - devices that had compared nothing, on evidence
  that was not theirs. Split the two things a broadcast does: DATA is for everyone (the bundle
  dedupes by id, over-delivery costs bandwidth), the ANSWER is for the addressee. The empty frame is
  the dangerous one - it carries no data at all and exists purely to end a wait. Address it at the
  DEVICE (`digestIdentity`), never the user, or a second device of the same person clears on it. A
  legacy frame with no addressee resolves towards the marker STAYING UP: an extra diff is free, a
  marker wrongly cleared is permanent, because the marker is the only thing that makes the device
  ask again.
- **DO NOT NARROW AN MLS APPLICATION MESSAGE WITH `recipients` TO ADDRESS IT.** `sender_ratchet_config()`
  is (2000, 2000): a per-recipient re-encryption burns that budget into a generation gap the other
  members cannot close (`forgetGroup` + re-Welcome). Addressing belongs in the PAYLOAD; it is not a
  secrecy boundary and must never be documented as one.
- **A ROW NOTHING ACKNOWLEDGES IS INVISIBLE FROM BOTH ENDS, SO THE DROP SITE MUST COUNT IT.** Only
  what reaches `enqueueMessage` can ever be ACKed; a row skipped for an empty or undecodable payload,
  and a frame the handler returns `false` for, are re-fetched on every reconnect for the whole
  retention window. The external symptom - a backlog that only grows - is identical for "the pull
  never runs", "the pull runs and everything fails" and "there is nothing to do". Count at the drop,
  name the causes apart, and report ONCE PER DRAIN (per frame is hundreds of lines that still never
  say how many) - and after the queue is idle, since enqueuing is not handling.
- **A TIMER THAT COMPENSATES FOR TWO TRANSPORTS BEING UNORDERED IS A GUESS; MAKE THE FRAME SAY WHICH
  CASE IT IS.** The 3 s `HISTORY_DIGEST_GRACE_MS` could not tell "the digest is a moment behind" from
  "this peer will never send one", so every value was wrong for one of them. One boolean on the
  election frame (`withDigest`) separates them: no promise = answer now, promise = wait for the
  EVENT. What is left is a BOUND, and the test of a legitimate bound is that its being reached is
  not a tuning question - here it means the frame never arrived, and the answer is the same fallback
  as before. Put the discriminator in the payload, never in the transport's addressing, and keep the
  DATA (here, which ids a device retains) out of the server's reach.
- **EVERY COMPATIBILITY SHIM GOES IN [legacy-compatibility](legacy-compatibility.md), WITH THE
  CONDITION THAT RETIRES IT.** A shim is invisible once it works - nothing fails, nothing warns, and
  the retiring condition is never re-checked - so it is written down where somebody will read it,
  with a comment at the site pointing back. The gate is never "the release is out": it is
  `minClientVersion` raised past it, which is what makes "no old client remains" a fact rather than a
  hope.
- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- A join is NOT evidence of a gap: the message store and the seen-frame ledger are keyed by USER, so
  a rotated identity rejoins every group while the browser still holds every message.
- A durable marker must carry the EVIDENCE that justified it, or nothing can ever revisit the
  diagnosis; one written without evidence is legacy - drop it, do not replay it.
- **A MARKER IS DISCHARGED BY ANYTHING THAT FALSIFIES ITS OWN EVIDENCE, NOT ONLY BY THE ANSWER IT
  WAS WAITING FOR** - and because the evidence differs per reason, the discharges do too. Two peers
  both awaiting history were each other's only possible responder, and the guard that (rightly)
  forbids a waiting device from vouching for completeness was implemented as SILENCE, so neither
  could ever clear: a fixed point the convergence argument never covered, because it reasons about
  the DATA and assumes someone is entitled to vouch. An empty symmetric difference falsifies
  `peer-holds-more` outright - the peer demonstrably no longer holds more - so that marker is
  retired by the measurement itself whatever the responder's own state, while `unreadable-frames`
  survives it, a frame neither device holds being still lost and answerable only by a third.
  Verified live on prod 2026-08-11 (WP-HISTBANNER-1). Residual and DELIBERATE: an
  `unreadable-frames` marker never self-clears, so every state edge re-solicits for the life of the
  conversation - bounded, zero-message, and the only alternative is a false completeness claim.
- **A CLAIM THAT A STRING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT
  MECHANISM GONE.** "Nouvelle tentative automatique" was written off as a lie left by the deleted
  retry ladder; the 15-minute `AWAITING_SWEEP_INTERVAL_MS` sweep is a different mechanism and still
  honours it exactly. One grep would have refuted the claim before it was written.
- A LIVENESS clock must be written by the thing whose liveness it measures. `updatedAt` answers "when
  was this row last written" and was asked "when was this device last seen" - so a peer's sync kept
  nine dead devices alive forever (WP-GHOST-1). Same shape as an epoch verdict answering a generation
  question: a column is only evidence for the question it was written to answer.
- **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE - RE-MEASURE
  BEFORE REUSING IT.** WP-GHOST-1's "a device with no key package" was carried forward, in this file,
  as the plan for a 29 499-row prod queue; it matches ZERO of those rows, because all 52 devices with
  a queue hold a valid key package. The two incidents share a symptom (frames going to a device that
  will never read them) and nothing else. A predicate is evidence about the population it was
  measured on; one `GROUP BY` with the predicate as a column refutes or confirms it in seconds.
- **A CORRECT GC WITH NO REPORT IS FOUND BY HAND, A DAY LATE.** Everything about the storm queue was
  working as designed - inside the retention window, valid key package, autovacuum running - so
  nothing complained while one device took 39 MB and thirty times the platform's whole traffic. The
  missing piece was never a rule, it was a LOOK. And the report must carry the evidence that
  separates the causes it cannot itself distinguish (here `KeyPackage.createdAt`: a live device
  falling behind is a client bug, a stale one is debris), or it sends the reader to the wrong fix.
- A device good enough to be MESSAGED must be at least as valid as one good enough to be INVITED. The
  invitation path checks the key package, the fan-out does not - and the gap is where the ghosts live.
- **WHEN A RESOURCE KEEPS REFILLING, DELETING IT IS NOT THE FIX - REVOKE WHATEVER KEEPS NAMING IT AS
  A DESTINATION.** The 2 073-row debris queue was emptied by REVOKING the dead browser generation, not
  by a sweep: a DELETE leaves the six routing memberships standing, so the next message re-queues and
  the count starts over - which the hourly report had already caught happening once. The revoke drops
  the memberships, the key packages and the queue together and records the fact in `revoked_device`.
  The GC predicate this seemed to want would have had to tell "a generation the user replaced" from
  "a device that is merely offline", a judgement the server cannot make and the user already made.
- An error says what it says: "this generation is consumed" is NOT "I already have this message".
  Keep the evidence that distinguishes them (the frame's own bytes) - and never let a native layer
  answer `Ok(None)` where the shared classifier could have decided. **This rule was written here and
  then broken for months by `mls-core` itself** (2026-08-10): a layer that cannot make a distinction
  must not make it, and the guard is `same_epoch_ratchet.rs`, not a comment. A test that asserts the
  swallow will happily protect the bug - this one did.
- **A device that has not noticed its own gap will vouch for its store.** `announceComplete` is the
  only claim that clears a proven marker, and the guard against making it wrongly (`actions.ts:1044`,
  "am I awaiting history myself?") is only as good as the claimant's own detection. A silent failure
  upstream does not merely lose data on that device - it promotes it to a trusted witness for
  everyone else's repair.
- **A responder is elected at RANDOM among all online devices except the requester's own**
  (`messaging.service.ts:1372-1382`), so any check on a repair must record WHICH device answered.
  Two runs of one check can exercise two different code paths on two different machines, and the
  greener verdict is the one that says less.
- EPOCH and GENERATION are different axes, and so are their repairs: a commit replay heals an epoch
  gap and can do nothing for a ratchet one (`TooDistantInTheFuture`), which only a new epoch clears.
  A verdict computed over one axis must never answer a question asked about the other - `epoch >=
  activeEpoch` after applying ZERO commits is "there was nothing to replay", never "it is healed".
- A wrapper string carries BOTH markers (`GAP_QUEUED:<group>:<the real OpenMLS error>`), so the order
  of a substring classifier is a decision, not a formality.
- **A SHIM THAT DOWNGRADES A LOG'S SEVERITY BY RE-READING ITS TEXT IS A MISSING CLASSIFICATION,
  ANNOUNCING ITSELF.** `CannotDecryptOwnMessage` - our own frame, handed back by the replay of our
  own mailbox, refused by RFC 9420 as designed - had no arm in `decrypt_kind`, so it fell through
  `Process error:` to `SenderRatchetGap` and NATIVE QUEUED IT for three retries it could never pass.
  Two web-only shims (`mls-wasm`'s logger, then `mlsWasmLoader`) rewrote its `error!` to `debug` by
  matching the marker in the text, and the harness demoted it a third time - so the platform that
  was actually doing the damage was the one place with no demotion at all. **Where the demotion is,
  the classification is not**: the arm belongs at the throw next to `TooDistantInTheFuture` and
  `past epoch application frame`, before the generic arm, and each shim's list must be re-checked for
  an entry whose emitter no longer exists. Corollary: **severity is the classification's to report,
  not the bare fact that a call returned `Err`** - `recevoir_message_bytes` logged `error!` above its
  whole match, so every benign classified case announced an application error on the phone, where the
  logs are hardest to read. Only what NOTHING has explained keeps `error!`.
- **A COMMENT ASSERTING WHERE A LINE COMES FROM IS A CLAIM, AND IT IS CHEAP TO REFUTE.** The harness
  had `CannotDecryptOwnMessage` written down as logged at DEBUG on every send; both halves were false
  and the defect above lived under them. The refutation was one probe that sent NOTHING: opening the
  DM on two peers produced the line once on each, opening a channel produced none. Same shape as the
  avatar IPv6 diagnosis - **a bad measurement is worse than none, because it gets written down.**

## Outbound delivery -> [chat](frontend/modules/chat.md), [mobile](frontend/mobile.md)

The queue, its barrier, the token rules and the native mirror are on those two pages. The three to
carry in the head:

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- **AN OPERATION ON A QUEUED OBJECT MUST CONSULT THE QUEUE, NEVER QUEUE A SECOND OPERATION BESIDE
  IT.** Two entries side by side encode an assumption - that the outcome the user asked for is
  reachable by ORDERING - and for a withdrawal it never is: deleting a message composed offline sent
  it and then took it back, because the text was still in front of the tombstone whatever order they
  went in. Ask the queue instead; it is the only thing that knows whether the frame is still here,
  and it answers before either path is taken rather than letting the caller learn it by watching a
  send happen. And the answer must be honest about the entry INSIDE its send: claiming a
  cancellation there loses the delete outright, where admitting it costs one event nobody minds
  (MUT-19).
- **A BRANCH THE CALLEE TOOK IS A FACT THE CALLER NEEDS - RETURN IT, OR IT WRITES THE SAME THING
  BOTH TIMES.** `deleteMessage` asked the queue, learnt whether the frame had left, and returned
  `void`; the caller therefore tombstoned in both cases, so a WITHDRAWN message left a durable
  "deleted" row on the sender for something no peer had ever received and nothing could ever
  reconcile. The consulting is only half the fix - a discriminator that stops one frame above the
  decision it exists for has been thrown away, not carried. Make it a TYPE (`DeleteOutcome`), not a
  boolean the next reader has to re-interpret. Found as four phantom losses by `recon.mjs`, and
  ATTRIBUTED by a causal test - one run of the check, one new row - never by argument from the dates.
- **A CANCELLATION IS ONLY AS DETERMINISTIC AS THE NARROWEST WINDOW IT CLOSES.** Deleting the
  durable row stops every FUTURE flush and nothing else - the flush already running walks a snapshot
  read before the user acted, and another tab walks its own. Three facts, one per window, or the fix
  works on a quiet client and not on a busy one. The native mirror is a fourth copy of that queue:
  leave a withdrawn entry in it and Android delivers from the background what was cancelled here.
- **A PAGE IS A UNIT OF TRANSFER, SO BOUND IT IN THE UNIT THAT DECIDES HOW LONG THE TRANSFER TAKES.**
  Rows do not: 500 frames carrying media was 12 MB, the client aborted on its own deadline having
  received nothing, ACKed nothing, and met the same 12 MB every time - a closed loop no retry
  escapes. Bounding the DEADLINE per page and leaving the page unbounded only moves it. A page
  always carries at least one row, whatever its size, or one oversized frame blocks its queue for
  ever.
- **TERMINATE A PAGED PULL ON AN EMPTY PAGE, NEVER ON A SHORT ONE.** "Fewer rows than I asked for"
  is an INFERENCE from the row limit being the only bound, and it silently stopped being true the
  day the server capped a page in bytes: 53 rows for a 500-row ask read as "queue empty" with 870
  frames still waiting. Only an empty answer is a proof, and it costs one request.
- **A PAGINATION CURSOR MUST BE A TOTAL ORDER, OR A PAGE BOUNDARY DELETES A ROW.** Resuming at
  `createdAt > last` is strict, `@CreateDateColumn` writes milliseconds from the application, and
  rows sharing an instant exist (one pair in the live queue the day this was found). Split such a
  group and its tail is skipped by every later page - queued for ever, delivered never. Either make
  the cursor total, or never end a page inside a group sharing the cursor's value; the second is what
  ships, because it also fixes clients too old to send anything else.
- **"ONE SMALL FRAME" BOUNDS THE BYTES AND SAYS NOTHING ABOUT THE LATENCY OF ASKING PERMISSION TO
  SEND IT.** A per-item loop is serialised for a reason; check that the reason still covers what the
  loop actually spends its time on. The reconciliation pass awaited each group in turn, justified by
  the MLS encryption mutex - true of the sends, false of the HTTP election in front of each one,
  which takes no lock at all. Nine groups, ~480 ms each, 4.35 s per reconnect, and the inbound drain
  that overlapped it inherited the whole duration and looked like the culprit. Concurrency here needs
  a BOUND, never a bare `Promise.all`: the item count is the user's conversation count, and fifty
  simultaneous requests on a phone radio at reconnect is a herd you inflicted on yourself.
  See [history-reconciliation](protocols/history-reconciliation.md).
- **A COUNT TAKEN BEFORE DECRYPTION CANNOT CLASSIFY WHAT IT COUNTS.** The sync banner was raised from
  `pendingCount`, a number of ciphertexts, and `MlsQueuedMessage` carries no delivery class while the
  server's envelope carries neither `silent` nor `durable` - so it announced nine history probes as a
  synchronisation of messages. Announce from the DECRYPTED buffer, which knows what it holds. And the
  same flag must not carry both "a drain is running" (what the concurrency guards need) and "there is
  something to tell the user": two questions, two flags.
- **A PAGE READ IS EVIDENCE ABOUT A WINDOW OF THE PAST, NEVER A STATEMENT THAT NOTHING ELSE EXISTS -
  so it is MERGED into what is on screen, never ASSIGNED over it.** Every history load has the shape
  fetch -> decrypt -> persist -> re-read a page to render, and the read is issued seconds after the
  load began: anything delivered meanwhile is on screen and is wiped by the assignment. Four sites
  had it, and it is invisible in a test because a test never delivers mid-load - it took a
  continuous sample of the receiver (`trace-arrival.mjs`) to see the row appear at +0.5 s and go at
  +3.4 s. The merge rule needs no timer and holds at any conversation size: the page decides only
  BETWEEN its oldest and newest row, memory keeps everything outside that window, and an unsent
  message is kept wherever it sits because no page can ever carry it. Any COUNT derived from the
  page has the same fault and must be computed over the merged list.
- A tab is "read-only" only where something CHECKS: leadership gated the socket, not the queue, so
  the follower encrypted anyway. And gating a writer freezes its state - whoever inherits the role
  must reload it, or it resumes exactly as far behind as the tab it replaced had moved on.
- The inbound drain lowers `isDraining` only when the message callback RETURNS, so every await inside
  it is a potential freeze of all inbound traffic - and the recovery seams re-acquire the MLS mutex
  the drain already holds, so awaiting one there is a DEADLOCK, not a slow path. A repair whose
  result nobody reads (a re-add, a Welcome, an external join) must be STARTED, never awaited - and it
  must log how it settles. `DeferredRecovery` on the Welcome path is the same lesson, learnt earlier.
- **A MUTUAL-EXCLUSION WINDOW NEEDS ONE ENTRY POINT FOR AWAITING, OR ITS FREEZES ARE INVISIBLE
  ONE AT A TIME.** Two awaits inside the drain had already frozen all inbound traffic and each was
  fixed where it stood, so the third was free to do it again - nothing typed "this await is inside
  the exclusion". `drain()` now has exactly one way to await (`guarded`), which names the phase, the
  group and the message, and keeps reporting because the ELAPSED time is the diagnosis. It
  deliberately does NOT cancel: the freeze loses nothing durable, whereas the alternative the WP
  proposed - moving the flush behind `isDraining = false` - lets a second drain call
  `beginBulkIngest` across a live `endBulkIngest`, and `bulkIngestPhases` being a STACK that would
  clear the UI buffer without flushing, i.e. WP-ECHO-1 by construction. Report the freeze, do not
  trade it for a loss.
- **A TERMINATION PROOF COVERS THE STRUCTURE IT IS WRITTEN OVER, AND WORK PARKED OUTSIDE THAT
  STRUCTURE IS INVISIBLE TO IT AND TO THE WATCHDOG BOTH** - nothing is awaiting, so there is nothing
  to time. The drain's proof is over its buckets; `pendingWelcomeGroups` parks frames beside them
  while a Welcome is in flight, and THREE paths closed that window by discharging it wrongly - a
  second Welcome (a re-add: ordinary) replacing the array, a failed Welcome deleting it "because the
  server will re-deliver" (true only of a frame carrying a `queuedMessageId`), and a throwing
  non-Welcome releasing a window its Welcome had not opened. **A WINDOW MUST BE CLOSED BY WHAT OPENED
  IT, THROUGH ONE EXIT WITH ONE BEHAVIOUR** (`releaseWelcomeBuffer`, which always re-queues and always
  names its reason); delete the paths that close one they did not open, and the leftover case becomes
  an INVARIANT you can assert - "the buckets are empty and a window survives" is impossible at any
  speed, so it is an error, not a deadline. Then, and only then, may the parked work count towards
  `isIdle`: what the barrier claims is "nothing left to apply", and a claim kept true by DROPPING
  what it counts is not the claim. [chat](frontend/modules/chat.md).
- `requestAnimationFrame` NEVER fires in a hidden document, so it can never be the only resolver of
  anything a background path awaits - and a "yield" that can hang is a deadlock, not a delay. Race it
  with a `MessageChannel` message; a timer fallback is clamped to ~1 Hz in the background.
- A deadline's SCOPE is part of its meaning: one budget over a paginated catch-up is a budget the
  devices that most need it can never meet, and an all-or-nothing pull makes each failure bigger than
  the last. Per page, ingested and ACKed as it lands - partial progress must be kept. Verified on
  hardware 2026-08-11 (WP-PENDING-1): 1 100 sends into a parked phone, two pages, a `Drain start`
  between them and two ACK steps server-side. **A verification of a STRUCTURAL fix must not claim
  the ORIGINAL failure**: the run's backlog was well inside the old 10 s budget, so it establishes
  partial progress and nothing about the timeout - say which, or the next reader believes more than
  was measured. [chat-delivery](services/chat-delivery.md).
- **A DEADLINE OVER A TRANSFER MUST MEASURE SILENCE, NOT ELAPSED TIME.** A total deadline answers
  "did this take too long", which is a fact about nothing: a big answer on a slow link and a dead
  connection score identically, so the constant has to cover the largest plausible answer times the
  slowest plausible link - a product nobody can bound, which is why no such number was ever
  justifiable. Ask instead whether anything is still coming: arm the timer before the request and
  RE-ARM it on the response head and on every body chunk (`fetchJsonUnderProgressDeadline`, over
  `res.body.getReader()`). The number then bounds only the longest quiet stretch the design permits,
  and stops being a tuning knob. Two things this owes: **race the reader against the abort rather
  than trusting the stream to honour the signal** - aborting stops the REQUEST, not a `read()`
  already awaiting a chunk, and a hang-guard that can itself hang is not one; and **carry whether
  the response head had arrived out with the error as a TYPE** (`StalledRequestError`), because a
  server that never started answering and a transfer that started and stopped are the two causes a
  retry policy above treats alike. A detector and a response are not two answers to one question:
  the deadline decides when to stop waiting, the halving ladder decides what to ask next, and
  neither can do the other's job. [chat-delivery](services/chat-delivery.md).
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- A UI buffer placed IN FRONT of a persistence call is a persistence bug, not a rendering choice:
  it returns early, so the write never runs, and a buffer that can be cleared without flushing loses
  it for good. `addMessageToChat`'s bulk-ingest return did exactly this to the sender's own message
  (WP-ECHO-1). Buffer AFTER the durable write, and make every discard log what it dropped.
- The mirror is READ as well as written: a file one side rewrites wholesale silently deletes
  whatever the other side appended, so every such pair needs an adoption pass, not just a drain.
- **A PER-ITEM API MAKES THE PER-ITEM COST INVISIBLE, AND THE LOOP IS WRITTEN WHERE NOBODY CAN SEE
  IT.** The background drain called a single-message entry point once per queued message, and each
  call re-read and re-wrote the WHOLE 2.7 MB MLS keystore - `O(N x |file|)` inside a 60 s OS
  deadline (WP-ANR-1). Nothing in either signature said "this is expensive to call twice". When a
  loop crosses an FFI/JNI boundary, the batch belongs on the SHARED side of it: one load, one save,
  per-entry results - which also puts the logic somewhere a host `cargo test` can reach.
- **BOUND THE WORK THAT CONSUMES AN IRREVERSIBLE RESOURCE, NOT THE WORK THAT COSTS TIME.** Capping a
  drain by how many messages it POSTs is the wrong axis: encrypting consumes a ratchet generation
  whether the frame is ever sent or not, so a cap on the POSTs still runs the sender past the peer
  and ends in `TooDistantInTheFuture`, which no retry repairs. The cap goes on the ENCRYPT; the
  surplus is not touched at all. A wall-clock budget is then only the safety net, never the plan.
- **THE RECORD OF WHAT IS STILL OWED IS ONLY AS DURABLE AS ITS LAST WRITE.** The outbox mirror was
  rewritten once, at the end of the drain, so a kill in the middle re-sent everything already
  delivered. Ask of any "remove it when done" bookkeeping what a kill between two writes costs, and
  make that a bounded number rather than the whole backlog.
- **A REPAIR THAT RECORDS ITS OWN OUTPUT AS NEW INPUT HAS NO FIXED POINT.** A replay is not a send:
  re-noting one into `recentSends` under a fresh id and a fresh timestamp defeated the expiry AND
  the dedup at once, so a five-minute decaying buffer became a permanent playlist and a bounded
  repair became a standing broadcast (WP-RETRANSMIT-1, ~430 frames/min for 13 min on prod). Ask of
  every self-healing loop what makes it STOP, and make that the thing a test pins.
- **A REPAIR LADDER MUST BE ORDERED BY WHAT EACH RUNG CAN FIX, NEVER BY WHAT EACH COSTS - and a rung
  that can fix NOTHING is deleted, not demoted.** Cheap-first is only sound when the cheap rung has a
  real chance, and the way to check is to read its TRIGGER: `signalDecryptFailure` had one call site,
  the rewound-sender branch, so the peer it asked was by construction the peer that could not answer
  - it re-encrypts at the same rewound ratchet. Measured twice on prod: 1, then 5, 15 and 25 payloads,
  none delivered. Its only success mode was the sender burning past our high-water mark on its own,
  i.e. recovery by exhaustion. **So the whole ladder is gone (2026-08-10)**: `decrypt_failed`,
  `retransmitRecentSends`, `recentSends` and the `isRetransmission` flag are deleted, and the
  history diff - which reads the peer's DURABLE store and names messages by id - is the ONE repair.
  A repair addressed by TIME is a broadcast, because a window cannot name its target, and it can only
  be as durable as what it reads.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** One
  question ("what am I missing, and who has it") was answered by NINE independent durations across
  three files, two of them retry ladders driving the same request, so the traffic was their product.
  The rule that replaced them: one request per STATE EDGE, and each diff exchange strictly reduces
  the symmetric difference, so termination is reached by construction rather than by budget. **The
  durable marker that first carried the idempotence is itself gone (2026-08-12)** - see the entry
  below on lifetime, and [history-reconciliation](protocols/history-reconciliation.md). What
  replaced it is cheaper than the state it was protecting: a state key costs one small frame, so a
  device may simply ASK on every connection and believe the answer, and the only note kept is an
  in-memory one collapsing a burst of identical triggers. Two clocks went with it - the 500 ms sleep
  before comparing became `waitForMessageQueueIdle()`, a real completion signal, and the 15 s retry
  of an unacknowledged frame became the EVENT that discharges it (the Welcome, or the store restore
  finishing). Ask of every timer what it would mean if it were wrong; if the answer is "more
  traffic", it is load-bearing and it should not be.
- **BUT THE DURABLE STATE IS IDEMPOTENCE ONLY FOR THE QUESTION IT WAS WRITTEN TO ANSWER, AND THE TWO
  QUESTIONS CAN DIFFER ONLY IN LIFETIME.** The rule above was applied one line too far: the guard
  became `if (isAwaitingHistory(...)) return` in front of the loss trigger. The marker answers "is
  this group short of history" (durable, cleared only by an empty diff); it was asked "have I already
  asked" (30 s). So on any group that had EVER been broken the marker was already standing when the
  next frame was lost, and the one trigger that fires on the loss itself never fired again - twelve
  `LOST frame` lines and ZERO solicitations on prod, the 15-minute sweep left pretending to be the
  mechanism. "Is an attempt outstanding" has exactly one witness, `isSolicitInFlight` (scheduled, or
  inside the response window). Same family as `updatedAt` and the epoch-verdict rule, with the twist
  that both answers were TRUE - only the questions differed. `setupMessageHandler.lostFrame.test.ts`.
  **The whole gate was deleted on 2026-08-12**, and the reason generalises: the marker existed
  because ASKING was expensive (the answer was a full store dump), so it had to be justified by
  stored evidence. Make the ask cheap - a 64-bit state key, one frame, silence when it matches - and
  the evidence, its ranks, its vouching and its give-up horizon all become unnecessary at once.
  **When durable state is hard to discharge, check whether the thing it is rationing still needs
  rationing.**
- **A TRIGGER THAT ARRIVES BEFORE ITS MECHANISM MUST BE HELD, NOT LOGGED AND DROPPED - especially
  when raising it CONSUMES the evidence.** `reconcileGroup` found no probe sender installed (the
  session installs it after inbound frames start draining), said so, and returned. The caller was
  `handleUnreadableFrame`, which ACKs the frame in the same breath - correctly, since no redelivery
  makes a consumed generation decrypt - so the request and the only thing that could ever raise it
  again were destroyed together, and a production DM stayed permanently short of its lost messages.
  **Ask of every "cannot do this right now" branch what will raise it a second time; if the answer is
  nothing, the branch is a silent data loss.** The fix is a deferral keyed by BLOCKER, discharged by
  the edge that lifts it (a peer returning, a sender being installed) - never by a clock, and never
  routed per reason: a group deferred under one blocker and discharged only by another's edge is
  exactly how the gap stayed open. Two corollaries paid for in the same incident. **An accidental
  repair hides the fault that needs it**: an unconditional sweep re-asked on the next connection, so
  making the sweep conditional is what turned this from hidden to permanent - expect a class of
  latent faults to surface whenever redundant work is removed, and go looking rather than waiting.
  And **discharge a deferral only on the act itself, never on a step that precedes it** - it used to
  clear on the election, an HTTP round trip that asks nobody anything, so a group whose probe then
  failed to encrypt was recorded as attended to.
  [history-reconciliation](protocols/history-reconciliation.md#a-group-that-could-not-heal).
- **A FIX THAT HOLDS A RAISED TRIGGER DOES NOT REACH BACKWARDS: STATE DAMAGED BEFORE IT SHIPPED HAS
  NO WITNESS LEFT, AND NEEDS A REASON TO COMPARE - NOT A CLEANUP.** Measured the moment the rule
  above shipped: the damaged group still did not heal, because every trigger needs a live witness and
  this one's had been consumed. **Before designing any destructive repair, trace what is actually
  PERSISTED by the failure** - here the footprint was zero (no tombstone, no placeholder, no field
  able to hold a gap, nothing rendered), so a cleanup would have had nothing to target and
  delete-and-recreate was strictly worse than comparing: it destroys what is still held and ends
  where the comparison ends anyway. **What remains after a silent loss is an ABSENCE, and an absence
  is undetectable from one side** - only a peer comparison finds it. The instrument for that already
  existed; what was missing was a reason to run it. So the shape of the fix is a ONE-SHOT audit
  gated on a durable generation, discharged **per item and only for items the act really happened
  for** (recording the pass's INPUT rather than its OUTPUT discharges what was merely deferred - the
  same failure again), with a constant bump as the only way to re-run it.
  [history-reconciliation](protocols/history-reconciliation.md#and-the-fix-does-not-reach-backwards---hence-the-audit).
- **A RETRY MUST TERMINATE ON THE EVENT THAT CHANGES THE ANSWER, NOT ON A CLOCK - AND THE EVENT IS
  USUALLY ALREADY NAMED SOMEWHERE.** An unacknowledged inbound frame was re-fetched every 15 s. The
  handler leaves one behind for exactly two reasons and both were already enumerated as a TYPE
  (`UnackedReason`): an unknown group needs its Welcome, an absent conversation needs the store
  restore. Neither is discharged by waiting, so every cycle re-fetched the same rows, failed them
  identically, and re-raised the catch-up overlay - for the whole session, on a device whose group
  never came back. `refetchFramesLeftBehind` is now fired where each event actually happens. No
  event, no ask, and no cycle to bound. The type that classified the failure was also the work list;
  a reason enumerated for a LOG is usually enough to drive the fix.
- **A LOOKUP INSIDE A PER-ITEM LOOP IS A COST THAT GROWS WITH THE WRONG THING.** `batchAddMessages`
  asked `convo.messages.find(...)` twice per incoming message, so a catch-up of `m` into a
  conversation of `n` cost `2·n·m` main-thread comparisons - about sixteen million for a large
  bundle, measured at ten minutes of frozen list with nothing lost. Fixed by one index built once
  per batch, and by making `resolveMessageTimestamp` take a LOOKUP rather than the array, so the
  cost is visible at each call site and no future one can reintroduce the scan silently. An index
  replacing a `find` must keep FIRST-wins, or making a path faster changes what it renders.
- A cause is not a label: `pending-offline` meant both "the request never left" and "it left and
  nobody answered", and the string named the first, so a silent peer was reported as an empty room.
  Two causes under one label is a WRONG answer, not a vague one - it points the user at the wrong fix.
- **READ YOUR OWN MAIL BEFORE ASKING ANYONE FOR NEWS - AND BEFORE ANSWERING ANYBODY.** A device may
  neither ASK for history nor ANSWER a request for it while its own inbound queue is still draining.
  Asking early compares against a store it is in the middle of completing, so it repairs a
  difference it was about to close by itself; answering early makes it an unreliable source - it can
  claim agreement it does not have yet, or send a bundle short of the frames it is about to apply,
  and either ends the exchange with the two devices still apart and the asker's coalescing window
  spent. **The barrier belongs at the ONE door every trigger comes through** (`reconcileGroup`), not
  at the call sites: it sat at the connection edge alone and covered one of four triggers, while the
  three reactive ones - an unreadable frame, a peer returning, a replay that gave up - fired from
  inside the very drain they should have waited for (measured on prod 2026-08-13: `asked` logged
  between a `Drain start` and its `Drain complete`, on a browser and on the phone). Two shapes it
  must keep: **reserve the coalescing window BEFORE the barrier**, or a burst of forty edges parks
  forty waiters and asks forty times when the queue empties; and **defer, never await, on the
  answering side**, because every responder leg runs inside the pipeline and awaiting the queue from
  there is the drain waiting on itself. It is a BARRIER (`waitUntilIdle` resolves on the drain loop
  ending) and never a delay.
  [history-reconciliation](protocols/history-reconciliation.md).
- **AN ANSWER MUST STATE THE RANGE IT VOUCHES FOR, OR A DEVICE THAT SIMPLY KEEPS LESS IS
  INDISTINGUISHABLE FROM A CONVERSATION WITH NO PAST.** A browser keeps 90 days and a phone 5 years
  BY DESIGN, so a clipped answer is the normal case, not a fault - and the asker sees only an
  absence, which is evidence of nothing. Believing it means losing years silently; re-asking on it
  never terminates, because the same peer is elected and only a counter or a clock could stop it.
  The answerer already knows where its own memory begins (`history_coverage.coveredFrom`), so it
  says so - and only when that is ABOVE the `since` it was asked for, or silence stops meaning "I
  cover you" and the fast path costs two frames instead of one. **It is sent even when the two state
  keys MATCH: agreement is not completeness**, two devices can hold the same set over the compared
  window and both be missing everything below it. **The walk that follows terminates on a delivered
  fact, never on a count**: each election EXCLUDES the members already heard from, so one member
  leaves the reachable set per step, and the server answers `no_peer_online` with a positive
  `excludedOnline` when there is nobody left - the proof. Three things keep it sound: a stated
  coverage is a FACT for the session (a retention window only slides forward), so no chase lifecycle
  is needed; an ORDINARY reconciliation must never carry an exclusion, because it is about CONTENT
  and a short-memoried peer still holds every new message; and a server that re-elects an excluded
  member must stop the walk LOUDLY, since a step that adds nobody is the one shape that would not
  terminate.
  [history-reconciliation](protocols/history-reconciliation.md#the-fourth-trigger-an-answer-that-does-not-reach-far-enough-back).
- **A FRAME READ BY ONE PATH MUST BE MARKED READ FOR EVERY OTHER PATH, OR EACH DEVICE REPORTS ITS OWN
  TRAFFIC AS LOSS.** Live delivery and the queue drain decrypt frames the shared archive also holds,
  and neither moved this device's position in that archive. The replay then walked the same row,
  found the generation already spent, and hit the branch asserting *"anything arriving HERE is a
  frame this device has never read - that is real loss"*. The assertion was false: `seenCipherHashes`
  was written by the replay alone. Every online device therefore reconciled on its ordinary traffic,
  which is a false alarm on the ONE signal that must never cry wolf - a real loss became
  indistinguishable from noise. Three shapes the repair must keep. **The key must be the CIPHERTEXT,
  not an id**: an archive row is addressed by a Redis stream id and a live envelope by a
  `queued_message` uuid, the two namespaces never intersect, and the server discards the stream id at
  write time - the bytes are the only thing both paths hold. **The set must be ONE OBJECT, not a
  re-read**: the replay hydrates it at its start and writes it back at its end, so a mark persisted
  independently mid-walk is erased by that final write, made from a copy predating it. **The cursor
  advances by WALKING, never by jumping**: marking a frame lets the replay skip it and move past it
  in stream order, whereas writing the live frame's position straight into the cursor would carry it
  over an earlier frame the server queue had already expired - turning a repairable gap into a
  permanent one. And do NOT mark from the Android background decrypt: it loads a throwaway state and
  never writes `mls.bin` back, so the foreground really does read that frame again.
  [history-reconciliation](protocols/history-reconciliation.md).
- **STATE THAT OUTLIVES THE EVENT THAT CREATED IT MUST TRAVEL AS STATE, NOT ONLY AS THAT EVENT.** A
  `pin` frame ages out of the server's retention window; the pin does not. So a device replaying
  every frame it is ENTITLED to could still never learn that a message is pinned, and a DM pin did
  not survive a fresh device while a channel pin did - because the server re-serves the channel one
  (MUT-15). The same shape as `editedAt`, which had to be carried beside `isEdited` for exactly this
  reason. Carry both halves: the events converge a device that is following along, the register
  covers what predates its window - and neither is redundant.
  [history-reconciliation](protocols/history-reconciliation.md).
- **A MUTATION THAT CARRIES NO CLOCK CANNOT BE MERGED, AND EVERY WORKAROUND FOR THAT IS A
  WORKAROUND.** `pin`/`unpin` carried a message id and nothing else, alone among the mutations here -
  a reaction dates each `(user, emoji)` pair, an edit dates itself, a deletion is absorbing. The
  first fix was "adopt a peer's set only into an EMPTY one", which is sound and is still a patch: it
  buys convergence for a fresh device by refusing it to every other one. **Date the frame instead**,
  on BOTH legs, and the special case disappears - larger `at` wins, an `unpin` becomes a dated
  tombstone rather than a removal, and any two devices can merge. Two corollaries that are easy to
  miss: **a tie needs a rule** (equal `at` resolves to unpinned, because "keep what I had" depends
  on arrival order and is therefore not a rule), and **the tombstones must TRAVEL** - a snapshot of
  what is merely pinned omits the answerer's `unpin`, which is exactly the entry a stale peer needs
  in order to lose. Undated frames from older clients are read at `at: 0` on replay and at receipt
  time when live; both are in [legacy-compatibility](legacy-compatibility.md).
- **AN EVENT FALLING THROUGH A HANDLER CHAIN UNHANDLED IS AN ACCIDENT UNTIL IT IS NAMED.** `pin` and
  `unpin` reached `applyReplaySystemEvent` and matched no branch, silently, for as long as the
  replay path has existed - beside a `REPLAY_IGNORED_EVENTS` set that exists precisely so that
  ignoring an event has to be a DECISION. A chain whose last arm is an implicit no-op cannot tell
  "we thought about this" from "nobody did". List what is deliberately dropped; then a gap is a
  missing name rather than a missing line.
- **"EVERY OTHER PATH" MEANS BOTH DIRECTIONS - ENUMERATE THE CONSUMERS, THEN CHECK EACH PAIR.** The
  rule above was implemented one way round and read as done: live delivery told the replay, the
  replay told nobody. It recorded its position as a STREAM ID, which is precisely the identifier the
  other path cannot look itself up by - the same disjoint-namespace fact the rule opens with, missed
  in the second direction because only the first was ever written down. So a frame the replay had
  just decrypted arrived live onto a spent generation and was filed as a LOST frame while the message
  was on screen (WP-FALSELOSS-2, 2026-08-13). **The tell that it was false was in the check's own
  record**: the row carrying the loss also carried `copiesOnReceiver: 1`. A shared ledger is a
  RELATION over the paths that write it, not a feature one path has - and a per-session structure
  cannot answer a durable question, so "which ledger" is settled by the QUESTION'S LIFETIME, never by
  which one the hot path already had at hand. Corollary paid for in the same incident: **mark on the
  SUCCESS path only.** A frame that failed to decrypt consumed nothing, and marking it would claim
  "already read" about a frame nobody has read - which mutes the one alarm that raises a repair. Mark
  the ROW on a give-up so the walk terminates; never the bytes.
  [history-reconciliation](protocols/history-reconciliation.md#the-ledger-was-one-way-and-the-false-loss-moved-to-the-head-of-the-stream).
- **A LEDGER MUST BE WRITTEN WHERE THE THING IT RECORDS ACTUALLY HAPPENS, NOT WHERE IT IS CONVENIENT
  TO ITERATE.** The rule above was then implemented in the right direction and STILL left the defect,
  because a batch spends in one place and reports in another: `decryptPage` consumes the ratchet for
  a whole page in a single call, while the marks were written by the loop that afterwards decodes each
  frame and awaits. Between the two there was a window in which the generation was gone and the ledger
  did not say so, and a frame arriving live inside it was filed as LOST. **A window is not a rare
  race - it is a reproducible one**: `msg1 --cold` then `msg1b` produced it every single time, and the
  proof was a PAIR from the same page, generation 520 called a loss and generation 521 recognised as a
  duplicate three seconds later, once the loop had reached it. When an operation is batched, ask where
  its EFFECT lands, not where its results are read: the record belongs next to the effect.
- **AND IT MUST BE READ WHERE THE VERDICT IS FORMED, NOT WHERE THE WORK WAS QUEUED.** The same rule
  has two directions and fixing the write exposed the read. The replay checked each row against the
  seen set while ASSEMBLING a page, then handed the page to `decryptPage`; live delivery can read one
  of those frames in between, so a frame that failed the batch may well have been read by the time
  that failure is judged. The comment on the failure branch even stated the assumption out loud - *"a
  frame already read is skipped before ever reaching the decrypt, so anything arriving HERE is a frame
  this device has never read"* - which is only true if the two moments are one. **An answer obtained
  before an await is about a world that has moved**; re-ask on the failure path, where it costs
  nothing because that path is already the exceptional one.
- **A LEDGER THAT RECONCILES AN OVERLAP IS NOT AN ORDER, AND MUST NOT CARRY THE ORDINARY CASE.** The
  two rules above make the shared ledger correct; they do not make the overlap rare. A barrier before
  a walk orders the two paths at its START and says nothing about its middle, and the archive holds
  every frame *including the queued ones* - so an unbounded walk reads exactly the rows live delivery
  is about to hand over, for as long as the walk lasts. **Bound the walk at the boundary it observed
  when it started**, and the two sets are disjoint by construction rather than deduplicated
  afterwards: the rows above the bound are never fetched, so they cost no bytes, no decrypt and no
  ledger entry. Stopping early is always safe for a cursor that advances by WALKING - it simply
  resumes there. Two questions separate this from a patch: *what is the bound a fact about* (the
  server's stream head, read once, not the client's clock), and *what width of seam is left* (here,
  one round trip instead of one walk - the queue and the stream are written at different moments, so
  no client-side ordering makes it zero, and the ledger keeps covering that remainder).
- **A BARRIER MAY NOT BE AWAITED FROM INSIDE THE THING THAT HOLDS WHAT IT WAITS FOR - AND WHERE IT
  MAY BE TAKEN IS PART OF THE ORDER IT ENFORCES.** The rule above orders the archive walk against the
  delivery queue as *pin the head, empty the mailbox, then read*; the correction to it moved the
  barrier one await LATER, past `createDecryptSession`. That opens a catch-up, which holds the global
  MLS mutex **for its whole life**, while the drain needs the same non-reentrant mutex for every
  message - so the walk waited for a drain that could not start. Both stopped for good: measured
  2026-08-15, bulk ingest opened at 14:58:44.612, the frame landed at 14:58:45.001, its drain nested
  to depth 2, and neither `Drain complete` nor `Bulk ingest done` ever came. The client stayed wedged
  until reload, and the server saw the same event from the far side - two frames unACKed, then
  `PUSH_DEFERRED -> FCM fallback` on a browser that has no push token. **The order was right and the
  placement was wrong**, and both facts can be had with the mutex free: pinning the head is one HTTP
  read that touches no MLS state, and emptying the mailbox IS letting the drain have the mutex. Three
  things this must keep. **The codebase already knew the class** - `answerAfterMailboxDrained` names
  it exactly, for the responder legs, and solves it the other way, by DEFERRING past the drain
  instead of awaiting it; a hazard already named in one place is the first thing to check when
  touching another. **The barrier now refuses rather than hangs**: it is the only place that can see
  `catchUpDepth > 0` at the moment of the call, so it logs an error naming the call site's mistake
  and returns, converting an unrecoverable hang into a defect report. And **a unit test that stubs
  the lock cannot see this** - the two tests covering that ordering both passed throughout, because a
  stub has no mutex; what a stub can still pin is the ORDER, so assert that the session is not open
  while the barrier is pending.
- **A BARRIER THAT ALSO ACTS MUST NOT BE REACHABLE BEFORE THE THING THAT ANSWERS FOR ITS ACTION -
  AND AT BOOT, "BEFORE" IS DECIDED BY A LINE NUMBER.** `waitForMessageQueueIdle` does not only wait,
  it PULLS when nothing else has (that half is what closed WP-DUPDELIVERY-1). `processQueue` returns
  immediately while `messageCallback` is unset, so a barrier taken before `setupMessageHandler`
  fetches frames into a queue with no consumer and then waits on the queue it has just filled -
  `waitUntilIdle` has nothing that can ever fire it. **Measured on prod 2026-08-15**: the startup
  archive replay sat above the handler registration in `sessionAuth`, and W2 - holding 2 frames
  queued since that morning's deadlock - stopped at 1 s on EVERY reload, before
  `[TAB] Leadership acquired`, so no socket was ever opened; the only trace was one
  `console.warn` about a callback. **W1 was the control: identical bundle, identical code, empty
  server-side mailbox, normal boot.** The trigger is therefore the ordinary state of anyone who has
  been away, and it does not heal - each restart re-runs it. Three things this must keep. **The fix
  is the ORDER, not the guard**: the consumer is registered before anything can pull, which keeps
  the pull (and so WP-DUPDELIVERY-1) intact - refusing to pull instead would trade a hang for a
  duplicate. **The guard is still owed**, because it is the only place that can see the fact at the
  moment of the call, and skipping beats hanging: a duplicate is caught by the fingerprint ledger, a
  client that never connects again is caught by nobody. And **`console.warn` was the whole report** -
  a swallowed branch that ends a device's session for good is an ERROR, and it must name the
  consequence (`n queued message(s) ... every mailbox barrier now open will never resolve`), not the
  condition.
- **`void` IS NOT DEFERRAL - A TRIGGER RAISED FROM INSIDE A REGION RUNS INSIDE IT.** Fire-and-forget
  hands the call to the microtask queue, which is emptied long before the enclosing `finally`; the
  region is still open when the callee's first `await` lands. `replayConversationHistory` raised
  `void reconcileGroup(...)` from inside its walk, under a comment claiming "the store is settled by
  now" - but `session.finish()` runs in the `finally`, so the catch-up still held the global MLS
  mutex, and `reconcileGroup` opens on the mailbox barrier, which needs that mutex for the drain. The
  barrier refused it and the ask went out **against a mailbox that was never emptied** - the one
  ordering guarantee that barrier exists to carry, and the reason it lives in `reconcileGroup` rather
  than at the connection edge. Raise the trigger after the region closes; asserting it "was called"
  passes either way, so **the test has to be an ORDERING against a gated close** (proven: it fails
  against the old placement, `Number of calls: 1`). Found by one dirty line on prod, W1, MSG pass 1
  of 5 - the only pass that followed a boot.
- **A GLOBAL DEPTH CANNOT NAME AN OWNER, SO THE REPORT MUST NAME THE CALLER.** `catchUpDepth > 0`
  answers "is a session open", never "is it MINE" - async JS has no current-holder notion, which is
  exactly why the MLS mutex is non-reentrant. A caller nested inside the session deadlocks; a caller
  merely running beside one would only wait, and is refused all the same. The two are fixed in
  different places, so `waitForMessageQueueIdle(caller)` takes the label at all seven call sites and
  both refusals quote it: without it, one `SKIPPED` line cost a read of every call site to attribute.
- **A RESPONSE HEADER IS INVISIBLE CROSS-ORIGIN UNLESS IT IS EXPOSED.** Carrying new metadata in a
  header keeps an array-shaped body compatible with every deployed client - the right trade - but the
  app runs cross-origin under Tauri (`http://tauri.localhost`), so without
  `Access-Control-Expose-Headers` the header reaches the browser and is hidden from the code. That
  fails on MOBILE ONLY, compiles, and deploys green: the exact shape of a fault no gate catches.
- **A NAME THAT LIES MAKES TWO KEY SPACES READ AS ONE.** `cipherFingerprint` held `msg.id`, a Redis
  stream id - not a fingerprint of anything. Every reader of that function, and the log line it fed,
  silently treated a row identifier and a ciphertext hash as the same currency, which is precisely the
  confusion the shared-key design existed to prevent. It surfaced only when both were printed side by
  side and one of them was obviously the wrong shape. Rename on sight: a variable whose name asserts a
  type it does not hold is a defect that has not been triggered yet.
- **A PROSPECTIVE FIX CANNOT BE VERIFIED BY THE FIRST MEASUREMENT AFTER ITS DEPLOY.** A fix that
  records something as it happens says nothing about what happened before it shipped, so the first
  run still shows the old damage - and that number fits "it works" and "it does nothing" equally
  well. Reading it either way is the mistake: a measurement whose outcome is the same under both
  hypotheses is not a measurement. Build the run that discriminates instead - here, traffic
  generated AFTER the new build is confirmed running, which the old code could not have marked -
  and take a control with no traffic at all, so the difference is attributable. Corollary: assert
  the build id, never the deploy. A green CD proves containers started; a client left open across
  a deploy keeps running the old bundle and reads exactly like one that was reloaded.
- **FOUR INVARIANTS OF THE HISTORY EXCHANGE THAT LOOK LIKE COMPLICATIONS AND ARE NOT.** Each one was
  paid for; the recurring temptation is to "simplify" them back.
  [history-reconciliation](protocols/history-reconciliation.md) carries the reasoning.
  - **`historyWindow.ts` is the only place either boundary is decided.** The floor is SHARED,
    monotone, merged as `max`, and **ships worth zero on purpose**. The window is LOCAL and fixed by
    platform (`isTauriRuntime()` alone: web 90 d, mobile and desktop 5 y), and `deviceWindowStart`
    rounds DOWN to the day - unrounded, two devices a second apart compare different ranges and the
    fast path can never fire.
  - **`since` is STATED by the asker and never recomputed by the answerer; the digest is NOT clipped;
    the clip is on the ANSWER, never the COMPARISON; each leg states its OWN window.** All four, or a
    boundary message goes permanently missing on one side, or every device is capped at the shortest
    window in the conversation.
  - **`toConversationMeta` and the in-memory seed in `loadExistingConversations` are MIRRORS and must
    be edited together.** A fix was silently defeated by exactly this: `readWatermarks` was written
    and never read back, so read state was correct until the first restart. **A field persisted but
    never read back is worse than one never stored** - the write succeeds and nothing reports it.
  - **`DELIVERY` in `frameDelivery.ts` is the ONLY classification** (`visible` / `mutation` /
    `transport`) and every send site names one; the server gate reads `body.durable`, not `!silent`.
    Each stream entry records its own `silent`, and `redeliverMissedDuringActivationWindow` filters
    on it or it rings the user for every reaction.

## UI and i18n -> [frontend/architecture](frontend/architecture.md), [auth](frontend/modules/auth.md) (native prompts)

Tokens, the one-way-colour sweep, the portalled dropdown, Svelte's whitespace trim and the native
prompt fields are all on those pages. What must not be forgotten between them:

- **A CLEANUP THAT RELEASES SOMETHING ACQUIRED ASYNCHRONOUSLY MUST WAIT FOR THE ACQUISITION.** An
  effect that unmounts before its `await` returns runs a release against a reference count that has
  not been incremented yet: it decrements nothing, the retain lands a moment later, and the resource
  is then held by NOBODY - never freed, and in the avatar case still served to every later mount of
  the same face. The `cancelled` flag guards the state assignment, not the resource; release inside
  the pending promise's `finally`, not beside it.
- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens - and the 31 the
  sweep left are DELIBERATE (switch thumbs, colour-picker handles, always-dark call/lightbox chrome,
  the white plate behind a QR). Do not "fix" them.
- Nothing types a string as user-visible, so no compiler enforces Paraglide - and no user-facing
  string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time). Default
  to Paraglide for ANY new user-visible string without being asked, on the first draft, not as a
  follow-up fix - a `showConfirm(...)` message and its custom button label were shipped as raw
  French literals (WP-SAFELINK-1), copying the shape of that store's own ~21 other call sites,
  none of which are Paraglide either; that existing pattern is not a precedent to extend.
- **A LANGUAGE SETTING BELONGS TO THE APP, NOT TO THE PHONE - AND THE RECEIVER IS WHAT PICKS IT.**
  Paraglide covers the bundle and nothing else, so each native surface needs its own table AND its
  own resolver: `appLocaleContext(context)` on Android, `CanariLocalized` / `localized` on iOS, all
  three reading `locale` from `push_context.json`. A bare `context.getString(...)` compiles, runs,
  and answers the OS language - wrong only for the users whose two settings disagree, and invisible
  to everyone testing on a French phone. Once a table exists, the failure moves: a key added to
  `values/` and forgotten in `values-en/` falls back SILENTLY to French with a green build, and on
  iOS the same omission ships the KEY ITSELF as the body. Neither is visible to a compiler, so both
  are pinned by `nativeStrings.test.ts`. See [mobile](frontend/mobile.md#the-language-a-notification-speaks).
- **A RULE THAT SAYS "REMEMBER TO RUN X FIRST" IS A MISSING DEPENDENCY, NOT A RULE.** This entry
  used to say: re-run `bun run paraglide:compile` before `bun run test` after any build - **an
  Android or iOS build counts**, because `beforeBuildCommand` is `bun run build`, and it leaves
  Paraglide output resolving to English. It fails as a handful of tests asserting French text and
  receiving the English message, which reads like an i18n regression in code nobody touched: 7
  failures across 4 files right after an APK build, 1481/1481 after one recompile with no source
  change between the two runs. **It cost the same 20 minutes a second time on 2026-08-15**, in a
  session that had already read this page - which is what a rule relying on memory is worth.
  `check` had always compiled first and `test` had not, so the fix was one word of
  `package.json`: `"test": "npm run paraglide:compile && vitest run"`. The symmetry is the point -
  when two scripts need the same precondition and only one declares it, the other does not have a
  rule, it has a bug.
- **AN INDEX INTO AN ARRAY YOU DO NOT OWN IS STATE THAT GOES STALE, AND `slice` PAST THE END IS
  SILENT.** `ChatArea` renders `messageGroups.slice(windowStart, …)` and recomputed `windowStart`
  only when the conversation KEY changed - while `loadHistoryForConversation` REPLACES
  `conversation.messages` with a 60-message page on every click and every reconnect. A long list
  shrinking under a window computed against it left the start past the end, and `slice` answered
  `[]`: header, avatar and composer with a void under them, no error, no skeleton, no empty state
  (WP-EMPTYVIEW-1, seen on prod with 598 messages stored and zero rendered). Same family as the
  feed-retry defect - a remount "fixed" it, so it read as data loss and was not. The fix is never to
  make the stored index correct; it is for the READ side to clamp against the current length
  (`utils/chat/renderWindow.ts`), so the invariant "a non-empty list yields a non-empty window"
  holds by construction rather than by whoever remembers to recompute. Ask of any cached index what
  invalidates it, and prefer a derived clamp over a recompute you have to remember.
- **A promise that has REJECTED stays rejected, so an `{#await}` over one sits in `{:catch}` for the
  life of the component** - nothing re-enters `{:then}` but a new promise, i.e. a remount. State a
  RETRY writes must therefore be read from OUTSIDE the thing that failed: the feed read
  `postsOverride` only inside `{:then}`, so "Reessayer" fetched the posts (200 in 326 ms, measured)
  and had nowhere to render them, while leaving the page and coming back worked - which reads as a
  network fault and is not one. A retry whose result is only consulted on the success path of the
  failed attempt cannot work by construction. Not unit-testable here (the defect is purely WHERE the
  template reads its state, and there is no component-rendering setup) - `check-feed-retry.mjs`.
- A synchronous "unknown" PLACEHOLDER is indistinguishable from an answer once it is stored, so
  anything that later resolves the real value loses to it - and a module-level cache re-renders
  nothing when it warms, so whether a user ever sees the truth depends on cache timing. Return the
  absence (`peekUserDisplayName` -> `null`, or an explicit `*Resolved` flag), never the label.
- **PORTALLING A DROPDOWN BREAKS ITS ACCESSIBLE RELATIONSHIP AS WELL AS ITS POSITIONING, AND
  NOTHING WARNS.** `aria-expanded` on a trigger whose panel is no longer its descendant announces
  "expanded" and names nothing - it needs an `id` + `aria-controls`. And the right role is a
  DISCLOSURE, never `role="menu"`: the menu role promises arrow keys, Home/End and typeahead, so
  claiming it for a set of navigation links describes an interaction the component does not honour.
  What a disclosure does owe is Escape, closing AND returning focus to the trigger - the outside
  click backdrop only serves a pointer. [architecture](frontend/architecture.md).
- **TWO COPIES OF A DIALOG DO NOT STAY IDENTICAL, THEY STAY PLAUSIBLE.** The lightbox and the PDF
  reader each looked right alone and disagreed on what no single-file review can see: a raw
  `aria-label="Fermer"` beside `m.common_close_label()`, plus `"Suivant"` and `"Image {n}"`, and a
  `z-[300]` beside a `z-300`. `shared/FullScreenViewer.svelte` now owns the portal, backdrop, card,
  header, close, safe areas, focus trap and Escape (WP-VIEWER-1). It deliberately does NOT own the
  content area: `lockTouch` (`touch-action: none`) is right for one bitmap and would kill the
  one-finger scroll a PDF is READ with, and a prop choosing between the two layouts would put the
  knowledge of both viewers into the component meant to know neither.
  [posts](frontend/modules/posts.md).
- A shared GESTURE is shared as arithmetic, not as a component: `pinchZoom.ts` carries both models -
  the global translate for one bitmap, the anchor for a paged column - and they are NOT
  interchangeable. `zoomAboutPivot` RESETS rather than clamps at the minimum scale, because a clamp
  leaves a photo wherever the gesture ended whenever the maths lands inside the bounds, and "unzoom
  puts it back" is the one thing a user may assume.
- French inclusive writing and elided forms defeat a TLD-shape heuristic for "this looks like a
  domain" (`.es`/`.it`/`.re`/`.ne` collide with "auteur.rice"/"cher.e.s"-style endings) - an exact
  WHITELIST of real hosts sidesteps the ambiguity entirely instead of trying to out-narrow it
  (WP-LINK-1).

## The public head, and the two adapters -> [frontend/seo](frontend/seo.md), [nginx](infrastructure/nginx.md)

The whole model - the injected head, the two escapers, the sitemap, the adapter split and the
fallback shell - is on those two pages, plus `BUILD_WEB` in
[frontend/architecture](frontend/architecture.md). The four that cost a live outage:

- A crawler on this site sees NO content: Googlebot renders, but as an anonymous visitor, so what
  it renders is the login screen. The injected `<head>` is the whole indexable surface, and the
  SITEMAP is the entire link graph.
- CLOUDFLARE REPLACES the body of an origin 5xx with its own 16-byte page, so an `error_page`
  without `=` reaches nobody behind the tunnel. Measured 2026-08-05; hence `=200`.
- nginx does not TRUNCATE an oversized upstream header, it 502s - SvelteKit's
  `Link: rel=modulepreload` is ~7.5 KB against a 4 KB default `proxy_buffer_size`.
- A deploy being green proves the containers started, never that the site answers: probe the public
  URL for each SHAPE of path (root, an app route, a prerendered file, a dynamic endpoint).

## The edge -> [cloudflare-edge](infrastructure/cloudflare-edge.md), [nginx](infrastructure/nginx.md)

The tunnel topology, the settings that are deliberate and the incident behind all of this are on that
page. The six that generalise:

- **NGINX OWNS EVERY RESPONSE HEADER; THE EDGE ADDS NONE.** The edge is production infrastructure
  with no representation in git, so no review, test or deploy can see it change - a hand-made rule
  there outranks the whole repository and nothing in CI will ever say so.
- **A SECOND CSP HEADER CAN ONLY REMOVE PERMISSIONS, NEVER GRANT ONE** - a browser enforces each
  policy independently and the effect is their INTERSECTION. A rule added to "loosen" a policy is
  structurally incapable of doing that, so its NAME will assert the opposite of its only possible
  effect. Corollary: deleting such a rule is provably safe, since the result is a superset.
- **`*` MATCHES NETWORK SCHEMES ONLY** - never `blob:`, `data:` or `filesystem:`. `connect-src *` is
  therefore STRICTER than `connect-src 'self' blob:` for the case that matters, and a directive
  spelt out in full next to it (`img-src * data: blob:`) keeps working, which makes the failure look
  arbitrary instead of systematic.
- **A PERMISSION TO DISPLAY IS NOT A PERMISSION TO READ.** `img-src` and `connect-src` govern two
  different things, and a feature that shows a remote image and then wants its BYTES needs both. The
  half that is allowed is the visible half, so the feature looks alive and does nothing - which is
  why the report says "the button is broken" and not "the policy is short a host".
- **A POLICY THAT MUST BE RESTATED PER BLOCK IS DECLARED ONCE AND INCLUDED** - nginx's `add_header`
  REPLACES the inherited set, so every block setting a header of its own drops the policy unless it
  carries it. Verbatim copies do not stay equal: one gets the new host and the others go on refusing
  it. And an allowlist is a DESCRIPTION OF THE CODE, so it has a test that fails when the code calls
  a host it does not name - no compiler, linter or deploy can see that gap, only a real browser on
  the real origin.
- **THE ACCOUNT IS THE UNIT OF AUDIT, NOT THE ZONE - AND A SECOND HOSTNAME CAN NAME THE SAME
  DESTINATION.** Two names on two different zones pointed at one origin, so gating one gated
  nothing; the TUNNEL INGRESS table maps hostname to service and is the only listing that shows it,
  where a DNS listing shows names alone. Before gating anything, check what already calls it by that
  PUBLIC name - a consumer using the private address is unaffected, one using the hostname breaks.
- **A CSP REFUSAL IS INDISTINGUISHABLE FROM AN ORDINARY FAILURE, BY DESIGN**: a blocked `fetch` and
  a dead network both throw `TypeError: Failed to fetch`, and a refused `<video>` reports the same
  `MEDIA_ERR_SRC_NOT_SUPPORTED` an unplayable codec does. Only `securitypolicyviolation` names the
  directive - build the probe on that event, or the probe reports the theory it was written with.
- **THE SINGLE PUBLIC ENTRY POINT IS ALSO A SINGLE POINT OF DISCONNECTION: A FRONTEND REDEPLOY CUTS
  EVERY PROXIED WEBSOCKET ON THE PLATFORM AT ONCE.** Measured 2026-08-14 - recreating the `frontend`
  and `frontend-ssr` containers at 12:45:20.5 produced five `Connection reset without closing
  handshake` at the gateway within three milliseconds, across four unrelated users. Two things
  follow. **The reconnect ladder is exercised on the whole fleet by every deploy**, so a defect in it
  is not an edge case - it is a fleet-wide outage on the next release ([WP-RECONNECT-1](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)).
  And **any measurement window that straddles a deploy explains its own fallout**, so a run that does
  not know it was rebuilt under itself will attribute the disconnections to whatever it was testing.

## Server-side fetches -> [chat-delivery](services/chat-delivery.md), [nginx](infrastructure/nginx.md)

The link-preview pipeline, the SSRF guard, the favicon cascade and the undici seam are on that page.
The three that generalise beyond it:

- **A STATED BUDGET THAT IS NOT THE ONE THAT FIRES IS A COMMENT, NOT A RULE.** The link preview armed
  an `AbortController` at 4 s while its undici dispatcher kept the library's own 10 s defaults, and
  the error recorded on prod was undici's - so nobody could say which deadline the system actually
  had. Set every mechanism that can enforce it from ONE constant, and check the layer underneath has
  no default of its own. The same read found an outbound call carrying no deadline at all, because
  the signal was simply never passed to it.
- An `<img src>` at a third party inside an E2E conversation tells that host who read and when.
  Proxying it is not a nicety - and the proxy is also the only thing checking the bytes are an image.
- `new URL(href, base)` RESOLVES hostile input rather than throwing - `javascript:` and `data:`
  survive as absolute URLs - so a try/catch around the parse guards nothing. Check the SCHEME.
- Serving a file is not serving it correctly: check the header, not the status code (nginx
  `mime.types` has no `.mjs`, so every ES-module asset went out as octet-stream).
- A safety check with an unrelated failure mode from the fetch it would ride along with needs its
  OWN endpoint, not a field bolted onto the existing response: `getLinkSafety` is decoupled from
  `getLinkPreview` precisely so a page with a broken `<title>` (which makes the preview throw)
  cannot take the Safe Browsing verdict down with it (WP-SAFELINK-1). And a check with no cache
  guidance from the upstream API for the COMMON case (Google gives a `cacheDuration` only for a
  flagged match, never for "clean") still needs an explicit, own TTL - inventing a number rather
  than caching it forever or not at all.

- **ONLY AN ANSWER MAY BE CACHED.** "The upstream says there is none" and "I could not reach the
  upstream" reach the same screen and must never reach the same cache: the second is not a fact about
  the subject, so storing it makes a passing outage stick for a whole TTL, and dressing it as the
  first (a 404 for a timeout) makes it a lie that outlives the incident. Canari's avatar proxy and
  the link-preview endpoint are the same defect twice, in opposite directions - one cached a refusal
  it invented, the other cached nothing at all
  ([core-service](services/core-service.md#the-avatar-proxy)).
- **A KEY NAMING A CONTENT MAY BE CACHED FOR EVER; A KEY NAMING AN IDENTITY MAY NOT** - and the
  store has to be able to express the difference. **Cache Storage ignores `Cache-Control`
  entirely**: `cache.match()` is a key lookup with no freshness check of any kind, so entries keyed
  by `/api/users/<id>/avatar` outlived every `max-age` the server sent and froze the first photo
  each device ever drew - one person, one face per device, for ever, and invisible to anyone who
  had only drawn them once. **A SECOND STORE OVER THE SAME BYTES NEEDS A SECOND LIFETIME, AND THE
  ONE NOBODY WROTE IS INFINITY**: the HTTP cache already honours what the server states, so a layer
  that cannot read it is not a cache but a freeze. The same test acquits the buckets beside it - an
  encrypted media id and `/api/media/public/<mediaId>?v=<updatedAt>` name CONTENTS, and a new upload
  is a new key ([core-service](services/core-service.md#the-avatar-proxy)).
- **AN OPTIONAL DECORATION THAT CANNOT BE FETCHED DEGRADES, IT DOES NOT ERROR** - and the LOG is
  where the causes are told apart, never the status code. A blip is a `warn`; a credential of ours
  being refused is an `error`, because only one of them needs a human.
- **A CACHE THAT ONLY REMEMBERS SUCCESSES AMPLIFIES EVERY FAILURE.** The absent case is usually the
  common one (40/40 accounts here have no photo), so a miss that is not remembered is a request
  repeated for ever, per render, per viewer - which is what turns ONE transient network fault into a
  burst of failures rather than a line. Measured twice: 479 recorded 502s from one outbound failure
  on the portal, and two requests per faceless avatar per mount on the web client.
- **OUR CREDENTIALS ARE NOT THE USER'S, SO OUR UPSTREAM'S 401 MUST NOT BECOME THEIRS.** A proxy that
  forwards an upstream 401 hands the browser the one status the standing rule lets log a user out.
- **A LOOKUP THAT FAILED RETURNS "I DO NOT KNOW", NEVER THE TEXT IT WOULD HAVE DISPLAYED.** The
  moment a failure answers with a renderable value, it is TRUTHY, and every caller written as
  `if (resolved) use it` overwrites what it already had - a name, a fallback, a cached row - with a
  placeholder. `resolveUserDisplayName` did exactly that to twenty-six call sites, and only on the
  FIRST failure, the suppression window answering `null` afterwards: one event, two renderings,
  chosen by how recently it had happened. **Rendering a placeholder is the caller's decision**; the
  resolver's job ends at the fact.
- **A CALL WITH NO DEADLINE CANNOT FAIL, WHICH IS WORSE THAN FAILING.** `fetch` has no default
  timeout anywhere; an upstream that accepts the connection and then says nothing holds it, and the
  work behind it, for as long as it likes. There is no error to catch and no fallback to reach, so
  every degradation written for that call - all of which trigger on a THROW - is dead code, and the
  page simply never finishes. It is the opposite failure from the one that gets measured (an
  unreachable host fails fast and gets amplified), and the two live on the same call site. **The
  budget belongs to the repository, not to the call**: one constant, every outbound path, or the
  next call written is the one that has none. Sky and Portail-etu each had four such calls
  (2026-08-16).

## Service-to-service calls -> [api-surface](protocols/api-surface.md#internal-cross-service-calls)

- **An internal call carries the callee's global prefix, or it is a 404 nobody reads.** Every Nest
  service here mounts `setGlobalPrefix('api')` while the internal base URLs are configured without
  it, and six of seven callers omitted it - channel push never delivered, an MLS-device guard reduced
  to a constant `true`, account deletion never purging chat or social data. **Fix it at the seam:** a
  `internal/service-urls.ts` per service that inserts the prefix exactly once, so it is not the
  caller's to write. Putting `/api` in the compose file fixes the deployment and leaves the code's
  defaults wrong.
- **A best-effort `.catch(warn)` is designed for a TRANSIENT fault and will hide a PERMANENT one for
  ever.** A route that has never once worked is indistinguishable, from the caller's side, from a
  service that is briefly down. If a call is allowed to fail silently, nothing about its own logs
  will ever tell you it is not merely unlucky - the only instrument that finds this class is the
  CALLEE's log read over a window in which the path is known to have run.
- **A SECOND COPY OF A SEND IS A SECOND CONTRACT, AND ONLY ONE OF THEM WILL BE MAINTAINED.**
  `POST /internal/push/notify` carried its own `getMessaging().send()` loop - the same one as
  `MessagingService.sendPushToUser` minus the `apns` block - so every push it carried (every salon
  message, post, form reminder and cross-device read frame) was a data-only FCM message: never
  surfaced by iOS, never handed to the NSE, dropped by every iPhone while the endpoint answered
  `sent`. The correct block existed, was documented, and was unit-tested field by field; **none of
  that reached the caller that did not call it.** A shared payload builder is not a shared path -
  test the message that actually leaves the process, through the real caller.
- **A convention applied in two places out of three is the worst state a convention can be in**, and
  the two correct ones are what make the third invisible: `payment/social-internal-client.ts` and the
  media call both spelt the prefix, so every reading of "how do we call another service here"
  returned a correct example.

## Contracts the compiler does not check -> [development](development.md)

Every unchecked seam - Tauri command names, plugin ACLs, `push_context.json`, `mlsWorkerProtocol.ts`,
`LoginErrorCode` - is enumerated there. Two to keep in the head:

- A cross-process contract is only as good as its test: pin the PATHS as well as the field names,
  or a writer on one OS fills a directory nothing ever reads.
- **A PAYLOAD FIELD WITH NO READER-SIDE CHECK DRIFTS IN BOTH DIRECTIONS, SILENTLY.** The channel push
  sent `workspaceId`, `messageId` and `createdAt` to every device for the whole life of the feature
  and no client read one of them, while `mentioned` - computed per recipient, and the only field that
  costs a user something - was read by none either, so an `@` in a salon was indistinguishable from
  any other message. Nothing could have caught it: the native halves are verified by COMPILING, which
  says nothing about which keys they read, and the payload never passes through TypeScript. Pin such
  a seam with a source-reading test in BOTH directions - every key sent is read, every key read is
  still sent (`channelPushFields.test.ts`, twin of `fcmCacheFields.test.ts`).
- Never let a capability probe swallow its own failure, and never branch on an error MESSAGE.
- **MAKING A DEAD CODE PATH REACHABLE RE-OPENS EVERY CHECK THAT PATH NEVER HAD.** The replay handlers
  for `delete_message` / `edit_message` applied a mutation by id with NO author check, which had
  cost nothing while no mutation ever entered the shared log; putting them there made the handlers
  the path every mutation takes, and re-opened one layer down a hole the live path had closed six
  months earlier (`f0dc3296`, `f924932b`). Before enabling dead code, audit it as NEW code - it has
  never been subject to any review the reachable paths went through.
- **CARRY THE EVIDENCE THAT THE WINDOW OPENED, OR A GREEN RESULT CANNOT BE TOLD FROM AN UNEXERCISED
  ONE.** Re-running MSG-1 after its fix PASSED - vacuously: the store was warm, the probe found
  nothing, the replay never ran, so the race window the bug lives in never opened. Any check whose
  bug needs a window must assert the window opened (`msg1b.mjs` refuses to report PASS unless the
  message pane actually grew), and the same rule is why a source-reading guard needs a vacuity
  assertion (`historyStateKeyInvalidation.test.ts` fails if it finds fewer write sites than exist).
- **A DISTRIBUTION IS NOT A DIAGNOSIS: BEFORE BLAMING A CAUSE, CHECK WHETHER THE MECHANISM THAT
  WOULD HAVE PREVENTED IT IS ALREADY RUNNING.** "p90 4.25 MB, i.e. unmodified phone photos" named a
  cause from a shape and planned an x5-10 lever on it; `compressImage` was already on every upload
  path and a 9 MP photo costs 245 KB through it, so the lever was worth nothing and the real bytes
  (video, and HEIC through `img.onerror`) were never looked for. The measurement that settles it is
  cheap - run the app's OWN transform over a representative input and compare to what is on disk.
- **A DISTINCTION CARRIED IN PROSE IS A DISTINCTION EXACTLY ONE CALL SITE WILL MAKE.** `410 Gone`
  became `new Error('MEDIA_PURGED_BY_RETENTION')`, so telling "expired for ever" from "the download
  failed" meant `String.includes` at each consumer - and of four media surfaces exactly one did it:
  one rendered the raw token to the user in red, one drew a generic broken image, one spun for ever.
  The classification belongs at the THROW, as a type (`MediaPurgedError` + one `isMediaPurgedError`).
- **WHEN THE THROW IS ON THE OTHER SIDE OF HTTP, THE TYPE IS A `code` IN THE BODY** - the same
  discipline, one layer out. `shouldRefreshChannelKey` matched five substrings to decide whether to
  refresh a channel key, two of them thrown locally and three sent by the social-service; the fix
  types the local pair (`ChannelKeyUnavailableError`) and names the remote pair
  (`STALE_CHANNEL_KEY_VERSION`, `CHANNEL_KEY_VERSION_REQUIRED`), read through a `ChannelApiError`
  that carries status and code while leaving `message` untouched. Two things the sweep showed:
  a list of substrings hides its own duplicates (`'Sync required'` was only the tail of
  `'Missing key for epoch N. Sync required.'`, so five sentences were four throws), and it hides
  which of them the client can even produce - `CHANNEL_KEY_VERSION_REQUIRED` was being retried
  although this client cannot emit it.
- **A `catch` THAT HAS TO RECOGNISE ITS OWN THROW IS TOO WIDE.** `importBackup` threw the v1 refusal
  from inside its own `try` and then did `e.message.startsWith('Les sauvegardes v1')` to let it back
  out. The branch was not a classification problem but a scope one: the version check belongs ABOVE
  the `try`, where nothing can catch it, and the branch disappears rather than being typed. Look for
  this shape wherever a `catch` converts everything to one verdict - the exception it makes for
  itself is the tell.
- **A STATUS PARSED BACK OUT OF A SENTENCE IS A STATUS THAT WAS DISCARDED.** `+layout.ts` logged a
  user out on `String(error).includes('(404)')`, matching a number `fetchUserProfile` had formatted
  into its own message a moment earlier. The status is the answer; carry it as a field
  (`UserProfileFetchError.status`) rather than printing it and reading it back.
  Corollary for any audit: **one surface handling a case is not "the case is handled"** - enumerate
  the consumers of the seam, never just the ones that mention it.
- **ENUMERATE THE WRITERS OF THE STATE, NOT THE CALLERS OF THE HELPER - AND THEN MAKE THE HELPER THE
  ONLY WRITER.** WP-HISTGHOST-1 was fixed by wiring the awaiting-history cleanup into
  `markConversationDeletedRemotely`, whose five call sites were all checked. It shipped and FAILED
  in production, because `lifecycle: 'removed'` was written INLINE in five OTHER places - a
  `groupDeleted` system message, being excluded from the group, discovery, a re-add finding the
  group tombstoned - and a sixth path purged the row outright, orphaning the marker with no row
  left to reach it. `grep` for the STATE, not for the function; then collapse every writer into one
  (`retireConversation`) and lock it with a test that greps the source, because no unit test can
  observe a seventh path that does not exist yet. [chat](frontend/modules/chat.md).
- **A PASSING CHECK THAT NEVER ARMED ITS PRECONDITION IS A CHECK THAT MEASURES NOTHING.** The first
  end-to-end run of DEL-1 was green: it created a group, invited the peer, sent messages, deleted
  it, and found no marker and no banner. There had never been a marker - the messages were sent
  AFTER the join, so the peer was missing nothing. The assertions would have held with the fix
  reverted. Every check that clears a state must first PROVE the state was set, and report
  `VACUOUS` rather than `PASS` when it was not.
- **A CONNECTION POOL MAKES `BEGIN` AND `COMMIT` TWO DIFFERENT CONVERSATIONS.** `tauri-plugin-sql`
  opens SQLite through sqlx's `Pool::connect` (default `max_connections = 10`), so each `execute` is
  its own acquisition and a three-call `BEGIN`/INSERT/`COMMIT` can touch three connections - leaving
  a transaction open on one of them for good, which then fails every later writer with `database is
  locked`. Proven on device by issuing two concurrent `BEGIN`s and having both succeed. Serialising
  in JS orders the sections but cannot bind them to a connection, which is why `runExclusive` looked
  right and was not. **A statement is the largest unit of atomicity available**: one multi-row
  `INSERT` (`db/sqliteBatch.ts`), never a loop inside a transaction - and a chunked batch is only
  safe because the rows are `INSERT OR REPLACE` under a caller-held key, so a re-run converges.
  [mobile > there is NO multi-statement transaction here](frontend/mobile.md).
- A plugin in `Cargo.toml` is not a plugin the app may CALL: Tauri v2 gates every plugin COMMAND
  behind `capabilities/`, and an ungranted one builds, ships and installs, then rejects on a real
  device. EVENTS are not gated - which is how `deep-link` worked warm and was dead cold for as long
  as the grant was missing. `tauriCapabilities.test.ts` is the guard.
- **A mocked repository never parses SQL**, so a query builder's output is unverified until a real
  Postgres sees it - and TypeORM does NOT preserve the order selects were declared in, so `DISTINCT`
  written into a `.select()` string lands mid-list once an `.addSelect()` follows (`.distinct(true)`
  is the only safe spelling). Where a test cannot reach, the DEPLOY LOG is the test.
- **Two frontend builds writing `build/` at once ship an app that cannot boot, and every gate is
  green.** SvelteKit's per-build `__sveltekit_<id>` names a global the HTML writes and the chunks
  read; mixed, `kit.start()` throws `Cannot read properties of undefined (reading 'data')` and a
  phone sits on the splash forever. `bun run build` now ends with
  `scripts/check-bundle-consistency.mjs`. Never run an Android/iOS build next to anything else that
  builds the frontend - `beforeBuildCommand` IS `bun run build`.
- A batch of maintenance jobs must catch and log PER JOB. Sharing one try/catch means the first
  failure hides every job after it, and a GC that silently does nothing is indistinguishable from a
  GC with nothing to do. **The same holds for any observer list, and a COMMENT claiming the
  subscribers are independent is not independence** - `endBulkIngest` awaited them in one bare loop,
  so a failing checkpoint would have taken the UI's render buffer down with it (WP-RETRANSMIT-1).
  Isolation is a `try` per subscriber, or it does not exist.

## Mobile and native -> [frontend/mobile](frontend/mobile.md)

Push transports, the App Group, the NSE, the decrypt ladder and the update target are all on that
page. The five to carry, plus one status line:

- **A GATE INSIDE A COMPONENT'S OWN `onclick` IS DEAD CODE WHEREVER SOMETHING ELSE ALREADY OWNS THE
  EVENT.** `AppLink`/`LinkPreviewCard` each gated their external link with a Safe Browsing check
  inside their bubble-phase `onclick` (WP-SAFELINK-1) - correct on the web, and silently bypassed on
  every Tauri build (Android, iOS, desktop), because `hooks.client.ts` had already installed a
  document-level CAPTURE-phase listener for exactly this class of link, months earlier, that calls
  `event.stopPropagation()` and opens the URL itself before the anchor's own handler ever runs. The
  fix is not "also gate the interceptor" - it is to gate the ONE function both paths actually call to
  open the URL (`openExternal`), so no future call site can forget the check by construction. Before
  adding a click handler to fix or gate something, grep for existing `addEventListener(..., true)` on
  `document`/`window`: capture fires before bubble, and `stopPropagation` there means your handler
  never sees the event at all - not silently, but invisibly, since nothing throws.
- An app extension has its OWN data container: a path that is right in the app process is silently
  wrong in the NSE, and the App Group is the only shared storage.
- Background decrypt applies no commit, so a silent commit push leaves the next message unreadable -
  that is the epoch gap, not a bug to retry through.
- **WORK GUARDED BY ONE LOCK IS ALREADY SERIAL - GIVING IT A THREAD EACH ONLY ADDS THE FIGHT.** A
  thread per push looks concurrent and is not: they all queue on the same `MlsStateLock`, at
  5 s per timeout, each winner re-reading the whole 1.6 MB `mls.bin`. Behind a backlog that reached
  97 timeouts, 60 retries and 20+ threads, until `ActivityManager` killed the process for
  `excessive cpu` - and a killed app delivers no notification and drains no outbox, which is the
  real cost. **Serialising such work adds no latency**, because the lock had already imposed the
  order; it removes only the contention (WP-PUSHHERD-1).
- **A LOCK TIMEOUT IS NOT A DOMAIN ANSWER.** `isGroupLocal` returned a plain `Boolean`, so lock
  unavailable, `mls.bin` unreadable, device key missing and JNI absent all became "the group is not
  joined on this device" - twenty verdicts from ten epoch queries, about a DM the device had been
  in for months, each one routed into the Welcome-race retry loop that then re-entered the same
  contended lock. Any predicate that can FAIL TO LOOK needs a third value, and `UNKNOWN` must reach
  no recovery at all: a catch-up answers an epoch gap and a race answers a pending join, and
  nothing has diagnosed either.
- **WHAT REMOVES A NOTIFICATION MUST KEY ON WHAT THE POSTER WROTE - AND ON IOS THERE ARE TWO
  POSTERS.** The in-app path posts under `canari-<stableId>`, the NSE under an identifier the system
  assigned; `CanariCancelConversationNotification` removed only the first, so on a KILLED iPhone -
  the only state where the NSE posts, and exactly the state a read on another device has to clean up
  - it matched nothing and the banner stayed. `threadIdentifier` is the conversation on both paths,
  so enumerate the delivered notifications and remove by thread. Then write the badge from the array
  already in hand: `removeDeliveredNotificationsWithIdentifiers:` has no completion handler, so
  re-reading the centre right after it counts what you just deleted, sometimes.
- A Play-signed install and the GitHub-signed APK cannot update each other, and switching sides
  needs an uninstall that wipes `mls.bin` - so the update target is a RUNTIME fact, never a constant.
- `minClientVersion` is the ONLY thing that interrupts a user now; raising it before the store
  rollout has reached devices locks everyone out behind a button leading to the old version.
- Only user-VISIBLE native strings stay French; everything read while debugging is English.
- A path restriction written for iOS has NO effect on Android: the App Link claim lives in a
  different file per platform and `assetlinks.json` has no notion of a path, so the lists are
  GENERATED from one source. A host with no path attribute claims the whole host.
- A CSS custom property consumed at TWO nesting depths applies its correction TWICE if both
  consumers independently subtract the same inset: `.app-layout` re-pinned itself to
  `--app-viewport-height` even though its own ancestor chain was already correctly shrunk by that
  same variable structurally (`padding-top`), leaving a gap the height of the status bar (WP-KBD-1).
  The fix is not making the second consumer's math right - it is deleting the second consumer.
- Edge-to-edge on Android is NOT guaranteed by `env(safe-area-inset-*)` alone: whether the OS
  populates it depends on OS-enforced defaults (`targetSdk` 35+ on Android 15+) that some OEMs
  (seen on Xiaomi/HyperOS) do not honor consistently for a WebView. Call `enableEdgeToEdge()`
  explicitly in `onCreate` rather than relying on version-gated enforcement to make the insets this
  app's CSS already assumes everywhere actually show up.
- **`fetch` IS NOT `fetch` in the WebView**: `hooks.client.ts` replaces `window.fetch` with the Tauri
  HTTP plugin's, which is a NETWORK client and rejects every non-`http(s)` scheme with
  `scheme <x> not supported` - a bare rejection that reads as a dead network. The routing rule must
  name what the plugin CAN do, never the exceptions: written as an exception list it missed `blob:`,
  and since saving an attachment reads its object URL back, EVERY download on both platforms failed
  while the ACL, the save dialog and `fs.writeFile` were all correct. `utils/fetchRouting.ts`, pure
  and tested. `XMLHttpRequest` is not patched - a passing XHR beside a failing `fetch` is the
  fingerprint.
- **A RELATIVE `/api/` PATH IS DEAD ON MOBILE, AND IT FAILS AS A SUCCESS.** The WebView's origin is
  `tauri.localhost`, so Tauri resolves the path as an ASSET, misses, and falls back to `index.html`
  - **200 with an HTML body**, so `res.ok` is `true` and only `res.json()` throws, inside whatever
  `catch` happens to be there. Seen on A1 2026-08-11 in the app's own log (`[tauri::manager] Asset
  api/mls/security/pin-status/... not found; fallback to index.html`). Three call sites had it and
  the third was destructive: `handlePinReset` read that `res.ok` as "the server cleared the
  verifier" and went on to wipe the device's MLS state, losing the history while the verifier stayed
  registered - the WP-DIRECTBOOT-1 shape again, a "cannot read" taken for a "not there" with a
  destructive branch behind it. Always a base from `utils/apiUrl.ts` (`coreUrl`/`socialUrl`/
  `gatewayUrl`/`deliveryUrl`) or `historyBaseUrl`; `apiUrl.absolute.test.ts` is the guard.
- A WEBVIEW HAS NO DOWNLOAD MANAGER: `<a download>` is a silent no-op on Android and iOS alike
  (Tauri installs neither a `DownloadListener` nor a `WKDownloadDelegate`), and the click still
  "succeeds", so there is no exception and no log - eleven buttons shipped dead. Everything saving a
  file goes through `$lib/utils/fileDownload.ts`. Never ask for a DIRECTORY on mobile (Android's SAF
  has only a document picker), and remember `fs:default` is READ-ONLY - the plugin being named in
  the capability file grants no write.
- A decision reachable from the CLEARTEXT push fields must never sit behind the decrypt ladder: an
  early return on "could not decrypt" silently swallows every action that never needed the plaintext
  (WP-NOTIF-1). And parity between the platforms is not parity of declarations - iOS was correct here
  and Android was not, differing only in WHERE an early return sat.
- A native thread has NO JAVA FRAMES on its stack, so `FindClass` from a JNI-attached Rust thread
  only reaches boot-classpath FRAMEWORK classes (`android.webkit.CookieManager`), never an
  app-bundled class - not `MainActivity`, not an AndroidX library class like
  `CustomTabsIntent`. Calling one of those reliably needs Tauri's own plugin-invocation path
  (`@TauriPlugin`/`Plugin(activity)`), which already runs with the right classloader context - not
  a raw `JNI_OnLoad`-cached `JavaVM` and a hand-rolled `attach_current_thread` (WP-OIDC-TAB-1).
- **A DEPENDENCY CAN MAKE YOUR PROCESS START IN A STATE YOU NEVER DESIGNED FOR, and the source
  manifest will not show it.** `tauri-plugin-notification` merges a `directBootAware` receiver on
  `LOCKED_BOOT_COMPLETED`, so Canari runs before the first unlock after every reboot; read the
  MERGED manifest. In that window a file `exists()` false, `SharedPreferences` loads empty AND
  CACHES that for the life of the process, and a Keystore alias is present but unreadable - three
  ways for "cannot read" to be mistaken for "not there". **A destructive repair must therefore be
  gated on knowing the state is really broken**, or a temporary condition becomes a permanent loss:
  `getOrCreateKey` deleted an intact key and regenerated it, orphaning the push secret for good
  (WP-DIRECTBOOT-1, fixed and VERIFIED on hardware 2026-08-11: same pid across the unlock, zero
  rejected secrets, and a real authenticated fetch forced by emptying the avatar cache).
  Only the notification CHANNELS can be created pre-unlock - they live in the
  system, not in our storage.
- A plain system-browser launch (`openUrl`) is an ORPHANED activity on Android: it opens in a
  separate task the calling app has no relationship to, so nothing on either side can dismiss it
  once the flow that needed it is done. A Chrome Custom Tab launched via `CustomTabsIntent`
  shares the LAUNCHING APP'S OWN TASK, which is what lets the OS close it automatically the
  instant that task's activity resumes to the foreground (confirmed via
  `dumpsys activity activities`: the tab's `ActivityRecord` shared the app's task id before
  login, and was gone from the task's history entirely after the deep-link return) - the
  right fix for "a login tab is left behind" is never a dismiss call, it is putting the tab in
  the right task to begin with.
- **A PAUSE MUST HAVE A SYMMETRIC RESUME, and a circuit breaker must never cut the wire to its own
  reset.** `pauseConnection` stopped both watchdogs on every background; nothing re-armed them, so
  one background/foreground cycle left a phone with no timer able to notice a dead socket. Then the
  reconnect circuit latched open with only the login paths able to close it - while the watchdog,
  the one thing whose job was to notice, reached through `scheduleReconnectImpl`, which the latch
  turns off. Ask of every breaker WHO closes it, and check that party is not itself disabled by it.
  Corollary that made this invisible: an app can be fully alive on HTTP and dead on its socket, so
  "the network works" is never evidence the connection does.
- **A RESUMPTION CONDITION MUST BE ONE EVERY CLIENT CAN EMIT, or the breaker is a permanent kill for
  whoever cannot.** The reconnect circuit released on "foreground, or a network change"; a desktop
  tab already in the foreground on an unchanged network produces NEITHER, ever - so it stayed dead
  for ever after any outage longer than the ~8 minute budget, silently, until a manual reload.
  Enumerate the client classes and ask, for each, WHICH event actually reaches the release. The fix
  is almost never a third event: it is deleting the termination. **A REPEATED TRANSPORT FAILURE IS
  NOT AN ANSWER AND MAY NEVER END A RETRY LOOP** - only a proof may (logged out; 401/403 on the
  refresh cookie), and both already existed. Justify it by cost, not by nerve: capped at 30 s the
  loop is two attempts a minute, below what the same client costs while connected. **Unbounded in
  COUNT still has to be bounded in RATE**, and exactly one rung armed at a time - a leaked timer per
  attempt turns "never gives up" into a storm. Lifecycle events then buy LATENCY, not recovery.
  (WP-RECONNECT-1, [auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it))
- **A RESCHEDULE ISSUED INSIDE THE GUARD THAT FORBIDS IT IS A NO-OP THAT LOGS SUCCESS.**
  `attemptReconnect` called `scheduleReconnect` from inside its `try`, where `isReconnecting` is
  still true - which is exactly one of the two early returns of the thing it was calling. Both
  failure paths did nothing, after logging `Retrying in Ns...`; the retry that appeared to work was
  a 60 s watchdog elsewhere. When a function re-enters its own scheduler, check the scheduler's
  preconditions against the state the caller is holding at that instant - and put the call after the
  `finally` that clears it.
- `getCurrent()` answers "the last deep link this PROCESS was handed", never "the app was just
  started by one" - the Rust plugin holds it for the life of the process, so every re-read must be
  deduplicated. **And STATE WHOSE JOB IS TO SURVIVE AN EVENT MUST NOT LIVE WHERE THAT EVENT DESTROYS
  IT**: the guard was a module variable, which a WebView reload wipes, so the reload replayed a
  15-minute-old launch URL (WP-RELOAD-DL-1). "Module variable" is a LIFETIME, not a detail - pick it
  against the event, here `sessionStorage`, which matches the plugin's own boundary.
- **A DESTRUCTIVE CONTROL EXPOSED TO THE USER NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A
  DENYLIST OF WHAT IT MUST AVOID.** WP-DEVICESTORAGE-1's "clear cache" in Settings (`deviceStorage.ts`)
  only ever calls `caches.delete()` on the three named Cache Storage buckets (media ciphertext,
  avatars, association logos) - it has no path to `mls.bin`, the message database, or the outbox
  mirror, because it never lists the app data directory at all. The measurement side is read-only
  and separate: `get_local_storage_usage` (Rust) buckets `{app_data_dir}` file sizes for DISPLAY
  only. A Settings-page button is easier for a user to hit by accident than a native OS "clear app
  data" dialog already is - same shape of risk as WP-DIRECTBOOT-1's `getOrCreateKey`.

**Android/iOS parity: CODE audited 2026-08-03 (v0.12.0, file by file), CONFIGURATION audited
2026-08-07.** Do not re-audit either - the table of every surface, what each is guarded by, and the
OS-imposed asymmetries that are NOT defects, is
[mobile > parity](frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed).
**iOS cannot be tested for a long while (user, 2026-08-07), so parity is maintained BY
CONSTRUCTION**: one shared file wherever the platforms can share one, a test reading both trees
wherever they cannot. Every parity defect ever found has been in CONFIGURATION, never in code -
the `/auth/callback` capture (`56fc6129`), the missing `deep-link` ACL (WP-DEEPLINK-1, which broke
BOTH platforms), and `applinks:www.canari-emse.fr` claimed on iOS alone though `www` 301s and Apple
does not follow redirects (fixed 2026-08-07, now asserted by `appSiteAssociation.test.ts`).
**A no-op on one platform must say WHY**: "nothing to do" and "there is no API and nobody has
looked" are different, and only the first is evidence - the iOS cookie jar is the second, and is now
`check P`.

## Release and CI -> [cicd](cicd.md)

Signing, the bump script, the secrets and every compile-check trick are on that page. The three
that decide whether you believe a run:

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- A green run is not proof YOUR file compiled: the iOS pbxproj is hand-maintained, so grep the log
  for `SwiftCompile`/`CompileC` on the file. (iOS only - Gradle cannot skip a source set.)
- The CD regenerates `infrastructure/.env` from the repo secrets, so a value set over SSH lasts until
  the next deploy. A credential is only real once it is a GitHub secret AND named in `cd.yml`.
  **A THIRD place is just as mandatory and easy to forget: the service's own `environment:` block
  in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for parity) must also name the var
  explicitly** (`FOO: ${FOO:-}`) - `.env` having the value proves nothing about whether Compose
  passes it into the container. `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `cd.yml` and
  `.env.example` and was still absent from `docker exec ... env` on prod (WP-SAFELINK-1) because
  this third step was skipped; the endpoint answered 200 with a wrong, silently-fail-open verdict
  the whole time, not an error - `docker exec <container> env | grep FOO` is the only way to catch it.
- **A TEST FILE NOBODY EXECUTES READS AS COVERAGE ON EVERY REVIEW.** Sky's `tests/api.test.ts` was
  neither passing nor failing for months - the vitest `include` only ever looked under `src/` - and
  it had rotted meanwhile: a mock missing an export the route calls, and an env assignment placed
  after a hoisted import, so every case would have answered 500 had it ever run. Nothing announces
  this; a green suite says only that the files it FOUND passed. When a suite lives outside the
  pattern's roots, or a runner's `include`/`testMatch` is edited, check the file COUNT, not the
  colour.
- A generated file the repo COMMITS needs both halves or neither: the bump must patch it, and
  `.gitignore` must really keep it - a later `*.lock` silently overrode the `!` written above it,
  and a lock nothing bumps is corrected by whatever unrelated commit next runs cargo.
  **Worse than either half is a generated file that the FORMATTER also owns**: the Tauri plugin ACL
  outputs (`plugins/*/permissions/{autogenerated,schemas}/`) were written expanded by `build.rs` and
  folded back by the pre-commit formatter, so every Android build dirtied the tree and every commit
  undid it. They are gitignored now, like `gen/schemas/` already was; the SOURCE (`default.toml` and
  the `COMMANDS` list in `build.rs`) stays tracked. Before ignoring any generated file, delete it and
  rebuild - that is the only proof the generator really owns it.

## Carte de la Vie Asso -> [carte-vie-asso](carte-vie-asso.md)

The contract with the Portail, and every rendering trap (text sizing, the PDF anchor, the split
watermark, Preflight), are on that page. The three that decide the contract:

- A published carte is the poster RESOLVED (poster px + `stage`), never fractions and never a layout.
  The showcase decides nothing: what it is not told, it cannot copy.
- Association identity joins live; the displayed members are a snapshot, so a roster edit republishes.
- The two repos must agree on the FONTS, or every measured box is wrong.

## Associations and agenda -> [social-service](services/social-service.md)

- A second surface for an existing action mirrors the SERVER's rule, not the first surface's:
  the association page gates on `PROPOSE_EVENT` there, the server also lets any BDE
  `VALIDATE_EVENTS` holder edit any event - so that holder had the right and nowhere to use it.
- What a modal hides because it is redundant is a decision of the PAGE, never of `canEdit`.

## Cotisations (Cercle) -> [cotisations](cotisations.md)

The page carries the tier model, the webhook ladder and everything debugging the live link cost.
The two that are security, not plumbing:

- The tier XOR has ONE implementation, `UserTagService.revokeSiblingTierTags`, and a tag revoke MUST
  be scoped to `issuingAssocId` or it is a cross-tenant IDOR.
- A product entity carries `webhookSecret` and `/products/all` answers every logged-in user - same
  lesson as `Channel.masterSecret`. `toSafeProduct` is the one seam, and a guard is a decorator
  nothing type-checks, so assert the metadata.

## Working in the Cercle repo -> `../le-cercle/AGENTS.md` (that repo's own contract), and the VEILLE loop in `CLAUDE.md`

That file is the contract for THAT repo - the per-action guard, the 403 rather than a redirect, the
empty signing key, the rollback that throws a success value, the date model, the `bun:sqlite` and
migration traps, the run-time config rule. Read it there; re-copying it here only makes the two
drift. One thing it cannot say from inside: a duplicate migration NUMBER is loud, not silent
(`exit(1)` before applying anything) - but only once both branches have merged, so check the highest
number on `main` before naming a file.

## Presence, in the gateway -> [chat-gateway](services/chat-gateway.md#presence)

- **The presence key is per DEVICE and every event that removes it is per CONNECTION.** Two tabs are
  one device. Any path deleting `user:online:{userId}:{deviceId}` must discount the connection it
  acts for and check for survivors - `AppState::remove_session` / `has_other_sessions` are the only
  two forms of that question, and a third call site writing its own is the bug this section exists
  for. Fixed 2026-08-16: the explicit `{"type":"disconnect"}` frame deleted unconditionally while
  `ConnectionGuard::drop`, running a moment later, correctly declined to - so the guard written to
  protect the key was what stopped it being restored.
- **A connection is identified by its `conn_id`, never by `is_closed()`.** An aborted send task still
  reports `false` until the runtime drops its receiver. `is_closed()` is only good enough for pruning
  senders alongside an authoritative removal by id.

## Sessions, in every app -> [sessions](sessions.md)

Settled 2026-08-04 by WP-SESS-1 and WP-SESS-2, SHIPPED in all four apps. The whole model and every
rule it cost is on that page - read it before touching any login, cookie or rotation.

- A cookie whose content IS the identity it claims is not a credential, it is a form field.
- A replayed rotating token is TWO holders of one cookie: revoke the session - but only with a grace
  window, and settle the race in ONE conditional `UPDATE`, never read-then-write.
- An empty key can fail OPEN or CLOSED and you cannot guess which. Decide explicitly.
- Rotation makes DURABILITY part of the protocol: a client that loses the new token does not just
  fail to refresh, it gets revoked. Force the write where the rotation happens, and AWAIT it - on
  Android the cookie jar reaches disk only on `CookieManager.flush()`, and a kill with no lifecycle
  callback rewinds it one generation.
- A dead session is an ANSWER: never retry the request anonymously, or "you are logged out" renders
  as "there is nothing here". Reach the verdict in one place and announce it from there - every
  caller that re-decides is a path that can forget.
- A one-shot announcement and a late subscriber are a RACE: replay the verdict to whoever registers
  after it. A fallback only covers the race if it does everything the real handler does, which it
  never does - ours redirected without closing the PIN modal, so `/login` arrived unusable.

---

## Shared gotchas -> [development](development.md), [cicd](cicd.md)

Environment and tooling traps that are not about any one subsystem. Each one cost a run.

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@`.
- **Postgres stores UTC and the prod host is `Europe/Paris` (CEST, +0200)**, so a DB timestamp is two
  hours behind the wall clock a test just wrote down - `18:09:47` in `queued_message` IS the
  `20:09:47` send. Both are CORRECT (`timedatectl` = CEST, `SHOW timezone` = UTC); do not "fix" the
  server clock, it would move the 03:30 backup cron and break every log correlation. Convert.
- MiConnect 2FA remembers the device for 8 h, so a later login only needs the code. If the CAS page
  stalls after Esup Auth accepts, go BACK to the browser tab and reload; ask the user rather than
  looping.
- A live credential is not a debugging input: reading the phone's cookie jar is refused, and the
  answer came from a probe that never touched the token. Reach for the observable, not the secret.
- Android Rust compiles from Windows: `NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125`, put
  `toolchains/llvm/prebuilt/windows-x86_64/bin` on PATH, `CC_aarch64_linux_android=aarch64-linux-android24-clang.cmd`,
  then `cargo check --target aarch64-linux-android`. It is the only local check of `#[cfg(android)]`
  code - and it proves compilation, never that a JNI `FindClass` resolves at runtime.
- Backend lint needs `npm install` in the app dir (bare `oxlint`/`oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- Never assert a wall clock in a test; two isolated browser contexts = two devices.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
