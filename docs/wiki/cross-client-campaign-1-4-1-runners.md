# The 1.4.1 campaign - how each blocking row is run and recorded

**Companion to [cross-client-campaign-1-4-1](cross-client-campaign-1-4-1.md), section 4.2** (the rows
that block the `1.4.1` stable). That page says WHAT each row asks; this one says HOW a row is played,
how its verdict reaches `results.ndjson`, and what the rig still lacks. Written 2026-10-24, when no
row had a runner: the rig had only building blocks (`fault.mjs`, `invariant.mjs`, the server window,
the R5 fixtures, `a1apk.mjs`) and gesture scripts from earlier campaigns.

**Nothing on this page has run against a live client.** Every row waits for the web MLS worker P1
on `1.4.1-alpha.2` to be fixed and a new pre-release to reach dev (plan section 5, step 1).

## 1. One contract for every row

Every runner below does the same six things, and only the action differs:

1. **Open and watch the seats the row names** from its first line (`mlsrow.mjs` `openSeats`: phones
   armed first, every seat `watch()`ed), so the whole row's console is judged, not the probe's seconds.
2. **Act only in a campaign-owned conversation (R5)** - a fixture of `campaign-fixtures.mjs`, or a
   group the row mints (`<GROUP><n>-<mark>`, `mintRowGroup`, recorded with its id and swept by
   `debris.mjs`). `site.mjs` refuses production at import (R1).
3. **Read the server's view before and after** (`serverView`: active epoch, commit-log epochs,
   roster, device seats) and the delivery service's `[COMMIT]` lines (`commitLines`).
4. **Run the invariant of section 4.0 after the action (R8)**, with its reload, on every client in
   play - BEFORE the reports, because `report()` drains what the invariant reads.
5. **Compose the verdict** (`rowkit.mjs` `composeVerdict`): `INVALID` when the premise could not be
   built, `VACUOUS` when an armed fault never fired (`fault.mjs` `report().vacuous`), `FAIL` on any
   own assertion or invariant, else `PASS`.
6. **Record it gated** (`finishObserved` with `serverWindowSince`): every seat's window, the deploy
   exclusion (R4, inside `gate()`) and the server window judged BY THE ROW ID (R6, `srvlog.mjs`
   `ROW_RULES`). A clean assertion over a dirty window lands `PASS-DIRTY`. Teardown runs after the row
   is on disk.

A concurrency row is played five times (`bun archive/run.mjs <PHASE> --repeat 5`); the verdict is the
set, as the plan says.

## 2. The runner set - ten files, by the SHAPE of the action

The smallest set is not one runner per row group: several groups share one action shape, and a runner
is one table plus one action per shape. Each holds its pure judgements in `<name>rows.mjs`, pinned by
`archive/<name>-selftest.mjs` in `make test-harness`.

| Runner | Rows | The action shape | State |
| --- | --- | --- | --- |
| `archive/floor.mjs` | FLOOR-1..3 | plain sends and one bulk Add | built ([#2393](https://github.com/emse-students/canari/pull/2393)) |
| `archive/race.mjs` | CC-1..5, RM-1, RM-2, RM-7 | two (or four) actions held by `fault.mjs` `hold` and released together | CC-1..4 built as `archive/cc.mjs` ([#2395](https://github.com/emse-students/canari/pull/2395)); RM owed |
| `archive/settle.mjs` | DUP-1..6, OFF-1, OFF-2, TOK-1..3 | a commit whose ANSWER is lost, refused or late; the settlement | built ([#2396](https://github.com/emse-students/canari/pull/2396)); DUP-3 records `SKIPPED`; DUP-7 moved to `devrows.mjs` (a new device) |
| `archive/offline.mjs` | OFF-3..5, NET-1..3, RM-8 | a seat without network, or a degraded one, for a duration | owed |
| `archive/gap.mjs` | GAP-1..3 | frames reordered, replayed or flooded against a frozen member | owed |
| `archive/kill.mjs` | KILL-1..5, RM-3 | a process killed at a point of the commit | owed |
| `archive/admit.mjs` | ADM-1..8 | a group link, an ask, Add or Decline, and the waiting seat's probes | owed |
| `archive/devrows.mjs` | DEV-1..4, DEV-6, DEV-7, DUP-7 | a device minted, revoked or woken | owed |
| `archive/salon.mjs` | RM-4..6 | two admins rewriting one salon's access | owed |
| `archive/big.mjs` | BIG-1..3 | everything at twelve devices | owed |

## 3. Row by row

`Atom` is what the rig already has; `Missing` is what the runner still needs. **Human** means a
person at a device, not the lead driving the bench. Cost is the plan's, five runs.

### FLOOR

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| FLOOR-1 | one marker each way in the fixture DM, timed from the send (receiver already waiting); re-counted after the invariant's reload | `send`, `awaitMessage`, `receivedOn`, `checkInvariant` | - | no | U | 10 min |
| FLOOR-2 | W1 mints `FLOOR2-<mark>`, ONE `addMembers` of peer, third, fourth; one commit, epoch +1, every seat active | `mintRowGroup`, `addMembers`, `serverView` | - | no | U | 15 min |
| FLOOR-3 | FLOOR-2's last group (ledger) with A1 and I1 in play as members; one tree across six clients | `openSeats` arms both phones | the fingerprint is an APPROXIMATION (not exposed to the page) | no - the rig unlocks I1 over WDA (Q4); TestFlight install on I1 once | B | 15 min |

### CC - concurrent commits (`race.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| CC-1 | a minted group of owner + peer; W1 Adds third, W2 Adds fourth, both POSTs `hold once`, released together; exactly one winner, the loser refused with a typed race refusal (`epoch_mismatch` or `concurrent_commit`, recorded, not judged), rebuilt and accepted, both users in | `fault.mjs` `hold`, `commitLines`, `addMembers` | - (a refusal answers `201`, nothing to forgive) | no | U | 30 min |
| CC-2 | as CC-1, one side Removes W4's user | as CC-1 | - (`removeMember` moved to `archive/addmember.mjs`) | no | U | 30 min |
| CC-3 | two seats Remove the same member; ONE commit lands, no second Remove rebuilt | as CC-2 | as CC-2 | no | U | 30 min |
| CC-4 | backdate the refresh ledger on W1 (a device that has COMMITTED in the group), trigger by a send, `hold` the refresh and W2's Add, release | `fault.mjs`, `armLeafRefresh` | - | no | U | 30 min |
| CC-5 | **BLOCKED-ON-ACCOUNT**. Four seats each commit within 200 ms, ten rounds | `fault.mjs` `hold` x4 | what each seat commits: an Add of someone not yet in - **a fifth campaign account** (the last joiner has nobody left to Add) | the user creates the account (one-off) | U | 30 min |

### DUP - the settlement (`settle.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| DUP-1 | `lose-answer once` on the commit POST; `[COMMIT] DUPLICATE` on the resubmission; one commit-log row | `fault.mjs`, `commitLines` | - | no | U | 20 min |
| DUP-2 | DUP-1, then W4 commits (an Add), then the resubmission | as DUP-1 | ordering W4's commit between the lost answer and the retry: `hold` the retry | no | U | 30 min |
| DUP-3 | **not played** (Q2): unit coverage stands in | - | the runner records `SKIPPED` with the reason, so the board shows it decided, not forgotten | no | - | - |
| DUP-4 | `lose-answer once`, then `status 409 once` on the resubmission | `fault.mjs` two rules | confirm rule precedence (first unspent match) in `fault-selftest` | no | U | 20 min |
| DUP-5 | `status 503 once`; sends blocked in that group only, settled at the next gateway connection | `fault.mjs`, `net.mjs` `cutHard` to force the reconnection | invariant 4 counts a fault-PROVOKED 5xx as dirt: `checkInvariant` needs the armed rules' records to forgive exactly those | no | U | 20 min |
| DUP-6 | `hold-answer` > 30 s twice while a second group sends | `fault.mjs` `hold-answer` | a second minted group on the same seats | no | U | 30 min |
| DUP-7 | `lose-answer` on an Add of a NEW device (W3), reload between merge and Welcome send | `newdevice.mjs` (W3 wipeable) | the reload point: the merge line (`awaitLine`) | no | U, PIN | 30 min |

### OFF - offline during a commit (`settle.mjs` for 1-2, `offline.mjs` for 3-5)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| OFF-1 | `hold` the POST, `cut()`, release on reconnect | `fault.mjs`, `net.mjs` `cut` | - | no | U | 20 min |
| OFF-2 | `lose-answer` + `cutHard()`; the reconnect answers `duplicate` | `fault.mjs`, `net.mjs` | - | no | U | 20 min |
| OFF-3 | W1 `cutHard()` while W2 and W4 move three epochs; on return the stage is refused, cleared, re-issued | `net.mjs`, `addMembers` | the invariant run with `expectStage` false AFTER the return | no | U | 30 min |
| OFF-4 | **BLOCKED-ON-ACCOUNT**. W2 `cutHard()` across ten commits and a hundred messages | `net.mjs` | ten commits need ten membership changes: Add/Remove of the fifth account in a loop | fifth account | U | 20 min |
| OFF-5 | A1 loses both radios mid-Add (`svc wifi/data disable`) | `phone.mjs` radio control | timing the cut on A1's stage line (logcat) | no | B | 30 min |

### GAP (`gap.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| GAP-1 | `hold` W2's history fetch while the socket delivers N+2 frames | `fault.mjs` `hold` | the history route's exact path for the rule | no | U | 30 min |
| GAP-2 | replay a captured past-epoch frame (own and another's) | - | a **response-rewrite** fault mode (capture a frame, deliver it later) | no | U | 20 min |
| GAP-3 | 2000+ frames while W2 is frozen | - | a **freeze** atom (`Debugger.pause` over CDP) and a fast sender | no | U | 45 min |
| GAP-4 | **not played on this build** (the shared-payload writer stays OFF) | - | records `SKIPPED` with the reason | no | - | - |

### RM - removal (`race.mjs` 1, 2, 7; `kill.mjs` 3; `salon.mjs` 4-6; `offline.mjs` 8)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| RM-1 | `hold` W2's own Add, W1 Removes W2, release | `fault.mjs` | extracted `removeMember` | no | U | 30 min |
| RM-2 | Remove while the removed member sends ten | `send` | the typed refusal read on the sender | no | U | 20 min |
| RM-3 | close the remover's tab on the roster-delete answer; measure how long until a later commit removes the leaf | - | a `Target.close` atom timed on a response | no | U | 30 min |
| RM-4 | two admins PATCH one salon's access, released together | `comm.mjs` `openChannelSettings`, `fault.mjs` `hold` | the second admin role on W2 in the venue | no | U | 30 min |
| RM-5 | a kick races an invitation into a private salon, x5 | as RM-4 | - | no | U | 30 min |
| RM-6 | a `channel.manage`-only member makes a salon private leaving out an admin | `comm.mjs` | a role holding only `channel.manage` | no | U | 15 min |
| RM-7 | the actor's demotion races their removal of someone | `fault.mjs` | the demotion gesture | no | U | 20 min |
| RM-8 | leave a group while `cut()` | `net.mjs` | extracted `leaveGroup` | no | U | 15 min |

### KILL (`kill.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| KILL-1 | `Target.close` at a random 0-800 ms after the stage, 20 runs | - | the `Target.close` atom and a reopen of the profile's app tab | no | U | 40 min |
| KILL-2 | kill the profile's whole browser, relaunch | `launch.mjs` `kill` / `start` | timing the kill on the stage | no | U | 40 min |
| KILL-3 | swipe A1 from recents mid-commit, 10 runs | `phone.mjs` | a recents swipe atom | no | B | 50 min |
| KILL-4 | `am kill` on the `[CHECKPOINT]` start line | `phone.mjs`, logcat | the line-triggered kill | no | B | 40 min |
| KILL-5 | close W1's tab on the Add's merge line, before the Welcome send | - | as KILL-1 | no | U | 30 min |

### ADM - group-link admission (`admit.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| ADM-1..3 | W4 follows a group link; the ask on every member; Add, Decline, or both at once | - | gestures: mint a group link, follow it, answer the ask (Add / Decline) | no | U | 65 min |
| ADM-4 | the waiting seat calls every member route from its own page; each `409 awaiting_admission` | `chat.mjs` authenticated request from the page | the route table | no | U | 20 min |
| ADM-5..7 | A1 on the `v1.4.0` debug APK (Q8 built it) as joiner, as member, as an external joiner | `a1apk.mjs`, `apkbuild.mjs` | the install swap and back to R2's APK | no | B | 95 min |
| ADM-8 | the link in a 1:1 and in a key group raises no ask | as ADM-1 | - | no | U | 10 min |

### DEV (`devrows.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| DEV-1 | W3 becomes a new owner device | `newdevice.mjs` | the notice counted once per device | no | U, PIN | 20 min |
| DEV-2, -3 | revoke W3 from W1, online then offline | `purge-devices.mjs` (recorded devices only) | the revoke GESTURE in the device list | no | U | 60 min |
| DEV-4 | two fresh devices enrol at the same instant | `newdevice.mjs` | a second wipeable seat **W6** (`WIPEABLE` allows W3 only) | no | U, PIN | 30 min |
| DEV-5 | **blocked on Q5** (how one device id presents a new key without a product seam) | - | the answer to Q5 | - | - | - |
| DEV-6 | revoke one device, then a new one of the same owner reads from the original arrival | `newdevice.mjs` | W6, as DEV-4 | no | U, PIN | 30 min |
| DEV-7 | the background Welcome on A1, three variants; trigger: `status 503` on the newcomer's `group-info` | `fault.mjs`, `phone.mjs`, logcat | the three variants' timing | no | B | 90 min |

### BIG (`big.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| BIG-1..3 | `campaign-big` at twelve devices: one bulk Add, a burst with two commits, a community removal then a newcomer | `addMembers`, `campaign-fixtures.mjs` | seats **W6-W8** (`launch.mjs`, `names.mjs`); the checkpoint time read on A1 and I1 | Q4 for I1 | B | 115 min |

### TOK, NET (`settle.mjs`, `offline.mjs`)

| Id | How it is run | Atom | Missing | Human | Class | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| TOK-1 | `status 401 once` on the commit POST; refresh then the SAME bytes | `fault.mjs` | - | no | U | 20 min |
| TOK-2 | `lose-answer` on `/api/auth/refresh` during a commit | `fault.mjs` | - | no | U | 20 min |
| TOK-3 | wait 61 min with the socket open, then a commit and a reconnect | - | nothing but the clock; unattended | no | U | 75 min |
| NET-1 | 800 ms, 50 kB/s during a four-device Add | `net.mjs` `throttleUpload` (upload only) | a full `emulateNetworkConditions` helper (latency + both directions) | no | U | 20 min |
| NET-2 | `cutHard()` every 10 s for five minutes while commits and messages flow | `net.mjs` | the flap loop | no | U | 20 min |
| NET-3 | every `/api/*` answered `200 text/html` | `fault.mjs` `status 200` with a string `body` (since #2396) | - | no | U | 20 min |

## 4. What cannot be automated, and how it is recorded instead

- **DUP-3 and GAP-4 are decided, not owed.** Their runner records `SKIPPED` with the plan's reason
  (Q2; the shared-payload writer OFF), so `bun rows.mjs` shows a decision rather than a gap.
- **DEV-5 waits on Q5.** Until answered, it is `pending` on the board, never `SKIPPED`.
- **The I1 rows (FLOOR-3, BIG-1..3) need no person** (Q4 settled): the rig unlocks the iPhone with
  `tools/ios-device/ios.mjs unlock` and types the PIN from stdin, from the private notes. If WDA ever
  stops answering, the lead asks for the unlock, runs the row unchanged, and the row carries the
  fact (the iPhone was unlocked by hand) in its detail.
- **CC-5 and OFF-4 are BLOCKED-ON-ACCOUNT**: they need a fifth campaign account, which the lead asks
  the owner for. `pending` on the board, with that reason.
- **The board**: Q6 settled - the old board is archived at
  [cross-client-testing-archive-1-4-0](cross-client-testing-archive-1-4-0.md) and
  [cross-client-testing](cross-client-testing.md) holds exactly these rows.
- **A gesture only a person can make** (none in section 4.2 today; the `O` rows of 4.3) is recorded
  by a small `archive/handrow.mjs --row <id> --verdict <V> --what "<observed>"` (owed): it records
  with the SERVER window (`serverWindowSince` = the start the lead gives) and states the client side
  `unobservable` in the detail, so a person's observation is never written as a watched `PASS`.
- **One-off actions for the user**: install the pre-release from TestFlight on I1; authorise adb on
  A1 if it reports `unauthorized`/`offline`; create the fifth campaign account (CC-5, OFF-4); add
  W4/W5 (and W6-W8 for BIG) to the machine-local `names.mjs`.

## 5. Two findings against the plan

- **FLOOR-2 could not ask its question on `campaign-g4`.** The fixture is built at step 2, before
  FLOOR, by an idempotent script, so the row would observe a creation that already happened, and every
  FLOOR re-run after a product fix would observe none. Resolved at the cause, both sides: the row mints
  its own `FLOOR2-<mark>` each draw and does ONE bulk Add there; the fixture builds every group with
  the same single bulk Add (`addMembers`), so its history is the product's ordinary path rather than
  one commit per member. The plan's row text says so now.
- **Q3's premise is wrong: the leaf-refresh ledger is not a Redis key.** It is CLIENT `localStorage`,
  `mls_leaf_refresh:<user>:<device>`, holding per group `{at, epoch, observed?, mintedAtSec?}`
  (`frontend/src/lib/mls-client/leafRefresh.ts`). A leaf this device's own commit produced is due at
  `at + 7 days`; a KeyPackage-dated leaf (a device that only received a Welcome) is dated by the key
  package and cannot be backdated that way; the trigger is the device sending. So CC-4 writes NOTHING
  on the server: it rewrites `at` on a campaign device that has already committed in the row's group,
  then sends. The lead accepted the correction; Q3 on the plan now says so.

## 6. What is left, in runner work

Measured against the FLOOR runner (one session including the kernel), the rest is roughly:

| Runner | New atoms it needs | Estimate |
| --- | --- | --- |
| `race.mjs` | `removeMember`/`leaveGroup` extracted, `armLeafRefresh` | 1 session |
| `settle.mjs` | fault forgiveness inside `checkInvariant` | 1 session |
| `offline.mjs` | `emulateNetworkConditions` helper, flap loop | 0.5 session |
| `gap.mjs` | response-rewrite fault mode, freeze atom | 1 session |
| `kill.mjs` | `Target.close` timed on a line, recents swipe, line-triggered `am kill` | 1 session |
| `admit.mjs` | link, ask, Add/Decline gestures; route table | 1 session |
| `devrows.mjs` | revoke gesture, W6 wipeable | 1 session |
| `salon.mjs` | admin roles in the venue | 0.5 session |
| `big.mjs` | W6-W8 seats | 0.5 session |
| `handrow.mjs` | - | 0.1 session |

About **eight sessions of desk work**, each with selftests only, then the live runs the plan's section
5 already costs. Every runner's first live draw is its real test: nothing above has met a client yet.
