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
| RM-5 | A community kick races an invitation into a private salon for the same user | W1 W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: all five cycles whole; the closing uncontested grant seats the subject, a salon message reaches them, and the tree holds one leaf per active device (no stale leaf); dirt is the deleted-salon read-mark 404 ([backlog](backlog.md#p3---a-read-mark-for-a-salon-that-no-longer-exists-is-retried-forever)) |
| RM-6 | A member holding only `channel.manage` makes a salon private while leaving off an admin | W1 W2 - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig 614d54231694. To be replayed on alpha.5 |
| RM-7 | A role demotion of the actor races their removal of someone | W1 W2 W4 - U | `pending` - no runner written yet; not yet scheduled |
| RM-8 | Leave a group while offline (#2259) | W1 W2 - U | `PASS` on `1.4.1-alpha.4` (dev.f49f499); predates rig 66efaf30890a |

## ADM - group-link admission, new and old clients

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| ADM-1 | A new person follows the group link (new clients everywhere) | W1 W2 + W4 joiner - U | `PASS-DIRTY` on `1.4.1-alpha.4` (dev.f49f499) - the server window was not clean; predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-2 | A member Declines | as ADM-1 - U | `FAIL` on `1.4.1-alpha.4` (dev.f49f499) - product: a stale re-add retry after a Decline re-lists the conversation; fixed for alpha.5 (#2493); predates rig b937940da71c. To be replayed on alpha.5 |
| ADM-3 | Two members answer at once: one Adds, one Declines | W1 W2 + W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: server clean; dirt is the deleted-salon read-mark 404 |
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
| DEV-2 | Revoke W3 from W1 | W1 W2 W3 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: server clean; dirt is the deleted-salon read-mark 404 and two `absorbed N seed(s)` debug lines on W3 |
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
| BIG-1-noI1 | BIG-1 without I1 (W1-W8 + A1), recorded under its own id while the iPhone reads no rows | W1-W8 +A1 - B | `PASS-DIRTY` - `1.5.0-alpha.1`: own and the invariant held; dirt is undeclared narration (restored messages marked unverified) |
| BIG-2-noI1 | BIG-2 without I1 | W1-W8 +A1 - B | `ERROR` - `1.4.1-alpha.5`: product finding, the desktop thread panel scrolled under a sr-only status label (fixed by #2535); replayed on `1.4.1-alpha.6` |
| BIG-3-noI1 | BIG-3 without I1 | W1-W8 +A1 - B | `FAIL` - `1.5.0-alpha.1`: FAIL-PRODUCT, pre-existing since `v1.4.0`, details in the private operations notes; seven of nine assertions held |

## LIST - a salon heard of live while its community's listing is in flight

Found by BIG-3-noI1 on A1 (2026-10-26); the cause and the fix are the backlog P2 "A salon heard of
live while its community's listing is in flight is deleted by that listing's clean-up". Runner
`archive/listrace.mjs`, table and judge `listracerows.mjs`. The subject's listing ANSWER is held
(`hold-answer once`), released under the client's own 20 s stall, and every wait is counted in rounds.
RED was `FAIL` on `1.4.1-alpha.6`, without the fix; GREEN on `1.5.0-alpha.1`, which carries it.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| LIST-RACE-1-W | W4 joins by link; W8 (same account) lists in session with its answer held; W1's salon heard while held is listed after the release | W1 W4 W8 - U | `PASS-DIRTY` - `1.5.0-alpha.1`: GREEN, the salon listed after the release (#2554); dirt named (a two-device key-group join race, backlog P3) |
| LIST-RACE-1-W-CTL | LIST-RACE-1-W with nothing held | W1 W4 W8 - U | `PASS-DIRTY` - `1.5.0-alpha.1`: listed in round 1 |
| LIST-RACE-1-A1 | W1's first salon starts A1's listing, held; a second salon heard while held is listed after the release | W1 +A1 - B | `PASS-DIRTY` - `1.5.0-alpha.1`: GREEN on the phone, the salon listed after the release (#2554) |
| LIST-RACE-1-A1-CTL | LIST-RACE-1-A1 with nothing held | W1 +A1 - B | `PASS-DIRTY` - `1.5.0-alpha.1`: listed in round 1 |

## COMM - communities, salons and their permissions

Replayed on `1.5.0-alpha.1` (2026-10-27) and, where the rig was repaired, on `1.5.0-alpha.2` (the same code plus the store text). The dirt behind every `PASS-DIRTY` is named in the ledger. The rig rot met on the way: the seats run below the `xl` breakpoint, where a `SidePanel` is a drawer whose scrim takes every click beside it.

| ID | What | Seats | Verdict |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1`, after the rig read the token apart from its per-read admission fragment |
| COMM-3 | An expired link, a `maxUses`-exhausted one, a REVOKED one and one to a deleted community all refused, and the rotation's new link accepted as the positive control | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-4 | The `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-5 | Promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-6 | SIX enforced permissions and no seventh, the three default roles as documented, and a toggle reaching the column a decision reads | `W1` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1`, after the rig closed the drawer scrim below `xl` |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-9 | Removed from a salon: routing rows dropped (`evicted=true`), the next message sealed under a session they do not hold | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` (with COMM-10) |
| COMM-10 | Removed from a salon: what they ALREADY hold stays readable - Graine retains seeds on purpose | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` (with COMM-9) |
| COMM-11 | Kicked from the COMMUNITY: the workspace purged and every private salon group left | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1`, after the rig closed the drawer scrim below `xl` |
| COMM-12 | Re-invited after a removal: sessions minted from now on, and the past only as `history_visibility` allows; a new device under `joined` (W3), and the rule widened under a member already in | `W1 W2 W3` | `VACUOUS` - `1.5.0-alpha.2` (same code): product defect - the saved history rule is not applied from the live frame ([backlog](backlog.md#p2---the-history-rule-saved-by-an-admin-is-not-applied-from-the-live-frame)) |
| COMM-13 | An admin JOINS a salon: 403 before and 200 after, the member list gains them, the transcript gains NOTHING | `W1 W2` | `VACUOUS` - `1.5.0-alpha.1`: the premise never arms on a live client - an online admin is not told of a new private salon ([backlog](backlog.md#p3---an-admin-who-never-joined-a-private-salon-is-not-told-when-it-is-created-or-deleted)) |
| COMM-14 | Channel notification levels enforced server-side | `W1 W2` +push | `PASS-DIRTY` - `1.5.0-alpha.2` (same code), on a private salon holding the owner and the peer (the venue gained accounts) |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.2` (same code), after the rig read wrapped labels and answered the app's own close confirmation (#1798) |
| COMM-16 | Delete a channel, then a community by typing its name: the rows really gone, the slug free again | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `PASS-DIRTY` - `1.5.0-alpha.1` and `1.5.0-alpha.2` (same code) on a clean rail |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `PASS-DIRTY` - `1.5.0-alpha.1`, after the rig took a cold-start WebView's empty URL as inert |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `FAIL` - FAIL-PRODUCT, details in the private operations notes |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.1` |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `PASS-DIRTY` - `1.5.0-alpha.2` (same code), after the rig closed the access drawer after the flip |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `PASS-DIRTY` - `1.5.0-alpha.2` (same code) |

## CALL - in-app 1:1 audio calls between two browsers

Runner `archive/callweb.mjs`, table, judges and narration `callrows.mjs`. W2 calls W4 in their DM;
W5 is CALL-WEB-7's second caller; CALL-WEB-6 closes W4 and W8, every device of the callee. Each seat
captures its OWN tone, read off its microphone before the row: on one shared beep, W2's echo
canceller learnt its own beep coming back and CALL-WEB-2 failed six times as a rig artifact (voided
`INVALID`). Every wait is counted in rounds; the unanswered rows wait 90 s, past the server's 60 s
ring window. The first readings were a scratch runner; the repo row replays them.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CALL-WEB-1 | W2 calls W4, W4 accepts: connected, audio heard both ways, W2 hangs up, both end | W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: dirt is chat-delivery `CallsService` ring/presence debug lines no rule scopes |
| CALL-WEB-2 | W2 mutes and unmutes mid-call: W4 hears under 1 %, then at least 20 % again | W2 W4 - U | `FAIL` - `1.5.0-alpha.2`: muted to 2.1 % of the baseline (bar 1 %), back to 14 % after the unmute (bar 20 %), on a baseline of 4.8 %; a steady tone is what noise suppression learns to remove, so rig versus product is not separated |
| CALL-WEB-2q | CALL-WEB-2 with W4 muted first, the scratch diagnostic of the shared beep | W2 W4 - U | `PASS-DIRTY` - `1.4.1-alpha.6`: with no echo of its own beep, W2 is heard again after the unmute; the repo row has no such variant |
| CALL-WEB-3 | the callee hangs up a connected call: both end | W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |
| CALL-WEB-4 | W4 declines while ringing: both end, never connected | W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |
| CALL-WEB-5 | W2 hangs up while W4 rings: W4's ring stops, W2 ends | W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |
| CALL-WEB-6 | every device of the callee closed: W2 rings until the server's 60 s window closes | W2, W4 W8 closed - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |
| CALL-WEB-7 | W5 calls W4 while W4 is in a call: W4 not rung over it, the call keeps flowing | W2 W4 W5 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |
| CALL-WEB-8 | W4's page reloads mid-call: W2's call ends | W2 W4 - U | `PASS-DIRTY` - `1.5.0-alpha.2`: chat-delivery ring/presence debug lines |

## LIVE - a live broadcast, watched from the web

LIVE-WEB-1 and -3 were read with a scratch runner (2026-10-26). LIVE-WEB-2 and LIVE-STALL-1 are repo
rows since 2026-10-27: `bun run.mjs --file liveweb.mjs --row <id>` (`liverows.mjs`), judged on each
viewer's own `[LIVE]` lines IN ORDER - a stall after the viewer's first delivery gap, or stalls with no
gap at all, fail the row (L-F1). The two `1.5.0-alpha.2` readings below are L-F1's BEFORE baseline:
that build predates the fix (#2583); the AFTER reading is owed on the pre-release carrying it. What each reading holds against the `lives_mode` flip is on
[live](frontend/modules/live.md#the-first-rig-readings-and-what-they-hold-against-the-lives_mode-flip-live-web-2026-10-27).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| LIVE-WEB-1 | W2 goes live from desktop Chrome; W4 and W5 watch from the feed card; W2 ends | W2 W4 W5 - U | `ERROR` - `1.4.1-alpha.6`: ERROR-PRODUCT, a desktop camera reports no facing and the live asks an exact one (#2574, after the stable) |
| LIVE-WEB-2 | A1 goes live as a member; W2 and W4 see the card, play, are counted; A1 ends and both see the end; no viewer stalls after its first delivery gap | A1 W2 W4 - B | `FAIL` - `1.5.0-alpha.2` (dev.6c5d9ef, A1 8cd51abf): every other fact held; W2 stalled 6 times and W4 4 times in a 6 s watch, neither named a delivery gap (L-F1, before #2583) |
| LIVE-STALL-1 | L-F1: A1 broadcasts for a minute to W2 and W4; no viewer stalls after its first delivery gap; each target buffer is recorded | A1 W2 W4 - B | `FAIL` - `1.5.0-alpha.2` (dev.6c5d9ef, A1 8cd51abf): W2 stalled 29 times and W4 26 times in 60 s, no delivery gap named (L-F1, before #2583); server window clean; A1 sealed 8 of 30 chunks as fragment pairs |
| LIVE-WEB-3 | LIVE-WEB-2 with W4's account following the broadcaster: the announcement names one follower | A1 W2 W4 - B | `PASS-DIRTY` - `1.4.1-alpha.6`: `followers=1`, the push found no token on a web account (a device reading is owed) |

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
