# Cross-client testing - the board

**State only.** Each check, what it asks, what it needs, and the verdict with the commit it ran on.
No commentary: the campaign's shape is [cross-client-campaign](cross-client-campaign.md), how a result
earns belief is [testing-methodology](testing-methodology.md), the instrument is
[`tools/cross-client-harness/README.md`](../../tools/cross-client-harness/README.md), the story of
every defect is `CHANGELOG.md`, and what is still open is `CLAUDE.md`.

Two accounts, anonymised everywhere as **owner** (W1, A1) and **peer** (W2). Target is PRODUCTION.

**A `PASS` CELL SAYS `PASS X/X` AND A TIME IF THE TIME MEANS ANYTHING. Nothing else.** A cell keeps
prose in exactly two cases: the verdict is not a clean pass (`PASS-DIRTY`, `FAIL`, `SKIPPED`, a
partial like `4/5`), or the row carries an unresolved item - a missing `a1Build`, an owed re-run.
Both are open state, which is what this file is. Everything a hard-won run cost to get goes to
[cross-client-campaign](cross-client-campaign.md); everything that was a defect goes to
`CHANGELOG.md`. The build belongs on the PHASE row, once, not on twelve check rows.

## Standing

Updated after every run.

| Phase | Scripts | Last build | State |
| --- | --- | --- | --- |
| 0 SETUP | - | - | 5/9 `passed`; SETUP-2 skipped by decision, SETUP-7/8 owed before CORRUPT and PIN |
| 1 MSG | 12 | `e9d951d7` | **12/12 `PASS` x1** (2026-08-21), all clients clean, server clean. Four A1 rows carry no `a1Build` - the runners never recorded it; the preflight does now, so they are owed a re-run for attribution alone |
| 2 TYPE | 5 | `e9d951d7` | **5/5 `PASS` x1** (2026-08-21), server clean. An earlier 5/5 x5 stands on superseded runner `25376b86` |
| 3 READ | 10 | `70497810` | **9/9 runnable `PASS` x5 - 45 verdicts, CLEAN 5/5**, server clean every pass (2026-08-21), runner `2c2b83d1b748`. READ-5 `SKIPPED`: needs four readers, the estate has two accounts |
| 4 MUT | 21 | `6748f6b8` | **CLEAN x5 2026-08-22** on runner `e3e5a60bb007` (+ x1 on `fbf202d9d9d9`), fleet homogeneous on `6748f6b8`: 24 of the 25 verdict rows `PASS` 5/5 (21 checks, four of which run in both venues), MUT-20 `SKIPPED` (unarmable until 2026-11-09). MUT-18 found a real convergence defect - two devices of one account edited one message and settled on different bodies, permanently and silently - now fixed and pinned |
| 5 SEARCH | 6 | - | `pending` |
| 6 MENTION | 6 | - | `pending` |
| 7 FWD | 5 | `25376b86` | 5/5 `passed` - 20 verdicts, 20 `PASS`; FWD-2 25/25 by hand |
| 8 GRP | 9 | - | `pending` |
| 9 COMM | 22 | - | `pending` |
| 10 DEL | 10 | - | `pending` |
| 11 TAB | 8 | - | `pending` |
| 12 MULTI | 6 | - | `pending` |
| 13 LIFE | 8 | - | `pending` |
| 14 NOTIF | 15 | - | `pending` |
| 15 CALL | 20 | - | `pending` - no script exists yet |
| 16 HEAL | 5 | - | `pending` |
| 17 PIN | 10 | - | `pending` |
| 18 CORRUPT | 10 | - | `pending` |

**Run order is the numbered ladder above, top to bottom.** It is the only copy of that order.

| State | Meaning |
| --- | --- |
| `PASS` / `passed` | ran, assertions held, run was clean - and the row names the build |
| `PASS-DIRTY` | ran, assertions held, and a client logged something no rule classifies - `gate()` demotes it, and the row NAMES the line. Not a pass: the campaign ends green or it does not end |
| `VACUOUS` | ran and proved nothing - never armed, or production was redeployed under it (`deploy.mjs`) |
| `pending` | not run against the current build |
| `FAIL` | ran and did not hold - paired with a Work Package carrying the log, or with a fixed commit |
| `SKIPPED` | cannot be armed with two accounts, or needs `--destructive` |
| `BLOCKED` | cannot run until something outside the campaign happens |

## The baseline `recon.mjs` starts from - established 2026-08-19

`LOSS` on the W1/W2 pair is the EXPECTED verdict until the number changes. **Five** message ids, all
on W1 only, all created 2026-08-16 between 09:45 and 16:27 UTC. A run reporting five has found
nothing; a sixth is new. Do not clear them - the divergence is the evidence. Why they are believed to
have never left the sender is WP-ECHO-1's, in [backlog](backlog.md).

## 0 - SETUP

| Id | Step | Needs | State |
| --- | --- | --- | --- |
| SETUP-1 | Build the debug APK, plus the jniLibs `.so` rescue | `+A1` | `passed` 2026-08-14 |
| SETUP-2 | Clean uninstall + install (wipes `mls.bin`) | `+A1` | `skipped` - deliberate; `install -r` keeps the store and avoids re-paying SETUP-4's 2FA |
| SETUP-3 | Start logcat | `+A1` | re-run each session |
| SETUP-4 | W1: log in as owner, enrol the device, set the PIN | `+user` | `passed` 2026-08-14 |
| SETUP-5 | W2: log in as peer, set the PIN | `W1 W2` | `passed` 2026-08-14 |
| SETUP-6 | A1: log in as owner, decline biometrics | `+A1` `+user` | `passed` 2026-08-14 |
| SETUP-7 | Discovery pass over the real at-rest artefacts | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-8 | Baseline snapshot of intact Android app data | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-9 | The dedicated venue for channel traffic | `W1 W2` | `passed` 2026-08-19 - recreated through the UI after the 2026-08-17 purge |

## 1 - MSG - the plain path

`226fe755`, 2026-08-16: 12 verdicts, 12 `PASS`, every client clean, server clean over the run's own
window. Earlier x5 series on `8a3edbdd`, `e62c21f1` and `25376b86` all read 13/13.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `W1 W2` | `PASS` - 325 ms |
| MSG-1-cold | Same, after a reload | `W1 W2` | `PASS` - 326 ms |
| MSG-1b | Delivery DURING a history load | `W1 W2` | `PASS` - 3 ms |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `+A1` | `PASS` - 578 ms. **No `a1Build`** - re-run owed for attribution (see the phase note) |
| MSG-3 | Reply renders with its quoted parent on both sides | `W1 W2` | `PASS` - 303 ms |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver decodes | `W1 W2` | `PASS` |
| MSG-5 | Channel message converges on all three; no `masterSecret` in any payload | `+A1` | `PASS`. **No `a1Build`** - re-run owed for attribution |
| MSG-6 | Link preview served through the proxy, never a third-party `<img src>` | `W1 W2` | `PASS` |
| MSG-7 | 30 rapid sends: order preserved, no gap, no duplicate | `W1 W2` | `PASS` - 2 000 ms |
| MSG-8 | Send to a BACKGROUNDED tab | `W1 W2` `+A1` | `PASS` |
| MSG-8b | Same, receiver on another page: badge and unread count | `W1 W2` `+A1` | `PASS` |
| MSG-9 | **Receiver** offline at the GATEWAY, then restored: lands once on reconnect | `W1 W2` | `PASS` - 16.9 s, nearly all the deliberate outage |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `W1 W2` | `PASS` |

## 2 - TYPE - typing indicators

`25376b86` x5: 25 verdicts, 25 `PASS`, every server window clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `W1 W2` | `PASS` - shown 73 ms, cleared 243 ms |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `W1 W2` | `PASS` - expired 4 180 ms, held 5 552 ms, inside the 3 500-9 000 ms bound |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `W1 W2` | `PASS` - cleared 5 978 ms, tab restored (navigated and unlocked) |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `W1 W2` | `PASS` - nothing while offline, nothing on reconnect, cut acted in 995 ms, back in 877 ms, 1 socket closed |
| TYPE-5 | Channel typing, a different transport entirely (REST, not WS) | `W1 W2` | `PASS` - channel/HTTP, shown 65 ms, cleared 224 ms |

## 3 - READ - receipts and unread counts

`25376b86` x5: 8 of 8 runnable `PASS` on every pass, 40 of 40 clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the badge on W1 and marks it read for the sender | `W1 W2` | `PASS` 5/5 |
| READ-2 | The SAME user's other device also clears | `+A1` | `PASS` 5/5 |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible | `W1 W2` | `PASS` 5/5 |
| READ-4 | The 2 s debounce batches: twenty messages send ONE watermark | `W1 W2` | `PASS` 5/5 |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three | `+user` | `SKIPPED` - needs FOUR readers and the estate has TWO accounts. The watermark is per USER, not per device (READ-3's lesson), so the phone does not make a third: two more enrolments are owed, and each costs the owner's 2FA. The `W1 W2` in this column was wrong - it said the row was runnable. |
| READ-6 | Channels send no receipts at all; read state comes from the server tally | `W1 W2` | `PASS` 5/5 |
| READ-7 | Unread count after a reload, with the receipt still in flight | `W1 W2` | `PASS` 5/5 |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `W1 W2` | `PASS` 5/5 |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `+A1` | `PASS` 5/5 |
| READ-10 | Reading a conversation whose peer has deleted it | `+A1` | `PASS` 5/5 - `--destructive` |

## 4 - MUT - editing, deleting, reacting, pinning

All four are MLS system events in a DM or group and REST calls in a channel, so **every row whose
cell says both runs twice**, once in the owner-peer DM and once in `Campagne de test`.

`e3e5a60bb007` x5 on `6748f6b8`, phone on `6748f6b8`: **24 of the 25 verdict rows `PASS` 5/5** (21
checks, four of which run in both venues), MUT-20 `SKIPPED` 5/5 (unarmable until 2026-11-09). The
fleet is homogeneous on purpose here - MUT-18 crosses two devices of ONE account, so a phone on an
older build measures the mixed fleet instead of the mechanism.

**The runner then moved to `fbf202d9d9d9`, and one x1 on it confirms the x5** - 24 `PASS`, MUT-20
`SKIPPED`, server clean. The delta attaches `silence` to any verdict that is NOT a PASS and is a
no-op on a green one by construction; it touches no assertion and no navigation. MUT-12 additionally
carries 9 verdicts of its own on that sha. Recorded per
[testing-methodology](testing-methodology.md) 33: a sha the board does not name is a run nobody can
tie to code.

**MUT-18 caught a real convergence defect, and it is fixed.** Two devices of one account editing the
same message settled on DIFFERENT bodies - W1 holding A1's text, A1 holding W1's - permanently, with
no error anywhere and nothing on either screen to suggest a disagreement. `edit_message` was applied
on arrival by every path that applies one, and "whichever frame came last" is not a rule: it is a
different answer per device, because two devices receive in different orders. All three appliers now
consult `editSupersedes`. The story is in `CHANGELOG.md`, the rule in
[durable-rules](durable-rules.md), and the mechanism in
[frontend/modules/chat](frontend/modules/chat.md).

**The server window read `unexplained=2` on every pass of the x5 that preceded it, and the lines were
MUT's own.** A channel message being hard-deleted (`[ChannelService] [CHANNEL] message deleted ...`,
and its `(moderation)` form) is the one delete in the product that leaves no tombstone, MUT-8 and
MUT-9 are the only checks that produce it, and neither had ever run in a window anybody classified.
Both shapes are now `NOTABLE` - visible, never silenced - and pinned in `srvclassify-selftest.mjs`.
That span, 30 464 lines over seven services on runner `4a9814f845d7`, then read clean with 15 notable
and nothing unexplained; the `e3e5a60bb007` x5 above classifies clean on all five passes too.

**MUT-12's channel leg has an intermittent that is NOT attributed to the product, and the reason is
written here so nobody re-derives it.** It has missed three times ever (2026-08-16, and twice on
2026-08-22 at 114 and 136 rendered paragraphs). The second of those was taken apart against the
production log: the message was never lost - the server created and pushed it two seconds BEFORE the
check gave up - and the sender's whole send took 600 ms once it started (`DISTRIBUTION_GROUP` ->
`liveGraineSessions` -> `CHANNEL_PUSH`). What preceded it was 21 seconds in which the sender's client
made no server call at all, having already rendered its optimistic bubble; `sendText` waits for that
bubble, so the check's clock had been running the whole time.

That leaves two causes, and the evidence available then could not separate them: a client-side stall,
or THIS host saturating while it drives two Chrome profiles and a phone. Both failures fell in
stretches where the box was also running greps, `ssh` and pre-commit sweeps; **eight consecutive
passes with the box deliberately quiet did not reproduce it**. That is not proof, and it is the
reason no defect is filed. The instrument is in place for the next occurrence instead: MUT's
`finish()` attaches `silence` - the longest hole in each client's OWN timeline - to any non-PASS
verdict, and a hole appearing in EVERY client at once is this host freezing while a hole in only the
sender's is the product. See [testing-methodology](testing-methodology.md) 34.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MUT-1 | **DM.** Edit a text message: both sides show the new text and an edited marker | `W1 W2` | `PASS` 5/5 |
| MUT-2 | **DM.** Edit clears `readBy` - the receipt restarts | `W1 W2` | `PASS` 5/5 |
| MUT-3 | **DM.** Edit refused on a message with media, and on someone else's | `W1 W2` | `PASS` 5/5 |
| MUT-4 | **DM.** Edit a message the peer has NOT yet received | `W1 W2` | `PASS` 5/5 - 247-356 ms, 0 sightings of the original |
| MUT-5 | **Channel.** Edit is absent by design - assert the control is not offered | `W1 W2` | `PASS` 5/5 |
| MUT-6 | **DM.** Delete a message: both sides show the tombstone, not a gap | `W1 W2` | `PASS` 5/5 - converges in 1-9 ms |
| MUT-7 | **DM.** The tombstone WINS over a body on merge | `W1 W2` | `PASS` 5/5 - 314-333 ms, no resurrection |
| MUT-8 | **Channel.** Delete is a HARD row delete, no tombstone | `W1 W2` | `PASS` 5/5 |
| MUT-9 | **Channel.** A moderator deletes another user's message | `W1 W2` | `PASS` 5/5 |
| MUT-10 | **DM.** The toolbar offers Delete to a moderator, where the handler refuses it | `W1 W2` | `PASS` 5/5 - does NOT reproduce: `canModerateSelectedChannel` is `false` outside a channel by construction |
| MUT-11 | **Both.** React, un-react, re-react; two users; several emoji | `W1 W2` | `PASS` 5/5 both venues |
| MUT-12 | **Both.** The 15-distinct-emoji cap, on both transports | `W1 W2` | `PASS` 5/5 both venues - cap holds at 15, slowest 22 ms |
| MUT-13 | **Both.** A reaction notifies the author only, never the reactor | `W1 W2` | `PASS` 5/5 both venues - author in 158-164 ms in a channel; the push half is NOTIF's, not claimed here |
| MUT-14 | **Both.** Pin and unpin, seen on the OTHER device | `+A1` | `PASS` 5/5 both venues - 305-341 ms |
| MUT-15 | **DM.** A pin reaches a device that was OFFLINE when it was placed | `+A1` | `PASS` 5/5 - converges 289-385 ms after the device returns |
| MUT-16 | **Channel.** A pin DOES survive, re-hydrated from the server | `+A1` | `PASS` 5/5 |
| MUT-17 | **DM.** Edit, then delete, then react to the deleted message | `W1 W2` | `PASS` 5/5 |
| MUT-18 | **DM.** Two devices of the SAME user edit the same message at once | `+A1` | `PASS` 5/5 - converges in 4-76 ms |
| MUT-19 | **DM.** Delete a message still in the outbox: no peer sees it, and the sender keeps no row | `W1 W2` | `PASS` 5/5 |
| MUT-20 | **DM.** Mutate a message older than the 90-day retention window | `W1 W2` | `SKIPPED` 5/5 - unarmable until 2026-11-09 |
| MUT-21 | **DM.** The hover action bar stays inside the pane and takes its own clicks | `W1 W2` | `PASS` 5/5 |

## 5 - SEARCH - finding a message

Client-side, in-conversation, substring-only: no server index, no global search.

**A gap no row here measures, verified on the source 2026-08-22.** A channel search asks the server
for at most 2000 rows; when the server reports the history was capped, `searchChannelHistory`
(`composables/useConversations.svelte.ts:448`) writes one log line and leaves `searchLimitedToLoaded`
false. So a channel past 2000 messages answers from a truncated corpus and says nothing. SEARCH-2
exercises the only branch that DOES raise the flag - a fetch that throws - because manufacturing a
2000-message channel inside a check is not practical. Recorded here rather than in a payload field,
per [testing-methodology](testing-methodology.md) 31.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| SEARCH-1 | A term in a recent message is found and highlighted; prev/next walk the hits | `W1 W2` | `pending` |
| SEARCH-2 | A term only in OLD history: does `searchLimitedToLoaded` tell the truth? | `W1 W2` | `pending` |
| SEARCH-3 | Deleted messages excluded; edited messages match their NEW text | `W1 W2` | `pending` |
| SEARCH-4 | Channel search pulls up to 2000 rows and decrypts them - time it | `W1 W2` | `pending` |
| SEARCH-5 | Accents and case: a French corpus is the real corpus here | `W1 W2` | `pending` |
| SEARCH-6 | The sidebar filter is a DIFFERENT search - assert it does not claim more | `W1 W2` | `pending` |

## 6 - MENTION - mentions and what they trigger

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MENTION-1 | The autocomplete inserts the `@[uuid]` token and it renders as a chip | `W1 W2` | `pending` |
| MENTION-2 | In a CHANNEL, the mentioned user gets a push even at level `mentions` | `+push` | `pending` |
| MENTION-3 | At level `none`, the mention gets nothing | `+push` | `pending` |
| MENTION-4 | In a DM or group a mention triggers NOTHING extra | `W1 W2` | `pending` |
| MENTION-5 | Mention a user who is not a member of the channel | `W1 W2` | `pending` |
| MENTION-6 | The channel path sends `mentionedUserIds` in CLEARTEXT - confirm the documented leak and nothing more | `W1 W2` | `pending` |

## 7 - FWD - forwarding

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| FWD-1 | Channel -> DM forward, the exact shape of the reported prod loss | `W1 W2` | `passed` 5/5 |
| FWD-2 | The same, 25 times in a loop - any single miss is the bug | `W1 W2` | `passed` on `5aaa1047` - 25/25, 0 lost, 0 duplicated, 0 `SecretReuseError`. Run by hand: `node fwd.mjs 25` |
| FWD-3 | Forward while the sender goes offline mid-send | `W1 W2` | `passed` 5/5 |
| FWD-4 | Forward from A1, backgrounded 200 ms later | `+A1` | `passed` 5/5 |
| FWD-5 | Forward into a conversation not opened this session | `W1 W2` | `passed` 5/5 |

## 8 - GRP - group membership and invitations

The first rung that moves an MLS epoch.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GRP-1 | Create a group, add a member, both sides see the roster and the Add commit merges | `W1 W2` | `pending` |
| GRP-2 | The picker must not offer existing members or yourself, and a no-op submission must not report success | `W1 W2` | `pending` |
| GRP-3 | Remove a member: the Remove commit, and what the removed device can still read | `W1 W2` | `pending` |
| GRP-4 | The group invitation LINK: generate, open it on the other account | `W1 W2` | `pending` |
| GRP-5 | Rename a group, seen on the other side | `W1 W2` | `pending` |
| GRP-6 | Leave a group - which deliberately commits nothing | `W1 W2` | `pending` |
| GRP-7 | Add a member who is offline; they join on their next connection | `W1 W2` | `pending` |
| GRP-8 | Add and remove the same member twice in a row, fast | `W1 W2` | `pending` |
| GRP-9 | A member row rendering a raw user id instead of a display name | `W1 W2` | `pending` - observed once |

## 9 - COMM - communities, channels, roles

A community is a `Workspace`, and **its membership is not MLS membership**. Every row is read against
MSG-5's standing assertion: no `masterSecret` in any payload, ever.

**WP-GRAINE-2 is closed**, both halves proven on production 2026-08-19 (distribution group
`d70e8952`, community `b9d52032`); the figures are on
[graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19).

**Twenty-five rows, and as of 2026-08-21 every one of them has a runner** - `comm1` .. `comm8`,
`comm910`, `comm11` .. `comm22`, `comm2324` (twice, once per check) and `comm25`, all sharing
`comm.mjs` and all reachable from `run.mjs COMM`. `checks.mjs` carries twenty-four entries for the
twenty-five checks, and the count in its own comment is what makes an omission visible. Why the rows
were rewritten on 2026-08-20 is in
[cross-client-campaign](cross-client-campaign.md#rows-that-named-a-mechanism-the-product-does-not-have).

**Two have never run on production**: COMM-14 needs real push, and COMM-18 kills the app and follows
a link into a cold start.

**AND THE STATE COLUMN BELOW STILL SAYS `pending` FOR TWENTY-ONE OF THEM, WHICH IS THE BOARD BEING
BEHIND ITS OWN LEDGER.** Measured 2026-08-21 by `rows.mjs`, which reads both: twenty-two rows across
the whole campaign have a verdict nobody wrote down, and twenty-one of them are COMM's. The rows are
deliberately left `pending` rather than filled in now, because filling them in would record belief the
same tool says not to hold - **twelve of the twenty-one cannot be believed as they stand**:

- **ten name no runner and eight name no build.** `COMM-2, 3, 11, 13, 15, 16, 19, 21, 23, 24` were
  recorded before `results.mjs` carried `check`/`checkSha`, and a verdict that cannot say which script
  produced it, on which bundle, is a memory rather than a measurement.
- **two were taken by a runner that has since been rewritten**: `COMM-4` (PASS) and `COMM-14` (FAIL).

The other nine PASSes and COMM-22's `PASS-DIRTY` name a current runner AND a build, and stand. Every
one of the twelve is re-run when the ladder reaches rung 9, and the cells are written ONCE, from
verdicts that carry both fields - which is also why they are not written twice.

**A1 has run a current build since 2026-08-21** - `67d40e3a`, replacing the `02ae609b` every earlier
A1 row was read on. That does not retire those rows, it dates them: a device's build is part of its
answer, and a row recorded on `02ae609b` says what that build did. **COMM-22 settled on the tenth attempt** - nine runs produced no believable
verdict (seven VACUOUS, one FAIL, and one VACUOUS that collided with a deploy of the harness
operator's own making, see rule 30) and the instrument was wrong every time, never the assertion.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `pending` |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `pending` |
| COMM-3 | An expired link, a `maxUses`-exhausted link, a REVOKED link, a link to a deleted community - and the rotation's new link accepted, as the positive control | `W1 W2` | `pending` |
| COMM-4 | Direct invite: the `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `pending` |
| COMM-5 | Roles: promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `pending` |
| COMM-6 | The permission grid offers the SIX enforced permissions and no seventh, the three default roles carry exactly what is documented, and a toggle reaches the column a decision reads | `W1` | `pending` |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `pending` |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** - `dm_device_group_memberships` for the salon's group names only its members | `W1 W2` | `pending` |
| COMM-9 | Removed from a private salon: the server drops their routing rows (`evicted=true`), and the next message is sealed under a session they do not hold while the previous one still opens | `W1 W2` | `pending` |
| COMM-10 | Removed from a private salon: the messages they ALREADY hold stay readable - Graine retains seeds on purpose | `W1 W2` | `pending` |
| COMM-11 | Kicked from the COMMUNITY: the client purges the workspace AND leaves every private salon group it held | `W1 W2` | `pending` |
| COMM-12 | Re-invited after a removal: they receive the sessions minted from now on, and the past only as `history_visibility` allows | `W1 W2` | `pending` |
| COMM-13 | An admin JOINS a private salon: they see it unjoined, `distribution-group` answers 403 before and 200 after, the member list gains their name, the transcript gains NOTHING, and the row stops offering the join | `W1 W2` | `pending` |
| COMM-14 | Channel notification levels enforced server-side | `+push` | `pending` |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `pending` |
| COMM-16 | Delete a channel, then a community by typing its name: the rows are really gone and the slug is free again | `W1 W2` | `pending` |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `PASS` 1/1 - `67d40e3a`, all six expectations, first A1 row on a current build |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `pending` |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `pending` |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `pending` |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `pending` |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `PASS-DIRTY` - `f9e17e49`, tenth attempt, first believable one. 12 sessions over 13 epochs, all seven expectations held. One dirt line, identical on both clients - see below |

**COMM-22's dirt is a lead, not a footnote.** Both clients logged, at the moment they first opened
the salon, `[GRAINE] salon 0a00f651 of 85d5164f: this device holds the distribution group but the
group holds NO row for it (0 device(s) for this user) - the local group is stale, rejoining` - W1 at
13:41:59, seconds after creating the salon, W2 at 13:42:38 on its first open. The repair fired and
worked; **a race that heals cleanly is still a defect**, and this one names the seam WP-REGRANT-1
was written for from the other side. Under investigation; whatever it turns out to be belongs in
`CHANGELOG.md` and its rule in [durable-rules](durable-rules.md), not here.
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `pending` |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `pending` |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `pending` |

## 10 - DEL - deleting a conversation, crossed

Deletion removes state while OTHER state keeps pointing at it, so each row pairs it with something
mid-flight.

**One of the ten has a runner, and it had one all along** - `del1.mjs`, WP-HISTGHOST-1's regression
check. It was absent from `checks.mjs`, so `run.mjs --list` reported DEL as zero coverage and nobody
looked for the file. The other nine are still to write.

| Id | The crossing | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `pending` - no banner, marker or retried solicitation may survive. **`del1.mjs` has covered this since WP-HISTGHOST-1** and was reachable from nothing: `checks.mjs` listed DEL with no scripts, so the phase read as zero coverage, and the script printed its verdict to stdout instead of recording it. Registered and wired to `record`/`gate` on 2026-08-21 - rule 22 |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `pending` - resolves or fails LOUDLY, never a silent permanent pending |
| DEL-3 | Both peers delete the same conversation within a second | `W1 W2` | `pending` - no error either side, neither resurrects it |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `pending` - no orphan blob left addressable |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `pending` - dropped without a decrypt-failure marker |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `pending` - `Drain start` still gets its `Drain complete` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `pending` - converges to deleted, no row re-created from a queued frame |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `pending` - purged as an orphan, never left soliciting for ever |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | `pending` - the view leaves cleanly |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | `pending` - reaches the server once, no re-broadcast on later reconnects |

## 11 - TAB - tabs and windows

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TAB-1 | Backgrounded tab receives; title/badge updates | `W1 W2` | `pending` - largely subsumed by MSG-8/8b |
| TAB-2 | Tab closed, message arrives, tab reopened: present exactly once | `W1 W2` | `pending` |
| TAB-3 | Whole browser killed and relaunched: all arrive, no re-login | `W1 W2` | `pending` |
| TAB-3b | Cold-start timing, five runs | `W1 W2` | `pending` - one unexplained 77.7 s run stands on the record, not reproduced in four further runs |
| TAB-4 | Two tabs of the SAME account: no double-send, no epoch fight | `W1 W2` | `pending` |
| TAB-5 | Reload fired under 100 ms after submit: sent once or clearly queued, never lost | `W1 W2` | `pending` |
| TAB-6 | Delete the refresh cookie, then act: clean re-login, not a silent empty list | `+user` | `pending` - the re-login costs the 2FA |
| TAB-7 | Offline -> act -> online, tab never reloaded | `W1 W2` | `pending` |

## 12 - MULTI - one user, two devices

Opens by sweeping every `+A1` row left behind in tiers B and C.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `+A1` | `pending` |
| MULTI-2 | Read on A1: read state reflected on W1 | `+A1` | `pending` |
| MULTI-3 | A1 enrolled AFTER W1 has history | `+A1` | `pending` |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= device check L) | `+A1` | `pending` |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `+A1` | `pending` |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `+A1` | `pending` |

## 13 - LIFE - Android lifecycle

Cross every LIFE state with: receive a DM, a channel message, a commit, a call.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| LIFE-1 | Foreground baseline | `+A1` | `pending` |
| LIFE-2 | Background (`HOME`): the notification carries the real decrypted text | `+push` | `pending` |
| LIFE-3 | Killed - **swipe from recents, not `am force-stop`** | `+push` | `pending` |
| LIFE-4 | Doze (`dumpsys deviceidle force-idle`) | `+push` | `pending` |
| LIFE-5 | After a reboot, app never opened - exercises `CanariBootReceiver` | `+push` `+user` | `pending` - needs the unlock pattern |
| LIFE-6 | Offline (both radios) | `+A1` | `pending` |
| LIFE-7 | Notification permission revoked mid-life | `+push` | `pending` |
| LIFE-8 | Process death (`am kill`), keeping WorkManager state | `+push` | `pending` |

## 14 - NOTIF - notifications

Sweeps every `+push` row left behind above it.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| NOTIF-1 | App killed, DM arrives: decrypted notification with real content | `+push` | `pending` |
| NOTIF-2 | App killed, a **commit** pushed, then a message | `+push` | `pending` - a generic fallback is CORRECT; opening the app must recover |
| NOTIF-3 | The same, message several epochs later | `+push` | `pending` |
| NOTIF-4 | Read on W1 while A1 is killed, W1 arriving at the salon AFTERWARDS: notification dismissed on A1 | `+push` | `pending` |
| NOTIF-4b | The same, W1 holding the salon ALREADY OPEN when the message lands - the case an unread counter cannot see | `+push` | `pending` |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `+push` | `pending` |
| NOTIF-6 | Quick reply from the shade (= device check K) | `+push` | `pending` - reported not working from a real phone 2026-08-20, on an APK predating the current bundle |
| NOTIF-6b | "Marquer comme lu" from the shade: the banner goes AND the salon is read on the other devices | `+push` | `pending` - never verified either way |
| NOTIF-7 | Tap -> deep link into the conversation, **backgrounded** | `+push` | `pending` |
| NOTIF-7b | The same with the app **KILLED** | `+push` | `pending` |
| NOTIF-8 | Doze + message: delivered, or on wake - record which | `+push` | `pending` |
| NOTIF-9 | Two devices of one user: exactly one notification surface behaves | `+push` | `pending` |
| NOTIF-10 | Airplane mode 10 min, 5 messages, then reconnect | `+push` | `pending` - all five survive |
| NOTIF-11 | Three messages into one salon: ONE notification carrying three stacked lines, not three notifications | `+push` | `pending` |
| NOTIF-12 | Who each stacked line is attributed to inside a salon | `+push` | `pending` - RECORDED, not asserted; see below |

**NOTIF-12 records rather than asserts**: attribution of a stacked line inside a salon is an open
product decision, in [backlog](backlog.md).

## 15 - CALL - audio and video

The largest hole: four unit-test files, zero harness scripts. Media is encrypted with a key exported
from MLS and applied per encoded frame; **if the browser does not support the transform the call
silently degrades to SFU-visible DTLS-SRTP**, so asserting that store is part of every row here.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CALL-1 | 1:1 audio W1 -> W2: ring, accept, two-way audio, hangup either side | `W1 W2` | `pending` |
| CALL-2 | 1:1 video: both streams render, and the E2E transform is ACTIVE | `W1 W2` | `pending` |
| CALL-3 | Group call in a 3-member group, one leg on A1 | `+A1` | `pending` |
| CALL-4 | Decline: the callee stops ringing, the caller learns nothing (current design) | `W1 W2` | `pending` |
| CALL-5 | Cancel before answer: `ring-end` reaches every device including siblings | `+A1` | `pending` |
| CALL-6 | Answer on A1 while W1 is logged in: W1 stops ringing | `+A1` | `pending` |
| CALL-7 | Unanswered: 60 s native timeout on the phone; the WEB side has none | `+A1` | `pending` |
| CALL-8 | Toggle mute and camera mid-call, and camera-on from an audio start | `W1 W2` | `pending` |
| CALL-9 | Speaker/earpiece routing on A1 | `+A1` | `pending` |
| CALL-10 | Incoming call with the app KILLED: FCM wakes it, full-screen intent, deep link | `+push` | `pending` |
| CALL-11 | The same in forced Doze | `+push` | `pending` |
| CALL-12 | Incoming call on the LOCK SCREEN, answered without unlocking | `+push` `+user` | `pending` |
| CALL-13 | iOS CallKit end to end | `+user` | `pending` - **never run on hardware** |
| CALL-14 | A call is refused in a community channel, by design | `W1 W2` | `pending` |
| CALL-15 | The room token expires (5 min): hold the invite, accept late | `W1 W2` | `pending` |
| CALL-16 | Network drop mid-call - expected to END the call, no ICE restart | `W1 W2` | `pending` |
| CALL-17 | A second incoming call while already in one - expected to vanish silently | `W1 W2` | `pending` |
| CALL-18 | The missed-call system message: who it names and on whose device | `W1 W2` | `pending` - a suspected defect |
| CALL-19 | Call system messages survive a reload and appear on a second device | `+A1` | `pending` |
| CALL-20 | Start a call, then the peer deletes the conversation | `W1 W2` | `pending` |

## 16 - HEAL - does a broken group repair itself?

The break is made by restoring an older snapshot of the web MLS database over the current one. It
rewinds W1's ratchet in EVERY group it holds, so no rung may follow without a teardown that restores
the **invariant**, never a snapshot. Every run needs `reload.mjs` first and a record of which device
answered.

**SEVEN ROWS SINCE 2026-08-21, AND TWO OF THEM ARE OLDER THAN THE ROWS.** `heal-a1.mjs` and
`heal.mjs` have existed, worked and recorded verdicts throughout - the phone mirror of HEAL-repair,
and the "does the next message arrive" question that follows an escalation - under ids no row had ever
named, which is why nothing reconciled them and nothing could report them missing. `rows.mjs` reads
the board and the ledger together and named all three faults at once: those two, plus `heal-web.mjs`
answering HEAL-repair under `HEAL-WEB`. Four runners, seven rows, and every runner now records the id
of the row it answers.

**HEAL-W1, HEAL-W3 and HEAL-W4 have no runner yet**, and are written as the ladder reaches this rung.
HEAL-W2's only ledger verdict is a `FAIL` from 2026-08-11, taken by a script **rewritten that same
day** - so the honest reading of that row is `pending`, not failing, and it says so.

| Id | How the group is broken | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `+snapshot` | `pending` - a `healed` verdict after applying ZERO commits is a regression |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch | `+snapshot` | `pending` - `TooDistantInTheFuture` must beat `GAP_QUEUED` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `+snapshot` | `pending` - no prior art on either client |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `+snapshot` | `pending` - quantitative: a run whose frame rate does not fall back to the ordinary send rate has found something. Runner: `heal-web.mjs` |
| HEAL-A1 | HEAL-repair mirrored onto the phone: **W2** is rewound and **A1** is the receiver that must detect and repair | `+A1` `+snapshot` | `pending` - W1 is parked deliberately, so the only possible history responder is W2, which holds the plaintexts because it sent them. Runner: `heal-a1.mjs` |
| HEAL-NEXT | After an escalation has ALREADY happened, does the next message arrive? | `+A1` `+snapshot` | `pending` - the frame that caused the escalation is unrecoverable by construction, so this is the only question left: does the group work again. Runner: `heal.mjs` |

## 17 - PIN

Read [auth](frontend/modules/auth.md) first - the PIN, the device key vault and `mls.bin` are one
mechanism.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| PIN-1 | Correct PIN, online | `W1 W2` | `pending` |
| PIN-2 | Wrong PIN xN: rejected, no lockout a correct PIN cannot clear, `mls.bin` untouched | `W1 W2` | `pending` |
| PIN-3 | A short PIN at setup, change, recovery AND unlock - the same rule in all four | `W1 W2` | `pending` |
| PIN-4 | Change the PIN on W1: key re-wrapped, other clients unaffected | `W1 W2` | `pending` |
| PIN-5 | Change it on A1 while W1 is open | `+A1` | `pending` |
| PIN-6 | Remove the PIN: the at-rest key survives the transition | `W1 W2` | `pending` |
| PIN-7 | PIN unlock while OFFLINE | `W1 W2` | `pending` - **a clean refusal is the expected result** |
| PIN-8 | Server unreachable but `navigator.onLine === true` | `W1 W2` | `pending` - a transport failure must NOT log the user out |
| PIN-9 | "Stay signed in", browser closed and reopened: vault path, no server round trip | `W1 W2` | `pending` |
| PIN-10 | Correct PIN, corrupt vault blob | `+snapshot` | `pending` - explicit failure, never a silent wrong-key state |

## 18 - CORRUPT - deliberate store damage

**Runs last.** SETUP-8's archive is the only way back that does not cost a full re-enrolment.

| Id | Corruption | Needs | State |
| --- | --- | --- | --- |
| CORRUPT-1 | Truncate the MLS state to half its length | `+snapshot` | `pending` - explicit failure + recovery, never a silent empty history |
| CORRUPT-2 | Flip one byte inside the ciphertext | `+snapshot` | `pending` - the AEAD tag must fail |
| CORRUPT-3 | Web vault blob replaced with valid base64 of garbage | `+snapshot` | `pending` - must surface, not hang |
| CORRUPT-4 | Zero-length MLS state | `+snapshot` | `pending` - treated as absent, clean re-enrolment |
| CORRUPT-5 | An MLS state in an OLDER envelope format | `+snapshot` | `pending` - keep a copy from before every format change |
| CORRUPT-6 | Delete `push_context.json` while killed, then push | `+push` `+snapshot` | `pending` - recover or fail loudly, never a decrypt loop |
| CORRUPT-7 | Drop an object store from the web message store mid-session | `+snapshot` | `pending` |
| CORRUPT-8 | A wrong-user MLS state restored under another account | `+snapshot` | `pending` - **a pass that "works" is a finding** |
| CORRUPT-9 | Fill the data dir until writes fail, then receive | `+A1` `+snapshot` | `pending` - no half-written save |
| CORRUPT-10 | Kill the process **during** an MLS state write | `+A1` `+snapshot` | `pending` - never a half-file read as valid |
