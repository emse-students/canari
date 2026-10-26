# Cross-client testing - the board

**THE 1.4.1 CAMPAIGN ON DEV, OPENED 2026-10-24.** Its rows are section 4.2 of
[cross-client-campaign-1-4-1](cross-client-campaign-1-4-1.md) - the MLS core that BLOCKS the
`1.4.1` stable - and nothing else; how each is run and recorded is
[cross-client-campaign-1-4-1-runners](cross-client-campaign-1-4-1-runners.md). The board before it
(the local-estate ladder, `0.16.3` to `1.4.0`) is kept verbatim at
[cross-client-testing-archive-1-4-0](cross-client-testing-archive-1-4-0.md), and the one before that at
[cross-client-testing-archive](cross-client-testing-archive.md). Neither is a gate; section 4.3 of
the plan (the old ladder re-run on dev, after the stable) reopens their rows here when it runs.

**STATE ONLY.** A cell is a verdict, a date and the build it ran on. The measurement is in
`results.ndjson`; `bun rows.mjs` reconciles the two and is run before anything below is believed.
The ledger still holds the archived campaign's ids, which this board no longer names: read the new
campaign alone with `bun rows.mjs --build <the pre-release commit>`.

**THE BAR IS `PASS` ON ONE BUILD**, the pre-release of step 1 of the plan; a verdict about one
build does not carry to the next. A concurrency row is five draws and its verdict is the set.
`Needs` is the seats and the plan's class (`U` unattended, `B` bench phone, `PIN`).

**ONE NAMED ENVIRONMENT EXCEPTION (2026-10-25), AND ONLY ONE.** The dev zone's Cloudflare JS
detections inject an inline `challenge-platform` script that our `script-src` refuses, once per
document. `watch.mjs` `DEV_EDGE_CSP_EXCEPTION` forgives exactly that refusal, on dev only, at most one
per document, never an app script's hash; every row that used it carries `environmentException` in
its detail. Any other CSP refusal is dirt. It goes when the owner turns the zone's detections off.

**THE iPHONE (I1) RUNS `1.4.1-alpha.4` FROM TESTFLIGHT AND READS NO ROWS (2026-10-25)** - it is
signed out, and nothing signs it in until the owner decides; every `+I1` row stays `pending`.

**AN UNEXPLAINED GATE FLAKE IS OPEN (2026-10-25)** - `make test-harness` failed twice and then
passed, with the failing assertion not captured
([backlog](backlog.md#p3---a-harness-self-test-run-failed-twice-and-could-not-be-reproduced-2026-10-25)).
No row verdict depends on it; it stays here until it is explained.

| State | Meaning |
| --- | --- |
| `PASS` | ran, the row's own assertions and the invariant of section 4.0 held, every window clean - and the row names the build |
| `PASS-DIRTY` | as `PASS`, and a client or the server logged a line no rule classifies: not a pass |
| `FAIL` | an assertion or an invariant did not hold - fixed in the same campaign, then a new pre-release |
| `VACUOUS` | an armed fault never fired, or dev was redeployed under the row: nothing was proved |
| `INVALID` | the row's premise could not be built, so the product was never asked |
| `SKIPPED` | decided not to run, with the reason in the cell |
| `pending` | not run on the current build; a reason after it (BLOCKED-ON-ACCOUNT, Q5) says what it waits for |

## FLOOR - re-proved on dev, in the same session, before anything else (tier A)

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| FLOOR-1 | DM send both ways, then a reload, on the new build | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 76e73f79e5ab |
| FLOOR-2 | Create a fresh group the row mints (`FLOOR2-<mark>`), add three users' devices in one bulk Add | W1 W2 W4 W5 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499) in ONE draw: the ledger also holds `VACUOUS` and `PASS-DIRTY` runs of it on the same build; predates rig 76e73f79e5ab |
| FLOOR-3 | The same group seen from A1 and I1 | +A1 +I1 - B | `pending` - not run on 1.4.1: class B, it needs A1 and the iPhone (I1), and I1 was signed out (the operator's reading of the iPhone, not a ledger record); the plan runs it by hand on the bench |

## CC - concurrent commits

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CC-1 | Two members Add two different users at the SAME epoch, released together | W1 W2 + targets - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig b090278c8e5e |
| CC-2 | A member Adds while another Removes someone, same epoch | W1 W2 W4 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig b54469f9920b |
| CC-3 | Two members Remove the SAME member at once | W1 W2 W4 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig b54469f9920b |
| CC-4 | A leaf refresh (unasked commit) races a member's Add | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig b54469f9920b |
| CC-5 | Burst: four devices each commit within 200 ms, ten rounds | W1 W2 W4 W5 - U | `pending` - BLOCKED-ON-ACCOUNT: needs a fifth campaign account |

## DUP - duplicate and retried commits (the settlement)

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DUP-1 | The commit lands and its ANSWER is lost | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig c0eb44e1900d |
| DUP-2 | DUP-1, and another member commits before our resubmission - a Remove; an intervening ADD during a held resubmission is covered by CC-1, not DUP-2 | W1 W2 W4 W5 - U | `PASS-DIRTY` (product) on `1.4.1-alpha.4` - every assertion held and the server was clean; the joiner received the next commit before its late Welcome - it now waits for it ([mls-protocol](protocols/mls-protocol.md#a-joiner-whose-first-frame-beats-its-welcome-waits-for-it-dup-2-2026-10-25)); the re-fetch after it re-reads a frame ([backlog](backlog.md#p3---a-re-fetch-after-a-late-welcome-re-reads-frames-the-live-socket-already-delivered-dup-2-2026-10-25)); predates rig c0eb44e1900d. To be replayed on alpha.5 |
| DUP-3 | The first request stalls past the server's 5 s commit lock while our resubmission arrives | - | `SKIPPED` - not played on the bench (Q2): unit coverage stands in |
| DUP-4 | A resubmission is answered `409 SEAT_CLAIM_OVERTAKEN` | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig c0eb44e1900d |
| DUP-5 | The commit is answered `503` | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig c0eb44e1900d |
| DUP-6 | The commit request never answers (30 s `write` deadline) | W1 W2 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product: the commit that never answers was not settled; fixed for alpha.5; predates rig c0eb44e1900d. To be replayed on alpha.5 |
| DUP-7 | An Add accepted only through a later resubmission still delivers its Welcome, once | W1 invites W4 (the third account) - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig cdbf5ba7263a. To be replayed on alpha.5 |

## OFF - offline during a commit

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| OFF-1 | Cut after the stage's checkpoint, before the POST leaves | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 06d5be3d143b |
| OFF-2 | Cut after the POST reached the server | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 06d5be3d143b |
| OFF-3 | The committer stays offline while the others advance three epochs | W1 W2 W4 - U | `PASS` (assertions) on `1.4.1-alpha.4` (dev.f49f499), recorded as a DEFECT, not a clean pass: the cut committer's add lock was freed by its 30 s TTL, not by a release, so the other member's Add waited on a clock ([backlog](backlog.md#p2---a-cut-holders-add-lock-ends-only-by-its-ttl-and-a-refused-waiter-sleeps-to-it-design-after-the-stable-off-3-2026-10-25)); predates rig 66efaf30890a |
| OFF-4 | A RECEIVER offline across ten commits and a hundred messages | W1 W2 - U | `pending` - BLOCKED-ON-ACCOUNT: needs a fifth campaign account |
| OFF-5 | The phone loses both radios in the middle of an Add it is making | +A1 - B | `ERROR` on `1.4.1-alpha.3`, the row threw before it could decide; BLOCKED-ON-RIG: the row holds A1's commit POST, and the Tauri apps send every first-party API call through `tauri-plugin-http`, below the WebView, where CDP `Fetch` cannot hold it (measured on A1 on 1.4.1-alpha.3, 2026-10-25); every row that faults the commit on A1 or the iPhone is blocked the same way. A radio cut timed around the commit would be a race. What would lift it: a fault point inside the app's routed fetch, in a bench build only (proposal, not built) |

## KILL - the process dies mid-commit

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| KILL-1 | Close the web tab at a random point between the stage and the answer, 20 runs | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 0b7fe696970b |
| KILL-2 | Kill Chrome's whole browser process at the same point (no unload handlers) | W1 W2 - U | `FAIL` on `1.4.1-alpha.4`, two PRODUCT findings: (A) while its first commit's answer was held, W1 built a second leaf refresh on top of it, and refreshed again after the revive - two commits no run armed; (B) a clean reload re-walked a control frame whose generation was already spent and reported it `unreadable for good (secret-reuse)`. The row's "2 accepts, the epoch moved 1" was also a RIG miscount (the epoch was read before the window opened), fixed: commits are now sorted by the epoch they name, a stray one fails the run, and each run keeps its dying and revived console. The alpha.4 runs recorded as 'answer unseen' were INVALID, not findings: every run saw its answer, and the kill-then-close order that misread it is fixed in the rig; predates rig 0b7fe696970b. To be replayed on alpha.5 |
| KILL-3 | W1's whole browser killed a short time after a send or a receive, 12 runs over four windows (moved from the A1 swipe on 2026-10-26: the A1 commit POST cannot be held, and the localStorage ratchet ledger and seen-marks are web-side) | W1 W2 - U | `pending` - the web row is written; it runs on `1.4.1-alpha.5` after the main replay, off the stable's critical path |
| KILL-4 | `am kill` during the checkpoint itself | +A1 - B | `pending` - BLOCKED-ON-RIG: as OFF-5 (its window is measured on a held commit); class B on A1 |
| KILL-5 | Kill between the merge of an Add and its Welcome send (`owed_welcome`) | W1 + W3 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 0b7fe696970b |

## GAP - epoch gaps and frame order

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GAP-1 | Application frames of epoch N+2 arrive before the commits N+1, N+2 | W1 W2 W4 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 93100c071abc |
| GAP-2 | A frame from a PAST epoch (own and others') | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 93100c071abc |
| GAP-3 | 2000+ frames in one epoch while one member is frozen (old HEAL-W3) | W1 W2 - U | `pending` - not yet played: it sends 2100 messages first (an estimate of about forty minutes, never measured), so it runs alone, not in the GAP phase |
| GAP-4 | A key-group frame stored ONCE, read by every seat (#2260): a community with five seats, two of them offline | W1 W2 W4 W5 +A1 - U+B | `SKIPPED` - not played on this build: the shared-payload writer stays OFF for 1.4.1 |

## RM - removal while a commit is in flight, and the removal bound

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| RM-1 | W1 removes W2 while W2's own Add is in flight | W1 W2 W4 - U | `pending` - no runner written yet; not yet scheduled |
| RM-2 | Remove a member while they send ten messages | W1 W2 - U | `pending` - no runner written yet; not yet scheduled |
| RM-3 | The remover dies after the roster delete and before the Remove commit lands | W1 W2 W4 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 0b7fe696970b |
| RM-4 | Two admins rewrite one salon's access list at once: each grants a different member | W1 W2 (both admins) - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig 614d54231694. To be replayed on alpha.5 |
| RM-4b | Two admins each revoke a different member of one private salon | W1 W2 (both admins) - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig 614d54231694. To be replayed on alpha.5 |
| RM-5 | A community kick races an invitation into a private salon for the same user | W1 W2 W4 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product: a salon grant landed after the member had been removed; predates rig 614d54231694. To be replayed on alpha.5 |
| RM-6 | A member holding only `channel.manage` makes a salon private while leaving off an admin | W1 W2 - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig 614d54231694. To be replayed on alpha.5 |
| RM-7 | A role demotion of the actor races their removal of someone | W1 W2 W4 - U | `pending` - no runner written yet; not yet scheduled |
| RM-8 | Leave a group while offline (#2259) | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 66efaf30890a |

## ADM - group-link admission, new and old clients

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| ADM-1 | A new person follows the group link (new clients everywhere) | W1 W2 + W4 joiner - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-2 | A member Declines | as ADM-1 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product: a stale re-add retry after a Decline re-lists the conversation; fixed for alpha.5 (#2493); predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-3 | Two members answer at once: one Adds, one Declines | W1 W2 + W4 - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-4 | : the waiting seat calls every member route from its own page (roster, members, enrol someone, mint a link, vouch, history, exclusions, call initiate/ring) | W4 waiting - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-5 | OLD joiner: A1 on the `v1.4.0` APK follows a link created on new clients | +A1 (old) W1 W2 - B | `pending` - needs A1 on the old v1.4.0 APK, installed by the operator (class B) |
| ADM-6 | OLD member: A1 on `v1.4.0` is a member when a NEW joiner follows the link | +A1 (old) W1 + W4 - B | `pending` - needs A1 on the old v1.4.0 APK, installed by the operator (class B) |
| ADM-7 | An external join by a non-member, from an old client, at the base | +A1 (old) - B | `pending` - needs A1 on the old v1.4.0 APK, installed by the operator (class B) |
| ADM-8 | The link in a 1:1 conversation and in a key group | W1 W2 - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean. The `ERROR` it recorded on the current rig (a user-id check written for UUIDs) is fixed in #2491; predates rig b937940da71c |
| ADM-9 | Declined, then re-invited by a new link: the Add built after the Decline admits | W1 W2 + W4 joiner - U | `pending` - added for `1.4.1-alpha.5` |
| ADM-10 | An Add held past a settled Decline: refused at the commit gate AND by the member-add route | W1 W2 + W4 - U | `pending` - added for `1.4.1-alpha.5` |

## DEV - device add, revoke, and the background Welcome

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DEV-1 | A new device of an existing member (W3 owner) | W1 W2 + W3 new - U, PIN | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig cdbf5ba7263a |
| DEV-2 | Revoke W3 from W1 | W1 W2 W3 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product, by ANALYSIS of the run's logs (the ledger records the failed assertions only): a 401 on the device's own revoked check is read as "unreachable", so the revoke reset never runs; predates rig cdbf5ba7263a. To be replayed on alpha.5 |
| DEV-3 | Revoke W3 while it is OFFLINE, then bring it back | W1 W2 W3 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product, by ANALYSIS of the run's logs (the ledger records the failed assertions only): the same 401 read as "unreachable" (the revoke reset never runs), and a 500 on a Welcome to a revoked device; predates rig cdbf5ba7263a. To be replayed on alpha.5 |
| DEV-4 | Two fresh devices enrol at the same instant (old HEAL-NEW-10) | W1 W2 + W3 W6 new - U, PIN | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig cdbf5ba7263a |
| DEV-5 | The same device id presents a NEW signature key (a copied profile re-keyed) | W1 + W3 copy - U | `pending` - not a runner row: attached to CORRUPT-8 and played later, blocked on Q5 |
| DEV-6 | A revoked device does not erase its owner's arrival (#2254) | W1 W3 W6 - U, PIN | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - rig race: the first invariant pass was judged during a commit in flight (the rig now settles first); predates rig cdbf5ba7263a. To be replayed on alpha.5 |
| DEV-7 | , its three variants: cold process, app opened inside the round trip, phone stale | +A1 killed, W1 W3 - B | `pending` - hand row, class B: A1 is swiped away by hand (variants cold, opened, stale) |

## BIG - a large group

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| BIG-1 | `campaign-big`: four users, twelve devices (W1-W8 + A1 + I1), created with one bulk Add | all - B | `pending` - class B: needs every seat including A1 and I1; scheduled for the alpha.5 replay |
| BIG-2 | 30 rapid messages from three senders while two commits land in the middle | all - B | `pending` - class B: needs every seat including A1 and I1; scheduled for the alpha.5 replay |
| BIG-3 | A community of twelve seats: a removal, then a new user | all - B | `pending` - class B: needs every seat including A1 and I1; scheduled for the alpha.5 replay |
| BIG-1-noI1 | BIG-1 without I1 (W1-W8 + A1), recorded under its own id while the iPhone reads no rows | W1-W8 +A1 - B | `PASS-DIRTY` - `1.4.1-alpha.5`: own 20/20 and the invariant held; dirt named (an old group's unsigned history, the phone arming trip fixed by #2533, the A1 history-coverage walk - a P3) |
| BIG-2-noI1 | BIG-2 without I1 | W1-W8 +A1 - B | `ERROR` - `1.4.1-alpha.5`: product finding, the desktop thread panel scrolled under a sr-only status label (fixed by #2535); replayed on `1.4.1-alpha.6` |
| BIG-3-noI1 | BIG-3 without I1 | W1-W8 +A1 - B | `ERROR` - `1.4.1-alpha.5`: product finding, a salon heard of live was lower-cased until a reload (fixed by #2538); replayed on `1.4.1-alpha.6` |

## TOK - a token expiring in the middle of an operation

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TOK-1 | The commit POST is answered `401` once | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig c0eb44e1900d |
| TOK-2 | The refresh itself fails as TRANSPORT during a commit | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 06d5be3d143b. To be replayed on alpha.5 |
| TOK-3 | The access token really expires (1 h TTL) while the socket stays open, then a commit and a reconnect | W1 W2 - U | `pending` - clock-only row: waits 61 min past the 1 h access token with the socket open, run alone and unattended; not yet scheduled |

## NET - a flaky network

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| NET-1 | A slow lossy link (800 ms, 50 kB/s) while a four-device Add runs | W1 W2 W4 W5 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 66efaf30890a |
| NET-2 | The socket flaps every 10 s for five minutes while commits and messages flow | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 66efaf30890a |
| NET-3 | A captive portal: every API call answered `200 text/html` | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 66efaf30890a |
