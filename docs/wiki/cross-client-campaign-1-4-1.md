# The 1.4.1 campaign on dev - the MLS core matrix, and what runs after the stable

**PLANNED 2026-10-24, NOTHING RUN.** This page is the plan for the multi-device campaign the owner
asked for once `main` is clean: on `dev.canari-emse.fr`, pathological cases included, planned here
and run later by the lead. It carries four things and nothing else:

1. the verdict on the existing campaign documents - what is stale, what is rewritten, what goes;
2. what the rig must gain before a single row on dev can be believed;
3. the matrix - every row with its question, what its `expect` ENTAILS, its devices, its fault, its
   cost and who has to be present - split into **the MLS core, which BLOCKS the `1.4.1` stable**, and
   the rows that run after it;
4. the order, the cost, and the open questions.

**How each row of section 4.2 is RUN and RECORDED** - its runner, the rig atom covering it, what is
still missing, and whether a person is needed - is
[cross-client-campaign-1-4-1-runners](cross-client-campaign-1-4-1-runners.md).

How a result earns belief is still [testing-methodology](testing-methodology.md), and nothing here
restates it. The rig is [the harness README](../../tools/cross-client-harness/README.md). When this
campaign has run, the rows' verdicts go to a board (section 1 says which), and this page keeps the
plan only.

---

## 1. The verdict on the existing documents

**Measured, not argued.** `bun rows.mjs` was run on 2026-10-24 against the ledger in the rig root
(read-only; `SITE` there still names the local estate, which is stopped). `bun identity.mjs` was
NOT run: it needs the Chrome profiles up on CDP and it reads the database through `estate.mjs`,
which routes by `SITE` - and pointing `SITE` at dev today sends those reads to PRODUCTION (section
2, R1). A tool that cannot be pointed at the target without touching production is not run "just
to see".

| What `rows.mjs` said | Count |
| --- | --- |
| rows the board names / rows with a verdict in the ledger | 261 / 193 (the board's own `Standing` table, dated 2026-09-07, says 247 / 156) |
| rows where board and ledger name DIFFERENT verdicts | 19 (GRP-1..10, NOTIF-2, NOTIF-4, NOTIF-14, HEAL-NEW-0, REEL-1, GRAINE-AUTH-1..3, -6) |
| rows the ledger answered and the board never recorded | 3 (READ-6, REEL-2, GRAINE-AUTH-7) |
| rows the board calls `PASS` "by hand", never recorded | 2 (NOTIF-7c, NOTIF-7d) |
| row/build pairs that answered differently on the SAME build - draws, not measurements | 52 |
| verdicts naming a commit `origin/main` no longer contains (squash-orphaned) | 29 |
| phone verdicts carrying no APK build | 41 |
| HEAL verdicts with no server window ("clean" means the web client only) | 15 |
| rows never run | 66 (SETUP x9, CALL x20, HEAL x16, NOTIF x11, PIN x4, CORRUPT x5, LIFE-5) |

And the dates: tiers A-C (MSG through DEL) were last answered on `0.16.3`, 2026-09-04 and -05 -
seven weeks and more than thirty releases before `1.4.x`, on the LOCAL estate, by profiles whose
devices have since been re-enrolled. **Not one row on the board exercises a mechanism this stable
ships**: commit settlement, the duplicate answer, admission by a member, the background Welcome's
staging, the removal bound, the lock order. Rule 18b already says what that means - a verdict is
evidence only for the assertions that produced it.

| Document | State | Disposition |
| --- | --- | --- |
| [cross-client-testing](cross-client-testing.md) (the board) | Its header says "Target is the LOCAL estate"; its `Standing` table is a seven-week-old snapshot; 24 cells disagree with the ledger; dozens of cells carry paragraphs although its own first rule says a `PASS` cell says nothing else | **ARCHIVE it as it stands** (a second archive beside [the LITHIUM one](cross-client-testing-archive.md), same status: where to look first when a re-run disagrees, worth nothing as a gate), and start a NEW board whose rows are the matrix of section 4, state only. Reconciling 24 cells of a board about another estate and another version is work that buys nothing |
| [cross-client-campaign](cross-client-campaign.md) (the design) | 1554 lines. The core is sound and is kept: how a check is written, the ladder's tiers, the delegation contract, the standing rules. Stale: "TARGET IS THE LOCAL ESTATE"; **the transports table**, which still says a community channel is readable by the server through a `masterSecret` column - dropped by migration `041` under Graine ([channel-encryption](protocols/channel-encryption.md)); and delegation point 6, which retires the mutual exclusion because "the target is LOCAL" - on dev a pre-release deploy replaces the estate under a run, so **the exclusion comes back** (R4 below). About 900 lines (from "Measurements the board deliberately no longer carries" to the end of the HEAL stories) are history, not design | **REWRITE** the head (target, transports, point 6) and **MOVE** the history sections to the archive page. Not a deletion: the HEAL stories are what a re-run of those rows reads first |
| [cross-client-campaign-resume](cross-client-campaign-resume.md) | Entirely about the 2026-09-03 restart onto `localhost:8081`: its bring-up says `node -e` and `npx vite build` (bun is the rule), its section 7 is done or tracked elsewhere, and "the dev estate" in its index line is something it never describes | **DELETE.** Section 3 of this page replaces it. `CLAUDE.md` links it from WHERE THINGS LIVE, so the deletion goes with the lead's `CLAUDE.md` update, not in this pull request (the link test would fail on a dangling row) |
| [testing-methodology](testing-methodology.md) | Rules, not state. Still true; rule 5b (another origin is another device) is exactly what moving to dev costs | **KEEP.** Nothing in it is stale for this campaign |
| [cross-client-ios](cross-client-ios.md) | Accurate about the adapter; no board row has run on I1 | **KEEP**; its row classification is re-read against the new matrix when the I1 rows are ported |
| [the harness README](../../tools/cross-client-harness/README.md) | "the LOCAL docker estate since 2026-09-03" throughout | **REWRITE the target paragraphs** when R1 and R2 land, in the same pull request as the code |
| [dev-environment](infrastructure/dev-environment.md), "The campaign rig needs nothing from dev ... cannot reach without an Access service token", and the "89 files" line under the owed capabilities | Both false today: the 89 literals were swept on 2026-09-04, and on 2026-10-24 `GET https://dev.canari-emse.fr/chat` answered `200` with no Access redirect | **CORRECTED** - dev is open by the owner's decision (2026-10-24, Q1 settled), and the rig needs no service token |
| `test-accounts.json` `_target` (rig root, outside the repository) | names the local estate | updated by hand when the rig is pointed at dev |

**What this pull request does about it**: it adds this page, a one-line notice at the top of the
board, the design page and the resume page pointing here, and an index entry. It deletes and
archives nothing - those moves change what `CLAUDE.md` indexes, and `CLAUDE.md` is the lead's.

---

## 2. What changed since `v1.4.0`, and why each is a row

`git log v1.4.0..origin/main` on 2026-10-24 holds 118 commits, nearly all merged that day. **Dev
runs `1.4.1-alpha.1`, build `dev.50a354e`, which carries NONE of the mechanisms below** - so the
first gesture of the campaign is a new pre-release from `main` (R7).

| Mechanism | Pull request | What can go wrong on a real estate | Rows |
| --- | --- | --- | --- |
| Commit settlement: a commit with no answer is RESUBMITTED as the same bytes; accepted or `duplicate` merges, a refusal clears, no answer keeps the stage and blocks the group until settled; the stage and its record written in ONE call, on disk before the first request | #2269 (and the settle paths of #2329) | a lost answer that forks, a stage cleared that the server accepted, a group blocked for good, the MLS lock held across a hung POST | DUP-*, OFF-*, KILL-*, TOK-* |
| `answerIfAlreadyAccepted`: the gate asks its commit log before EVERY refusal on the epoch or a seat, so our own commit is `duplicate` at any later epoch | #2269 | a resubmission overlapping its own first request past the 5 s Redis lock, read as `epoch_mismatch` | DUP-2, DUP-3 |
| Periodic leaf refresh (at most every 7 days of activity) and the stray-leaf collector removing a revoked device's leaf; `403 DEVICE_REVOKED` first at the gate | #2269 | an UNASKED commit racing a member's Add; a revoked leaf left in a tree | CC-4, DEV-2, DEV-3 |
| A new person joins a group only through a member: link accept writes `awaitingAdmission`, the base answers `409 awaiting_admission`, a member's device shows the ask, Add or Decline | #2358 | a waiting seat that acts as a member anywhere; a Decline that strips an admitted person; an OLD client on either side | ADM-* |
| The background Welcome's Add staged in `mls.bin`, settled by whoever loads it next; the route says what happened | #2287, #2329 | a killed phone answering from a stale epoch; `ACCEPTED AND NOT HELD`; the foreground overwriting a staged Add | DEV-7 |
| Seat claims and departures serialised under one lock (`dm_seat_evictions`, `distribution_departures`) | #2258 | a claim and an eviction crossing; a deadlock | RM-1, RM-5 |
| The removal bound: `REMOVAL_EXCEEDS_ACTOR`, a rewrite refused whole with `409 CHANNEL_ACCESS_CHANGED`, `409 DEPARTURE_SUPERSEDED` after three inline retries, salon rows locked before membership rows | #2284 | two admins editing one salon's access; a kick racing a grant; a lock-order inversion | RM-4..RM-7 |
| A key-group frame stored once, not once per seat | #2260 | a seat that misses a frame stored for "everyone" | **none on this build**: the writer is OFF on dev for 1.4.1 (see "Decided by the lead" below), so GAP-4 is not played. BIG-3 still runs, on the per-seat path |
| Graine: rotate a seed on a removal or a new user only; the past only to a proven admission; answers scoped to readable salons; a shut phone joins a key group from the push; history addressed to the asking device | #2263, #2273, #2262, #2266, #2270 | a removed member keeping the next seed; a link joiner reading the past it may not; a phone missing a salon after a kill | GR-* |
| KeyPackage bound to its device, device keys pinned on first sight; new-device notices | #2268, #2278 | a legitimate re-enrolment refused as an impostor; a notice missing or doubled | DEV-1, DEV-5 |
| A revoked device no longer erases its owner's arrival; a group exit sends what it can first | #2254, #2259 | a history floor reset by a revocation; an exit half-done offline | DEV-6, RM-8 |
| Push registration bound to the session; ended at sign-out; WS gateways accept an access token only | #2307, #2302, #2319 | a socket that cannot reconnect after a token expiry | TOK-4 |

---

## 3. What the rig must gain before a row on dev means anything

**Every item here BLOCKS the campaign.** Each is desk work, done without the owner, and each lands
as its own pull request with a selftest - the rig is reviewed like the product.

| Id | What | Why it blocks | Size |
| --- | --- | --- | --- |
| **R1** | **`estate.mjs` learns THREE estates, not two.** Today `LOCAL` is a boolean and everything not local is PRODUCTION: `psql`, `redis` and the server log reader run `docker exec infrastructure-*` on the shared host. With `SITE = https://dev.canari-emse.fr`, every one of the 14 rig files that read the database through it (`identity.mjs`, `devices.mjs`, `arm.mjs`, `grainedb.mjs`, the GRP, DEL, HEAL-REVOKE, GRAINE-AUTH runners...) would read production's tables and production's logs and report them as dev's. The fix: an estate is `local` / `dev` / refused; dev resolves its containers by compose LABEL `com.docker.compose.project=canari-dev`, as `reset-dev-to-seed.sh` does, and REFUSES when the label is not that; production is not a value the rig accepts | without it a dev verdict is computed from production state, and the first `cleanup.mjs` query that later learns to write would write there | M |
| **R2** | **`a1apk.mjs --estate dev`**: VITE origins = `https://dev.canari-emse.fr`, no `adb reverse`, no `local-estate` capability (dev is `https://`, inside the default scope), DEBUG so CDP reaches the WebView. Plus `--ref v1.4.0` to build an OLD client for the mixed-version rows | today it refuses a SITE with no explicit port; the release APK of the store tracks is not inspectable | S |
| **R3** | **`fault.mjs`, a response-stage fault atom over CDP `Fetch`**: per URL pattern, `lose-answer` (let the request reach the server, then fail the response the page sees), `delay N`, `status 5xx`, `status 401 once`, `hold until released`, each recording the request id it acted on and the server's own log line for it. `net.mjs` can only refuse a request before it leaves or slow its upload; **no tool here can make a request land and its answer vanish**, which is the case the settlement exists for | DUP, OFF, KILL and TOK cannot be armed otherwise | M |
| **R4** | **The deploy exclusion is back, and `deploy.mjs` enforces it for dev**: a run records dev's `/api/version` `build` at start and end and is `VACUOUS` if it changed; no pre-release is cut while a campaign session is open | a `gh release create *-alpha.*` redeploys dev under the run | S |
| **R5** | **Fixtures on dev, campaign-owned and named so**: the four rig accounts (owner, peer, third, fourth), their PINs, the owner-peer DM, a test venue with a public and a private salon, groups `campaign-g2` (2 users), `campaign-g4` (4 users), `campaign-big` (section 4.8). Built THROUGH THE PRODUCT, never the database. Dev holds testers' own work: **a destructive row touches only containers this campaign created**, by allowlist (`--only <ids> --expect N`) | dev is shared; a row that opens "whatever is on screen" writes on a tester's conversation | S, one session |
| **R6** | **The server window reads dev**: `srvlog.mjs` and `serverwindow.mjs` resolve dev's containers through R1, and the classifier learns the lines this stable added (`[COMMIT] ... settling`, `duplicate`, `[ADMISSION]`, `[UNINVITED_ENTRY]`, `[STRAY]`, `[BG_WELCOME]`, `REMOVAL_EXCEEDS_ACTOR`, `CHANNEL_ACCESS_CHANGED`, `DEPARTURE_SUPERSEDED`) - each as EXPECTED for the row that provokes it and as dirt everywhere else | the bar is `PASS`, never `PASS-DIRTY`, and an unclassified server line is dirt by construction | S |
| **R7** | **A pre-release from current `main`** (`1.4.1-alpha.2` or later) deployed to dev and green, its APK and TestFlight build installed on A1 and I1; the APK the rig drives is R2's debug build of the SAME commit | dev's `dev.50a354e` predates every mechanism of section 2 | release gesture, ~1 h with `main`'s CI |
| **R8** | **One invariant probe for every MLS row**, `invariant.mjs`, run after the row's action on EVERY client in play (section 4.0) | every row below asserts it; written once, not per runner | S |

**R1 is a P1 of the rig, not a convenience**: the README's own rule is that an observer pointed at
the wrong estate answers "no" (methodology, "AN OBSERVER POINTED AT THE WRONG ESTATE"). Here it
would answer about the wrong estate with production's data, and nothing would say so.

---

## 4. The matrix

### 4.0 What every MLS row asserts, besides its own question

After the row's action, and again after a reload of every web client (the reload is what proves the
state was SAVED, not only held in memory):

1. **One tree.** Every member device of the group reports the same epoch AND the same epoch
   fingerprint (`window.__canariMlsEpochs()`, the predicate of
   [cross-client-harness-findings](cross-client-harness-findings.md#no-row-can-tell-a-healthy-conversation-from-an-epoch-forked-one-2026-08-29));
   no fork finding (`fork`, `unproven`, `contradiction`) was recorded.
2. **No stage left behind** unless the row expects one: no group holds a `pending_submission`; the
   server's commit log has exactly one row per epoch the row moved.
3. **A message after the event reaches every member once**, in order, with the right author.
4. **None of these lines, anywhere**: `ACCEPTED AND NOT HELD`, `ERASES`, `UNREADABLE`,
   `[ADMISSION]` at ERROR, `is ABSENT from the state this foreground keeps`, a 5xx in the server
   window; and no client logged out (a transport failure is not an answer).
5. **The roster read and the tree agree** (`user-members` against the leaves), so a seat the server
   holds and a leaf a device holds cannot drift apart silently.

**A concurrency row runs FIVE times and its verdict is the set** - one `FAIL` in five is the
verdict. The old board holds 52 draws on one build; a race measured once is a coin.

### 4.1 Devices and who must be there

| Seat | What | Account |
| --- | --- | --- |
| `W1` `W2` | the two Chrome profiles, CDP 9224 / 9223. **On dev they are NEW devices** (another origin is another device, rule 5b) - the local estate's state is untouched | owner / peer |
| `W3` | a third profile: the owner's second web device, or a fresh device a row mints | owner |
| `W4`..`W8` | further profiles, headless allowed, for the large group and the fourth account | third / fourth / owner |
| `A1` | the Mi 9T (`fa71073b`) over `adb`, R2's debug APK; for the mixed-version rows the `v1.4.0` debug APK | owner |
| `I1` | the iPhone 12 through `tools/ios-device` (WDA + the inspector bridge), the pre-release build | owner |
| - | **the Pixel 6a is the owner's personal phone and is never a test device** | - |

| Class | Means |
| --- | --- |
| `U` | **unattended**: browsers only; can run while nobody watches, including at night |
| `B` | **bench**: needs A1 or I1 on the bench and plugged in, driven by the lead over `adb` / WDA - **no owner needed**. Typing the Canari encryption PIN on a new device or a relocked app is part of this: the rig types it from `test-accounts.json` (`pin.mjs`) |
| `O` | **owner at a device**: a physical gesture no tool here performs - a reboot left unopened, the lock screen, Face ID, an iPhone passcode the bench cannot type (Q4) |
| `PIN` | the row CHANGES, resets or re-enters a PIN as its subject, or mints a device that must be enrolled with one. Not an owner gesture, but it can strand a device: a PIN reset on one device leaves the others' stores sealed under the old PIN ([cross-client-harness-findings](cross-client-harness-findings.md)). These rows run LAST in their session |

### 4.2 MLS core - THIS BLOCKS THE `1.4.1` STABLE

Each row: the question, what `PASS` entails (written so a row whose condition makes the good outcome
impossible FAILS on it), the devices, the fault, the class and the cost of FIVE runs.

#### FLOOR - re-proved on dev, in the same session, before anything else (tier A)

| Id | Question | `PASS` entails | Devices | Class | Cost |
| --- | --- | --- | --- | --- | --- |
| FLOOR-1 | DM send both ways, then a reload, on the new build | one copy, < 2 s, right author; section 4.0 holds | W1 W2 | U | 10 min |
| FLOOR-2 | Create a fresh group the row mints (`FLOOR2-<mark>`), add three users' devices in one bulk Add | one commit, every device `active`, 4.0 holds | W1 W2 W4 W5 | U | 15 min |
| FLOOR-3 | FLOOR-2's group seen from A1 and I1 | both decrypt, both at the same fingerprint | +A1 +I1 | B | 15 min |

**FLOOR-2 does not create `campaign-g4`** (decided 2026-10-24): that fixture is built at step 2,
before FLOOR, by an idempotent script, so a row pointed at it would observe a creation that already
happened - and every FLOOR re-run after a product fix would observe none. The row mints its own group
each draw and asks the bulk-Add question there; `campaign-g4` stays the fixture the later rows stand
on, built by the same single bulk Add. Runner: `tools/cross-client-harness/archive/floor.mjs`.

#### CC - concurrent commits

**The contract is the OUTCOME, not the refusal code** (lead, 2026-10-24): exactly one winner, the
loser rebuilt on the new epoch and its change landed or was refused with a typed reason, no fork,
the invariant clean. Which of the gate's two race refusals the loser met depends on how close the
arrivals were, so it is recorded in the row's detail and never decides it.

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| CC-1 | Two members Add two different users at the SAME epoch, released together | exactly one winner of the shared epoch; the loser refused with a typed race refusal (`epoch_mismatch` or `concurrent_commit` - the code is recorded, not judged), cleared, rebuilt on the new epoch and accepted; both users in, one tree | W1 W2 + targets | `hold` both submits, release together (R3) | U | 30 min |
| CC-2 | A member Adds while another Removes someone, same epoch | as CC-1; the removed user holds no leaf at the end, the added one does | W1 W2 W4 | as CC-1 | U | 30 min |
| CC-3 | Two members Remove the SAME member at once | one commit lands; the other is refused and does NOT rebuild a second Remove of a leaf already gone | W1 W2 W4 | as CC-1 | U | 30 min |
| CC-4 | A leaf refresh (unasked commit) races a member's Add | both land in some order, no stage left, no Add lost | W1 W2 | the refresh must be DUE: W1's own `localStorage` refresh ledger backdated on a leaf its own commit produced (no server write - Q3's Redis key does not exist), then `hold` | U | 30 min |
| CC-5 | **BLOCKED-ON-ACCOUNT** (a fifth campaign account). Burst: four devices each commit within 200 ms, ten rounds | every round converges; the server log shows no 5xx and no lock wait over the budget | W1 W2 W4 W5 | none | U | 30 min |

#### DUP - duplicate and retried commits (the settlement)

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| DUP-1 | The commit lands and its ANSWER is lost | the stage is kept, the resubmission (same bytes) is answered `duplicate`, merged once; one commit-log row; the group sends again | W1 W2 | `lose-answer` on the commit POST | U | 20 min |
| DUP-2 | DUP-1, and another member commits before our resubmission | still `duplicate` at an epoch past `base + 1`; merged; our leaf correct; NOT `epoch_mismatch` | W1 W2 W4 W5 | `lose-answer`, the resubmission held (`hold x2`), W4 - at the new epoch - Adds W5, then release. W5 because W4's commit must be one it can make: an Add (`archive/settle.mjs`) | U | 30 min |
| DUP-3 | The first request stalls past the server's 5 s commit lock while our resubmission arrives | the gate answers the resubmission from its log (`duplicate`) or refuses it and the FIRST lands; never two epochs for one commit. **Hard to arm from a client** - the stall must be inside the server transaction; `delay` on the response stage is not that. **NOT PLAYED ON THE BENCH** (Q2 settled 2026-10-24): unit coverage only | - | - | - | - |
| DUP-4 | A resubmission is answered `409 SEAT_CLAIM_OVERTAKEN` | the stage is KEPT, not rebuilt; the next settlement decides for good | W1 W2 | `lose-answer once`, then `status 409 once` carrying the `SEAT_CLAIM_OVERTAKEN` body (the client types the refusal by its `code`); the next send settles | U | 20 min |
| DUP-5 | The commit is answered `503` | outcome unknown, stage kept, sends blocked IN THAT GROUP ONLY, settled at the next gateway connection, then sends resume | W1 W2 W4 | `status 503` while armed (the first request, its resubmission and the blocked send's settle); W1 Adds W4 so W2, already a member, can show the blocked send absent while a side group's arrives; then `cutHard` and back | U | 20 min |
| DUP-6 | The commit request never answers (30 s `write` deadline) | `RequestDeadlineError`, one resubmission, a second expiry keeps the stage; **decrypts in another group keep flowing during the hold** (the MLS lock is not held unbounded) | W1 W2 | `hold` > 30 s twice, a second group sending meanwhile | U | 30 min |
| DUP-7 | An Add accepted only through a later resubmission still delivers its Welcome, once | the joiner receives exactly one Welcome; a reload mid-settlement re-sends only the uncleared recipients | W1 + new device W3 | `lose-answer` on the Add, reload between merge and Welcome send | U | 30 min |

#### OFF - offline during a commit

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| OFF-1 | Cut after the stage's checkpoint, before the POST leaves | reconnect resubmits, accepted, merged once | W1 W2 | `cut()` at the checkpoint (R3 `hold` then cut) | U | 20 min |
| OFF-2 | Cut after the POST reached the server | the reconnect's resubmission answers `duplicate` | W1 W2 | `lose-answer` + `cutHard()` | U | 20 min |
| OFF-3 | The committer stays offline while the others advance three epochs | on return its stage is refused `epoch_mismatch`, CLEARED, the device catches up and re-issues its intent if it still holds | W1 W2 W4 W5 | W1's Add of W5 held then failed under `cutHard()`; W2 Adds W4 and refreshes its leaf twice (`archive/offline.mjs`) | U | 30 min |
| OFF-4 | A RECEIVER offline across ten commits and a hundred messages | every commit applied in order, every message once, no rung-2 repair needed | W1 W2 | `cutHard()` on W2 | U | 20 min |
| OFF-5 | The phone loses both radios in the middle of an Add it is making | as OFF-2 on A1; the settle runs at the next connection, not at the next app open only | A1 W2 | `hold-answer` on the Add, then `svc wifi disable; svc data disable` (and the USB reverse on the local estate), the answer failed | B | 30 min |

#### KILL - the process dies mid-commit

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| KILL-1 | Close the web tab at a random point between the stage and the answer, 20 runs | on reopen every run ends merged-once or cleared-and-caught-up; never a fork, never a blocked group | W1 W2 | `Target.close` after a random 0-800 ms | U | 40 min |
| KILL-2 | Kill Chrome's whole browser process at the same point (no unload handlers) | as KILL-1 | W1 W2 | `taskkill` of the profile's browser, then relaunch | U | 40 min |
| KILL-3 | Swipe A1 away during a commit it is making, 10 runs | as KILL-1 on reopen; the native stage and its record survive together | +A1 | swipe from recents at a random point | B | 50 min |
| KILL-4 | `am kill` during the checkpoint itself | the next load finds the old state or the new one, never a half-file; a stage found without a record is cleared | A1 W2 | `am force-stop` at fractions of the send-to-request window measured on an un-killed run: the client writes no `[CHECKPOINT]` line, and `am kill` cannot reach a foreground process | B | 40 min |
| KILL-5 | Kill between the merge of an Add and its Welcome send (`owed_welcome`) | after reopen the joiner gets ONE Welcome; a duplicate copy is read as a redelivery | W1 W2 | `POST /api/mls/welcome` held, then `Target.closeTarget` (W2 joins: any joiner asks the question) | U | 30 min |

#### GAP - epoch gaps and frame order

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| GAP-1 | Application frames of epoch N+2 arrive before the commits N+1, N+2 | queued, applied in order once the commits arrive; nothing dropped | W1 W2 W4 W5 | W2 cut while W1 Adds W4 then W5 and sends; the commit rows taken out of W2's pull on its return (`rewrite`), rung 1's commit-log fetch held while W1 sends live (`archive/gap.mjs`) | U | 30 min |
| GAP-2 | A frame from a PAST epoch (own and others') | classified by `content_type`, never re-queued as a retryable gap | W1 W2 | one frame of each captured from a pull, the group moved three epochs, both put in front of a later pull of W2 | U | 20 min |
| GAP-3 | 2000+ frames in one epoch while one member is frozen (old HEAL-W3) | `TooDistantInTheFuture` reached before `GAP_QUEUED` loops; the frozen member recovers through the ladder, not a silent gap | W1 W2 | W2 cut while W1 sends 2100; W2's first pull starts after the 2050th (`rewrite-url`). Not a `Debugger.pause`: a frozen page that later receives every frame IN ORDER never exceeds the forward distance (2000) | U | 45 min |
| GAP-4 | A key-group frame stored ONCE, read by every seat (#2260): a community with five seats, two of them offline | every seat, on return, reads the frame once. **NOT PLAYED ON THIS BUILD**: it needs the shared-payload writer, which stays OFF for 1.4.1 (see "Decided by the lead" below) | W1 W2 W4 W5 +A1 | `cutHard()` on two seats | U+B | 30 min |

#### RM - removal while a commit is in flight, and the removal bound

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| RM-1 | W1 removes W2 while W2's own Add is in flight | exactly one wins; if the Remove, W2's Add is refused and W2 ends with no leaf and no re-add; if the Add, the Remove is rebuilt on top and both effects hold | W1 W2 W4 | `hold` W2's commit, release after W1's | U | 30 min |
| RM-2 | Remove a member while they send ten messages | messages before the Remove's epoch delivered; after it, refused to the sender with a typed error, never shown as sent | W1 W2 | none | U | 20 min |
| RM-3 | The remover dies after the roster delete and before the Remove commit lands | RECORDED: the leaf survives (known P2, [backlog](backlog.md#p2---a-removed-member-whose-leaf-survived-is-re-added-automatically-by-a-link-review-of-2358)); the row measures that the next member commit or repair removes it, and how long | W1 W2 W4 W5 | the roster DELETE's answer held, then `Target.closeTarget`; W2 Adds W5 as the next member commit | U | 30 min |
| RM-4 | Two admins rewrite one salon's access list at once | one wins; the other gets `409 CHANNEL_ACCESS_CHANGED`, named in the panel; visibility, allowlist and write policy are the winner's; any begun departure settled `cancelled` | W1 W2 (both admins) | release both PATCHes together | U | 30 min |
| RM-5 | A community kick races an invitation into a private salon for the same user | the kick retries inline; `409 DEPARTURE_SUPERSEDED` only if three races outlast it; the user ends either kicked with no salon seed, or a member with one - never half | W1 W2 W4 | release both together, x5 | U | 30 min |
| RM-6 | A member holding only `channel.manage` makes a salon private while leaving off an admin | `403 REMOVAL_EXCEEDS_ACTOR`, named; no group minted, no departure begun | W1 W2 | none | U | 15 min |
| RM-7 | A role demotion of the actor races their removal of someone | the removal reads the COMMITTED role: refused if the demotion committed first | W1 W2 W4 | release both together | U | 20 min |
| RM-8 | Leave a group while offline (#2259) | what can be sent is sent before the server step; the rest is refused with a reason; no half-left group | W1 W2 | `cut()` | U | 15 min |

#### ADM - group-link admission, new and old clients

| Id | Question | `PASS` entails | Devices | Class | Cost |
| --- | --- | --- | --- | --- | --- |
| ADM-1 | A new person follows the group link (new clients everywhere) | the joiner reads "Waiting for a member..."; the base answers `409 awaiting_admission`; every member device shows the ask; one member's Add admits them; the ask leaves every screen at the next sweep | W1 W2 + W4 joiner | U | 20 min |
| ADM-2 | A member Declines | `withdrawn`: roster row, queued Welcomes and device rows gone, no eviction or exclusion written; the joiner never reads the conversation | as ADM-1 | U | 15 min |
| ADM-3 | Two members answer at once: one Adds, one Declines | the Add wins (`already-admitted`) or the Decline wins and the Add becomes an ordinary invitation; never an admitted person stripped | W1 W2 + W4 | U | 30 min |
| ADM-4 | **Security**: the waiting seat calls every member route from its own page (roster, members, enrol someone, mint a link, vouch, history, exclusions, call initiate/ring) | each answers `409 awaiting_admission`; presence and ring audiences exclude it; nothing it does admits anyone | W4 waiting | U | 20 min |
| ADM-5 | OLD joiner: A1 on the `v1.4.0` APK follows a link created on new clients | it meets the withheld base (`409`), falls back to asking a member, is admitted by a member's Add; the server's `[GROUP_INFO] base withheld` line is rate-limited, not one per retry | +A1 (old) W1 W2 | B | 45 min with the install |
| ADM-6 | OLD member: A1 on `v1.4.0` is a member when a NEW joiner follows the link | A1 may auto-Add (the shim); the Welcome lift admits the joiner; no `[ADMISSION]` ERROR; recorded which device added | +A1 (old) W1 + W4 | B | 30 min |
| ADM-7 | An external join by a non-member, from an old client, at the base | refused; `[UNINVITED_ENTRY]` count stays 0; no "entered without being added" notice anywhere | +A1 (old) | B | 20 min |
| ADM-8 | The link in a 1:1 conversation and in a key group | no ask is raised (only a GROUP conversation takes one) | W1 W2 | U | 10 min |

#### DEV - device add, revoke, and the background Welcome

| Id | Question | `PASS` entails | Devices | Class | Cost |
| --- | --- | --- | --- | --- | --- |
| DEV-1 | A new device of an existing member (W3 owner) | added automatically as `member-device`; the new-device notice and contact line appear on the owner's and the peer's devices once each | W1 W2 + W3 new | U, PIN | 20 min |
| DEV-2 | Revoke W3 from W1 | the stray-leaf collector removes W3's leaf in every group by allowlist; W3's next commit is `403 DEVICE_REVOKED`; nobody removes their own leaf | W1 W2 W3 | U | 30 min |
| DEV-3 | Revoke W3 while it is OFFLINE, then bring it back | the wipe is deferred, not lost; on return it holds nothing; the leaf was already removed | W1 W2 W3 | U | 30 min |
| DEV-4 | Two fresh devices enrol at the same instant (old HEAL-NEW-10) | both admitted, one tree, no add-lock deadlock | W1 W2 + W3 W6 new | U, PIN | 30 min |
| DEV-5 | The same device id presents a NEW signature key (a copied profile re-keyed) | `DeviceTrustRefusedError` before staging; nothing added; the owner is told | W1 + W3 copy | U | 30 min, needs Q5 |
| DEV-6 | A revoked device does not erase its owner's arrival (#2254) | after revoking one device, a new device of the same owner gets the history floor of the ORIGINAL arrival | W1 W3 W6 | U, PIN | 30 min |
| DEV-7 | **The background Welcome reading owed on the Mi 9T**, its three variants: cold process, app opened inside the round trip, phone stale | exactly the lines [backlog](backlog.md#hardware-reading-owed-user-one-background-welcome-on-the-mi-9t-2026-10-22) names for each variant, and none of the forbidden ones. The trigger needs the newcomer's external join to FAIL for a reason other than not being a member: on dev, the R3 `status 503` fault on the newcomer's `group-info` read, not a database delete | +A1 killed, W1 W3 | B | 90 min |

#### BIG - a large group

| Id | Question | `PASS` entails | Devices | Class | Cost |
| --- | --- | --- | --- | --- | --- |
| BIG-1 | `campaign-big`: four users, twelve devices (W1-W8 + A1 + I1), created with one bulk Add | one commit; every device decrypts the first message; the commit's checkpoint time recorded on A1 and I1 (the owed release-build phone measurement, [mls-protocol](protocols/mls-protocol.md)) | all | B | 45 min |
| BIG-2 | 30 rapid messages from three senders while two commits land in the middle | every message once, in order, on every device; no stage left | all | B | 30 min |
| BIG-3 | A community of twelve seats: a removal, then a new user | ONE new seed per event (#2263), not one per epoch; the removed seat cannot open the next message; the newcomer reads only what its admission allows (#2273) | all | B | 40 min |

#### TOK - a token expiring in the middle of an operation

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| TOK-1 | The commit POST is answered `401` once | refresh, then the SAME bytes resubmitted; merged once; no logout | W1 W2 | `status-unsent 401 once` - a real 401 is the auth guard's, before the gate | U | 20 min |
| TOK-2 | The refresh itself fails as TRANSPORT during a commit | no logout; outcome unknown kept; settled once the network answers | W1 W2 | `lose-answer` on the refresh | U | 20 min |
| TOK-3 | The access token really expires (1 h TTL) while the socket stays open, then a commit and a reconnect | the gateway (access tokens only since #2319) is re-authenticated; the settlement runs at the reconnection | W1 W2 | wait 61 min | U | 75 min wall clock, unattended |

#### NET - a flaky network

| Id | Question | `PASS` entails | Devices | Fault | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| NET-1 | A slow lossy link (800 ms, 50 kB/s) while a four-device Add runs | completes or settles; no `lock_budget_spent` that is not followed by a clean retry | W1 W2 W4 W5 | `net.mjs` `degrade` (latency and both throughputs; CDP has no loss rate, so the lossy half is not reproduced) | U | 20 min |
| NET-2 | The socket flaps every 10 s for five minutes while commits and messages flow | 4.0 holds at the end; every message once | W1 W2 | W2 `cutHard()` on every other 5 s tick; W1 sends each tick, refreshes its leaf every 18 | U | 20 min |
| NET-3 | A captive portal: every API call answered `200 text/html` | no logout, no stage cleared, a typed transport failure; recovery when it ends | W1 W2 W4 | `status-unsent 200` + HTML on `/api/*` for 20 s from the submission of W1's Add of W4 | U | 20 min |

**Total for the blocking matrix, five runs per concurrency row: about 17 hours of runs**, of which
about 12 are `U` (browsers alone) and about 5 are `B` (a bench phone on the desk). **Nothing in it
needs the owner at a device** unless Q4 answers that the iPhone cannot be unlocked over WDA.

### 4.3 After the stable - runs, but does not hold `1.4.1`

| Group | What | Class |
| --- | --- | --- |
| SKEW | A client clock shifted +-2 h (web: `Date` offset injected with `Page.addScriptToEvaluateOnNewDocument`; A1: the clock set by hand in Settings): message order, edits (`editedAt` winner), the undated one-hour margin of the history floor, the refresh ledger. **Instrument limit stated on the row**: an injected `Date` is not the OS clock, and TLS or token validation never sees it | U, B |
| GR | Graine after 1.4.0: a link joiner reads only the past its proven admission allows (#2273); an answer carries only readable salons' seeds (#2262); a shut phone joins a salon's key group from the push (#2266); history answered to the asking device (#2270) | U, B |
| LADDER | The old ladder re-run on dev under the NEW board: MSG, TYPE, READ, MUT, SEARCH, MENTION, FWD, GRP, COMM, DEL, TAB, MULTI - on the new build, once, as the regression floor of the non-MLS surface | U |
| PHONE | LIFE, NOTIF (dev has no APNs key, so iOS push rows wait for one), PIN-4..6, PIN-10, HEAL-NEW-4..6, -13, HEAL-REVOKE-6 | B, PIN |
| CALL | 1:1 audio is on in dev (`calls.mode = audio_video`); CALL-1..20 have no runner | B |
| CORRUPT | CORRUPT-1 (FAIL), -5, -7..-10 | B |
| TOK-3, LIFE-5, CALL-12, CALL-13 | an hour of wall clock, or the owner at the phone (reboot left unopened, the lock screen, CallKit) | O |

---

## 5. The order, and what one session costs

**The order is fixed and there is no other copy of it.** It follows the ladder's rule: each step
assumes what the one before proved.

| Step | What | Who | Cost |
| --- | --- | --- | --- |
| 0 | R1, R2, R3, R4, R6, R8 - code and selftests, one pull request each (`make test-harness` green) | lead, desk | ~1.5 days |
| 1 | `main` clean, R7: cut the pre-release, wait for dev green, install it on A1 (R2 debug, same commit) and I1 | lead | ~1.5 h |
| 2 | R5 fixtures on dev; `bun rows.mjs`, `bun cleanup.mjs`, `bun identity.mjs` (now safe: R1) | lead | ~1 h |
| 3 | FLOOR | lead | 40 min |
| 4 | CC, DUP, OFF, GAP-1..3, RM-1..8, TOK-1..2, NET - the `U` rows, unattended | rig | ~10 h, one night |
| 5 | KILL-3/4, OFF-5, ADM-5..7 (old APK installed, then R2's new one back), DEV-7, BIG | lead + bench | ~6 h |
| 6 | ADM-1..4, ADM-8, DEV-1..6, KILL-1/2/5 - the rows that mint devices or touch PINs, last | lead | ~4 h |
| 7 | the stable may be cut when every row of 4.2 is `PASS` on ONE build - the build of step 1 | lead | - |
| 8 | section 4.3 | lead | after the stable |

**A product FAIL in a blocking row is fixed in the same campaign** (delegation point 8 - fix the
product, never weaken the row), then a NEW pre-release, then the whole of step 3 and the affected
group again: a verdict about one build does not carry to the next.

---

## 6. Open questions

- **Q1. SETTLED (owner, 2026-10-24): dev is reachable with NO Access gate, on purpose.** The
  `200` measured on `/chat` is the intended state, and the rig needs no service token for dev
  ([dev-environment](infrastructure/dev-environment.md) says so now).
- **Q2. SETTLED (2026-10-24): DUP-3 is NOT played on the bench.** The overlap needs a first request
  stalled INSIDE the server transaction past the 5 s lock, which no client can arm. A dev-only delay
  seam on the server would be a product change made for a test. The unit coverage stands in for the
  row: `BaseMlsService.unresolvedCommit.test.ts` and the gate's specs.
- **Q3. SETTLED (2026-10-24, corrected and accepted by the lead): CC-4 writes NOTHING on the
  server.** There is no Redis key: the refresh ledger `mls_leaf_refresh:<user>:<device>` is the
  device's own `localStorage` (`leafRefresh.ts`), so the row arms the refresh on the campaign device
  itself, backdating a leaf its own commit produced
  ([runners, section 5](cross-client-campaign-1-4-1-runners.md#5-two-findings-against-the-plan)).
- **Q4. SETTLED (2026-10-24): the rig unlocks the iPhone.** `tools/ios-device/ios.mjs unlock`, then
  the PIN typed from stdin (the bench phones' PINs are in the private operations notes, never
  printed, never committed). FLOOR-3 and BIG need no person.
- **Q5. How does DEV-5 make one device id present a new key** without a product seam? Copying a
  profile and re-keying it touches the encrypted store; the row may belong to CORRUPT-8 instead.
- **Q6. SETTLED (2026-10-24): a new board.** The old one is archived verbatim at
  [cross-client-testing-archive-1-4-0](cross-client-testing-archive-1-4-0.md), and
  [cross-client-testing](cross-client-testing.md) now holds the rows of section 4.2 alone.
- **Q7. SETTLED (2026-10-24): no tester notice.** Dev is a sandbox. R5 already confines
  destructive rows to campaign-owned containers, and the load of a night of KILL and NET rows is not
  announced.
- **Q8. SETTLED (2026-10-24): the `v1.4.0` debug APK BUILT** with `--build-only --ref v1.4.0
  --accept-dead-production-literal` (the two dead production literals of that tag are accepted by
  name, see the [harness README](../../tools/cross-client-harness/README.md)). The fallback below did
  not have to be taken. The original question: the `v1.4.0` debug APK for the mixed-version rows is built from the tag with today's
  toolchain; if it no longer builds (a dependency moved), the old-client rows fall back to the
  Play internal-track `1.4.0` build, which is not inspectable over CDP - those rows then read the
  server's side only, and say so.

### Decided by the lead (2026-10-24)

- **`QUEUED_PAYLOAD_SHARED_WRITES` STAYS `false` on dev for the 1.4.1 campaign**, as it does on
  production. The repo rule in [chat-delivery](services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)
  says turning the writer on is a code change in a LATER release, never an operator flip. So this
  campaign runs with the writer OFF.
  - The shared-writes path keeps its unit coverage.
  - It gets its own campaign, with its own release.
  - The one row that depends on it, **GAP-4**, is not played on this build.
  - BIG-3 runs on the per-seat path that 1.4.1 actually uses.
