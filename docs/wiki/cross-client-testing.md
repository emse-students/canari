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
| FLOOR-1 | DM send both ways, then a reload, on the new build | W1 W2 - U | `pending` |
| FLOOR-2 | Create a fresh group the row mints (`FLOOR2-<mark>`), add three users' devices in one bulk Add | W1 W2 W4 W5 - U | `pending` |
| FLOOR-3 | The same group seen from A1 and I1 | +A1 +I1 - B | `pending` |

## CC - concurrent commits

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CC-1 | Two members Add two different users at the SAME epoch, released together | W1 W2 + targets - U | `pending` |
| CC-2 | A member Adds while another Removes someone, same epoch | W1 W2 W4 - U | `pending` |
| CC-3 | Two members Remove the SAME member at once | W1 W2 W4 - U | `pending` |
| CC-4 | A leaf refresh (unasked commit) races a member's Add | W1 W2 - U | `pending` |
| CC-5 | Burst: four devices each commit within 200 ms, ten rounds | W1 W2 W4 W5 - U | `pending` - BLOCKED-ON-ACCOUNT: needs a fifth campaign account |

## DUP - duplicate and retried commits (the settlement)

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DUP-1 | The commit lands and its ANSWER is lost | W1 W2 - U | `pending` |
| DUP-2 | DUP-1, and another member commits before our resubmission - a Remove; an intervening ADD during a held resubmission is covered by CC-1, not DUP-2 | W1 W2 W4 W5 - U | `PASS-DIRTY` (product) on `1.4.1-alpha.4` - every assertion held and the server was clean; the joiner received the next commit before its late Welcome - it now waits for it ([mls-protocol](protocols/mls-protocol.md#a-joiner-whose-first-frame-beats-its-welcome-waits-for-it-dup-2-2026-10-25)); the re-fetch after it re-reads a frame ([backlog](backlog.md#p3---a-re-fetch-after-a-late-welcome-re-reads-frames-the-live-socket-already-delivered-dup-2-2026-10-25)) |
| DUP-3 | The first request stalls past the server's 5 s commit lock while our resubmission arrives | - | `SKIPPED` - not played on the bench (Q2): unit coverage stands in |
| DUP-4 | A resubmission is answered `409 SEAT_CLAIM_OVERTAKEN` | W1 W2 - U | `pending` |
| DUP-5 | The commit is answered `503` | W1 W2 - U | `pending` |
| DUP-6 | The commit request never answers (30 s `write` deadline) | W1 W2 - U | `pending` |
| DUP-7 | An Add accepted only through a later resubmission still delivers its Welcome, once | W1 + new device W3 - U | `pending` |

## OFF - offline during a commit

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| OFF-1 | Cut after the stage's checkpoint, before the POST leaves | W1 W2 - U | `pending` |
| OFF-2 | Cut after the POST reached the server | W1 W2 - U | `pending` |
| OFF-3 | The committer stays offline while the others advance three epochs | W1 W2 W4 - U | `pending` |
| OFF-4 | A RECEIVER offline across ten commits and a hundred messages | W1 W2 - U | `pending` - BLOCKED-ON-ACCOUNT: needs a fifth campaign account |
| OFF-5 | The phone loses both radios in the middle of an Add it is making | +A1 - B | `pending` - BLOCKED-ON-RIG: the row holds A1's commit POST, and the Tauri apps send every first-party API call through `tauri-plugin-http`, below the WebView, where CDP `Fetch` cannot hold it (measured on A1 on 1.4.1-alpha.3, 2026-10-25); every row that faults the commit on A1 or the iPhone is blocked the same way. A radio cut timed around the commit would be a race. What would lift it: a fault point inside the app's routed fetch, in a bench build only (proposal, not built) |

## KILL - the process dies mid-commit

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| KILL-1 | Close the web tab at a random point between the stage and the answer, 20 runs | W1 W2 - U | `pending` |
| KILL-2 | Kill Chrome's whole browser process at the same point (no unload handlers) | W1 W2 - U | `pending` |
| KILL-3 | Swipe A1 away during a commit it is making, 10 runs | +A1 - B | `pending` - BLOCKED-ON-RIG: as OFF-5 |
| KILL-4 | `am kill` during the checkpoint itself | +A1 - B | `pending` - BLOCKED-ON-RIG: as OFF-5 (its window is measured on a held commit) |
| KILL-5 | Kill between the merge of an Add and its Welcome send (`owed_welcome`) | W1 + W3 - U | `pending` |

## GAP - epoch gaps and frame order

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GAP-1 | Application frames of epoch N+2 arrive before the commits N+1, N+2 | W1 W2 W4 - U | `pending` |
| GAP-2 | A frame from a PAST epoch (own and others') | W1 W2 - U | `pending` |
| GAP-3 | 2000+ frames in one epoch while one member is frozen (old HEAL-W3) | W1 W2 - U | `pending` |
| GAP-4 | A key-group frame stored ONCE, read by every seat (#2260): a community with five seats, two of them offline | W1 W2 W4 W5 +A1 - U+B | `SKIPPED` - not played on this build: the shared-payload writer stays OFF for 1.4.1 |

## RM - removal while a commit is in flight, and the removal bound

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| RM-1 | W1 removes W2 while W2's own Add is in flight | W1 W2 W4 - U | `pending` |
| RM-2 | Remove a member while they send ten messages | W1 W2 - U | `pending` |
| RM-3 | The remover dies after the roster delete and before the Remove commit lands | W1 W2 W4 - U | `pending` |
| RM-4 | Two admins rewrite one salon's access list at once: each grants a different member | W1 W2 (both admins) - U | `pending` |
| RM-4b | Two admins each revoke a different member of one private salon | W1 W2 (both admins) - U | `pending` |
| RM-5 | A community kick races an invitation into a private salon for the same user | W1 W2 W4 - U | `pending` |
| RM-6 | A member holding only `channel.manage` makes a salon private while leaving off an admin | W1 W2 - U | `pending` |
| RM-7 | A role demotion of the actor races their removal of someone | W1 W2 W4 - U | `pending` |
| RM-8 | Leave a group while offline (#2259) | W1 W2 - U | `pending` |

## ADM - group-link admission, new and old clients

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| ADM-1 | A new person follows the group link (new clients everywhere) | W1 W2 + W4 joiner - U | `pending` |
| ADM-2 | A member Declines | as ADM-1 - U | `pending` |
| ADM-3 | Two members answer at once: one Adds, one Declines | W1 W2 + W4 - U | `pending` |
| ADM-4 | : the waiting seat calls every member route from its own page (roster, members, enrol someone, mint a link, vouch, history, exclusions, call initiate/ring) | W4 waiting - U | `pending` |
| ADM-5 | OLD joiner: A1 on the `v1.4.0` APK follows a link created on new clients | +A1 (old) W1 W2 - B | `pending` |
| ADM-6 | OLD member: A1 on `v1.4.0` is a member when a NEW joiner follows the link | +A1 (old) W1 + W4 - B | `pending` |
| ADM-7 | An external join by a non-member, from an old client, at the base | +A1 (old) - B | `pending` |
| ADM-8 | The link in a 1:1 conversation and in a key group | W1 W2 - U | `pending` |

## DEV - device add, revoke, and the background Welcome

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DEV-1 | A new device of an existing member (W3 owner) | W1 W2 + W3 new - U, PIN | `pending` |
| DEV-2 | Revoke W3 from W1 | W1 W2 W3 - U | `pending` |
| DEV-3 | Revoke W3 while it is OFFLINE, then bring it back | W1 W2 W3 - U | `pending` |
| DEV-4 | Two fresh devices enrol at the same instant (old HEAL-NEW-10) | W1 W2 + W3 W6 new - U, PIN | `pending` |
| DEV-5 | The same device id presents a NEW signature key (a copied profile re-keyed) | W1 + W3 copy - U | `pending` - blocked on Q5 |
| DEV-6 | A revoked device does not erase its owner's arrival (#2254) | W1 W3 W6 - U, PIN | `pending` |
| DEV-7 | , its three variants: cold process, app opened inside the round trip, phone stale | +A1 killed, W1 W3 - B | `pending` |

## BIG - a large group

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| BIG-1 | `campaign-big`: four users, twelve devices (W1-W8 + A1 + I1), created with one bulk Add | all - B | `pending` |
| BIG-2 | 30 rapid messages from three senders while two commits land in the middle | all - B | `pending` |
| BIG-3 | A community of twelve seats: a removal, then a new user | all - B | `pending` |

## TOK - a token expiring in the middle of an operation

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TOK-1 | The commit POST is answered `401` once | W1 W2 - U | `pending` |
| TOK-2 | The refresh itself fails as TRANSPORT during a commit | W1 W2 - U | `pending` |
| TOK-3 | The access token really expires (1 h TTL) while the socket stays open, then a commit and a reconnect | W1 W2 - U | `pending` |

## NET - a flaky network

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| NET-1 | A slow lossy link (800 ms, 50 kB/s) while a four-device Add runs | W1 W2 W4 W5 - U | `pending` |
| NET-2 | The socket flaps every 10 s for five minutes while commits and messages flow | W1 W2 - U | `pending` |
| NET-3 | A captive portal: every API call answered `200 text/html` | W1 W2 - U | `pending` |
