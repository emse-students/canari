# Backlog

**Everything below is SCHEDULED** - the user's decision of 2026-08-18: the backlog and `CLAUDE.md`
are both emptied before the campaign restarts. This file is no longer a parking area; it is the
DETAIL for the queue in `CLAUDE.md`, which carries the order and one line per item. Read the order
there, the substance here, and delete an entry from BOTH when it ships.

The exception is the handful that genuinely cannot be pulled forward - blocked upstream, blocked on
an iPhone that does not exist, blocked on credentials somebody else owes, or post-campaign by the
user's own decision. Each says which it is, and `CLAUDE.md` lists them together at the end of the
queue so that "not scheduled" never has to be inferred.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

---

## Security - blocked upstream

### ANSWERED - the `libcrux-chacha20poly1305` panic never reached this product

**It was filed as the one open alert reaching attacker-controlled input on a path that matters. It
reaches nothing: the crate is not compiled.** The claim rested on reading the lockfile, where
`libcrux-chacha20poly1305` sits under `openmls_rust_crypto` -> `hpke-rs` -> `hpke-rs-libcrux` ->
`libcrux-aead`. A lockfile lists what COULD be resolved, including optional dependencies nothing
turns on, so it never proves a crate is built. `cargo tree -i` does, and it finds no path to
`libcrux-aead`, `hpke-rs-libcrux` or `libcrux-chacha20poly1305` on any target:

| crate                      | in the lockfile | compiled |
| -------------------------- | --------------- | -------- |
| `hpke-rs-rust-crypto`      | yes             | **yes**  |
| `chacha20poly1305` 0.10.1  | yes             | **yes**  |
| `aes-gcm` 0.10.3           | yes             | **yes**  |
| `hpke-rs-libcrux`          | yes             | no       |
| `libcrux-aead`             | yes             | no       |
| `libcrux-chacha20poly1305` | yes             | no       |

The HPKE backend this build actually uses is `hpke-rs-rust-crypto`, i.e. the RustCrypto AEADs. The
libcrux ones are the alternative backend, and nothing selects it. Two libcrux crates ARE compiled -
`libcrux-sha3` and `libcrux-secrets`, through `hpke-rs` itself - and their advisories are the ones
that survive; both are pinned by `openmls_rust_crypto 0.5.1`, and a `0.0.x` requirement is exact in
Cargo semver, so only a stable `openmls_rust_crypto 0.6.0` moves them.

Every one of these is now an entry in the crate's `.cargo/audit.toml`, each naming why it cannot be
honoured and what lifts it, so `cargo audit` is green without any of them being forgotten. The
openmls provider upgrade is still owed - it is what drops the unbuilt crates out of the lockfile and
unpins the two real ones - but it is a scheduled dependency upgrade, not a live defect, and nothing
about it is urgent.

**The rule this leaves: a lockfile entry is not a dependency.** `cargo audit` reads the lockfile, so
it reports crates that are never linked; the first question about any advisory is whether
`cargo tree -i` can reach the crate at all.

---

## Open questions

**They live in [open-questions](open-questions.md), not here.** An item with no severity is a
QUESTION - its first task is to answer it, not to write code - and mixing those with scheduled defects
is what made this file hard to read. Nothing is scheduled from that page: an answer either produces an
entry here or closes the question.

## Measurements owed

### P3 - the last node runtime: four jest suites that will not run under bun (decided 2026-08-27, AFTER the campaign)

**Scheduled, not parked, and the decision behind it is the user's** (2026-08-27): npm leaves now,
node leaves later. npm is already gone - `node --run test` replaced the one `npm test` in
`ci.yml` and the one `bun run test` in the Makefile's `test-history`, so nothing in this repository
invokes a package manager other than bun. What survives is the node RUNTIME, in three places:
`actions/setup-node` twice in `ci.yml` (once for the backend suites, once for the harness
self-tests) and once in `code-analysis.yml`.

**The measured blocker, and it is one file.**
`apps/chat-delivery-service/src/controllers/admin-storage.controller.mls.spec.ts` passes 8/8 under
node and fails under the bun runtime. That single spec is why CI installs, lints and builds with bun
but TESTS with node, and both call sites say so in a comment. **Do not collapse the two runtimes
without re-running that spec** - the note has been in `CLAUDE.md` since the bun migration and it is
the only thing standing between a green pipeline and a silently weaker one.

**What the work actually is.** Porting four NestJS services from jest to `bun test`: `jest.fn()` and
`jest.spyOn` to bun's `mock`/`spyOn`, `ts-jest` (which TypeScript 7 already could not load - see
[ecosystem-convergence](ecosystem-convergence.md) section 9), the `moduleNameMapper`, and the
`@nestjs/testing` module fixtures. It is days, not hours, and it touches suites that guard MLS
storage - the wrong place to discover a mock that silently stopped asserting.

**Sequencing, and why it is not now.** The campaign is running and prod is the test server. A test
framework migration changes what "green" means for every rung still to be taken, so it waits until
the ladder reaches the bottom. Until then the honest description of this repo is: **bun is the
package manager and the runtime everywhere except one test invocation, which runs on node on
purpose, for a reason that has been measured.**

### P1 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27)

**This is not a bug report. It is the absence of one, which is worse.** `apps/call-service` was
brought back to compiling on 2026-08-27 after two Dependabot majors had merged onto `main` through a
CI hole (story in `CHANGELOG.md`; the hole itself is closed - the crate is in the Rust matrix now).
The bumps were `webrtc` 0.11 -> 0.17 and `axum` 0.7 -> 0.8. **What is verified is that it builds,
that clippy is clean under `--all-features`, and that its ten unit tests pass. Not one of those runs
the ICE stack, and not one of them places a call.** The repository's own rule names exactly this
distance: a green gate is not a working system.

**Six majors of webrtc-rs is not a version bump, it is a different library.** One behaviour change is
already known because it caused a compile error: `RTCIceServer::credential_type` is gone, and the
rule it carried moved inside the crate - `RTCIceServer::urls()` now returns `ErrNoTurnCredentials`
for a `turn:`/`turns:` URL whose username or credential is empty, where 0.11 accepted the same input
with an `Unspecified` credential type. A misconfigured TURN entry therefore used to degrade quietly
and now fails the WHOLE ICE configuration for that peer connection. `build_rtc_ice_server` warns and
names the offending server, which is the only thing that can be done from here without a call.

That one surfaced because it broke the build. **The ones that did not break the build are the reason
this entry exists**, and they cannot be enumerated by reading a diff - between 0.11 and 0.17 the
crate reworked ICE gathering, DTLS and the RTP/RTCP interceptor chain, none of which this crate's
types force it to acknowledge.

**What settles it is one call, and only one call.** Two peers, audio and video, over the SFU, with
TURN configured as production configures it - the relay path specifically, because that is the path
the `ErrNoTurnCredentials` change sits on and the path a STUN-only test never touches. Watch for: the
peer connection reaching `connected` at all; the terminal ICE line the crate already logs; whether
renegotiation still lands (`main.rs` has a renegotiation path that no test covers either).

**Blocked on nothing but a runner.** This is rung 15 of the ladder, CALL, and CALL is one of the
three phases with NO runner written - so the measurement cannot be taken until that runner exists.
Until then the honest statement is that calls are UNVERIFIED on this build, not that they are broken:
nothing observed them failing, because nothing observed them at all. **Do not let a release carry
this without the call being placed**, by the runner or by hand - a release is precisely the moment
the shipping-order hazard turns an unverified change into a user-visible one.

### P2 - what made the profile fetches fail on that device at that moment

**The MECHANISM is closed** (2026-08-16): the swallowed `catch` now accuses, a reconnection clears
`failedAt` because a failure recorded while the network was down is evidence about the network rather
than about the user, a failed lookup answers `null` instead of the label that overwrote names the
caller already had, and `displayName.spec.ts` pins all of it.

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. Do not assume it is the
same fault as the avatar endpoint, and do not assume it is not.

**The denominator now rides ON the accusation (2026-08-19).** `displayName.ts` counts the lookups
that actually reached the network - a cache hit, the current user, the `system` sender and a lookup
already suppressed by the backoff are all excluded, because counting them would drive the rate
towards zero exactly as the cache warmed and measure the cache rather than the fault - and every
warn now ends `(failed/attempted lookups failed this session, X%)`. One line answers both "did a name
get lost" and "how often does that happen here", which is the question the backoff turns on.
`displayNameLookupStats()` exposes the same numbers to a test or a debug surface.

**Where the number will come from:** the campaign run logs, on both platforms. Nothing here is sent
anywhere - there is no client telemetry and this did not add any - so the rate is read from a device
or a browser console during a run, which is exactly where the symptom was seen. Server-side is not
an option: `GET /api/users/:id` is not request-logged, and a client that never reached the network
would not appear there anyway.

**Then decide about `FAILURE_BACKOFF_MS`.** A high rate argues the two-minute suppression is doing
real work against a refusing server; a rate near zero argues it is a clock hiding a name for two
minutes over a blip that the reconnection listener already handles.

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

The code half is fixed: `UpstreamUnreachableError` classifies at the throw, so an unreachable host is
a **502 `no-store`** never remembered, while an answer about the URL stays a cacheable 400; and
`OUTBOUND_BUDGET_MS` is the single budget, set on the `AbortController` AND on the undici dispatcher,
so the stated budget is the one that fires. Pinned by `security.controller.link-preview.spec.ts`.

**What is owed is not a code change.** Within one three-minute window on 2026-08-15, two unrelated
upstreams timed out from two different containers (`chat-delivery-service` → Wikipedia at 14:37:02,
`core-service` → gallery at 14:39:58). That is not evidence about either upstream, and it is the
second time this shape has been mistaken for one - the IPv6 reading was refuted by measuring the
components, which all came back healthy. **Measure EGRESS over time rather than the endpoints again**:
the component probes already say each is fine at the moment it is asked, so what is left to establish
is whether these stalls are CORRELATED, which a one-shot probe cannot answer by construction.

**ARMED 2026-08-19.** [`infrastructure/egress-probe/`](../../infrastructure/egress-probe/README.md)
takes a sample a minute - both stalled upstreams, the tunnel back to ourselves, a control at 1.1.1.1,
and the same target from inside `chat-delivery-service` through Node's own fetch - with DNS, connect
and TLS recorded apart from the total. `report.py` prints each conditional rate beside the base rate
it has to beat. Installed in the `canari` crontab, verified writing, `probe.err` empty.

**This item cannot be closed by working on it.** A report over a quiet week says the week was quiet.
Read the ledger the next time a stall appears in a service log; that is the moment the two
hypotheses differ, and the stall will already have been measured.

---

## Communities and permissions

Six entries came out of ONE audit on 2026-08-17, prompted by a user question rather than by a
failure. **All six are closed as of 2026-08-19** and are not repeated here - the last one, two communities
sharing a name, the user closed by decision rather than by code (2026-08-19: it is not a defect).
The five that shipped on 2026-08-18: the mechanism is on
[social-service](services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18),
the audit and its prod figures on [community-rework](services/community-rework.md), the rule in
[durable-rules](durable-rules.md), and the story in `CHANGELOG.md`. Those six are closed; the entry
below them, a private salon's seed being sealed to the whole community, closed on 2026-08-20.
WP-REGRANT-1, opened 2026-08-21 by the campaign, shipped and was verified on production the same day -
its entry below is kept as CLOSED because the second attempt at the fix is the interesting half. **One
thing IS open here, and it is an observation rather than a finding:** the past-epoch seed frame below.
**The association permission audit, asked for on 2026-08-26, SHIPPED the same day** - all three
parts. Its measured flag table, the one predicate that replaced four disagreeing spellings, and the
seven findings D1-D7 are on [association-permissions](association-permissions.md), the only copy;
the rules it paid for are in [durable-rules](durable-rules.md), the story in `CHANGELOG.md`, and the
French user page it owed is `docs/user-guide/permissions-association.md`.

### P3 - an epoch-0 seed frame is delivered on every rotation, and nobody can open it (observed 2026-08-21, did not reproduce)

**COMM-22, six cycles, six of these** - one per cycle, both clients seeing the same frame at the same
second, `group_epoch` 3/5/7/9/11/13 and `msg_epoch` **0 every time**. So a frame sealed at the group's
first epoch is presented again on every rotation.

**Not a loss, and the product says so:** the frame is acknowledged and the seed arrives through the
history request instead - 12 markers of 12 warm AND cold. What is unexplained is why an epoch-0 frame is
delivered at all: `queued_message` held no publish matching it, which points at a REPLAY rather than a
sender sealing under a stale handle, and "points at" is not a finding.

**AND IT DID NOT REPRODUCE** - the next run on the same build, after `cleanup.mjs` swept three debris
communities, recorded `pastEpochFrames: []` over six cycles. The other half of the original observation
WAS real and is closed (a deleted community's seed carrier held for ever - see
[graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21)),
and it accounts for the redelivery bursts but not for these frames, which appeared on a salon whose
community was alive.

**P3 and not higher because it may already be gone.** Settling it needs ONE probe that publishes a seed
and reads back what the server fanned out - a different instrument from the COMM runners. `comm22.mjs`
records `pastEpochFrames` verbatim on every run, so every future run says whether it is back, and the
cheapest next step is to read those rows rather than to build the probe.

### P3 - a log line calls a routine race "Non-recoverable", and its own comment says otherwise

Found on 2026-08-25 while classifying the whole `[PENDING]` site for `watch.mjs`, so it is a reading
of the code and not a symptom anyone reported. `actions.ts:312-323` handles an Add that failed on
`WrongEpoch` or `epoch_mismatch`. Its comment is explicit about what that means - *"Transient
concurrent race (gap 1): another device committed simultaneously. Check if the invitation is already
fulfilled; otherwise let the next cycle retry"* - and the retry really happens: the missing commit
arrives through the queue and the sweep runs again. Then, on the path where the membership does not
yet read `active`, it logs:

    [PENDING] Non-recoverable error for <device>: <errStr sliced to 100>

**Every word of that is wrong about the branch it sits in.** It is recoverable, by the mechanism the
comment describes, and nothing about it is an error the reader can act on. A line that overstates
its own severity is the same defect as one that understates it: it teaches its reader to discount
the tag, and `[PENDING]` has seventeen other lines that need to be read.

**It also costs the classifier its determinism, and that is the part that made it visible.** The
line reaches `notable` only because `NOTABLE`'s generic `/epoch|GAP|out-?of-?sync|re-?add|welcome_request/i`
rule happens to match words the ERROR TEXT carried - and `errStr.slice(0, 100)` can cut them off, at
which point the identical event lands in `unexplained` and breaks `clean`. So one log call has two
buckets, chosen by how long an error string was. Both spellings are pinned in
`classify-selftest.mjs` for exactly that reason, with the seam named rather than smoothed over; that
is the correct handling of an accident, not a fix for it.

**THE FIX IS THE LINE, NOT THE RULE.** Say what the branch knows - the epoch moved under us, the
invitation is still pending, the next sweep retries - and drop the raw `errStr` interpolation that is
carrying the classifier. Then the rule matching it can be anchored and exact like the other
fourteen, and the `notable`/`unexplained` coin-flip disappears with it.

**Why it is deferred.** It is a product-code string change, so W1 and W2 only see it after a deploy,
and for the run that straddles that deploy the classifier has to accept both spellings - which is
precisely the transition being managed right now for `Welcome -> ... pour ...` (fixed to `for` on
2026-08-25, both spellings pinned). Doing two of those at once during the ladder buys nothing. It is
one edit plus one rule swap once the ladder is done.

### P2 - the notification path ships raw literals, and answers the same caller in two languages

Found 2026-08-25 while reading `useMessaging.svelte.ts:485` for TAB-1's re-scope. Every user-visible
string on the notification and forward paths is an inline literal, which the standing rule forbids
outright (*"User-visible strings use Paraglide - no inline literals, ALWAYS, even in a plain `.ts`
util, and even when a nearby call site already has raw strings"*):

- `useNotifications.svelte.ts:226-227` - `'Appel entrant'`, `` `${callerName} vous appelle` ``,
  `'Un contact vous appelle'`, and the `'Canari'` title fallback at `:202`.
- `useMessaging.svelte.ts:496` - `'Nouveau message'`, the body of every message notification whose
  preview is empty.

**The half that is worse than untranslated is INCONSISTENTLY translated.** One function hands its
caller a French failure and an English one through the same field:

- `useMessaging.svelte.ts:1173` - `error: 'Conversation introuvable.'`
- `useMessaging.svelte.ts:1205` - `error: 'Nothing to forward.'`
- `useMessaging.svelte.ts:1227` - `error: 'Conversation not ready.'`

Whatever renders `error` shows whichever it got, so a French user meets English on two of the three
forward failures. That is not a missing translation but a visible defect, which is why this is P2 and
its siblings above are not. Nothing types a string as user-visible, so no gate catches any of it -
the reason the rule says to reach for Paraglide on the FIRST draft.

Not fixed on sight: a frontend change redeploys prod, and prod is the test server - a push during a
run makes the phase VACUOUS. It belongs to the first work package after the ladder.

### P3 - a Welcome is repaired by kick + re-add, and nothing records which of the two causes it was

Found 2026-08-25, while attributing GRP-8's `PASS-DIRTY` of 2026-08-24 (the run is on the
[board](cross-client-testing.md); the environment half is a methodology rule and is not repeated
here). A device of the group's creator was fanned into a new group, then sent a `welcome_request`
for a group whose leaf was ALREADY in the MLS tree. `actions.ts:956` handles that the documented way
- read the tree, kick the stale leaf, re-add - and logs `[KICK] Stale leaf ... removed`.

**The repair is right; what is missing is which situation it repaired.** Two reach this line and they
are not the same event:

- the Welcome was **lost or never delivered**, and the device's request is the retry that recovers
  it. The mechanism working exactly as intended.
- the Welcome was **still in flight**, and the device asked before it arrived. Then the push and the
  pull overlap, the repair is reconciling two paths that produced the same leaf, and the standing
  rule applies: *a race that heals cleanly is still a defect - name what makes the two paths overlap
  and delete the overlap; a ledger that reconciles them afterwards is a witness, never a fix.*

Nothing at the kick site can tell them apart, and the client that would know is the one being
repaired. **What would distinguish them:** the requesting device's own log - whether it had received
and failed to process a Welcome for that group, or had never seen one - and the elapsed time between
`sendWelcome` for that (group, device) and the `welcome_request` arriving. Neither is recorded today.
Carry the discriminator to the decision from where it is already known, rather than learning by
failing: the handler knows when the Welcome was sent, so the line can say which case it is.

Not raised above P3 because the repair is correct either way and no user-visible loss has been
observed - but it is the reason a group-creating check can go dirty on a device nobody touched, so
whoever reads the next `[KICK]` needs this page.

### P3 - the seam that forgets a conversation forgets it silently

Found on 2026-08-25 in the same reading. `historyReconcile.ts:756` is `forgetGroupReconciliation`,
the one seam every deletion path calls so that state describing a conversation cannot outlive one -
`conversations.ts:193` and `:228`, `groupActions.ts:151` and `:362`. Its own doc comment says why it
is one seam and not a line in each path: *"the old registry learnt the hard way: state describing a
conversation may not outlive one, and three separate pieces of it once did, one of them
user-visible."*

It clears three maps - `asked`, `deferred`, `coverageStated` - and logs nothing at all. So the
mechanism that exists BECAUSE this state once leaked past a deletion leaves no evidence that it ran,
which is the one thing a reader would want when it leaks again. Every rule this project has about
observation says the same: a correct mechanism with no report is found by hand, a day late.

**One line at entry, naming the group and what it held** (`asked`/`deferred`/`coverageStated` all
carry a value worth printing - a deferred reason, a peer count), plus the rule to classify it. Two
sibling exports read the same maps and are called only by `historyReconcile.test.ts` -
`deferredReconciliations()` and `statedCoverage()`. That is a legitimate test seam, not dead code,
and it stays.

**Why it is deferred.** Same reason as the entry above and filed with it: a product log line changes
what the classifier sees on four deletion paths at once, so it lands after the ladder, with its rule
written in the same commit.

### P1 - a re-granted member stranded by a refused re-join (WP-REGRANT-2) - CODE IS IN, THE PROOF IS OWED

**Every half is now shipped, and none of them has been measured together.** Kept as a P1 for exactly
that reason: the defect was found by COMM-22 and only COMM-22 can retire it - four grant/revoke cycles
green. The measurement, the log tables and the three wrong diagnoses this entry went through are in
`CHANGELOG.md`, and the rules they left are in [durable-rules](durable-rules.md); none of it is
restated here.

| Half | What it was | Where |
| --- | --- | --- |
| The forget was not durable, so a reload restored the stale tree | the strand itself, permanent | shipped 2026-08-25 |
| Five join refusals flattened into one `false` | the doomed commit resubmitted for 20 minutes | `3ec46d85` - `ExternalJoinOutcome`, six variants |
| A transport failure relabelled "a newer commit landed" | a retry whose premise a lost packet cannot support | same commit - `reason: 'unreachable'`, claiming nothing |
| The walk's silent skip, indistinguishable from a walk that never ran | a paragraph of this entry was wrong about it | it logs which condition declined |
| **The READ refusal flattened the same way** | a 403 reported as `keeping the one this device holds` | 2026-08-26, below |

**The last one was found by reading this entry rather than by a run**, and it is the same defect one
layer up. `joinDistributionGroup` classified nothing before concluding from local state, so EVERY
refusal of `getDistributionGroup` reached the `heldLocally` branch first - and a 403 is that route
ANSWERING, on the membership of the scope, which is the whole reason the GroupInfo is served from
social-service at all. A revoked member holding the tree therefore logged the sentence written for a
lost packet, then reconciled its roster and asked for history on a salon it had just been refused.
The status had been on `ChannelApiError` since that class was introduced; nothing read it. Now the
three answers are separated BEFORE local state is consulted, and only the refusal that says nothing
about entitlement falls back on what the device holds. It does NOT drop the tree - that is a
destructive repair owing its own evidence, and the revoke has already deleted the delivery rows that
would make the tree worth anything. The test that asserted `/could not read/` for a 403 was pinning
the defect and now asserts the classification.

**What is owed: a COMM-22 run, and nothing else.** It is on the re-run list for its own reasons
(web-only, no phone), so the proof costs no extra work.

### P2 - a bundle of pure DECLINES still goes out as transport, and a dropped decline strands a requester

**The measured case shipped 2026-08-25** - an answer carrying seeds is now `DELIVERY.keyMaterial`,
silent AND durable, so the server queues it without consulting presence. Story in `CHANGELOG.md`, rule
in [durable-rules](durable-rules.md), and COMM-18 is a clean `PASS` on it.

**What is left is the same shape, smaller, and has never been observed.** A bundle of PURE DECLINES
still goes out as transport, deliberately: it carries no key material and restates a fact the requester
could derive. But a dropped decline strands a requester exactly as permanently as a dropped seed did -
it is the fact that sends them to the NEXT member, and nothing re-asks.

**Why it is not fixed with the other half.** It needs the ability to deliver a frame to a device that
presence reports offline WITHOUT appending it to the group's log - the fourth combination `DELIVERY`
does not have (`silent` and `durable` were one boolean until 2026-08-12, and `durable` still gates both
the presence filter and the history append server-side). Splitting them is a wire-level change, so it
waits for a measurement that needs it rather than being guessed at now.

### P3 - a poll whose deadline passes while the card is on screen flips only on reload

Left behind by the COMM-15 fix of 2026-08-25, and stated here so it cannot hide behind that defect a
second time. The closure of a channel poll is now the SERVER's statement (`ServedChannelPollMeta.closed`,
[social-service](services/social-service.md#channel-polls-and-who-decides-one-is-over)), which fixes
the case that mattered - a poll closed by a human, whose card used to stay open for ever because two
clocks answered the question. It does not fix the case where the deadline simply arrives: `closed` is
stamped when the poll is handed out, and nothing re-reads it afterwards.

Two things stop at that instant, and only one of them is worth anything. The FOOTER (the vote form
giving way to the ended label) is the one that matters, and it is wrong for as long as the card stays
mounted - a person can still submit into a poll the server will refuse with a 403, which is the same
class of "the server enforces a rule the client has never heard of" the write-policy work already
named. The COUNTDOWN is cosmetic: `pollCountdown` renders whole minutes and does not tick, so it is
already stale between renders, and it now floors at zero rather than claiming an ended poll is still
open.

**The fix is NOT a timer in the card**, which is what "make it tick" would buy, and would put a
per-poll interval in a list that scrolls. The deadline is KNOWN, so the moment it becomes interesting
is known too: one `setTimeout` per mounted poll, at `endsAt - now`, that flips the poll's own state
once and never fires again for an already-closed poll (and never at all for one with no deadline).
Even that has to state whose clock it used, so the delay is computed from the same server statement
the card is already given rather than from a comparison this side makes. Alternatively - and cheaper -
the vote submission's own 403 is a fact the card can act on, which is the one path where being wrong
actually costs a person something.

**Why it is deferred.** It is a rendering item behind a defect that is fixed, nothing on the ladder
asserts a deadline arriving live (the campaign closes polls with the close control), and MUT-20 aside
no check waits on wall-clock time at all. It belongs with the rendering pass, not with a rung.

## Messaging convergence

### P2 - a frame no rule recognises is retried for ever, so one bad frame dirties every later row (measured 2026-08-27)

**The cause that produced it is FIXED** (the create-race session orphaning - story in
`CHANGELOG.md`, mechanism in [channel-encryption](protocols/channel-encryption.md)). What is left
is the amplifier, which is independent of it and will do the same for the next unrecognised frame.

`mlsDecryptError.ts` classifies a decryption failure into nine kinds. Five are PERMANENT
(`own-message`, `secret-reuse`, `past-epoch-application`, `generation-gap`, `evicted`) and are
acknowledged, because retrying them can only fail again. Everything else, `unknown` included, is
treated as recoverable: warned about and **not** acknowledged, so the server redelivers it on the
next connection, for ever.

`ValidationError(InvalidSignature)` matches no rule, so it lands in `unknown`. On the COMM rung of
2026-08-27 a single such frame - one message sealed against a discarded group - came back on every
subsequent row of the rung and turned **fifteen otherwise clean cells into `PASS-DIRTY`**. One
defect, fifteen reports of it, and no way to tell from a cell which was which.

**What the repair must NOT be.** Acknowledging `unknown` silently would hide exactly the divergence
the classifier exists to surface, and a retry budget or an age cutoff would put termination on a
clock - both are refused by standing rules. **What is wanted is a proof of permanence.** One is
probably available and unexploited: a signature that fails validation at a distribution epoch this
device has already advanced past can never validate later, which is the same argument
`past-epoch-application` already makes. Settle whether `InvalidSignature` can be proven permanent
from the epoch pair the frame already carries; if it can, it becomes a permanent kind, is
acknowledged, and is logged at a level that ACCUSES with the epochs attached. If it cannot, the
frame needs a durable per-frame record so it is reported ONCE rather than every connection.

**Evidence:** the COMM re-run of 2026-08-27 on `6808a89c`, W1 console, group `c6c3bba5`,
`msg_epoch=0 group_epoch=0`.

### P2 - an external joiner's own commit locked the next joiner out; FIXED for that path 2026-08-26, one half left (COMM-22)

**Reproduced on two builds with one runner**, `d6f61539` (2026-08-25T21:56Z) and `2a4297cb`
(2026-08-26T17:45Z), `armed: true`, six grant/join/send/revoke/send cycles both times. It is NOT the
wreckage path `ea8266b2` removed: that commit landed at 20:25Z, before both.

The signature is narrow, and that is what makes it a defect rather than a slow window:

| | value |
| --- | --- |
| sender reads | 12 of 12, 6 837 ms |
| peer reads WARM | **11 of 12** |
| peer reads COLD, after reload + PIN | **11 of 12** - the same eleven |
| seeds the peer holds | **11**, for 12 sessions |
| `nothingStaysUnreadable` | true |

**WARM AND COLD ARE IDENTICAL, WHICH IS THE WHOLE FINDING.** A repair that had not finished yet would
differ across a reload; the same eleven on both sides means the twelfth seed is not late, it is
absent, and no reload will fetch it. The row it belongs to renders as explicitly unreadable
(`no seed for session ... (repairable)`) - so the product is honest about it and the reader still
never sees the message.

**THE SENDER DID ANSWER.** `repair.senderAnswered` holds nine answers summing to twelve seeds and
`senderWithheld` is empty, while `peerAbsorbed` records four lines summing to seven. So the loss is
on the receiving or the requesting side, not a sender that refused.

**THE CAUSE, FROM THE RUN LOG OF `2a4297cb`.** The peer is not slow and it is not refused a seed: it
is not IN the salon's distribution group at all, and it is its OWN earlier commit that put it out.

    19:36:12  W1  no base published for salon 58afab93 - creating group 9e46429d
    19:36:12  W1  POST .../distribution-group/group-info        <- base published at epoch 0
    19:36:21  W1  Processing Commit group=9e46429d sender=<peer>  <- the peer's external join, epoch -> 1
                  ... and NO group-info POST from the peer, ever
    19:36:26  W2  externalJoin STALE base for 9e46429d (published 0, group at 1) - not attempting
    19:36:31  W2  undecryptable frame on 9e46429d - not acknowledged: Group not found
    19:36:34  W2  could not ask for 1 missing seed(s) in channel 58afab93: Group not found
    19:36:40  W1  the published base is at epoch 0 while the group is at 1 - republishing   <- 14 s too late

**AN EXTERNAL JOIN ADVANCES THE GROUP AND LEAVES THE BASE BEHIND IT.** `externalJoin` publishes the
new base with `void this.refreshGroupInfo(joined.groupId)` (`BaseMlsService.ts:2288`) - fire-and-forget,
by the same deliberate choice as the one after `submitCommit` (`:1912`), so a commit that succeeded is
never reported as failed because a follow-up did not land. The check reloads the peer moments later on
a CLEAN state, so that follow-up never lands AND the tree that could mint the base is gone with it. The
joiner has locked itself out, and every stateless joiner after it: the commit gate accepts a base equal
to the active epoch and nothing else, and a distribution group has no peer-Welcome fallback.

**THE REPAIR EXISTS AND IS 14 SECONDS LATE, WHICH IS WHY THE LOSS IS PERMANENT.** `republishStaleBase`
did fire, three times across the run (base 0->1, 6->7, 12->13), from the one holder with a current
tree - but its trigger is that holder's *ordinary read* of the salon, not the epoch change, so it
always lands after the refused peer has already given up. And the peer's giving-up is terminal twice
over: `stale_base` is treated as a fact for the session, and the seed repair on top of it deletes its
`outstanding` entry before the send it then loses (`repair.ts:124-160`), with `asked` never set
(`:303-321`) and all three re-arm paths driven by an arriving answer that cannot come.

**Two standing rules name it.** *Never learn by failing what a fact could have told you* - the repair
hands the ask to a layer certain to refuse it, to discover a group it is not in, eight seconds after
`stale_base` established exactly that. And *a race that heals cleanly is still a defect* - here it
does not heal at all.

**THE WINDOW WAS DELETED, NOT NARROWED - and it cost no Rust at all.** An external commit is applied
to the returned instance at once, unlike a staged add/remove, so the joiner is at `base + 1` the
moment `join_by_external_commit` returns and can export the base its own commit created *before*
merging. That base now travels inside `POST /api/mls/commit`, and chat-delivery writes it with the
epoch advance in ONE transaction: `putGroupInfo(groupId, base, baseEpoch + 1)` inside
`groupRepo.manager.transaction`. There is no follow-up call left to lose, so the reload that used to
take it takes nothing, and the `void this.refreshGroupInfo(...)` that followed an accepted external
join is gone rather than kept alongside. The client refuses to publish at all if its instance is not
at `gi.baseEpoch + 1` (the base is monotonic; one blob under the wrong epoch would strand the group
for good), and abandons the join instead - `build_failed`, whose welcome_request fallback already
exists. Proved by `mls-core/tests/external_join.rs`
(`a_joiner_exports_the_base_its_own_commit_created_before_merging`: a fourth device holding NOTHING
joins on the base the joiner exported, and messages converge), by three server specs in
`messaging.commit-log.spec.ts`, and by two in `BaseMlsService.externalJoin.test.ts` - one of which
asserts that NOTHING follows the submission.

**Narrowing was considered and rejected**: republishing on *applying* a commit rather than on the next
read would cut 14 s to under a second, but a two-member salon whose other member is offline still has
nobody to mint the base, and a shorter race is still a race.

**THE HALF THAT REMAINS, and why it is separate.** An ordinary staged commit (add/remove) cannot
export a base at submit time: its commit is unapplied, so the device is still at the OLD epoch and
`export_group_info` would describe the base the joiner already has. Those paths keep
`void this.refreshGroupInfo(groupId)` after the merge (`BaseMlsService.ts:1912`) and a holder's
`republishStaleBase` as their repair - the same window, one round-trip wide, on a device that stays a
holder and is far less likely to reload mid-flight. Closing it needs the GroupInfo openmls already
builds and all four call sites discard (`mls-core/src/members.rs:85,121,273`, `welcome.rs:86`, each
destructuring `_group_info`); the groups use `use_ratchet_tree_extension(true)`, so it carries the
tree exactly as `export_group_info(.., true)` does. Layers: `mls-core` -> `mls-wasm` (a third slot on
the returned array) -> `BaseMlsService` -> the already-widened `submitCommit`, plus `npm run
generate`. The server side is done and takes it unchanged.

**ONE HYPOTHESIS ALREADY REFUTED, recorded so it is not re-run:** the missing session was
`R3jf6bcWThQ2oUnLKLaKvi--`, the only one of the twelve whose id ends in `-`, which in SQL would open
a comment. It does not: `getGraineHistoryFloors` binds the ids as an array
(`IN (:...sessionIds)`, `channel.service.ts:1318`), so nothing is interpolated. The trailing dashes
are a coincidence of base64url.

**THE RECORD WAS INCONSISTENT ACROSS THREE FILES before this**, which is why the FAIL survived two
sessions unnoticed: the board said `VACUOUS`, [cross-client-campaign](cross-client-campaign.md) said
a believed `PASS-DIRTY`, and `results.ndjson` said `FAIL` twice. All three now say `FAIL`. The
believed pass was real but on an OLDER runner, and its shape differed where it matters: the peer
missed seven sessions there and absorbed all seven.

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (measured 2026-08-26)

**Found by a fix working.** GRP-8's round-2 re-admission Welcome used to be dropped as a redelivery
(closed in `e027679a`), so the re-admission never happened on the joiner and the check passed anyway -
it counts the INVITER's roster. With the Welcome processed, this is the honest consequence. Nine clean
`PASS` rows before `feecfaf5`, `PASS-DIRTY` on it.

**THE SAME FRAME IS JUDGED TWICE AND THE TWO ANSWERS DISAGREE**, fifteen seconds apart, on `feecfaf5`:

    11:09:19  Frame arrived after this device was evicted - ACKed and dropped, no repair is owed
              msg_epoch=3 group_epoch=3
    11:09:34  [WELCOME] held but EVICTED - re-admission, not a redelivery   -> forget_group, epoch 4
    11:09:34  Past-epoch application frame, unreadable for good: msg_epoch=3 group_epoch=4
    11:09:34  [History] frame never read here and unreadable for good; will reconcile
    11:09:34  [HISTORY_RECONCILE] asked ... whether we hold the same history

`history.ts`'s `kind === 'evicted'` branch already carries the whole argument three lines above the one
that fires - *"we are not entitled to the plaintext, so there is nothing for a reconciliation to
recover"*. The defect is that this reasoning is keyed on the CURRENT membership state, so it stops
applying the instant the device is re-admitted, while the frames it protects are still in the stream.
**A column is only evidence for the question it was written to answer**: `evicted` answers "am I out
NOW", not "was I out THEN".

**What it costs:** one reconciliation per re-add over the whole exclusion window rather than one frame,
so it scales with how long the device was out and how busy the group was - against *"doit marcher avec
une conversation de toute les tailles"*. And it puts a repair line in a window where nothing needed
repairing.

**The fix, and the one thing blocking the obvious version.** An ENTITLEMENT FLOOR per group, written
where the Welcome installs - which is now a named branch, `readmittedAfterEviction` in
`setupMessageHandler.ts`. A frame below the floor is then handled exactly like `evicted`: marked seen,
no loss, no reconciliation. **The frame's own epoch is not visible from JS** - Rust has it and prints it
(`msg_epoch=3 group_epoch=4`) but the error reaching `classifyIncomingDecryptError` is
`SecretTreeError(TooDistantInThePast)` with no number, and `getEpoch(groupId)` gives only the current
epoch. So either surface the frame's epoch through the decrypt error - **never learn by failing what a
fact could have told you** - or key the floor on the STREAM POSITION at re-admission, since the replay
already walks rows in order and row ids are timestamps. The second needs no WASM rebuild and no APK.

**A policy question sits behind it and is NOT answered here** - see
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add). Nothing
should be changed on the strength of a reading of it.

**How to confirm it is gone:** GRP-8 goes clean. It is the only check that re-adds a removed member.


### P3 - a `history_bundle` restores the EDITED flag without the edited body

Found by enumerating every applier of a message mutation on 2026-08-22, after three defects in that
seam were fixed (see `CHANGELOG.md` and [chat](frontend/modules/chat.md)). This is the fourth
applier, and unlike the other three it is not broken - it is deliberately narrower than the others in
a way that has a visible consequence nobody has decided about.

`systemMessageHandler.ts`, the `history_bundle` merge over messages a device ALREADY holds: a
deletion in the bundle replaces the body with the tombstone, and an edit in the bundle sets
`isEdited: true` and fills `editedAt` when absent - but never touches `content`. So a device that
missed an `edit_message` frame and later receives a bundle carrying the edited message ends up
showing the PRE-EDIT text with an "edited" marker on it. It cannot diverge two bodies, because it
never writes a body; it can present a body it knows is superseded.

**Why it is not simply a bug to fix.** Taking the bundle's body means trusting a peer's copy of
another member's message content over our own, and the comment on the deletion branch (D5) shows the
narrowness there was reasoned rather than accidental. `editSupersedes` now gives the merge a rule it
did not have when it was written - apply the bundle's body when its `editedAt` is strictly newer -
which would close this without trusting anything undated. That is a trust-model decision, so it is
recorded here rather than taken while a campaign is running.

**What would tell us it matters:** no board row covers it, and reaching it needs a device that missed
an edit AND is later handed a bundle containing it - which is the FWD/HEAL shape, not MUT's.

### P3 - a deleted group leaves every OTHER member a dead row, for ever, clearable only one at a time

Found on 2026-08-24 while clearing the campaign's own debris off W2, and the retention itself is NOT
the finding - it is deliberate and right. `initializeConnection.ts:171` forgets the member's WASM
state, so she can no longer send, and then calls `onGroupDeletedRemotely` so the conversation is
marked `removed` and shown with a banner "instead of removing it silently". `decideAbsentGroupFate`'s
first guard then makes that state unreachable by any later reconciliation, because it records what
its owner was TOLD. Removing a conversation from under someone without telling them would be the
worse behaviour, and the design says so.

**What has no answer is the ACCUMULATION, and the fact that the only exit is per-row.** "Supprimer
localement" acts on the OPEN conversation, so N dead rows cost N navigations and N clicks; there is
no bulk gesture, no "clear the deleted ones", and nothing ages them out - a `removed` row is
permanent by construction. The rig measured the extreme: W2 held **189** of them, from one phase of
one campaign, and clearing them needed a purpose-built sweep (`dismiss.mjs`) driving the button 189
times. A real user's number is not 189, but it is not zero either and it only ever grows: a promo
with a group per project, deleted at the end of each year, accumulates a dozen dead rows that no
gesture can clear together.

**Why it is a product decision rather than a bug to fix.** Any bulk control has to decide what it may
touch, and the only honest allowlist is "conversations already marked `removed`" - which is
exactly the set whose whole purpose is to have been SEEN by its owner first. A control that clears
them wholesale re-introduces, by the owner's own hand, the silent removal the banner exists to
prevent. So the question is a UX one and belongs to the user: is the exit a bulk action, an
age-out for a row whose banner has been seen, or nothing at all.

**What would tell us it matters:** no board row covers it, and no rung would ever notice - every
runner either creates and deletes its own group (so it is the CREATOR, whose copy `deleteGroup`
purges) or leaves the debris behind for the next run to inherit. That asymmetry is why it went
unseen for the whole campaign: W1 measured clean at 9 conversations on the same day W2 held 189.

### P1 - a REVOKED device kept its local store, restored only SOME conversations, and a locally-pending deletion blocked the new conversation with that peer

Reported by the user 2026-08-23, verbatim: *"sur un vieux PC client qui avait toujours une memoire
locale (pourquoi, puisqu'il avait ete des appareils connectes via l'interface ?), le fait de se
reconnecter n'a pas charge toutes les conversations (certaines oui, certaines non). Pire : une
conversation 1v1 avec quelqu'un [qui] avait ete en attente de suppression locale sur cet appareil (le
pair avait supprime la conversation, mais nous elle etait toujours presente localement) a fait
barrage a la reception de la nouvelle conversation avec ce pair (ca faisait doublon j'imagine)."*

Three separate things, in the order they have to be answered:

1. **ANSWERED, AND IT IS WHY THIS ENTRY IS A P1.** The question was what revocation is DEFINED to
   do; the user settled it 2026-08-23, verbatim: *"Effacer ce qu'il detient (il doit devenir un
   appareil comme neuf s'il essaie de se reconnecter, c'est a ca que sert la blacklist non ?)"*.
   Revocation is a WIPE. A revoked device that still holds its local store is therefore a defect,
   not a wording problem.

   **WHICH OF THE TWO IT WAS IS NOW SETTLED, BY READING: THE MECHANISM EXISTS, SO IT DID NOT FIRE.**
   `resetDeviceAsFreshImpl` (`sessionAuth.ts`) is thorough - MLS state, the device id, the sync-guide
   flag, every `device-name:` key, the IndexedDB store cleared AND closed, the session's own handle
   closed, the auth cleared, the device wiped to factory. **What was missing was a path that ASKS.**
   Until 2026-08-26 the only two triggers were `resetRequired` on the PIN check and a
   `device_revoked` control frame, and the first was reached only inside
   `if (!isBiometric && !isVaultLogin)`. So a vault or biometric login never learned at login time
   that it had been revoked, and depended entirely on a frame arriving while it was online - a frame
   sent to a device that was not there to receive it. **Fixed 2026-08-26**: every login path now
   resolves its real device id and asks `/api/mls/devices/:userId/:deviceId/revoked` before `init()`,
   and the one wipe is `wipeRevokedDevice`, shared by all three triggers - which also gave the frame
   path the MLS teardown it was skipping, on the one path where the service is still live. Story in
   `CHANGELOG.md`, rule in [durable-rules](durable-rules.md).

   **TWO CANDIDATE CAUSES SURVIVE that fix and only the user's own history separates them**, so
   neither is worth code before rung 16 measures it: the removed panel row may have been
   SESSION-only, since `handleRemoveRow` calls `deleteDevice` only when `row.device` exists, in which
   case nothing was ever revoked and nothing is broken; or the device was deleted but
   `revokeRowSessions` failed - a state the code already anticipates in as many words - leaving the
   PC a valid refresh cookie, so it never reached a login path at all.

   The rest of that decision is not a fix but three things to VERIFY, and they are rows, not prose:
   a revoked device really does become like-new; its first reconnection resynchronises as a NEW
   device would, history included; and if that first pass does not catch everything up, the later
   connections do, through the heal-on-diff mechanism - which must be shown to TRIGGER, and to
   trigger on the right conditions rather than on any reconnection at all.

   The last of those is the one a green run can most easily fake. A heal that fires on every
   connection would make every check pass while proving nothing, so its conditions are part of the
   assertion, not context around it - the standing rule that a predicate which named the last
   incident is not the predicate that names the next one applies to its trigger directly.
2. **A partial restore is worse than no restore.** Reconnecting brought back some conversations and
   not others, with nothing saying which or why. A restore that silently stops halfway looks
   complete, so the user does not know to retry - it needs to know its own expected count and report
   the shortfall, per the standing rule that a correct mechanism with no report is found by hand a
   day late.
3. **A local tombstone was treated as a live conversation for de-duplication.** The peer had deleted
   the 1v1; locally it sat pending deletion; the NEW conversation with that same peer was then
   dropped, apparently as a duplicate of the record that was on its way out. Whatever key the dedup
   uses must exclude anything pending deletion, or the pending state has to be resolved before the
   new conversation is accepted - a record that exists only to be removed must not be able to refuse
   its own replacement.

**This is HEAL's, by the user's own framing** (*"On y reviendra au moment ou on fera la campagne
HEAL"*). Rung 16 is where it gets armed, and item 1 now carries FOUR rows rather than needing a
definition: the wipe on revocation, the like-new state on reconnection, the first-reconnect resync
with history, and the heal-on-diff trigger with its conditions. Items 2 and 3 are both reproducible
without a second human - a stale profile plus a peer-side delete is exactly what the HEAL runners
already build - so all of it becomes rows on [cross-client-testing](cross-client-testing.md) rather
than hand-checked stories.

**One thing to settle before writing those rows, and it is not obvious which way it goes:** a wipe is
executed BY the device being wiped, so it can only run when that device next comes online - and a
device that never returns is never wiped, whatever the server recorded. So the row proving "it became
like-new" and the row proving "the wipe ran" are not the same row, and neither implies the other. The
blacklist is what makes the first true without the second, which is exactly the reading the user's
own phrasing points at (*"c'est a ca que sert la blacklist non ?"*). The 2026-08-26 fix does not
change that - a wipe still needs the device back - but it narrows "comes online" from "is online at
the moment a frame is sent" to "logs in at all, by any path", which is the difference between a
guarantee and a coincidence.

### P3 - the web has exactly ONE out-of-page unread signal, it needs a permission, and the first message is spent asking for it

Measured 2026-08-24 while writing TAB-1, which is how the row got re-scoped: its stated subject was
"backgrounded tab receives; title/badge updates", and the second half turned out not to exist.

**What the product does.** `useMessaging.svelte.ts:485` posts a web `Notification` for an inbound
message when `document.visibilityState !== 'visible' || !document.hasFocus()`. That is the only thing
a user who has switched to another window can perceive. `document.title` and the favicon are never
touched for an unread message - MSG-8b has measured that four times over and its own recorded
evidence says so plainly (`title` is `'Communautes - Canari'` before, during and after; the favicon
never changes). The only other signal is the in-page badge (`'1 non lus'`), which requires the tab to
be in front to be read - so for a backgrounded user it is not a signal at all.

**Where that leaves a user who has not granted the permission.** `sendSystemNotification` checks
`Notification.permission !== 'granted'`, calls `requestSystemNotificationPermission()` and RETURNS -
so the first message that arrives while the tab is away is not delivered as a signal at all: it is
spent on the prompt. And a user who denied once is in a permanent state where a backgrounded tab has
no unread signal whatsoever, with nothing to fall back on.

**Why the title and the favicon are the right answer if this is fixed.** They need no permission, no
service worker and no user decision, they cost one line each, and they are what every other chat on
the web does. This is not a fallback in the sense the durable rules forbid - there is no primary path
failing silently here; it is a second, unconditional surface for a signal that currently has exactly
one conditional one.

**Not decided, and it is the user's call:** whether the permission-less case is worth serving at all,
given that the Tauri desktop build has its own notification path and the phone has FCM. The web tab
is the case with no floor under it.

TAB-1 (`tab1.mjs`) now asserts the mechanism that DOES exist - exactly one notification while hidden,
none while in front, the tag naming the conversation - so this entry is about the gap the row cannot
assert, not about a defect in what it covers.

### P2 - an offline deletion is remembered and never replayed, and DEL-10 fails on its own fix (measured 2026-08-26)

**The memory half works; the trigger half does not.** DEL-10 was `FAIL` on `c6eb7b20` because the
deletion was LOST - attempted once with the link cut, the local state purged anyway, and the group
handed back by `discoverMissingGroups`. `pendingGroupExits` fixed that half. On `2a4297cb` the row is
`FAIL` again, and what broke has moved:

| field | value | reading |
| --- | --- | --- |
| `sentWhileOffline` | 1 | the DELETE was attempted |
| `listedOnDeleter` | true | the group was NOT purged locally - the durable row did its job |
| `sentOnFirstReconnect` | 0 | **nothing replayed it** |
| `sentOnSecondReconnect` | 0 | nor the second time |
| `onServerAfter` | `live` | the deletion never happened |

So the decision is written down and kept, exactly as designed, and then no one comes back for it.
`drainPendingGroupExits` has two triggers - `ConnectivityStore.onReconnect`, and one pass at chat start
for the app killed while offline - and the check reconnects the link WITHOUT a reload, so only the
first applies. Either it does not fire for a link cut through CDP, or it fires and the drain finds no
row.

**BOTH HALVES OF THAT ARE NOW INSTRUMENTED (2026-08-27), and it took a product change as well as a
runner one.** The runner half was the easy half: `del10` snapshots `consoleLines(w1)` around each
reconnect and records `firstReconnectSaid` / `secondReconnectSaid`, so the entry now carries whether
the trigger announced itself (`ConnectivityStore` logs before it emits, so that line IS the listener
running) and whether the drain announced a replay. The product half is the one worth reading: the
drain returned a bare `[]` for `!storage` and for re-entrancy, and an empty array is precisely what a
trigger that never fired returns too - so two of the four ways to replay nothing were unnameable from
outside. They accuse now. `owed.length === 0` deliberately stays silent, because THAT one is routine:
it runs on every reconnect of every session that owes nothing, and a line there is the noise that
teaches a reader to skip `[EXIT]` and then to skip the one that matters. **The re-run is owed and
will name the cause rather than the symptom.**

**Do not read this as the old defect returning.** The two failures share a row id and nothing else: one
lost the decision, this one keeps it and never acts on it. The fix for the first is what makes the
second visible at all.

## Mentions

### P2 - a mention notification shows a 64-character hex id where the name should be

Found by the user on the phone, 2026-08-22, while the MENTION rung was running.

The wire format of a mention is `@[<64 lowercase hex>]` (`utils/mentions.ts`), and the WEB resolves
it at render time - `mentions.parse.ts:44` replaces `@[id]` with `@DisplayName` for bodies, previews
and reply quotes. **The Android notification does not.** `CanariFirebaseMessagingService` READS the
token (line 1332, `decrypted?.text?.contains("@[$myUserId]")`) to decide whether this is a mention of
me, and then passes the decrypted text to the notification builder unchanged. Both paths are
affected: the MLS/DM one and `handleChannelMessage`.

So the notification reads `Salut @[d82cd226…64 hex…] tu peux regarder ?`.

**It is worse than cosmetic.** `canari_mentions` is `IMPORTANCE_HIGH` and asks to bypass DND
(`CanariApplication.kt:223`): the one notification designed to interrupt someone is the one that
cannot be read. And the check that covers the path does not see it - MENTION-2 asserts that the
notification carries the marker, which is true of a body full of hex.

**THE NAME CANNOT COME FROM THE SERVER'S PUSH PAYLOAD, and that is the whole difficulty.** The
mentioned ids already ride in cleartext for routing (the documented leak, MENTION-6), but a display
NAME is not an opaque id: putting it in the payload sends real names of real students through FCM and
APNs on every mention. This codebase already refused that trade once - the reaction push used to
carry 80 characters of decrypted message text, composed server-side, and was cut back to an id, an
emoji and who reacted, for exactly this reason.

**So the resolution belongs on the device, and it has the shape to do it.** `fetchAvatar(userId)`
already resolves a stranger's avatar from `GET /api/mls/push/avatar/:targetUserId`, authenticated by
`requesterId` + `deviceId` + the Keystore push secret, behind a 24 h file cache. A display name wants
the same three things:

- a sibling endpoint on `push.controller.ts` (there is none today - the routes are listed at
  `mls/push/{register,fetch-proto,avatar,media,refresh-token,…}`), returning `resolveUserDisplayName`
  from `utils/display-name.ts`;
- `fetchDisplayName(userId)` in the service, mirroring `fetchAvatar`'s cache-then-HTTP shape;
- a substitution pass over the body before the notification is built.

**The degrade must be decided, not defaulted.** A cache miss with no network - the exact case a
notification arrives in - must not print hex. Replacing the token with a generic word loses who was
mentioned; keeping the id keeps it unreadable. Not decided here.

**iOS is presumed to have the same gap and cannot be checked** - no iPhone in the estate
(`device-verification.md`). `push-payload.ts` builds the APNs half from the same fields.

**Cost, stated because it is why this is not a drive-by fix:** it crosses the server (a new
authenticated route, deployed) and the native app (Kotlin, plus an APK rebuild and install), and the
rebuild re-bases A1's build for every phase of the ladder that follows it.

## The harness itself

### P3 - an internet scanner can stop a `--repeat`, and separate invocations are the way round it (2026-08-26)

`GRP --repeat 5` stopped at pass 1 with `frontend-ssr NOT CLEAN ... unexplained=3`, the three lines being
`[404] HEAD /WP`, `[404] HEAD /old`, `[404] HEAD /Old` - a scanner sweeping a public host for WordPress
and a leftover backup directory.

**`srvlog.mjs` is not wrong to leave them there.** Its 404 rules are keyed on a stack prefix the
application provably cannot own (`/wp-*`, `/administrator/`, `/_next/`), and its own comments state twice
why a blanket `[404]` rule may never exist: it would forgive a route we DO own answering 404. `/WP` misses
the existing rule on case and on the absent hyphen, and `/old` is a shape a SvelteKit app could own, so
forgiving it would break the file's criterion rather than extend it.

**So the finding is not the three lines - it is that campaign throughput depends on what the internet
does to prod during a window.** Prod IS the test server, so this recurs with every new scanner spelling,
each time costing the remaining passes of a `--repeat`.

**The route round it, used the same day, needing no change to any gate:** the stop is BETWEEN passes, not
inside one - all ten checks of pass 1 ran and recorded their verdicts. Five separate `run.mjs GRP`
invocations therefore give five measured passes where `--repeat 5` gives one, with nothing disarmed. It
costs one preflight per pass.

**The real fix, when it is worth the time,** is to stop enumerating spellings and read the fact instead:
the set of paths the application owns is knowable without a build, from `frontend/src/routes/**` and
`frontend/static/**`. A 404 on a path IN that set is a defect; a 404 outside it provably cannot be ours.
That satisfies the file's own criterion better than any regex and closes the class instead of the
instance - the difference [testing-methodology](testing-methodology.md) rule 42 is about.


### P2 - a LIVE socket dies in the middle of GRP-3, and no navigation explains it (measured 2026-08-25)

**Accepted as a `PASS-DIRTY` by the user's decision of 2026-08-25** - *"on peut se contenter des pass
dirty et passer a la suite"* - so this is recorded rather than blocking rung 8. The frontier drawn with
that decision is what makes it recordable: dirt whose CLASS has been read and named may pass, dirt that
is unclassified or that touches an assertion may not. This one is a known SHAPE with an UNKNOWN cause,
which is the reason it is a P2 and not a note.

**The measurement.** `GRP --repeat 5`, pass 1, 2026-08-25. Ten rows, nine `PASS`, and GRP-3
`PASS-DIRTY` on exactly one line:

    dirt_W1: wsEvents: ["11:28:30.944 Network.webSocketClosed {requestId 20644.93706}"]

Every product assertion held - `rosterBeforeRemoval: 2`, `rosterAfterRemoval: 1`,
`peerStillHoldsPreRemovalMessage: true`, `peerReceivedPostRemovalMessage: false`,
`removedDeviceLearntFromTheCommit: true`, `removedDeviceAskedToComeBack: []`. The row was recorded at
11:28:42, so the close landed ~12 s before the end of the check: inside the 30 s negative window,
roughly 18 s AFTER `removeMember` and after the post-removal send. It is on W1, the client that did
the removing, not W2, the one removed.

**WHY THE KNOWN EXPLANATION DOES NOT APPLY, which is the whole finding.** Rule 14 of
[testing-methodology](testing-methodology.md) established that every `goto` is a `Page.navigate`, that
a document replacement closes its own socket, and that `1006` follows - so `ignoringNavigation`
forgives at most `documentsReplaced` closes. This close was NOT forgiven, and GRP-3 gives it nowhere
to come from: every `openGroup` in it passes `navigate: false`, and `ensureChat` does not reload - it
clicks `text=Discussions`, a client-side SvelteKit route change, which fires
`Page.navigatedWithinDocument` and replaces no document. So `documentsReplaced` is 0, the forgiveness
budget is 0, and this is a live socket dying. `wsidle.mjs` already ruled out the other cheap reading:
W1 and W2 left untouched for eight minutes produced **zero** closes, so nothing on the path drops an
idle connection and the event is caused by something the check does.

**What is NOT known, and must not be guessed.** No console line accompanied it - READ's instance of
this shape came with `[WS] Disconnected. Code: 1006` beside it and this one came with nothing, though
that may only mean the app's own line is classified BENIGN and therefore absent from the dirt
projection rather than absent from the log. Whether the socket reopened is also unmeasured HERE:
`watch.mjs:1121` collects `Network.webSocketFrameError` and `Network.webSocketClosed` and **not**
`Network.webSocketCreated`, so a reconnection could never have appeared in this row. Reading its
absence as a failure to reconnect would be exactly the inference rule 39 warns about.

**The rate.** One in two recent runs: clean on the attempt of 2026-08-25 that stopped on the server
window, dirty on the next. GRP-3's `PASS-DIRTY` of 2026-08-24 is a DIFFERENT cause and must not be
counted here - it was an `[OUTBOX] ... evicted from ...` line from a browser left on a stale bundle,
which is what `8c248131` closed.

**How to settle it, in order, and none of it needs a new tool.** `ws1.mjs` already prints one
interleaved timeline of every `Network.webSocket*` event and every console line on one clock, written
for precisely this question on READ. Point it at GRP-3's sequence rather than READ-1's; add
`Network.webSocketCreated` to the collector at `watch.mjs:1121` first, since the reconnection is half
the answer and is currently invisible by construction. Then the discriminator is cheap: if the close
sits at a fixed offset from `removeMember` it belongs to the Remove commit path, and if it sits at a
fixed offset from the socket's own age it is a lifetime, which `wsidle.mjs` did not test because it
watched a socket for eight minutes rather than an old one.

### P2 - ONE NAMED STARTING POINT, reachable at every granularity (asked 2026-08-25)

**The user's requirement, verbatim:** *"Le preflight doit permettre d'executer chaque phase, voire meme
chaque etape de phase ou groupe d'etape en ayant le meme point de depart, independamment de ce qui a pu
se passer avant"*, and before it *"tu peux recharger la page au debut de la phase au moment de l'etape
d'initilisation, ce serait beaucoup plus simple"* and *"Si le modal de pin s'affiche, tape le pin, s'il
ne s'affiche pas, ne le tape pas, si on est sur la mauvaise page, on peut recharger la page"*. It is
their standing directive - deterministic, reproducible, explicable - applied to initialisation.

**What is true today, measured 2026-08-25 rather than assumed.** `client()` opens a CDP connection and
guarantees NOTHING about the application: not the route, not the lock, not whether a modal is up. Of
23 sampled runners, **8 assert something at their start** (`ensureChat` or `goto`) and **15 assert
nothing at all** - `msg2`, `msg3`, `msg5`, `msg67`, `msg8`, `msg9`, `msg10`, `type`, `del1`, `comm2`,
`comm14`, `tab1` among them. They inherit whatever the previous script left, which is exactly what
`client()`'s own comment admits: *"Seventeen call sites pass no match at all and were relying on the
browser having one page - true after the preflight, and silently false the moment anything leaves a tab
behind."* The preflight does the work ONCE per run, so the guarantee decays with every script after it.

**The contract to write.** One exported entry point, idempotent, with an ASSERTED postcondition rather
than a described one:

- **The target state is named, not implied**: on `/chat`, unlocked, no overlay, chat mounted, on the
  deployed bundle. The same five facts `state.mjs` already reads.
- **It is cheap when already satisfied** - read the state first, act only on what diverges. That is
  what makes it affordable to call between step GROUPS inside a phase, which is the granularity asked
  for; a call that always paid a reload would be too expensive to put there.
- **The PIN is typed only if the gate is really up** (the user's wording exactly). Detected
  structurally: `#encryption-pin`, or a button whose text is the `U+232B` backspace glyph. Never by
  searching the page text - see the predicate entry below, which is what made a false lock permanent.
- **A wrong route is repaired by RELOADING, for a web client.** Not because a reload is a fallback -
  it is a REPAIR, logged loudly, and CLAUDE.md's rule stands: a fallback is a signal, never a path.
  Reaching it means the previous check left the client somewhere, and the log is what makes that
  visible.
- **A1 is excluded from the reload, by construction.** `goto` on the phone re-locks the PIN and breaks
  Tauri's IPC callbacks into the old document; `chat.mjs` throws rather than let a caller do it by
  accident. The phone keeps the repair path.
- **It says what it erased, before erasing it.** The existing repairs are loud on purpose - *"the day
  it is something else, the line is the only warning"* - and a check that leaves a modal up is a defect
  in that check. Silent tidying would delete the only evidence of it.
- **Then every runner calls it**, and `run.mjs`'s preflight becomes that same contract applied per
  device plus the run-wide checks (identity, bundle, server window). One definition, not two.

**Why it is worth the conversion cost.** [testing-methodology](testing-methodology.md) 33 says changing
what a check READS invalidates its green rows, and that is the argument that has deferred other
wholesale conversions. It does not bite here in the same way: the contract does not change what any
assertion measures, it makes the state BEFORE the assertion known. What it removes is a class of
failure the campaign has already paid for repeatedly - a check measuring behind a modal, on the wrong
route, or behind a PIN gate - each of which produced a refusal or a hang, never a false PASS. The rows
stay; the flakiness they cost goes.

### P2 - `purge-devices.mjs` is a destructive control keyed on a string the product never renders

**Found 2026-08-25, and found by being unable to run it rather than by it doing damage.** W1's account
had accumulated two dead web devices (two Firefox logins from 2026-08-22, neither the running client),
and they were a material confound rather than clutter: W1 CREATES every group the GRP phase makes, so
the creator's own devices are fanned into each one and a device that will never process its Welcome
sits in every roster the phase measures ([durable-rules](durable-rules.md), on a revoked device keeping
its store). The user deleted both by hand the same day, which is why nothing is blocked - the tool that
was supposed to do it is what remains open.

**Three predicates in it are stale, and the third is the dangerous one.**

1. The panel-settled wait tests `/APPAREIL(S) CONNECT/i`. The product renders
   `4 APPAREIL(S) ENREGISTRE(S)` - `chat_devices_count_label` is `"{devices} appareil(s) enregistre(s)"`.
   So the wait times out after 45 s on a panel that has been fully loaded the whole time, which is how
   this was found at all.
2. `READ_PANEL` and `TAG_TARGET` identify a row by walking up to `/Appareil\s*\d/`. **That string is
   absent from the render.** Every row therefore reads as the empty string.
3. Because every row is `''`, `--keep` matches nothing and the tool falls through to clicking the
   first deletable button in DOM order. On the fleet as it stood that is a Firefox row, but nothing in
   the tool makes that true - `--keep 'Tauri'` does not match either, because the phone's row shows
   `tauri-d8` lowercase and `Android`/`ANDROID`, never the `"Desktop (Tauri)"` label
   (`DeviceManagementPanel.svelte`) that only the detail view uses. One reorder and it deletes A1,
   which costs a re-enrolment plus SETUP-4's 2FA - the one step no tool here can answer.

`shortDeviceId` is `deviceId.slice(0, 8)`, so every web device of one user renders the same short id.
**The id cannot discriminate between them**; the only per-row text that does is `Derniere activite` and
the `Connecte le <date>` line.

**The repair, which is a rewrite of what it is allowed to touch, not a selector fix:**

- **An allowlist, `--only`, never `--keep`** ([durable-rules](durable-rules.md): a destructive control
  needs an allowlist of what it may touch). Nothing is deleted unless it was named.
- **`--expect N`, and a refusal if the panel does not hold exactly N rows.** A fleet that changed
  shape since the caller looked at it is a reason to stop, not to proceed on ordinal position.
- **Row identity from `Connecte le <date>` bounded to ONE occurrence**
  ([testing-methodology](testing-methodology.md) 24), because that is the only rendered string that
  separates two web logins of the same account.
- **The load-error state reported, not waited on.** `chat_devices_load_error` ("Impossible de charger
  les appareils lies a votre compte.") is currently not accepted by the wait, so a failed load spends
  45 s and then reports a timeout - the same confusion between "the question could not be asked" and
  "the answer is no" that [testing-methodology](testing-methodology.md) 38 is about.

**Until that lands the tool must not be run**, and a device that has to go is a click the user offered
to make (*"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein"*,
2026-08-25).

### P3 - a build names itself by a clock, and the commit is inferred from it

`/_app/version.json` carries `Date.now()` at build time and nothing else, so `resolveStamp` derives
the commit by asking git for the newest one at or before that instant. Rule 35 fixed the half that
was outright wrong - a locally built bundle was being dated against `origin/main`, a ref that does
not contain it until somebody pushes - but the derivation itself remains an inference, and it moves
if a commit ever lands carrying an earlier date than the build that preceded it (a pull of somebody
else's work, a rebase).

**The fix is the bundle carrying its own commit**: SvelteKit takes `kit.version.name` in
`svelte.config.js` and writes it verbatim into `version.json`. Setting it to `<builtAtMs>-<sha>`
keeps the timestamp the `updated` store needs to distinguish two builds of the SAME commit, and adds
the identity the harness currently guesses. `resolveStamp` then parses instead of querying git, and
the `ref` argument disappears with it.

Two constraints, both established 2026-08-22 rather than assumed:

- **The Docker image does not build the frontend.** `infrastructure/local/Dockerfile.frontend` copies
  `frontend/build/client` from an artifact the CI `build-frontend` job produced, so git availability
  is a question about the CI job and the local Tauri build, not about the image. Both have a
  checkout.
- **It changes the deployment's version identity**, which is why it was not done during the campaign:
  prod IS the test server, and a `svelte.config.js` that throws when git is absent breaks every
  build including CD. Verify the CI job's checkout depth before relying on `git rev-parse`.

### P3 - six runners carry a dead import, and fixing them now would retire green rows

`oxlint tools/cross-client-harness/` reports eight warnings across `newgroup.mjs`, `msg9.mjs`,
`ckpt.mjs`, `type.mjs`, `tabguard-selftest.mjs` and `ws1.mjs` - unused imports and one useless
spread, nothing that changes what any of them measures.

**Deliberately not fixed during the campaign.** `msg9.mjs` and `type.mjs` back MSG and TYPE, both
green on the board, and `checkSha` hashes the runner's source: touching either supersedes its rows
(`rows.mjs`), so the ledger would demand a re-run of two finished phases to pay for a dead import.
Rule 33 is what makes that automatic, and it is right to be - the ledger cannot know the edit was
cosmetic, and a human waving it through is exactly the judgement the rule exists to remove.

Sweep all eight in ONE commit once the ladder is finished, when a re-run costs nothing. Note the
harness is NOT oxfmt-formatted (`oxfmt --check` fails on files nobody has touched), so the sweep is
`oxlint` only - running the formatter would rewrite the whole directory.

### P3 - the bubble-action and observation helpers live in one runner, and every other runner re-invents them

`mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED - its own header calls this "a pattern the rest of
the harness could adopt". `search.mjs` did not adopt it and hand-rolled a confirm click that pressed
the wrong button for as long as the check has existed (2026-08-22, see `CHANGELOG.md`). The same
split exists for observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's
`finish()` attaches it to every non-PASS verdict, and no other phase does - which is exactly the
evidence rung 5's one SEARCH-2 miss needed and did not have.

**Why it is not done yet, and this is the whole reason it is written down.** The shared home is
`chat.mjs`, and every phase consults `chat.mjs`. Moving a helper there invalidates MSG, TYPE, READ and
MUT under [testing-methodology](testing-methodology.md) 33 - "a board row whose phase was touched
anywhere gets re-run rather than reasoned about" - which is hours of ladder time to buy a refactor
nothing is currently failing for. So it waits for a moment when the rig can be changed wholesale and
the affected phases re-run together, rather than being slipped in mid-ladder where it would silently
cost four phases their verdicts.

### P3 - eight runners open IndexedDB by hand, and `idb.mjs` exists

`idb.mjs` (2026-08-24) is the one reader that ITERATES the databases a profile holds, filters
`CanariDB_` while excluding `CanariDBMls*`, and never decrypts. It was written because `recon.mjs`
takes the FIRST database it finds, which on a two-account Chrome profile is a coin toss, and because
reaching into `CanariDBMls*` by prefix returns an empty result that reads exactly like "nothing
queued". Counted 2026-08-24, `indexedDB.databases` appears in nine files and one of them is `idb.mjs`: EIGHT
call sites still carry their own copy of the preamble (`del1`, `dismiss`, `grainestore`, `grp`,
`identity`, `mlsdb`, `mut`, `recon`), and `del.mjs` is the only phase reading through the module.

**Why the copies are deliberately still there.** Converting a caller changes what that caller READS,
and every one of them belongs to a phase already green on the board - so the conversion invalidates
those rows under [testing-methodology](testing-methodology.md) 33, exactly as the
bubble-helper entry above does. The duplication costs nothing while it is identical; it costs a phase
the day one copy is fixed and ten are not, which is the shape `recon.mjs`'s first-database bug already
had. So this waits for the same wholesale moment: convert all eight, re-run the phases together.

## Search

### P3 - `ChatArea.svelte` swallows three branches and has no logger at all

Found on 2026-08-22 while verifying the SEARCH-2 gap description against source, before rung 5 ran.
The component is 1206 lines, carries the whole in-conversation search UI, and contains **no logging
of any kind** - no `Log.d`, no `appendLog`, nothing. It also has three branches that discard a
failure silently:

- `refreshSearchMatches`, `catch { ids = null; }` - the full-history search failing is indistinguishable
  from a channel having no local persistence, and both land on the same `searchLimitedToLoaded = isChannel`.
  This is the branch SEARCH-2 exercises.
- `onRequestOlderFromPeers().catch(() => 'unavailable')` - a peer scrollback request failing is
  reported to the UI as "unavailable" and to nobody else.

A third, `searchableText`'s `catch { return message.content; }`, is listed here only to be dismissed:
`parseEnvelope` throwing is the ordinary case for a plain-text message, so logging it would be noise
on every search over normal history. It is named so the next reader does not re-open it.

The standing rule is that every swallowed branch logs, because in a best-effort path that is all a
loss leaves. None of these do, so a user reporting "search found nothing" leaves no trace anywhere
that says whether the query ran, threw, or ran against a truncated corpus.

**Deliberately not fixed before the phase ran.** SEARCH-2 drives the first of these branches, and a
check is worth more against the code as it shipped than against code changed the hour before to make
it look better. The fix is also not one line: it needs a logger introduced into a component that has
none, which is a change worth making once and reviewing, not slipped in mid-campaign.

**Related, and NOT the same item:** in-conversation search folds case but not diacritics, in all
three places that match (`useConversations.svelte.ts:438,480` for which messages match,
`messageDisplay.ts:218 splitWithHighlight` for the highlight, `ChatArea.svelte:622` for the query).
On a French corpus "reunion" cannot find "reunion" spelled with an accent. SEARCH-5 predicts exactly
this and PASSES when it holds, so it is a FINDING the board records rather than a check failure - see
the SEARCH section of [cross-client-testing](cross-client-testing.md).

### P2 - the posts search escapes the feed's filters, and scans the whole base before it answers anything

Reported by the user 2026-08-23, verbatim: *"La recherche dans les posts permet d'acceder a des posts
apres notre arrivee a l'EMSE (la recherche desactive les filtres ?)"*. Three distinct things, and
they are not the same severity.

1. **The filters appear not to apply to the search.** The feed is scoped, the search is not, so the
   search surfaces posts the scoped feed would never show. **The first task is to establish what that
   scope IS**, because it decides everything: a scope that is a VISIBILITY rule makes this a P1
   (search reads what the reader may not read), a scope that is only a convenience narrowing makes it
   a P2 surprise. Do not write code before that question has an answer - `## Open questions` is where
   an unanswered one belongs, and this entry moves there rather than growing a fix if the answer is
   not immediate.
2. **The order is backwards: filter, THEN search.** Filtering downstream means the search spends its
   whole cost on rows that were never going to be displayed. Correctness aside, it is the same work
   done against a corpus several times larger than the reachable one.
3. **It loads everything before it answers.** A post from this week should not wait on a scan of the
   entire base. The search should walk backwards in time and stream what it finds, so a recent hit is
   returned early and the long tail keeps arriving - the standing requirement is that the mechanism
   works for a corpus of ANY size, and a single up-front load is the shape that cannot.

Related but NOT the same item: in-conversation (chat) search is the entry above; this one is the
social feed. MiGallery's `fuzzyScore`/`fuzzySearch` is the reference implementation the standing
search requirement points at.

## Composer and reactions

### P2 - the emoji picker cannot be scrolled, and often opens outside the screen

Reported by the user 2026-08-23. Two defects and two questions, and they are listed apart because
only the first two are known to be wrong.

- **The list does not scroll.** Whatever does not fit in the panel is unreachable, so the picker
  offers exactly one screenful of the set it claims to offer.
- **The panel frequently renders partly off-screen.** So this is not only a scroll bug: the placement
  has no viewport clamping, and near an edge the picker loses rows in a second, independent way.
- **ANSWERED 2026-08-23, NO: the glyph set is the platform's.**
  `frontend/src/lib/components/messages/MessageEmojiPicker.svelte` mounts `emoji-picker-element`,
  which renders native codepoints in the system font - there is no bundled sprite sheet. Only the
  DATA is self-hosted (`data-source="/emoji-data-fr.json"`, and that exists so French search keywords
  work: `locale="fr"` alone translates the UI and not the keywords). So one codepoint, N pictures -
  Windows, Android and iOS each draw their own, and the library even ships an
  `emojiUnsupportedMessage` for a client with no colour emoji at all. **The product decision this
  bullet said was owed was TAKEN on 2026-08-23: we bundle one set - see the entry below, which is
  one work package with this one.**
- **ANSWERED 2026-08-23, YES: recents exist** - `canari_recent_emojis` in `localStorage`, most-recent
  first, capped at 12, rendered as a row above the picker. Two limits worth knowing before anyone
  "adds" the feature: it is PER DEVICE and never synced, and it is fed only by
  `handleEmojiClick`, so a reaction added by any path that does not go through this picker never
  reaches the list.

**The likely cause of BOTH defects is one line, and it is the same line.** The panel is
`flex flex-col overflow-hidden` with a `max-height` written by `bindFixedPopover`
(`frontend/src/lib/actions/fixedPopover.ts`), and the `<emoji-picker>` inside it already carries
`min-h-0 flex-1` - which is exactly the arrangement that sizes correctly on its own. It is then
overridden by an inline
`style="height: min(22rem, calc(var(--popover-max-h) - {recents ? '5.5rem' : '3rem'}))"`. That
subtraction is a HARD-CODED GUESS at the height of everything above the picker, and the recents row
is `flex-wrap` with up to twelve 32 px buttons plus a label inside a `min(92vw,22rem)` panel - so it
wraps to two lines well before twelve, and the guess is then short by a whole line. The picker is
sized taller than the room actually left, the parent is `overflow-hidden`, and the bottom of the list
- with its scroll affordance - is clipped away. **The fix is to delete the inline height, not to
correct the constant**: the flex layout already knows the answer, and a second hard-coded number
would be wrong again the next time the header gains a line (the reactions-at-limit banner is exactly
such a line, and it is not in the guess either).

A second, narrower placement fault is in `computeFixedPopoverPosition`: `maxHeight` is floored at
`Math.max(160, ...)` after the side has been chosen, so on a short viewport the panel can be given
160 px in a gap smaller than 160 px and hang off the bottom. The floor should not be able to exceed
the space that was measured.

Both defects are visible without any instrument, so this needs no campaign row to be believed - but
the picker sits on the reaction path that DEL, MUT and MSG all drive, so fixing it mid-ladder changes
code under checks that have already run. Schedule it after the ladder unless the user says otherwise.

### P2 - the app draws emoji with the platform's font, and must draw ONE bundled font everywhere (decided 2026-08-23)

**Decided by the user on 2026-08-23, and the weight is explicitly NOT a factor** (their words: the
size does not enter the decision). Canari bundles **Noto Color Emoji** and draws every emoji with it,
in the whole app and the whole site, on every platform. This is the product choice the third bullet of
the picker entry above said was owed.

**It is ONE work package with the picker fixes, not two** - the user's framing, and it is structurally
right: the picker is where the set is OFFERED and the app is where it is DRAWN, so offering what the
font cannot draw, or drawing what the picker never offers, is a single defect seen from two ends. The
picker's scroll and placement faults are described in the entry above and are not restated here.

Microsoft's Fluent Emoji was examined first, on 2026-08-23, and **rejected on coverage, not licence**.
It is MIT (copyright Microsoft Corporation, no trademark clause in the repository), so it would have
been legally clean. Measured on its git tree: 1 595 base emoji, 3 145 variants, **zero country flags**
(the only "flag" assets are Black, White, Chequered, Triangular, Crossed, Pirate, Rainbow,
Transgender and Flag-in-hole), **no family / couple / people-holding-hands ZWJ sequences** at all, and
frozen at Unicode 15.1 (its Emoji 15.1 merge is from 2024-10-02, its last commit 2025-01-30). It also
ships no font whatsoever - 12 625 files: 3D PNG 109.7 MB, Color SVG 131.9 MB, Flat SVG 17.2 MB, High
Contrast 6.4 MB. A set with no flags cannot be THE set for a French student association.

#### Why Noto, in numbers

`googlefonts/noto-emoji`, OFL 1.1, last push 2025-09-15. Measured on its git tree 2026-08-23:

- `svg/` holds **3 732 glyph sources**, of which **2 291 are multi-codepoint sequences** (ZWJ
  families, couples, professions, skin tones). Country flags live in `third_party/region-flags`, and
  the prebuilt fonts prove they are shipped: `Noto-COLRv1.ttf` 4.7 MB **with** flags against
  `Noto-COLRv1-noflags.ttf` 2.8 MB, plus a `NotoColorEmoji-flagsonly.ttf` of 0.8 MB.
- **It is level with the picker's own dataset.** Probed by codepoint: every Emoji 16 addition
  (fingerprint, leafless tree, root vegetable, splatter, harp, shovel) and every Emoji 17 sample
  taken (distorted face, orca, trombone, treasure chest) is present. That is what makes "the picker
  offers exactly what the app can draw" an achievable requirement rather than an aspiration.
- **Licence.** OFL 1.1 permits embedding in the APK/AAB/IPA/AppImage and permits modification
  (subsetting, rebuilding). The header declares `Copyright 2013 Google LLC` with **no Reserved Font
  Name**, so a rebuild does not force a rename. Two real obligations: the OFL text travels with the
  binary, and the font is never sold on its own. One notch more verbose than MIT, no practical effect
  here, and compatible with a public repository.

#### The format is the whole difficulty, and it has a solution

No single colour-font table covers both engine families, and Canari ships on both:

| Table | Chromium: WebView2 (Windows), Android WebView, Chrome/Edge | WebKit: WKWebView (iOS, macOS), Safari | Firefox |
| --- | --- | --- | --- |
| **COLRv1** | yes, 98+ | **no** - not implemented, and marked not in active development (WebKit standards-positions 415) | yes, 107+ |
| **OT-SVG** (`SVG` table) | **no**, ever | yes - Safari 12.1+, iOS Safari 12.2+ | yes, 31+ |

The two are exactly complementary, and **they fit in one file**. `maximum_color`, from
`googlefonts/nanoemoji` (Google's own tool, the one that builds Noto), adds the `SVG` table to a COLR
font and the reverse; its stated intent is "a font that will Just Work in any modern browser". Each
engine reads the table it understands, from a single `.woff2`. Where a two-file split is preferred
instead, the selector is `src: url(...) tech(color-COLRv1), url(...) tech(color-svg)`, with
`@supports font-tech()` available since Safari 17 for the awkward case.

Three things that must not be got wrong:

- **Do not pass `--bitmaps`.** Chrome and anything on Skia *prefers* CBDT to COLR when both tables are
  present (nanoemoji says so, over Skia 12945 and FreeType 1142), and CBDT is the 10.1 MB build.
  Weight is not a factor by the user's decision, but rendering the WRONG table is a defect.
- **nanoemoji describes itself as "under active development, doubtless full of bugs".** So it is not a
  CI dependency: build ONCE, commit the produced `.woff2`, and record the exact command plus the
  expected hash so the artefact is reproducible without the toolchain being installed anywhere. This
  is the opposite disposition to `frontend/src/lib/wasm/`, which is generated and not committed
  precisely because every pipeline can build it; nothing in CI can build this one.
- **Serve it from our own origin**, never Google Fonts: a third-party font host leaks the IP of every
  member and cannot work offline in the Tauri apps.

**WebKitGTK (the AppImage) is the one target that may read neither table** - it goes through
FreeType/Skia and WebKit bug 191976 ("[FreeType] Color emoji not properly supported") is still open.
It is also the only target where the failure is free: the system emoji font on Linux **is** Noto
Color Emoji, so the fallback draws the same pictures. Verify it once on a real AppImage; do not design
around it.

**And note what this is, under the standing rule that a fallback is a signal and never a path**: a
font stack IS a fallback chain, so "it looks right" is not a verdict. The question is always *which
family resolved*, and that is measurable - see the campaign rows below.

#### What has to change in the app

- **The two global stacks are the whole of it, and neither has an emoji fallback today**, which is why
  100 % of emoji are currently the platform's: `frontend/src/app.css:134` (`body`) and
  `frontend/src/app.css:144` (`h1`-`h6`, `.font-brand`). Append the bundled family to both.
- **The picker uses the same family or the app disagrees with itself.** `emoji-picker-element` 1.29.1
  exposes `--emoji-font-family` on the element; that is the entire change on that side.
- **Every stack that is re-declared for an EXPORT is a place the screen and the artefact can
  disagree**, and each one must be handled explicitly: `PosterCanvas.svelte` (4 inline stacks),
  `calendarExport.ts`, `trombinoscope.ts`, `avatar.ts` (an SVG data-URI stack), and
  `MentionComposerInput.svelte:399` (monospace).
- **A PDF is not a browser.** `frontend/src/lib/pdf/appFonts.ts` maps a computed stack plus a weight
  onto an embedded jsPDF font, so an emoji in an exported PDF is a separate question this WP owes an
  answer to (embed, or rasterise). The CSS change does not cover it.
- `font-display: swap` plus a preload, and the font shipped as a bundled app asset so the mobile
  builds have it at first paint with no network. An invisible emoji while a font loads is worse than a
  platform emoji.

#### The picker must offer exactly what the font can draw

- **What it offers today**: `frontend/static/emoji-data-fr.json`, 540 KB, emojibase FR, **1 923 base
  entries / 3 953 including skins**, groups 0-9 all populated (270 flags, the France flag present,
  249 ZWJ entries), with `version` values up to **Emoji 17**.
- So the offered set and Noto are level, and the WP owes a **build-time diff that proves it**: every
  codepoint and every sequence in the dataset must resolve to a glyph in the shipped font (`cmap`
  plus the `GSUB` ligatures that make a flag or a ZWJ family one glyph). It belongs in the build
  recipe, not in a one-off notebook. A miss is then either a font to rebuild or an entry to drop -
  either way a known fact, not a surprise on a member's screen.
- **DEFECT FOUND WHILE SCOPING THIS, and it is the "offers everything" half.**
  `MessageEmojiPicker.svelte:256` reads
  `data-source={getLocale() === 'en' ? undefined : '/emoji-data-fr.json'}`, and `undefined` means the
  element's default, which is
  `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json`
  (`picker.js:1649`). So on the English locale the app fetches its emoji data from a third-party CDN -
  an outbound request, hence an IP leak, for every user who opens the picker; the picker cannot open
  offline, which is fatal in the mobile apps; and `@^1` pins nothing, so the offered set changes under
  us, which is exactly the non-determinism the standing directive forbids. **Self-host the EN dataset
  the way FR already is, and pin both.**
- `emojiUnsupportedMessage` is shown by the library when it detects no colour-emoji support at all.
  Once a font is bundled, decide whether that state is still reachable (WebKitGTK is the only
  candidate) and delete the string if it is not - a message nothing can display is noise in
  `messages/*.json`.

#### What a future campaign owes - asked for by the user on 2026-08-23

These are rows for the **second campaign** (see that entry below); they are listed here, once, and are
not restated there. Every one names the evidence it rests on, because "the emoji looked fine" is not
an observation.

1. **The bundled family actually resolved**, per platform, on W1, W2 and A1 - plus an iPhone when one
   exists. `document.fonts.check()` is necessary and not sufficient: it answers "loaded", not "used".
   The verdict rests on a rendered-pixel comparison of one known codepoint against the same codepoint
   with the platform family forced. **Identical pixels mean the bundled font did NOT apply.**
2. **The same codepoint is the same picture on every device.** One message carrying a v1 emoji, a
   country flag, a ZWJ family, a skin-toned person, an Emoji 16 and an Emoji 17 addition; compare the
   rendered bubble across W1, W2 and A1. Cross-device identity IS the point of this WP, so this is the
   row that fails if the font silently did not load on one client.
3. **A flag and a ZWJ sequence render as ONE glyph**, not as two letters or five people. This is the
   row Fluent would have failed outright, and a font built without its `GSUB` fails it too.
4. **The whole set is reachable in the picker**: scroll to the last row of the last group, on a short
   viewport, with the recents row both empty and full - the two states whose heights differ, which is
   the arrangement the picker entry above traces the clipping to.
5. **The panel is entirely inside the viewport** at each anchor: first message, last message, a row at
   the top edge, one at the bottom, on the own side and the peer side.
6. **French search still finds things** (the FR dataset is load-bearing for keywords) **and English
   search works with the network off** - the row that would have caught the jsdelivr default.
7. **Pick, send, peer**: the codepoint the peer receives equals the one picked, and it is still a
   CODEPOINT - copy the text out and assert on it. That is the proof the app stayed on the font path
   and did not drift into image substitution.
8. **A reaction** carrying a flag and a ZWJ sequence survives the round trip, including the
   distinct-reaction limit path.
9. **The notification shade is drawn by the OS**, so an emoji in a notification body uses the SYSTEM
   font and will not match the app. Assert what it does; do not assert that it matches.
10. **Exported artefacts**: an emoji in a poster, a calendar and a trombinoscope export. Whatever this
    WP decides for PDF, the campaign asserts it.
11. **Cold start, offline, on A1**: open the picker with no network and confirm the set is complete AND
    that no request left the device - an assertion about the absence of an outbound request, which the
    harness's server window can support.

#### Limits to state before anyone reports them as bugs

- **The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
  surface are drawn by the platform.** Bundling a font changes nothing there. "The notification shows
  a different emoji" is then expected behaviour, not a regression.
- A member on an Android WebView older than Chrome 98 gets neither table and falls back to the system
  emoji font - which on Android is Noto anyway, so the picture is unchanged. `minClientVersion` is not
  the lever for this.


### P3 - the two controls on a device row do not look like the same kind of thing (reported 2026-08-25)

**Reported by the user with a screenshot**: *"Petite note graphique, il faudrait homogeneiser la
corbeille et la modification."* On a device row the delete control is a filled rounded square and the
rename control is a bare pencil floating under the text, so two controls of equal standing read as one
button and one decoration.

The divergence is entirely in two class lists in `DeviceManagementPanel.svelte`, and it is every axis
at once rather than a single oversight:

| | rename (`Edit2`) | delete (`Trash2`) |
| --- | --- | --- |
| resting background | none | `bg-black/5` / `dark:bg-white/5` |
| radius | `rounded-lg` | `rounded-xl` |
| padding | `p-1.5` | `p-2.5` |
| icon | `size={14} strokeWidth={2}` | `size={18} strokeWidth={2.5}` |
| press feedback | none | `active:scale-95` |

**Where they may legitimately still differ: colour.** The destructive one hovers red, the rename one
amber, and that is the distinction worth keeping - a trash can and a pencil should differ by INTENT,
not by whether they look clickable.

Two things to settle before touching it, because neither is answerable from the row alone:

- **The same pair exists elsewhere.** A homogenisation that only fixes this panel trades one
  inconsistency for another, so the fix is a shared class (or a `.btn-glass` modifier - `app.css` is
  the single source of truth for tokens and `--radius-*`, CLAUDE.md) applied at every site, and the
  audit of those sites is part of the work.
- **The rename control also sits in a different place in the layout** - inside the text block, after
  the version line - while the delete button is a sibling of the whole row. Matching their appearance
  without settling their POSITION will just move the question.

Grouped with the emoji-picker geometry and the bundled-font work above: all three are user-reported
appearance items, all three are post-ladder, and all three want the same pass over `app.css` rather
than three local patches.

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

## Payments

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

**2026-08-19: onboarding storage coexists (see [core-service#payments](services/core-service.md#payments-stripe--lydia)),
and checkout routing now does too.** `resolvePaymentTarget` (`payment-delegation.util.ts`) takes the
active provider as a parameter and resolves against the matching column pair; `AssociationsService`/
`ProductsService` fetch it from the public `GET /api/payments/provider` before resolving, and let a
failure to reach core-service propagate rather than guess. `PaymentTarget.connectAccountId` (renamed
from `stripeAccountId`) now genuinely holds whichever provider's account is active. A Lydia
`request/do` payment is also confirmed server-side now: `confirm_url`/`cancel_url`/`expire_url` are
registered per-request, and `POST /api/payments/lydia-request-callback`
(`webhook.controller.ts`) verifies the signature and fans out to the same submission/purchase
fulfillment Stripe's webhook already used, via a shared `order_ref` encoding
(`form:<submissionId>` / `product:<productId>:<userId>`, parsed by `lydia-order-ref.ts`).

**Two things still block actually flipping the switch, both found while wiring this:**
1. **`payerRecipient` is never supplied.** `LydiaPaymentProvider.createCheckoutSession` throws
   without it (`request/do` needs the payer's email/phone), and nothing in `products.service.ts`/
   `forms.service.ts` resolves one - the interface field has existed since Phase 2 but no caller was
   ever wired to it. Needs a design decision on where the payer's email comes from for a boutique
   purchase (a logged-in user's account has no email stored in social-service today; only forms with
   a guest `input.email` field have one at all).
2. **The `business/create` `BUSINESS_VALIDATED`/`BUSINESS_UNVALIDATED` webhook is deliberately not
   built.** It has no documented signature and `vendor_token` is PUBLIC - building it as-is would let
   anyone knowing another association's vendor_token forge or break its `lydiaOnboardingComplete`,
   with no resync since Lydia sends the event once. Add "does `business/create`'s `webhook` param
   have a signature scheme?" to Livrable A below before building this.

---

### MEASURED 2026-08-20 - a role change does not reach the person it is about

**COMM-5 passes and records `liveWithoutReload: false`.** The promotion itself is immediate and
correct - `member` -> `moderator` -> `admin` -> `member` on the server, each step landing before the
next was asked for, and the owner's own panel showing each one. What does not happen is the OTHER
device learning about it: the peer gained the manage controls only after a full reload, and the wait
that says so is bounded at 20 s and reported next to the answer.

**Which direction matters is the demotion, not the promotion.** A promoted moderator who cannot
moderate until they reload is an annoyance. A DEMOTED administrator goes on being offered every
control they have just lost, for as long as their tab stays open. That is not a security hole - the
server re-checks every one of them, and the components say so in their own comments ("hiding the
button is convenience, not the gate") - but it is a person clicking things that will now fail, with
no explanation on screen.

**DECIDED 2026-08-20 by the user, and SHIPPED the same day: PUSH IT.** `workspace.role.changed`
carries the new role's whole permission set to the member it concerns and to nobody else, and their
client applies `viewerCanManage` from the event - it does not refetch, because a refetch can fail,
can be declined while a load is already in flight, and would return exactly what the event already
carries. Best-effort and logged: the role is written before the announcement is attempted, so a
failed publish leaves the member where they were before any of this existed. COMM-5 is now STRICT on
`liveWithoutReload` and keeps the reload path only to separate "the push did not arrive" from "the
grant never happened".

**The invariant this rests on, written down because nothing enforces it:** `viewerCanManage` is the
only permission-derived value the client caches. The event carries the full list so that the day a
second one is cached, only the client handler changes.

### FOUND 2026-08-20 - a custom role can be created by the API and by nothing else

`POST /channels/roles` exists, `ChannelService.createRole` on the client exists, and **no component
in the application calls it**. The roles tab renders a permission grid over whichever roles the
workspace already has - the three defaults - and offers no way to add a fourth. Enumerated, not
assumed: `createRole` has exactly two non-test references in the frontend tree, its declaration and
nothing else.

**DECIDED 2026-08-20, by the user: THREE ROLES IS THE PRODUCT.** `ChannelService.createRole` is dead
client code and is deleted; COMM-6 is rewritten to ask what the grid actually does - that it offers
exactly the six enforced permissions and no seventh, and that a toggle on it is enforced.

**The server route is KEPT, and this is the reasoning rather than a shrug.** `POST /channels/roles`
is the only way a custom role can exist at all, and the grid renders whatever roles a workspace has
- so a role made through the API is visible and editable, just not creatable, and the interface
degrades into read-and-edit rather than breaking. Deleting the route would also delete the tested
service method behind it and the migration history that shaped it, for no gain: nothing calls it, so
nothing costs anything. **The one wart worth writing down:** `normalizeRoleLabelToCanonical` folds
any unrecognised role name to `member`, so a custom role shows in the member list as "Membre" while
holding whatever permissions it was given. That is a display fault waiting for the day somebody uses
the route, not today's problem.

**What is NOT in doubt** is the six: `channel.access` and `channel.send` are out of the registry, out
of the grid and out of `channel_roles.permissions` by migration, and `RETIRED_PERMISSIONS` keeps
their names only so an old client's write can be told from a wrong one.

### P3 - an admin who never joined a private salon is not told when it is deleted

`channelAudience` is the salon's roster, and since 2026-08-19 an administrator reaches a private
salon by JOINING it rather than through `workspace.manage` - so one who has not joined is not on the
roster and receives no `channel.deleted`, nor any other event the salon emits. They ARE shown that
the salon exists (name only, `viewerHasAccess: false`), so their sidebar keeps a row for something
that is gone until their next load.

**Not fixed by widening the audience**, which is the obvious move and the wrong one: that is exactly
what put every private salon's messages, typing, pins and poll tallies on the socket of members the
same server refuses to serve them over REST, and it was closed this week. The shape that would work
is a separate, contentless `channel.gone` addressed to the community - worth doing only if the stale
row is ever seen to matter, since a reload clears it and nothing is wrong underneath.

### REPORTED 2026-08-20 - quick reply from the shade does not work, and mark-as-read is unknown

From the user, on the phone, unprompted. **The APK on that device predates the current bundle**, so
neither observation is attributable to the code as it stands - which is exactly why they are rows
(NOTIF-6, NOTIF-6b) and not fixes. `CanariNotificationActionReceiver` implements both actions and
both call `cancelConversationNotification`; device check K recorded the reply path as sending, with
K2 covering the undelivered case ([device-verification](device-verification.md)).

**Owed in this order:** rebuild the APK, install it, then run NOTIF-6 and NOTIF-6b. A failure on the
current bundle is a defect; a failure on the old one is the mixed fleet doing what it is.

## Play Store compliance

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

**Play's requirement, verbatim in substance:** an app that supports user sign-in, optional or
mandatory, must support Zero-Tap Sign-In restoration when the user moves to a new Android device.
Mobile and tablet only. Games are exempt; Canari is not. Enforcement begins **April 2027**. Three
exemptions exist and none obviously fits us: a Block Store integration completed by **30 September
2026**, enterprise or permanently-private apps, and a regulatory exemption requested for
financial/healthcare mandates.

**The mechanism is the Restore Credentials API**, and a restore credential is a system-managed
WebAuthn public key credential - a passkey the user never sees, tied to the package name, created
silently after sign-in, backed up with the device and readable on the new one during setup. It is
`androidx.credentials`, minimum Android 9 (our minSdk is exactly 28, so every install qualifies),
GMS core 24220000 or higher. **It works regardless of `android:allowBackup`**, which matters here:
the credential lives in the system credential store, not in app data, so it is orthogonal to the
device-transfer exclusion shipped on 2026-08-26 and does not reopen it.

**What this costs is a server we do not have.** `grep` over `apps/core-service/src` for `webauthn`,
`passkey`, `publicKeyCredential` and `fido` returns NOTHING: there is no WebAuthn registration or
assertion endpoint anywhere, and a restore key needs both - a `PublicKeyCredentialCreationOptions`
to create, an assertion to verify, and a store that keeps restore keys distinguishable from real
passkeys. Canari's session model is an opaque refresh row plus a stateless 1 h access token
([sessions](sessions.md)); a successful assertion has to mint exactly that pair.

**THE PRINCIPLE IS DECIDED - THE USER ACCEPTED IT ON 2026-08-26, AND THE WORK IS SCHEDULED AFTER
THE CAMPAIGN.** The question put to them was not technical: zero-tap means the new device is signed
in with no password and no second factor, and Google's documentation states plainly that the API
"does not handle multi-factor authentication", while Canari has 2FA and SETUP-4 exists because
re-enrolling a device costs one. It was accepted on the ground below - a restored session
authenticates, it does not decrypt - and because the exemptions on offer (enterprise, permanently
private, financial or healthcare regulation) do not describe a student messaging app, so refusing
would have risked a publication block rather than bought time. **Do not re-open the principle; what
is open is the build, and it does not start before the ladder reaches the bottom.**

**What it does NOT restore, and why that is fine.** Keystore material is non-exportable, so the MLS
device key does not travel. A zero-tap sign-in authenticates; it does not decrypt. The new device
still enrols as a new MLS client and is re-invited, exactly as
[frontend/backup](frontend/backup.md) already describes for a restore onto a different device. The
feature is therefore coherent with E2EE - it removes a password prompt, not a re-enrolment.

**Three traps to carry into the work when it is scheduled:**

- **The logout half is a requirement, not a nicety** - Play requires the restore key be deleted when
  the user signs out. Canari's logout lives in TypeScript, so this needs a Tauri command down to
  `ClearCredentialStateRequest(TYPE_CLEAR_RESTORE_CREDENTIAL)`, and it must run on the paths that
  log out WITHOUT a user gesture too - a 401/403, a revoked session.
- **The library is `1.7.0-alpha03` at the time of writing.** An alpha is not shippable on the
  release track here; check for a stable line before starting, not after.
- **`E2eeUnavailableException` is expected, not exceptional** - it fires when the user has no screen
  lock or no Google backup, and the documented handling is to retry with `isCloudBackupEnabled =
  false`. That is a second path, so it is logged at a level that accuses and its rate is measured
  before anyone believes what it says.


## Post-campaign projects - decided, not scheduled

### The MLS + Graine explanation, written FOR THE USER - audience settled 2026-08-20

**Asked for earlier, deferred on one question: who reads it.** Three audiences were offered and the
user chose the first outright.

**Who it is for: the user.** What is guaranteed, against whom, and - as loudly - what is NOT.
Prose and diagrams. **No file names, no function names, no code**, because those are what a
maintainer needs and this is not for a maintainer. Readable end to end in one sitting, which is a
length constraint and therefore a selection constraint: everything that does not change what the
reader can conclude is cut.

**What it must contain, since the whole point is the boundary.** What the server sees (ciphertext,
sizes, timings, who talks to whom) and what it cannot see. What a community's shared key means: every
member of a community holds the key to every PUBLIC salon in it, by design, and until 2026-08-20 to
every private one too. What a private salon's own group changed, and what it did not - an admin now
JOINS and is visible in the member list; forward secrecy was decided AGAINST, deliberately, and the
document says so rather than omitting it. What leaving, being removed, and being re-invited actually
do to the keys. What a stolen device gets, and what the PIN does and does not protect.

**The two audiences declined, recorded so the choice is not re-litigated.** A maintainer's page (file
names, invariants, where each is held) would be a wiki page more, long, needing to stay synchronised
- the wiki already carries that, split across
[mls-protocol](protocols/mls-protocol.md) and [graine](protocols/channel-encryption.md). A security
assessor's document (explicit threat model, what an excluded member can do) is the most demanding of
the three and nobody has asked for one.

**Written AFTER the campaign**, because the campaign is what turns the design into something
measured, and a document that says "this is guaranteed" before anything has run is a claim about a
file rather than about a system.

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` becomes a real second environment - decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction is
authorised on prod only because there is nowhere else, and each one leaves debris on a shared server
that real members use.

**What has to be decided before any of it is built**, because a second environment is a second copy of
every secret and every service: whether it gets its own database or a snapshot of prod's, its own
object storage, its own push credentials (an FCM sender is per-project, so a shared one would send a
test notification to a real phone), and whether its data is ever restored from prod - which would
carry real people's ciphertext onto a machine with weaker rules. Scope that first; the tunnel and the
DNS are the easy half, and they are already in hand.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Campagne de test`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

**The eleven emoji rows belong to this campaign** - they are listed in the bundled-emoji-font
entry above, which is their only copy.
