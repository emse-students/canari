# Cross-client testing - the board

**STATE ONLY, AND IN AS FEW WORDS AS THE STATE ALLOWS.** A cell is a verdict, a count, and a time if
the time means anything. Everything else lives elsewhere and is never restated here:
[cross-client-campaign](cross-client-campaign.md) is the campaign's shape and what a run cost,
[testing-methodology](testing-methodology.md) is how a result earns belief and how a cell is written,
[`the README`](../../tools/cross-client-harness/README.md) is the instrument, `CHANGELOG.md` is every
defect, `CLAUDE.md` is what is open.

Two accounts, anonymised as **owner** (W1, A1) and **peer** (W2). Target is PRODUCTION. **Run order
is the numbered ladder below, top to bottom - the only copy of that order.**

## Standing

| Phase | Scripts | Last build | State |
| --- | --- | --- | --- |
| 0 SETUP | - | - | 5/9 `passed`; SETUP-2 `skipped` by decision, SETUP-7/8 owed before CORRUPT and PIN |
| 1 MSG | 12 | `e9d951d7` | **`PASS` 12/12 x1**; four `+A1` rows owe a re-run for `a1Build` |
| 2 TYPE | 5 | `e9d951d7` | **`PASS` 5/5 x1**; the x5 stands on superseded runner `25376b86` |
| 3 READ | 10 | `70497810` | **`PASS` 9/9 x5** on `2c2b83d1b748`; READ-5 `SKIPPED`, terminal |
| 4 MUT | 21 | `6748f6b8`, A1 `a7981206` | **`PASS` 24/24 x5** on `e3e5a60bb007`; MUT-20 `SKIPPED` until 2026-11-09 |
| 5 SEARCH | 6 | `1f396ac7` | **`PASS` 6/6 x5** on `928f8b286dac` |
| 6 MENTION | 6 | `1f396ac7`, A1 `a7981206` | **`PASS` 6/6 x5** on `cdc081edabc0` |
| 7 FWD | 6 | `1579d5c3`, A1 `a7981206` | **`PASS` 6/6 x5** |
| 8 GRP | 10 | `feecfaf5` | **`PASS` 9/10 x4**; GRP-8 `PASS-DIRTY` deterministically, accepted 2026-08-25 |
| 9 COMM | 25 | `0c31be5d`, COMM-12/22 `66639621`, A1 `0c31be5d` | 19 `PASS`, 5 `PASS-DIRTY`, no `FAIL`, no `VACUOUS`; COMM-10 never run |
| 10 DEL | 10 | `0c31be5d`, DEL-9 `66639621`, A1 `0c31be5d` | 4 `PASS`, 6 `PASS-DIRTY`, no `FAIL`, no `VACUOUS`; 7 cells owe a re-run on `del.mjs` `2dd7a0f4a933` |
| 11 TAB | 8 | - | `pending` |
| 12 MULTI | 10 | `0c31be5d` | 1 `PASS`, 1 `PASS-DIRTY`, 1 `VACUOUS`, 2 `SKIPPED`, MULTI-5 `ERROR`; every cell owes a re-run on `multi.mjs` `74bb17b8283f` |
| 13 LIFE | 8 | - | `pending` |
| 14 NOTIF | 21 | - | `pending` |
| 15 CALL | 20 | - | `pending` - no runner exists |
| 16 HEAL | 31 | `48b65d08` | 2/31 taken: HEAL-NEW-0 `PASS-DIRTY`, HEAL-NEW-1 `PASS` |
| 17 PIN | 10 | - | `pending` - no runner exists |
| 18 CORRUPT | 10 | - | `pending` - no runner exists |

| State | Meaning |
| --- | --- |
| `PASS` / `passed` | ran, assertions held, run was clean - and the row names the build |
| `PASS-DIRTY` | ran, assertions held, and a client logged something no rule classifies - `gate()` demotes it, and the row NAMES the line. Not a pass: the campaign ends green or it does not end |
| `VACUOUS` | ran and proved nothing - never armed, production was redeployed under it (`deploy.mjs`), or a client was still executing a bundle the deployment had replaced (`bundle.mjs`) |
| `pending` | not run against the current build |
| `FAIL` | ran and did not hold - paired with a Work Package carrying the log, or with a fixed commit |
| `SKIPPED` | cannot be armed with two accounts, or needs `--destructive` |
| `BLOCKED` | cannot run until something outside the campaign happens |

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

GRP-3's earlier socket close did not return on `feecfaf5`; both P2s are in [backlog](backlog.md).

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

**Standing, `0c31be5d`: no `FAIL` and no `VACUOUS` left.** COMM-22 is `PASS` and clean - twelve
Graine sessions, twelve seeds on a warm and a cold peer, and the first production sighting of a
joiner publishing `base + 1` inside its own commit. **COMM-12 passes on the third attempt, and only
because the rail was swept**: its two `VACUOUS` were a CD deploy, then the campaign's own accumulated
community tiles stealing a click. **COMM-8 passes**, which is the forked distribution group measured
at last, and COMM-11 is clean with it. **What the rung still owes:** the 403 served to the OWNER in
COMM-23, and WP-REGRANT-2's proof - COMM-8 passes with `seedAfterTheGrant: repaired`, not `true`.

A community is a `Workspace`, and **its membership is not MLS membership**. Every row is read against
MSG-5's standing assertion: no `masterSecret` in any payload, ever.

Twenty-five rows, all with a runner; COMM-23 and COMM-24 share `comm2324.mjs`. COMM-9 and COMM-10
share one recorded verdict, `COMM-9/10`.

**THE AMPLIFIER FIX HELD, AND WHAT IT WAS HIDING IS NOW READABLE** (re-run 2026-08-27 on
`cb967b6c`, twenty rows `--without A1`; the four `+A1` rows still carry their `6808a89c` verdict).
**15 `PASS` where the previous sweep had none** - the twenty-one cells really were one defect, and
acknowledging a same-epoch refusal removed it. `could not join the distribution group` still appears
in no row.

Three cells survived, and they are not the old signature:

- **COMM-8 `FAIL`** - the one row whose dirt was never only the amplifier. A member granted a private
  salon reached its delivery roster and then stored no seed at all. **The peer external-joined the
  salon's group twice across a navigation** - base 0, then base 1, two seconds apart - because an
  accepted external join was durable on the SERVER and volatile on the client: the epoch advance is
  written for every other member the instant the gate accepts it, while the secrets live only in
  WASM memory until some later checkpoint. The reload found no local group and joined again. The
  salon reached epoch 2, the granting device stayed at 0 refusing frames it had no tree for, and the
  seed it held could not move. **FOUR groups were double-joined in this one rung** (`93c80263`,
  `a3b34f58`, `73cb54d2`, `60561454`). Fixed - the join now awaits its structural checkpoint - and
  the rung owes a re-run to confirm it.
- **COMM-11 `PASS-DIRTY`** - one same-epoch refusal at 0/0 on `5e09125d`, correctly ACKed now but
  still an ERROR. Same root: a distribution group forked by a duplicate join.
- **COMM-9/10, COMM-21, COMM-22 `VACUOUS`**, all three unchanged by the fix, which is what
  adjudicates them: none was the debris. COMM-21's HTTP 400 survived exactly as predicted.
  COMM-22 has since been re-run and is `PASS` and clean on `66639621`.

**THE ACK FIX DID NOT CAUSE COMM-8.** The ledger carries `seedAfterTheGrant: false` twice on pre-fix
builds (`d3cff54c`, `d6f61539`), and it has never once recorded `'distributed'` - every pass this row
has ever taken came through the history-repair route, never the distribution frame.

**COMM-18 cost five FAILs that were four distinct product defects** - stories in `CHANGELOG.md`, what
they measured in [cross-client-campaign](cross-client-campaign.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-3 | An expired link, a `maxUses`-exhausted link, a REVOKED link, a link to a deleted community - and the rotation's new link accepted, as the positive control | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-4 | Direct invite: the `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-5 | Roles: promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-6 | The permission grid offers the SIX enforced permissions and no seventh, the three default roles carry exactly what is documented, and a toggle reaches the column a decision reads | `W1` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** - `dm_device_group_memberships` for the salon's group names only its members | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d` - **the FAIL is gone**, and it was the fork: an external join durable on the server and volatile on the client. Twelve assertions hold, the peer is refused with a 403 and was never sealed a seed. **One residual: `seedAfterTheGrant` reads `repaired`, not `true`** - the granted peer holds its seed because the REPAIR path delivered it, and a fallback is a signal, never a path. The proof WP-REGRANT-2 wants is therefore still not taken |
| COMM-9 | Removed from a private salon: the server drops their routing rows (`evicted=true`), and the next message is sealed under a session they do not hold while the previous one still opens | `W1 W2` | `PASS-DIRTY` 2026-08-27 on `0c31be5d` (recorded under the combined id `COMM-9/10`). Dirt is ONE W1 line: `[GRAINE] lost the first-publish race for 38ad9778... - joining the published base instead`. It heals, and a race that heals cleanly is still a defect - name what makes the two publishes overlap |
| COMM-10 | Removed from a private salon: the messages they ALREADY hold stay readable - Graine retains seeds on purpose | `W1 W2` | `PASS-DIRTY` 2026-08-27 on `0c31be5d` - same combined row, same dirt as COMM-9. **The runner debt the user named is PAID**: a line that cannot ask its question now says so in `failures[]` instead of recording a bare `VACUOUS` |
| COMM-11 | Kicked from the COMMUNITY: the client purges the workspace AND leaves every private salon group it held | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d` - clean, `failures: []`. Every routing row dropped, the roster cleared, and the salon left BOTH sidebars. The fork signature it shared with COMM-8 is gone |
| COMM-12 | Re-invited after a removal: they receive the sessions minted from now on, and the past only as `history_visibility` allows | `W1 W2` | **`PASS-DIRTY`** 2026-08-27 on `66639621` / `__sveltekit_1s256u0`, after `cleanup.mjs` swept the rail - **and the sweep IS the adjudication**. The row had gone `VACUOUS` twice: once on a mid-run CD deploy with `failures: []`, then again with a NAMED failure, `click missed its target: [aria-label="Ajouter une communaute"] - dispatched at 108,475 on <BUTTON>, taken by` a community TILE of an earlier COMM run. `stableCentreOf` had cleared that point 120 ms earlier and the recorder named who took it, so the campaign's OWN debris - 8 communities on the rail - was overflowing the control. Six debris communities and 26 debris salons later the same runner passes unchanged, which is the cleanest possible proof that nothing about the product was ever at fault here: **an inherited state, not a defect**, and queue item 4's per-step starting point is what stops it recurring. The dirt is 9 social-service lines the classifier has no rule for - a workspace create, an invite pair, the distribution-group commits, and six `No message queued after validation - recipients=0` WARNs that are correct for a key-distribution group whose only member is its creator. Noise to teach `srvclassify` about, not a signal |
| COMM-13 | An admin JOINS a private salon: they see it unjoined, `distribution-group` answers 403 before and 200 after, the member list gains their name, the transcript gains NOTHING, and the row stops offering the join | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-14 | Channel notification levels enforced server-side | `+push` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - **re-run WITH the phone at last** (it had stood on `6808a89c` since 2026-08-22) |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-16 | Delete a channel, then a community by typing its name: the rows are really gone and the slug is free again | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - **re-run WITH the phone at last** |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `PASS-DIRTY` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - **re-run WITH the phone**; the deep link landed and the marker was on screen in 153ms. Dirt is one A1 line, `[hooks] launch URL already acted on by this start, ignoring the replay` - a designed dedupe announcing itself, and the only reason this is not a PASS |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `PASS-DIRTY` 2026-08-27 on `0c31be5d` - it was `VACUOUS`. Dirt is ONE W2 line, `[MLS] Skipping stale MLS state write (v63068 <= stored v63069)`, the `peerWroteBefore` signature. **Its 400 probe is INTENDED and is not the cause** - `comm21.mjs:196` requires it; read the whole verdict line before chasing the status code |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | **`PASS`** 2026-08-27 on `66639621` / `__sveltekit_1s256u0`, `clean: true` - the re-run in the quiet window, and the row's first real verdict after two `VACUOUS` deploys. All seven assertions hold on a salon carrying **12 Graine sessions minted over 6 join/leave cycles** (epochs 1->13): every message reached the server (12/12), the sender reads all 12, and the peer reads all 12 both warm (3.2 s) and cold (3.3 s, `gate: unlocked`), holding **one seed per session** - the same twelve session ids in `seedsWarm` and `seedsCold`, so nothing was reconstructed by luck. `nothingStaysUnreadable` is the assertion that matters: the peer DID miss 30 frames and DID render `[CHANNEL] ... unreadable ... (repairable)` rows, then `[GRAINE] absorbed` closed every one. **This is also the first production measurement of the joiner publishing `base + 1` inside its own submission**: `[MLS] externalJoin succeeded ... (base epoch 0, base for 1 stored with the commit)`. The `TooDistantInThePast` warns are on an unrelated group at `msg_epoch=2`, correctly refused |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `PASS-DIRTY` 2026-08-27 on `0c31be5d` - the routing flip holds. Dirt is on W1, the OWNER: `GET /api/mls/group-info/8473ce11 -> 403` followed by `[PIPELINE] Recovery attempt finished`. A 403 to the owner of the group it just minted is a QUESTION, not a designed refusal - the one thing in this COMM run nobody has explained |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - clean |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `PASS` 2026-08-27 on `0c31be5d`, A1 `0c31be5d` - **re-run WITH the phone at last**: the second device took the salon seeds after the join, with no second join |

## 10 - DEL - deleting a conversation, crossed

**Standing, `0c31be5d`: no `FAIL` and no `VACUOUS` left - the rung is answered end to end.** DEL-7
and DEL-9 each cost a HARNESS fault, both fixed; the rows carry them.

Deletion removes state while OTHER state keeps pointing at it, so each row pairs it with something
mid-flight.

**All ten have a runner** - `del1.mjs` for DEL-1, `del.mjs --only N` for the rest; the phase order and the phone row are justified in `checks.mjs` beside the list.

| Id | The crossing | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `PASS-DIRTY` 1/1 - armed at last (`armed: true`), 4/4 assertions. Dirt = 6 `[History] frame never read here and unreadable for good (past-epoch-application)` on W2, a designed line announcing loss that reconciliation then recovers |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `PASS 1/1` on `0c31be5d` |
| DEL-3 | Both peers delete the same conversation within a second | `W1 W2` | `PASS-DIRTY 1/1` on `0c31be5d` |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `PASS-DIRTY 1/1` on `0c31be5d` |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `PASS 1/1` on `0c31be5d` |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `PASS-DIRTY 1/1` on `0c31be5d` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `PASS 1/1` on `0c31be5d`: reached A1 in 147ms, killed at `LAST`, purged on wake, converged in 0ms, ONE `[READD]` solicitation. **It first recorded `INVALID` blaming the product** - `the group never reached A1` - when the group HAD reached A1: `devicesFor` matched its phone declaration `del.mjs --only 7` by whole-string equality against the invocation that actually exists (`--only 7 --destructive`), so the preflight silently ran `W1 W2` and left the phone unarmed. Then, armed, the row still could not SEE the group: the phone sidebar holds its rows but is `display: none` behind an open conversation at 411px, so a `width > 0` filter reads an empty list. THIRD sighting of that one fault (READ-9 2026-08-21, MUT-18 2026-08-22), each time fixed at one call site - which is why there was a third. Both fixed in the harness |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `PASS 1/1` on `0c31be5d` - first run ever, and it validates the `solicitationsAbout` predicate DEL-7 now shares. **RUNS LAST of the phase**, it restores a snapshot over W1's real state |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | **`PASS-DIRTY`** 2026-08-27 on `66639621` / `__sveltekit_1s256u0` (runner `2dd7a0f4a933`) - the re-run in the quiet window, and the row's real verdict after a `FAIL` and a `VACUOUS` that were both HARNESS faults. Its four assertions hold: pane `composer` -> `nothing`, no conversation held, unlisted, lifecycle `purged`, and the `forget_group` pair is logged. **The dirt is ONE unexplained W1 line**, `[blocks.isBlockedWith] Object` - a debug log printing an object as the string `Object`, which tells its reader nothing; it is noise to fix, not a signal about this row. **The two earlier verdicts are kept below because each left a rule.** It first recorded `FAIL` because the runner pre-empted its own gate: `rep.clean` sat inside its `ok` expression, so one benign `[HISTORY_COVERAGE]` line - caused by A1 joining the fleet - failed a row whose own assertions held, and made `PASS-DIRTY` structurally unreachable for it. `gate` only ever downgrades; folding cleanliness into an assertion is a category error. It then recorded `VACUOUS` with all four assertions holding, because CD deployed `5bb1cc92` mid-run and `gate` refused the attribution. Both fixed |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | `PASS-DIRTY 1/1` on `0c31be5d`, **and that CONTRADICTS the `FAIL` taken on `2a4297cb`** - the missing trigger fired here, in the dirt itself: `[EXIT] replaying 1 exit(s) the server never answered` then `[EXIT] c92c92e4... delete replayed - server deleted it`. The two lines are `unexplained` on W1 and that is the whole dirt. **Do not close the P2 in [backlog](backlog.md) on one row**: nothing here identifies what changed between the two builds, and the old FAIL measured a queued SEND (`sentOnFirstReconnect=0`) where this one measured a queued EXIT. Re-read it, do not declare it fixed |

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

MULTI-5's `ERROR` is runner debt, not product.

Opens by sweeping every `+A1` row left behind in tiers B and C.

### The four rows added 2026-08-28, and why NOTHING on this board could have caught the defect

**A conversation lost both its directions for 134 minutes on production and every rung above would
have passed through it.** The peer had NO active device in the group: a placeholder identity
(`userId='unknown'`, `deviceId='pending'`) had been stored as an `active` member 0.84 s before the
real members joined, and the peer's own two devices sat `pending` and were never activated. Full
account in [backlog](backlog.md), not restated here.

**The board was searched before these rows were written, and the gap is STRUCTURAL, not an
oversight.** Of the 200-odd rows, exactly ONE reads `dm_device_group_memberships` at all - COMM-8 -
and it reads **who is named**, never **what status they hold**. Every other row asserts the SYMPTOM:
a message appears, a badge lights, a list is right. That is precisely what this defect leaves
intact - it was invisible from the sender's side, and the receiver's side was a device the rig does
not own. **A rung can be green while a member of the group is a string the client itself defines as
"no identity yet".**

**Nor would the ladder have run long enough.** Every runner enrols, measures and tears down inside
one session. Three of the ten stranded memberships found on production had stood since 2026-08-03,
twenty-five days, and no row anywhere asks a question whose answer is a POPULATION rather than an
event. MULTI-10 is that question, and it is the cheapest of the four.

**And it is NOT an iOS defect, which is what makes it belong here rather than on
[device-verification](device-verification.md)**: nine of the ten stranded devices are `web-`, on
Chrome, and the guards that shipped are one client seam and one server allowlist, neither of them
platform-specific. `W1 W2` alone can run all four rows.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `+A1` | `PASS 1/1` on `0c31be5d` |
| MULTI-2 | Read on A1: read state reflected on W1 | `+A1` | `VACUOUS` on `0c31be5d` - `no stored conversation row named the peer`, so the row never got to ask its question. Fixture debt, undiagnosed |
| MULTI-3 | A1 enrolled AFTER W1 has history | `+A1` | `SKIPPED` on `0c31be5d`, **and the reason is RETIRED**: the skip was priced on SETUP-4's 2FA, and the user stated on 2026-08-27 that a 2FA, a re-login and a phone reboot are all payable on request ([campaign](cross-client-campaign.md), `+user`). It is now simply OWED, and it is the mobile twin of `HEAL-NEW-6` - run them together, one re-provisioning pays both |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= device check L) | `+A1` | `SKIPPED` on `0c31be5d` - the 2FA half of the reason is retired (see MULTI-3), but this row is still DESTRUCTIVE on the one armed phone, and A1 is the device every `+A1` row on the ladder depends on. It runs LAST of the phone rows, after `HEAL-NEW-4/5/6` have taken their measurements, or a revocation costs the rest of the campaign its only phone |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `+A1` | **`ERROR`** on `0c31be5d`, and it is RUNNER debt: `openChannel` on the second tab saw `no gateway connection line within 30 s`, then `sidebarPanel: false, listedEntries: 14, bodyChars: 960`. NOT the SharedWorker limitation - two tabs each hold their own socket and their own MLS client ([chat-gateway](frontend/chat-gateway.md), `backlog` 1718). **Live hypothesis, UNPROVEN**: a fresh tab is a fresh JS context, so it is behind the PIN gate, and ~14 buttons is a numeric keypad. `pin.mjs --match` is the fixture fix (it exits 2 when already unlocked) |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `+A1` | `PASS-DIRTY 1/1` on `0c31be5d` |
| MULTI-7 | Every device of both users reaches `active` in `dm_device_group_memberships`, and **no row names a placeholder identity** | `W1 W2` | `pending` - written 2026-08-28, **runner `roster.mjs --row 7`** (2026-08-28). Asserts the ROW, which nothing on this board has ever done. It is the cheap half of the defect: `userId` and `deviceId` are compared against the client's own non-identity literals (`unknown`, `pending`), and a match is a `FAIL` however well the messages flowed |
| MULTI-8 | A second device enrolled while the peer is OFFLINE reaches `active` within the activation budget, **without a reinstall** | `W1 W2` `+W3` | `pending` - written 2026-08-28, **runner `roster.mjs --row 8`** (2026-08-28) - W3 is the second device it enrols, so the row costs no re-enrolment of A1. and this is the row that names the defect. On production the activation never came at all and the "heal" was the user uninstalling the app, which minted a new device id and took the group's only commit. **A reinstall must not be what makes this pass** - the runner asserts the ORIGINAL device id went `active`, and a new one appearing is a `FAIL`, not a recovery |
| MULTI-9 | With one device `pending`, **the peer's messages are still delivered to it once activated** - and the sender is not told they were | `W1 W2` `+W3` | `pending` - written 2026-08-28, **runner `roster.mjs --row 9`** (2026-08-28). The runner asserts the sharper half it can decide: a message sent while a member device is pending must still be RECOVERABLE by that device after it activates. Losing it is the 134 minutes. The half nobody watched: for 134 minutes messages were accepted, fanned out and lost, and both clients showed them sent. Asserts delivery after activation AND that nothing claimed success in between; a message accepted for a group with an inactive member is the case to name |
| MULTI-10 | **Whole-population invariant**: no membership `pending` past the budget, and none under a placeholder identity, ACROSS THE DATABASE | none | `pending` - written 2026-08-28, **runner `roster.mjs --row 10`** (2026-08-28), which opens NO client - it reads the table and the gateway only. and the only row here that does not ask about one group. Three of the ten stranded rows found on production had stood 25 days, so the question every other row cannot ask is how many there are. Runs as a preflight, and its output is a COUNT with the offending ids - a non-zero count is a finding even when every other rung is green. **`FAIL` on `e731b5b8`** (2026-08-28 00:51 UTC), and the verdict is a true positive against DATA rather than code: exactly ONE expectation is unmet, `noPlaceholderIdentityAnywhere`, on the single row `userId='unknown'` / `deviceId='pending'` / `status=active` in group `7da231f8`, written **2026-08-27 21:00:13 UTC**. The two invariants that would accuse the product both HOLD: zero `(group, user)` pairs with no active device, and all 10 `pending` rows belong to devices the gateway is not talking to - a switched-off device is legitimately pending, which is why the budget half is discriminated by presence and reported as `notCountedAgainstTheProduct` rather than counted. **The row cannot go green by being re-run**: the guards of `c8addd53` stop the NEXT placeholder being written and repair no existing one, so this is one `DELETE` on production - a one-off destructive action that belongs to the user, not a tool |

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

**AND FOUR MORE, ON THE USER'S ASK OF 2026-08-27: a revoked device that missed a LOT.** Verbatim:
*"un appareil qui a ete revoque, qui a manque plein de messages/changements MLS (nouveaux groupes,
suppressions de groupes etc) et de bien voir si tout est rattrape correctement a la fin (l'appareil
revoque devrait agir comme un appareil neuf puisque la revocation lui demande de tout supprimer, mais
il faut le tester). Ce cas est la porte vers beaucoup d'autres, toujours avec les histoires d'ordre,
et de device mobile ou web."*

**The expectation is an EQUALITY, and that is what makes it testable at all:** if revocation really
wipes, then a revoked device returning is a NEW device, and its final state must be the state a fresh
device reaches in the same window - the whole `HEAL-NEW-*` group already measures that side. So these
rows do not re-measure repair, they measure SAMENESS, and any difference is the finding: a returning
device that ends with more than a fresh one kept something the wipe was supposed to destroy
(HEAL-REVOKE-1's open P1 is exactly a device that kept everything); a device that ends with LESS is
carrying state that survived just enough to poison enumeration - the worse of the two, because it
looks healthy.

**Why the missed CHANGES matter and not just missed messages.** A device away for a long window misses
two kinds of thing, and only one of them has a catch-up path: messages accumulate in a queue that can
be drained, while MEMBERSHIP changes - a group created, a group deleted, a member removed - move the
epoch and cannot be replayed at all. A returning device therefore has to be told the shape of the
world rather than catch up to it, which is enumeration, which is the `HEAL-NEW-*` mechanism again. The
axes the user names - ORDER, and web versus mobile - apply unchanged, so the same equality is asserted
in each.

| Id | How the group is broken | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `+snapshot` | `pending` - a `healed` verdict after applying ZERO commits is a regression |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` - **a `FAIL` of 2026-08-11 stands in the ledger** and must not be read as current: it predates the `build` field entirely, so no artefact can be named for it, and it recorded `recovered: false` with `unknownGroupFired: 0` and `recoveryLines: 0` - the drain ran 8/8 and nothing asked for the missing group. That is the FIRST question of the rung, not its verdict |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch | `+snapshot` | `pending` - `TooDistantInTheFuture` must beat `GAP_QUEUED` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `+snapshot` | `pending` - no prior art on either client |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `+snapshot` | `pending` - quantitative. Runner: `heal-web.mjs` |
| HEAL-A1 | HEAL-repair mirrored onto the phone: **W2** is rewound and **A1** is the receiver that must detect and repair | `+A1` `+snapshot` | `pending` - W1 parked, so W2 is the only possible responder. Runner: `heal-a1.mjs` |
| HEAL-NEXT | After an escalation has ALREADY happened, does the next message arrive? | `+A1` `+snapshot` | `pending` - the escalating frame is unrecoverable by construction. Runner: `heal.mjs` |
| HEAL-REVOKE-1 | A device revoked through the connected-devices UI: is its local store actually gone? | `W1 W2` | `pending` - the user found one that kept everything, P1 in [backlog](backlog.md) |
| HEAL-REVOKE-2 | The revoked device reconnects: is it like-new, holding nothing from before? | `W1 W2` | `pending` - the blacklist can make this row pass while HEAL-REVOKE-1 fails |
| HEAL-REVOKE-3 | First reconnection after revocation resynchronises as a NEW device would, history included | `W1 W2` | `pending` - a shortfall must be REPORTED, not silently partial |
| HEAL-REVOKE-4 | The heal-on-diff mechanism catches up what the first reconnection missed - and fires on the RIGHT conditions | `W1 W2` | `pending` - the TRIGGER CONDITIONS are part of the assertion, not context |
| HEAL-REVOKE-5 | Revoked, then the account CHANGES a lot while it is away - groups created, groups deleted, messages sent - then it returns | `W1 W2` `+user` | `pending` - the user's ask. The assertion is an EQUALITY against a fresh device enrolled in the same window (`HEAL-NEW-*` supplies the reference), not a repair count. Ending with MORE than the fresh device means the wipe kept something; ending with LESS means something survived just enough to poison enumeration **Runner `healrevoke.mjs --row 5`** (2026-08-28) |
| HEAL-REVOKE-6 | The same, where the revoked device is **the phone** | `+A1` `+user` | `pending` - the mobile half of the user's ask. A1's store is SQLite behind the native layer, not the WebView IndexedDB the web wipe clears, so "the wipe ran" is a different claim here and must be read from the native store |
| HEAL-REVOKE-7 | The **ORDER** of the return: the revoked device back BEFORE the other devices are online, and back AFTER | `W1 W2` `+user` | `pending` - same equality across both orders, for the same reason HEAL-NEW-11/12/13 exist: a responder present from the start and one arriving late are different mechanisms. A difference in final state is a `FAIL`, a difference in time is dirt with a number **Runner `healrevoke.mjs --row 7 --order first|last`** (2026-08-28) |
| HEAL-REVOKE-8 | A group **DELETED while the device was revoked** must not return as a Sync row | `W1 W2` `+user` | `pending` - HEAL-NEW-7 from the other side, and the sharper case: the returning device may hold a stale membership belief no fresh device would have. Three causes must stay separable - a server tombstone, a per-user dismissal, and an exit the DELETING device still owes **Runner `healrevoke.mjs --row 8`** (2026-08-28) |

### The new-device path - sixteen rows the eleven above do not reach (`HEAL-NEW-*`)

Every row above breaks a device that **already held** the group - a rewound snapshot, or a
revocation. A device that has **never held anything** is a different mechanism, and it is the one the
user names as the app's sensitive point (2026-08-27): conversations stuck on the "Sync" badge, some
repairing and others not, and rows for conversations that are DELETED.

**Why it is a mechanism and not a variation.** A new device holds no group, so every row it shows is
minted by server enumeration - `discoverMissingGroups` in `utils/chat/actions.ts` - and every one of
them starts `isReady: false`. The badge is `chat_sync_badge_label` ("Sync"), rendered by
`ConversationTile.svelte` on exactly `!isReady && lifecycle !== 'removed'`. So **"Sync" is not a
progress indicator, it is the absence of MLS state** - and a row that will never repair looks
identical to one that is about to. Getting from there to ready is rung 2 of the
[recovery ladder](../protocols/mls-recovery-ladder.md): `requestReAdd` tries `externalJoin` (fetch the
published GroupInfo, build an external commit, no peer required), and only when no GroupInfo exists
does it fall back to a `welcome_request` - which **needs a member ONLINE to answer it**. So who else
is running is not a nuisance variable to be held constant, it IS the axis, which is why the user's
five conditions are five rows and not five repetitions of one.

**What this group must separate, and no existing row does:** an enumerated row that repaired by
external join, one that repaired by a peer's Welcome, one that CANNOT repair because nobody can
answer, and one that should never have been enumerated at all. All four look the same in the sidebar.

**The cost, stated once: every row here is `+user`,** because a fresh device pays SETUP-4's 2FA -
which is why MULTI-3 has been `SKIPPED` since `0c31be5d`. The group is only affordable if ONE 2FA
buys many rows, so it stands on a primitive the rig does not have: `newdevice.mjs`, clearing the
Canari ORIGIN (IndexedDB, the device key vault, the refresh cookie) while leaving the CAS/Authentik
session on its own origin intact, so the next load enrols as a device the server has never seen
without a credential prompt. **That is a claim, not a plan, and nine rows may not rest on an
unmeasured one** - it is HEAL-NEW-0 and it runs first.

**ORDER IS AN AXIS, NOT A DETAIL, and equality across it is the assertion** (user, 2026-08-27:
*"W3 actif avant W1, w1 actif avant W3, etc. Toutes les configurations sont a tester et finir, pour
que tout pass, de la meme facon (tout l'interet de la reconciliation)"*). A responder that is
ALREADY online when the fresh device first enumerates, and the same responder arriving AFTER every
row has gone amber, are two different mechanisms wearing one sidebar: the first can be answered
inside the initial `discoverMissingGroups`, the second needs something to notice later and ask
again - a reconnect, a presence event, or a retry. That is why each responder kind gets a
present-from-the-start row AND an arrives-late row, and why the verdict is an EQUALITY: **a
difference in the FINAL state between two orders is a `FAIL`; a difference in the TIME to reach it
is dirt carrying a number.** Reconciliation that depends on who booted first is not reconciliation.

**EVERY ROW HERE IS A TIMELINE, NOT A SNAPSHOT** (user, 2026-08-27: *"Est-ce-que tout finit bien par
HEAL, et est-ce que le temps gene la navigation/UX"*). Two questions, and a readiness count answers
neither: does it EVENTUALLY heal, and is the app usable while it does not. So every row records, per
sample, an elapsed offset and a wall-clock stamp - the offset is what an assertion may use, the
stamp is what makes a sample correlatable with a console, logcat or server line when the cause turns
out to be on the far side of the wire. A row that ends amber must name WHICH rows and for how long;
a row that heals must say when. `syncrows.mjs` is that reader, and it counts readiness off
`data-conversation-tile` / `data-ready` / `data-removed` rather than off the "Sync" badge's text,
because the badge is a Paraglide message and counting it counts the translation - the day the string
moves, the count silently becomes zero, which is exactly the answer that lets a HEAL row pass over a
broken app.

| Id | The condition the row isolates | Needs | State |
| --- | --- | --- | --- |
| HEAL-NEW-0 | The rig can mint a device the server has never seen, repeatably, on ONE 2FA | `+user` | **`PASS-DIRTY` on `48b65d08`** (2026-08-28 01:12 UTC) - the primitive the other ten rest on, and it holds: the wipe leaves no identity, no store and no cookie; the account comes back; a `device_id` the server had never seen is minted; the census carries it; and there is **no credential prompt** - the SSO session lives on `auth.canari-emse.fr` / `cas.emse.fr` and wiping the app's origin does not touch it, so a re-enrolling device fills no field. That is why the eleven rows cost ONE 2FA and not eleven. The dirt is the bulk `[History] frame never read here and unreadable for good (past-epoch-application); will reconcile` a fresh device prints for every frame older than its own epoch - see the note below the table. **It reached this verdict only after three rig faults were fixed**; the three earlier `FAIL`s of the same night measured the instrument |
| HEAL-NEW-1 | Fresh device, **nothing else online** - external join is the only path there is | `+user` | **`PASS` on `48b65d08`** (2026-08-28 01:25 UTC) - isolates `externalJoin` from every peer path, and the isolation was REAL: W1 and W2 killed, the phone force-stopped, and the gateway asked twice - `extra: []` after a 915 ms drain. Ten rows went amber and stayed amber for the full 600 s window, `serverActive: 10` throughout, which is the outcome the condition entails: a group with no published GroupInfo has no path in and no amount of waiting makes one. **What this row does NOT yet assert is that the app SAYS `no_peer_online`** - it asserts the OUTCOME and refuses the measurement (`INVALID`, intruder named) when the fleet is not empty, which is the stronger guard, but the console status itself is unread. HEAL-NEW-5 is where that distinction has to be made, because a stall with nothing owed and a stall that reported why are the same picture here **Runner `healnew.mjs --row 1`** (2026-08-28) |
| HEAL-NEW-2 | Fresh device, **the PEER online** - a responder that is not us | `+user` | `pending` - the `welcome_request` fallback, with the roster's other user answering **Runner `healnew.mjs --row 2`** (2026-08-28) |
| HEAL-NEW-3 | Fresh device, **another device of the SAME user online** (W1) | `+user` | `pending` - the responder is our own other device. This is the condition the user actually lives in **Runner `healnew.mjs --row 3`** (2026-08-28) |
| HEAL-NEW-4 | Fresh device, the only possible responder is **the phone, foreground** | `+A1` `+user` | `pending` |
| HEAL-NEW-5 | The same, **phone BACKGROUNDED** | `+A1` `+user` | `pending` - a responder that cannot answer must not leave a group on Sync with nothing owed. This is the row that says whether the ladder terminates on a PROOF or on a clock |
| HEAL-NEW-6 | **The new device IS the phone**, enrolled after the account has history | `+A1` `+user` | `pending` - this is MULTI-3, and it stops being `SKIPPED` the moment a 2FA is being paid anyway |
| HEAL-NEW-7 | **A DELETED conversation must not come back as a Sync row** | `+user` | `pending` - the user's first symptom. Three causes must be told apart, and only two are visible to a new device: a server tombstone (`deletedAt`, filtered by `activeServerGroups`), a per-user dismissal (`getDismissedGroups`), and an **owed exit** - which lives in the DELETING device's own IndexedDB (`pendingGroupExits.ts`) and therefore cannot be seen by a second device at all. While the first device still owes the server that exit, a new device is *entitled* to re-create the group, and the user sees a deleted conversation wearing a Sync badge |
| HEAL-NEW-8 | **N conversations at once: do they ALL repair?** | `+user` | `pending` - the user's second symptom. The assertion is a COUNT plus the identity of every laggard, never a sample: `RECOVERY_TIMEOUT_MS` throttles to one attempt per period and `PROBE_COALESCE_MS` collapses a 30 s burst, so whether recovery is per-GROUP or per-DEVICE is exactly what a 13-conversation account measures and a 1-conversation account cannot |
| HEAL-NEW-9 | After repair, does the new device get the HISTORY? | `+user` | `pending` - `externalJoin` restores membership, never the past. [history-reconciliation](../protocols/history-reconciliation.md) says a new device with no peer online starts with everything unread; this row separates "no history" from "no history YET" |
| HEAL-NEW-10 | Two fresh devices enrolling **at the same time** | `+user` | `pending` - the add-lock (`/api/mls/push/acquire-add-lock`) under two concurrent enumerations. Lowest of the group: the race the user suspects is HEAL-NEW-8's, and this one costs a second 2FA |
| HEAL-NEW-11 | The responder is our own **W1, arriving LATE** - W3 goes amber ALONE, then W1 comes online | `+user` | `pending` - the order twin of HEAL-NEW-3, and the harder half: nothing is listening when the rows are minted, so something must ask AGAIN. Same final state as HEAL-NEW-3 or `FAIL` **Runner `healnew.mjs --row 11`** (2026-08-28) |
| HEAL-NEW-12 | The responder is the **PEER W2, arriving LATE** - W3 goes amber alone, then W2 comes online | `+user` | `pending` - the order twin of HEAL-NEW-2. A `welcome_request` nobody heard is not a request that will be re-heard: whether it is re-issued on the peer's arrival is the row **Runner `healnew.mjs --row 12`** (2026-08-28) |
| HEAL-NEW-13 | The responder is **the phone, arriving LATE** - W3 goes amber alone, then A1 is brought to the foreground | `+A1` `+user` | `pending` - the order twin of HEAL-NEW-4, and the one that says whether the retry is driven by OUR reconnect or by the RESPONDER's. Read with HEAL-NEW-5, whose responder can never answer |
| HEAL-NEW-14 | **The heal is INTERRUPTED** - a reload, then a link cut and restored, while rows are still amber | `+user` | `pending` - the user's own worry (*"en cas de coupure, rechargement de la page ou autre"*). Idempotence comes from durable state and termination from a proof: a reload must not restart the ladder from zero, and a cut must not leave a row amber with nothing owed |
| HEAL-NEW-15 | **Is the app usable while it heals?** N rows amber, and the user navigates and sends | `+user` | `pending` - the second half of the user's question. An amber sidebar that cannot be clicked, or a healed conversation that will not open, is a finding independent of whether the heal eventually completes - and a 10-minute heal is acceptable where 10 minutes of a frozen list is not **Runner `healnew.mjs --row 15`** (2026-08-28) |

**WHAT THE FIRST NIGHT OF THIS RUNG ACTUALLY MEASURED, 2026-08-28.** Five rows died in a row -
HEAL-NEW-0 `FAIL`, HEAL-REVOKE-5/7/8 and MULTI-8/9 `INVALID` - all on `login: false`, and not one of
them measured the product. **One cause, six rows:** the wipe clears the app's origin and does not
touch the SSO session, which lives on `auth.canari-emse.fr` and `cas.emse.fr`, so the browser walks
the whole flow and lands signed in with no field to fill - and `login.mjs` read "no `#username`
after 30 s" as a failure. `newdevice.mjs`'s own header had said so since it was written; the helper
had not been told. Three rig faults came out, each fixed by making a predicate name what it meant:

- **A missing form is TWO outcomes.** Classified at the throw now, by the fact available there -
  where the browser ended up - because downstream both are the same sentence.
- **`PARAGLIDE_LOCALE` was never a survivor.** MEASURED: clearing the origin leaves `[]`, and the
  reload the rig performs on purpose - so the wipe is read against a fresh document - is what writes
  the locale back. Asserting zero keys asserted against the rig's own reload. The claim is now no
  IDENTITY survived, with an allowlist by name rather than a tolerance by count.
- **`pin.mjs` exits 2 for "no unlock modal", which is an OBSERVATION.** `run()` collapsed every
  non-zero to `false`, so "the gate was not there" and "the gate refused us" reached the verdict as
  the same missing tick. Whether the app challenges a brand-new device is a question about the
  product, not this primitive's claim, and smuggling it in answered it by accident.

**A LAUNCHER CLICK IS JUDGED BY ITS EFFECT.** A button that has painted but not hydrated takes the
click and does nothing with it - `realClick`'s recorder confirms the `BUTTON` received the event, so
no layer reports a problem - and the step then spends its budget waiting for a navigation that never
started. A dropped click is not cured by waiting longer, so the step retries and ends on a fact.

**MEASURED AND OWED A ROW OF ITS OWN: a brand-new device enrols with NO PIN gate shown.** It reaches
`/chat`, enrols, and the census carries it, while `pin.mjs` finds no modal. Recorded as `pinGate:
"none shown"` on every HEAL row rather than judged here - see section 17, where the question
belongs.

**THE PHONE IS NOT PART OF ANY HEAL-NEW TOPOLOGY, so every row stops it first.** A1 is a third
device of the OWNER's account, fanned into every group the owner creates, and no row here models it:
row 1 claims nothing of the account was online, rows 2 and 12 claim no device of ours could have
served the Welcome, and rows 3, 11 and 15 could not say whether W1 or the phone answered. `am
force-stop` is the kill, for the reason a browser is killed rather than navigated away - a
backgrounded app keeps its gateway socket - and it is paired with a restore registered as an exit
hook, because a row that dies early would otherwise leave the package in Android's STOPPED state
where FCM is cancelled, and every later push row would silently measure this row's kill.

**THE DIRT EVERY FRESH DEVICE CARRIES.** `[History] frame never read here and unreadable for good
(past-epoch-application); will reconcile` arrives once per frame older than the device's own epoch -
hundreds of lines on an account with history. A device that was not in the group at that epoch
genuinely cannot read those frames, so the condition is expected; what is not settled is whether
`severe` is the right level for it, and until that is answered **every row on this rung is
`PASS-DIRTY` at best**, which is a reporting question standing between this rung and the `PASS` the
user asked for.

**THE CAUSE OF EVERY HEAL-NEW FAILURE WAS THE PER-USER DEVICE CAP, AND THE PREDICATE WAS RIGHT ALL
ALONG, 2026-08-28 10:22.** One mint on a quiet prod settled it: `POST /api/mls/register-device -> 400`,
`[KP] Publication failed (400) - welcome_request deferred to next connection`, then
`[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package` on the server for all ten groups. `registerDevice`
counts the account's `key_package` rows and throws at `MAX_DEVICES_PER_USER` = 15 **before it logs
`[REGISTER_DEVICE] START`**, which is why the server's trace looked empty. The owner account stood at
exactly 15, and **all fifteen slots were the campaign's own abandoned mints**. With the debris purged
(25 devices deleted through the product's own panel, account back to 2), the same profile published
its KeyPackage in **1.9 s**.

**So the census was never the wrong question - it was the RIGHT one, asked of a device the server had
refused.** Reading `auth_sessions` instead made the row pass while the device was unusable, which is
worse than the failure it replaced. The primitive now reads BOTH facts and reports the pair: a session
with no KeyPackage is not "publication is slow", it is "the registration was REFUSED, go read the
server's line". It also asserts the account has a free slot BEFORE it wipes anything, and purges the
id each mint abandons - a sixteen-row rung fills a fifteen-device cap by construction. **The product
half is a P1 in [backlog](backlog.md): a 400 that means "delete a device" reaches the user as a
console line saying "deferred to next connection".**

**THE SECOND NIGHT MEASURED ONE THING, AND IT WAS THE INSTRUMENT, 2026-08-28 03:30-03:58.**
Run 3 of the ladder took eight rows and recorded NOTHING: HEAL-NEW-2, -12, -3, -11 and -15 exited 1,
and all four HEAL-REVOKE rows exited 2 on the preflight's own refusal. **No verdict from this run is
on this board, and none should be** - `gate` refusing the attribution is again the only reason
nothing false was recorded.

**The five HEAL-NEW rows died on one predicate, and the predicate was wrong.** Every row failed
`sameAccountEnrolled` while everything the row was written to measure had already succeeded: the
wipe was total, the IdP kept its session, the client minted a fresh id (`mtca2o9o-6fn1` for row 2),
and `active` grew from 9 to 10. The poll added the night before then ran its FULL 60 s deadline -
`the census carries the new id: false (after 63762ms)` - so the fix that was supposed to remove the
flake instead proved the fact is never true. **`census()` reads `key_package` UNION
`dm_device_group_memberships`** (`devices.mjs:76`), so a device that has published no KeyPackage and
joined no group is not absent from the census, it is INVISIBLE to it. Measured on prod for that
exact device: `auth_sessions` 1 row at 01:33:32 - the same instant the client reported the id -
`key_package` 0, `one_time_key_package` 0, memberships 0. **There is no device-registry table at
all**; `auth_sessions` is the only table that records that a device exists, and it is the table the
predicate should have read.

**The population question was asked before believing any of it, and it changed the answer.** Web
devices holding a session but no KeyPackage, by day: **12 of 22 today, and ZERO on every day from
2026-08-21 to 2026-08-27** but one. That shape reads exactly like a regression landing with tonight's
deploy - and it is not one: **all 12 belong to `d82cd226`, the harness owner account, first seen
between 01:30:01 and 01:45:59, which is run 3's HEAL-NEW window to the second.** Nothing outside this
rig is affected, and no P1 is opened. **What is NOT settled is which of two causes it is** - the
runner tearing W3 down before the client gets to publish (rig timing), or a wiped profile genuinely
failing to publish (product). The discriminator is one gesture and it is the first thing owed on
resumption: **mint ONE device by hand, leave it entirely alone for ten minutes, then query
`key_package`.** Until that is run, `enrolled` must not be read as a product fact in either
direction.

**The four HEAL-REVOKE rows never started, and the cause is W2, not the runner.** Each preflight
reported `W2 (9223): OFFLINE` and `still unknown on /login after 4 repair(s) - unknown -> unknown ->
unknown -> unknown -> unknown`, while `start w2` answered exit 1 (already running) every time. W2 was
therefore alive, on `/login`, and logged out - and the ladder's `baseline()` cannot repair that,
because `launch.mjs start` is a no-op against a running browser and `unlock.mjs` only answers a PIN
gate. **A device that has lost its session is a state no baseline in this rig currently restores**,
which is the per-STEP starting point queue item 6 was written for, now blocking rows rather than
merely owed. `login.mjs --device W2` against the live profile is the cheap first attempt.

**One rig fault was fixed and has not yet run:** `revoke()` in `healrevoke.mjs` read the census once,
immediately after the purge, and that single read is the gate all four HEAL-REVOKE rows stand on. It
now polls for the disappearance with a 45 s bound and records `goneInMs`. It inherits the census
defect described above and must be re-pointed at `auth_sessions` / `revoked_device` in the same pass.

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
