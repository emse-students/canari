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
| 1 MSG | 12 | `e9d951d7` | **`PASS` 12/12 x1** (2026-08-21). Four A1 rows carry no `a1Build` - re-run owed for attribution |
| 2 TYPE | 5 | `e9d951d7` | **`PASS` 5/5 x1** (2026-08-21). An earlier x5 stands on superseded runner `25376b86` |
| 3 READ | 10 | `70497810` | **`PASS` 9/9 x5** on runner `2c2b83d1b748` (2026-08-21). READ-5 `SKIPPED`: needs four readers, the estate has two |
| 4 MUT | 21 | `6748f6b8`, A1 `a7981206` | **`PASS` 24/24 x5** on runner `e3e5a60bb007`, + x1 on `fbf202d9d9d9`. MUT-20 `SKIPPED`: unarmable until 2026-11-09 |
| 5 SEARCH | 6 | `1f396ac7` | **`PASS` 6/6 x5** on runner `928f8b286dac` |
| 6 MENTION | 6 | `1f396ac7`, A1 `a7981206` | **`PASS` 6/6 x5** on runner `cdc081edabc0` |
| 7 FWD | 6 | `1579d5c3`, A1 `a7981206` | **`PASS` 6/6 x5** (FWD-2 x1, 25 iterations) |
| 8 GRP | 10 | `feecfaf5` | **`PASS` 9/10 x4** + GRP-8 `PASS-DIRTY` deterministically, accepted by the user 2026-08-25. GRP-3's earlier socket close did not return on `feecfaf5`; both P2s in [backlog](backlog.md) |
| 9 COMM | 25 | `d6f61539` / A1 `e96bfa12`, COMM-4, COMM-22 and COMM-24 on `2a4297cb` | 12 `PASS`, 10 `PASS-DIRTY`, **3 `FAIL`** (COMM-8, COMM-18, COMM-22). **THE WHOLE RUNG OWES A RE-RUN**: eleven of those thirteen carry ONE signature, the stale-base join fixed on 2026-08-26 |
| 10 DEL | 10 | `2a4297cb` | 8 `PASS`, DEL-1 `PASS-DIRTY`, **DEL-10 `FAIL`** (reproduced on the deployed fix). DEL-8 ran for the first time |
| 11 TAB | 8 | - | `pending` |
| 12 MULTI | 6 | - | `pending` |
| 13 LIFE | 8 | - | `pending` |
| 14 NOTIF | 21 | - | `pending` |
| 15 CALL | 20 | - | `pending` - no script exists yet |
| 16 HEAL | 11 | - | `pending` |
| 17 PIN | 10 | - | `pending` |
| 18 CORRUPT | 10 | - | `pending` |

**Run order is the numbered ladder above, top to bottom.** It is the only copy of that order.

| State | Meaning |
| --- | --- |
| `PASS` / `passed` | ran, assertions held, run was clean - and the row names the build |
| `PASS-DIRTY` | ran, assertions held, and a client logged something no rule classifies - `gate()` demotes it, and the row NAMES the line. Not a pass: the campaign ends green or it does not end |
| `VACUOUS` | ran and proved nothing - never armed, production was redeployed under it (`deploy.mjs`), or a client was still executing a bundle the deployment had replaced (`bundle.mjs`) |
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
| MSG-9 | **Receiver** offline at the GATEWAY, then restored: lands once on reconnect | `W1 W2` | `PASS` - 16.9 s |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `W1 W2` | `PASS` |

## 2 - TYPE - typing indicators

`25376b86` x5: 25 verdicts, 25 `PASS`, every server window clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `W1 W2` | `PASS` - shown 73 ms, cleared 243 ms |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `W1 W2` | `PASS` - expired 4 180 ms |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `W1 W2` | `PASS` - cleared 5 978 ms |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `W1 W2` | `PASS` - cut 995 ms, back 877 ms |
| TYPE-5 | Channel typing, a different transport entirely (REST, not WS) | `W1 W2` | `PASS` - channel/HTTP, shown 65 ms, cleared 224 ms |

## 3 - READ - receipts and unread counts

`25376b86` x5: 8 of 8 runnable `PASS` on every pass, 40 of 40 clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the badge on W1 and marks it read for the sender | `W1 W2` | `PASS` 5/5 |
| READ-2 | The SAME user's other device also clears | `+A1` | `PASS` 5/5 |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible | `W1 W2` | `PASS` 5/5 |
| READ-4 | The 2 s debounce batches: twenty messages send ONE watermark | `W1 W2` | `PASS` 5/5 |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three | `+user` | `SKIPPED`, TERMINAL (user, 2026-08-23) - needs FOUR readers and the estate has TWO accounts, the watermark being per USER. Closed, not deferred |
| READ-6 | Channels send no receipts at all; read state comes from the server tally | `W1 W2` | `PASS` 5/5 |
| READ-7 | Unread count after a reload, with the receipt still in flight | `W1 W2` | `PASS` 5/5 |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `W1 W2` | `PASS` 5/5 |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `+A1` | `PASS` 5/5 |
| READ-10 | Reading a conversation whose peer has deleted it | `+A1` | `PASS` 5/5 - `--destructive` |

## 4 - MUT - editing, deleting, reacting, pinning

All four are MLS system events in a DM or group and REST calls in a channel, so **every row whose
cell says both runs twice**, once in the owner-peer DM and once in `Campagne de test`.

`e3e5a60bb007` x5 on `6748f6b8`, phone on `a7981206`: **24 of the 25 verdict rows `PASS` 5/5** (21
checks, four of which run in both venues), MUT-20 `SKIPPED` 5/5. Confirmed by one x1 on runner
`fbf202d9d9d9`. The 207 rows misrecord `a1Build`
([testing-methodology](testing-methodology.md) 35).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MUT-1 | **DM.** Edit a text message: both sides show the new text and an edited marker | `W1 W2` | `PASS` 5/5 |
| MUT-2 | **DM.** Edit clears `readBy` - the receipt restarts | `W1 W2` | `PASS` 5/5 |
| MUT-3 | **DM.** Edit refused on a message with media, and on someone else's | `W1 W2` | `PASS` 5/5 |
| MUT-4 | **DM.** Edit a message the peer has NOT yet received | `W1 W2` | `PASS` 5/5 - 247-356 ms |
| MUT-5 | **Channel.** Edit is absent by design - assert the control is not offered | `W1 W2` | `PASS` 5/5 |
| MUT-6 | **DM.** Delete a message: both sides show the tombstone, not a gap | `W1 W2` | `PASS` 5/5 - 1-9 ms |
| MUT-7 | **DM.** The tombstone WINS over a body on merge | `W1 W2` | `PASS` 5/5 - 314-333 ms |
| MUT-8 | **Channel.** Delete is a HARD row delete, no tombstone | `W1 W2` | `PASS` 5/5 |
| MUT-9 | **Channel.** A moderator deletes another user's message | `W1 W2` | `PASS` 5/5 |
| MUT-10 | **DM.** The toolbar offers Delete to a moderator, where the handler refuses it | `W1 W2` | `PASS` 5/5 |
| MUT-11 | **Both.** React, un-react, re-react; two users; several emoji | `W1 W2` | `PASS` 5/5 both venues |
| MUT-12 | **Both.** The 15-distinct-emoji cap, on both transports | `W1 W2` | `PASS` 5/5 both venues - 22 ms |
| MUT-13 | **Both.** A reaction notifies the author only, never the reactor | `W1 W2` | `PASS` 5/5 both venues - 158-164 ms |
| MUT-14 | **Both.** Pin and unpin, seen on the OTHER device | `+A1` | `PASS` 5/5 both venues - 305-341 ms |
| MUT-15 | **DM.** A pin reaches a device that was OFFLINE when it was placed | `+A1` | `PASS` 5/5 - 289-385 ms |
| MUT-16 | **Channel.** A pin DOES survive, re-hydrated from the server | `+A1` | `PASS` 5/5 |
| MUT-17 | **DM.** Edit, then delete, then react to the deleted message | `W1 W2` | `PASS` 5/5 |
| MUT-18 | **DM.** Two devices of the SAME user edit the same message at once | `+A1` | `PASS` 5/5 - 4-76 ms |
| MUT-19 | **DM.** Delete a message still in the outbox: no peer sees it, and the sender keeps no row | `W1 W2` | `PASS` 5/5 |
| MUT-20 | **DM.** Mutate a message older than the 90-day retention window | `W1 W2` | `SKIPPED` 5/5 - unarmable until 2026-11-09 |
| MUT-21 | **DM.** The hover action bar stays inside the pane and takes its own clicks | `W1 W2` | `PASS` 5/5 |

## 5 - SEARCH - finding a message

Client-side, in-conversation, substring-only: no server index, no global search.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| SEARCH-1 | A term in a recent message is found and highlighted; prev/next walk the hits | `W1 W2` | `PASS` 5/5 |
| SEARCH-2 | A term only in OLD history: does `searchLimitedToLoaded` tell the truth? | `W1 W2` | `PASS` 5/5 - one `ERROR` in the six, the intermittent of [testing-methodology](testing-methodology.md) 34 |
| SEARCH-3 | Deleted messages excluded; edited messages match their NEW text | `W1 W2` | `PASS` 5/5 |
| SEARCH-4 | Channel search pulls up to 2000 rows and decrypts them - time it | `W1 W2` | `PASS` 5/5 - 322-474 ms |
| SEARCH-5 | Accents and case: a French corpus is the real corpus here | `W1 W2` | `PASS` 5/5 |
| SEARCH-6 | The sidebar filter is a DIFFERENT search - assert it does not claim more | `W1 W2` | `PASS` 5/5 |

## 6 - MENTION - mentions and what they trigger

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MENTION-1 | The autocomplete inserts the `@[uuid]` token and it renders as a chip | `W1 W2` | `PASS` 5/5 |
| MENTION-2 | In a CHANNEL at level `mentions`, the mention REACHES the receiver's phone | `+A1` | `PASS` 5/5 - 2 423-2 505 ms |
| MENTION-3 | At level `none` it reaches nothing - carrying its own positive control | `+A1` | `PASS` 5/5 - control 2 434-2 523 ms |
| MENTION-4 | In a DM or group a mention triggers NOTHING extra | `W1 W2` | `PASS` 5/5 |
| MENTION-5 | Mention a user who is not a member of the channel | `W1 W2` | `PASS` 5/5 |
| MENTION-6 | The channel path sends `mentionedUserIds` in CLEARTEXT - confirm the documented leak and nothing more | `W1 W2` | `PASS` 5/5 |

## 7 - FWD - forwarding

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| FWD-1 | Channel -> DM forward, the exact shape of the reported prod loss | `W1 W2` | `PASS` 5/5 - `46d392cdd788` |
| FWD-2 | The same, 25 times in a loop - any single miss is the bug | `W1 W2` | `PASS` 25/25 - `46d392cdd788`, by hand (`node fwd.mjs 25`) |
| FWD-3 | Forward while the sender goes offline mid-send | `W1 W2` | `PASS` 5/5 - `31e6989802bb` |
| FWD-4 | Forward from A1, backgrounded 200 ms later | `+A1` | `PASS` 5/5 - `31e6989802bb` |
| FWD-5 | Forward into a conversation not opened this session | `W1 W2` | `PASS` 5/5 - `31e6989802bb` |
| FWD-5-repeat | The same shape N rounds from a FRESH session each - the volume FWD-5 cannot carry alone | `W1 W2` | `PASS` 5/5 - `4e27a34e7b8e` |

## 8 - GRP - group membership and invitations

The first rung that moves an MLS epoch, and the rung that proved a third device changes what a
two-device check measures: GRP-4's evictions were committed by an undriven fleet member, not by
either driven browser.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GRP-1 | Create a group, add a member, both sides see the roster and the Add commit merges | `W1 W2` | **`PASS`** - `feecfaf5` x4; one run `PASS-DIRTY` on the deliberately unclassified `[KICK] Stale leaf`, read and benign (the phone re-asked for a Welcome whose leaf was already in the tree) |
| GRP-2 | The picker must not offer existing members or yourself, and a no-op submission must not report success | `W1 W2` | **`PASS`** |
| GRP-3 | Remove a member: the Remove commit, and what the removed device can still read | `W1 W2` | **`PASS`** - `feecfaf5` x4. An earlier run was `PASS-DIRTY` on one `webSocketClosed` no navigation explains; it did not return, and it stays a P2 in [backlog](backlog.md) |
| GRP-4 | The group invitation LINK: generate, open it on the other account | `W1 W2` | **`PASS`** - `feecfaf5` x4 after `e027679a`; was 4 FAIL / 4 PASS before it (two parties added the joiner's leaf, the healing Welcome dropped as a redelivery) |
| GRP-5 | Rename a group, seen on the other side | `W1 W2` | **`PASS`** |
| GRP-6 | Leave a group - which deliberately commits nothing | `W1 W2` | **`PASS`** |
| GRP-7 | Add a member who is offline; they join on their next connection | `W1 W2` | **`PASS`** |
| GRP-8 | Add and remove the same member twice in a row, fast | `W1 W2` | `PASS-DIRTY` - `feecfaf5` x4, identical each time: the re-admitted device calls its own exclusion window a loss and reconciles for it. P2 in [backlog](backlog.md). Clean before `e027679a`, when the re-admission never happened |
| GRP-9 | A member row rendering a raw user id instead of a display name | `W1 W2` | **`PASS`** - not reproduced |
| GRP-10 | The invitation link of one group must not appear in another group's panel | `W1 W2` | **`PASS`** |

## 9 - COMM - communities, channels, roles

A community is a `Workspace`, and **its membership is not MLS membership**. Every row is read against
MSG-5's standing assertion: no `masterSecret` in any payload, ever.

Twenty-five rows, all with a runner; COMM-23 and COMM-24 share `comm2324.mjs`. COMM-9 and COMM-10
share one recorded verdict, `COMM-9/10`.

**ELEVEN ROWS ARE ONE DEFECT, and the board claimed a sweep the ledger never gave it (corrected
2026-08-26).** The cells below held the verdicts of the earlier `5d7fac13` run while the ledger's
newest verdict for eleven of them came from the later `d6f61539` sweep and was worse - so the board
read 23 `PASS` where the evidence read 12 `PASS`, 10 `PASS-DIRTY` and 3 `FAIL`. It now reads the
ledger. What the correction exposed is worth more than the correction: from COMM-8 at 21:27 to
COMM-21 at 21:47, every dirty cell carries the SAME line on W2, naming the same salon -
`[GRAINE] could not join the distribution group of salon <id>` - a salon COMM-8 had created twenty
minutes earlier and whose distribution group W2 never stopped failing to join. That is the stale-base
defect COMM-22 measured head-on, fixed 2026-08-26 (`CHANGELOG.md`), and it means those ten
`PASS-DIRTY` plus COMM-8's `FAIL` are one re-run, not eleven investigations.
**COMM-18 cost five FAILs that were four distinct product defects** - stories in `CHANGELOG.md`, what
they measured in [cross-client-campaign](cross-client-campaign.md) - and its `FAIL` of 2026-08-25
22:02 was never retired: a `PASS` two hours earlier on the same build does not answer it.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `PASS` 1/1 |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `PASS` 1/1 |
| COMM-3 | An expired link, a `maxUses`-exhausted link, a REVOKED link, a link to a deleted community - and the rotation's new link accepted, as the positive control | `W1 W2` | `PASS` 1/1 |
| COMM-4 | Direct invite: the `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `PASS` 1/1 - the dirt was a classifier hole, not the server |
| COMM-5 | Roles: promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `PASS` 1/1 |
| COMM-6 | The permission grid offers the SIX enforced permissions and no seventh, the three default roles carry exactly what is documented, and a toggle reaches the column a decision reads | `W1` | `PASS` 1/1 |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** - `dm_device_group_memberships` for the salon's group names only its members | `W1 W2` | **`FAIL`** - the three negatives all held (`403`, absent from the sidebar, no seed announced); what failed is the positive control, `seedAfterTheGrant: false`. The peer was granted the salon and never got a session, because its external join into that salon's distribution group could not land - the stale-base defect, fixed 2026-08-26. Re-run owed |
| COMM-9 | Removed from a private salon: the server drops their routing rows (`evicted=true`), and the next message is sealed under a session they do not hold while the previous one still opens | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-10 | Removed from a private salon: the messages they ALREADY hold stay readable - Graine retains seeds on purpose | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-11 | Kicked from the COMMUNITY: the client purges the workspace AND leaves every private salon group it held | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-12 | Re-invited after a removal: they receive the sessions minted from now on, and the past only as `history_visibility` allows | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-13 | An admin JOINS a private salon: they see it unjoined, `distribution-group` answers 403 before and 200 after, the member list gains their name, the transcript gains NOTHING, and the row stops offering the join | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-14 | Channel notification levels enforced server-side | `+push` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `PASS` 1/1 |
| COMM-16 | Delete a channel, then a community by typing its name: the rows are really gone and the slug is free again | `W1 W2` | `PASS` 1/1 |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `PASS` 1/1 |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | **`FAIL`** - 2026-08-25 22:02 on `d6f61539`, the channel reached with `seeds.held: 0` and `roster.linkedGroupId: null`. A `PASS` at 135 ms two hours earlier on the SAME build does not retire it. Re-run owed, and it needs the phone |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `FAIL` - the peer ends ONE seed short of twelve, warm and cold alike, because its own external join left the base an epoch behind. Reproduced on `d6f61539` and `2a4297cb`; cause fixed 2026-08-26, re-run owed |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `PASS-DIRTY` - the stale-base join on W2, one cause with ten others (see above); re-run owed |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | **`PASS`** 1/1 on `2a4297cb`. The earlier `PASS-DIRTY`'s dirt was the unpublished-graine read, unpinnable without blinding the race detector |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `PASS` 1/1 |

## 10 - DEL - deleting a conversation, crossed

Deletion removes state while OTHER state keeps pointing at it, so each row pairs it with something
mid-flight.

**All ten have a runner** - `del1.mjs` for DEL-1, `del.mjs --only N` for the rest; the phase order and the phone row are justified in `checks.mjs` beside the list.

| Id | The crossing | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `PASS-DIRTY` 1/1 - armed at last (`armed: true`), 4/4 assertions. Dirt = 6 `[History] frame never read here and unreadable for good (past-epoch-application)` on W2, a designed line announcing loss that reconciliation then recovers |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `PASS 1/1` |
| DEL-3 | Both peers delete the same conversation within a second | `W1 W2` | `PASS 1/1` |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `PASS 1/1` |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `PASS 1/1` |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `PASS 1/1` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `PASS 1/1` |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `PASS 1/1` - first run ever. **RUNS LAST of the phase**, it restores a snapshot over W1's real state |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | `PASS 1/1` |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | **`FAIL` on `2a4297cb`**, the deployed fix - reproduced, and the half that broke has moved. The row IS kept now (`listedOnDeleter`, no local purge) but nothing replays it: 1 attempt offline, `sentOnFirstReconnect=0`, `sentOnSecondReconnect=0`, group still `live`. Memory is right, the TRIGGER is missing. P2 in [backlog](backlog.md) |

## 11 - TAB - tabs and windows

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TAB-1 | Backgrounded tab receives; title/badge updates | `W1 W2` | `pending` - RE-SCOPED 2026-08-24 onto the web `Notification`, the only out-of-page signal the product has. The gap it cannot assert is P3 in [backlog](backlog.md) |
| TAB-2 | Tab closed, message arrives, tab reopened: present exactly once | `W1 W2` | `pending` |
| TAB-3 | Whole browser killed and relaunched: all arrive, no re-login | `W1 W2` | `pending` |
| TAB-3b | Cold-start timing, five runs | `W1 W2` | `pending` - one 77.7 s run stands on the record, unexplained and not reproduced in four more |
| TAB-4 | Two tabs of the SAME account: no double-send, no epoch fight | `W1 W2` | `pending` |
| TAB-5 | Reload fired under 100 ms after submit: sent once or clearly queued, never lost | `W1 W2` | `pending` |
| TAB-6 | Delete the refresh cookie, then act: clean re-login, not a silent empty list | `+user` | `pending` - the re-login costs the 2FA |
| TAB-7 | Offline -> act -> online, tab never reloaded | `W1 W2` | `pending` - written 2026-08-24, never run |

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
| NOTIF-4 | Read on W1 while A1 is killed, W1 arriving at the salon AFTERWARDS: notification dismissed on A1 | `+push` | `pending` - a `PASS-DIRTY` on `1f396ac7` stands in the ledger, taken by a runner changed since |
| NOTIF-4b | The same, W1 holding the salon ALREADY OPEN when the message lands - the case an unread counter cannot see | `+push` | `pending` |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `+push` | `pending` |
| NOTIF-6 | Quick reply from the shade (= device check K) | `+push` | `pending` - reported not working from a real phone 2026-08-20, on an APK predating the current bundle |
| NOTIF-6b | "Marquer comme lu" from the shade: the banner goes AND the salon is read on the other devices | `+push` | `pending` - never verified either way |
| NOTIF-7 | Tap -> deep link into the conversation, **backgrounded** | `+push` | `pending` |
| NOTIF-7b | The same with the app **KILLED** | `+push` | `pending` |
| NOTIF-7c | Tap -> deep link into a CHANNEL, **backgrounded**: the salon is on screen and holds the marker | `+push` | `pending` - 7/7b are the DM only |
| NOTIF-7d | The same into a CHANNEL with the app **KILLED**, so the PIN gate mounts first | `+push` | `pending` - the case most likely to lose a pending deep link |
| NOTIF-8 | Doze + message: delivered, or on wake - record which | `+push` | `pending` |
| NOTIF-9 | Two devices of one user: exactly one notification surface behaves | `+push` | `pending` |
| NOTIF-10 | Airplane mode 10 min, 5 messages, then reconnect | `+push` | `pending` - all five survive |
| NOTIF-11 | Three messages into one salon: ONE notification carrying three stacked lines, not three notifications | `+push` | `pending` |
| NOTIF-12 | Who each stacked line is attributed to inside a salon | `+push` | `pending` - RECORDED, not asserted; see below |
| NOTIF-13 | The BODY is readable: a mention renders as a name, never as its `@[uuid]` token | `+push` | `pending` - expected to FAIL until the P2 in [backlog](backlog.md) ships |
| NOTIF-14 | The TITLE names its conversation: community and salon for a channel, the sender's resolved display name for a DM | `+push` | `pending` |
| NOTIF-15 | A REACTION to one of my messages notifies me on a killed device, carrying the emoji and who reacted, and no message text | `+push` | `pending` - MUT-13 asserts the in-app half and defers the push half here |
| NOTIF-16 | A mention lands on the `canari_mentions` channel and a plain message on `canari_messages` - the importance split that bypass-DND rests on | `+push` | `pending` |

**NOTIF-12 records rather than asserts**: attribution of a stacked line inside a salon is an open
product decision, in [backlog](backlog.md).

## 15 - CALL - audio and video

The largest hole: four unit-test files, zero harness scripts. **A browser without the frame
transform degrades the call to SFU-visible DTLS-SRTP silently**, so every row here asserts the
transform is active.

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

**Four runners for eleven rows**, and every runner now records the id of the row it answers:
`heal-web.mjs` (HEAL-repair), `heal-a1.mjs` (HEAL-A1), `heal.mjs` (HEAL-NEXT). HEAL-W1, HEAL-W3,
HEAL-W4 and the four HEAL-REVOKE rows are written as the ladder reaches this rung. HEAL-W2's only
ledger verdict is a `FAIL` from 2026-08-11 taken by a script rewritten that same day, so it reads
`pending`.

**The four HEAL-REVOKE rows** come from the user's decision that revocation is a WIPE
([backlog](backlog.md)). They are four rows and not one because a wipe is executed BY the device being
wiped: "the wipe ran" and "the device came back like-new" are different claims.

| Id | How the group is broken | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `+snapshot` | `pending` - a `healed` verdict after applying ZERO commits is a regression |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch | `+snapshot` | `pending` - `TooDistantInTheFuture` must beat `GAP_QUEUED` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `+snapshot` | `pending` - no prior art on either client |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `+snapshot` | `pending` - quantitative. Runner: `heal-web.mjs` |
| HEAL-A1 | HEAL-repair mirrored onto the phone: **W2** is rewound and **A1** is the receiver that must detect and repair | `+A1` `+snapshot` | `pending` - W1 parked, so W2 is the only possible responder. Runner: `heal-a1.mjs` |
| HEAL-NEXT | After an escalation has ALREADY happened, does the next message arrive? | `+A1` `+snapshot` | `pending` - the escalating frame is unrecoverable by construction. Runner: `heal.mjs` |
| HEAL-REVOKE-1 | A device revoked through the connected-devices UI: is its local store actually gone? | `W1 W2` | `pending` - the user found one that kept everything, P1 in [backlog](backlog.md) |
| HEAL-REVOKE-2 | The revoked device reconnects: is it like-new, holding nothing from before? | `W1 W2` | `pending` - the blacklist can make this row pass while HEAL-REVOKE-1 fails |
| HEAL-REVOKE-3 | First reconnection after revocation resynchronises as a NEW device would, history included | `W1 W2` | `pending` - a shortfall must be REPORTED, not silently partial |
| HEAL-REVOKE-4 | The heal-on-diff mechanism catches up what the first reconnection missed - and fires on the RIGHT conditions | `W1 W2` | `pending` - the TRIGGER CONDITIONS are part of the assertion, not context |

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
