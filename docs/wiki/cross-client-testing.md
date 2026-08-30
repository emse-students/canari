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
| 0 SETUP | - | - | 5/9 `passed`, 1 `skipped` |
| 1 MSG | 12 | `e9d951d7` | **`PASS` 12/12 x1** - 4 `a1Build` re-runs owed |
| 2 TYPE | 5 | `e9d951d7` | **`PASS` 5/5 x1** |
| 3 READ | 10 | `70497810` | **`PASS` 9/9 x5**, READ-5 `SKIPPED` |
| 4 MUT | 21 | `6748f6b8`, A1 `a7981206` | **`PASS` 24/24 x5**, MUT-20 `SKIPPED` |
| 5 SEARCH | 6 | `1f396ac7` | **`PASS` 6/6 x5** on `928f8b286dac` |
| 6 MENTION | 6 | `1f396ac7`, A1 `a7981206` | **`PASS` 6/6 x5** on `cdc081edabc0` |
| 7 FWD | 6 | `1579d5c3`, A1 `a7981206` | **`PASS` 6/6 x5** |
| 8 GRP | 10 | `feecfaf5` | **`PASS` 9/10 x4**, GRP-8 dirty by design |
| 9 COMM | 25 | `0c31be5d`, COMM-12/22 `66639621`, A1 `0c31be5d` | 19 `PASS`, 5 `PASS-DIRTY`, COMM-10 shared |
| 10 DEL | 10 | `0c31be5d`, DEL-9 `66639621`, A1 `0c31be5d` | 4 `PASS`, 6 `PASS-DIRTY`; 7 re-runs owed (`2dd7a0f4a933`) |
| 11 TAB | 8 | - | `pending` |
| 12 MULTI | 10 | `0c31be5d` | 2 taken, 8 open; every cell owes a re-run (`74bb17b8283f`) |
| 13 LIFE | 8 | - | `pending` |
| 14 NOTIF | 21 | - | `pending` |
| 15 CALL | 20 | - | `pending` - no runner exists |
| 16 HEAL | 33 | `0f06a4b3`, `48b65d08`, HEAL-NEW-3/11 `ebef7f3c`, HEAL-NEW-2/12/15 `038c7e8d`, HEAL-REVOKE-5/8 `0044a041` | 10/33 taken: 3 `PASS`, HEAL-NEW-0/2/12/15 and HEAL-REVOKE-5/8 `PASS-DIRTY`, HEAL-REVOKE-7 `FAIL`; BOTH order pairs (2/12 and REVOKE-7) adjudicated EQUAL on the campaign page; -7 found a P1 (fixed `edb8d7ab`) and owes half B on it; 1 and 3 owe an ungated re-run |
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

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| SETUP-1 | Build the debug APK, plus the jniLibs `.so` rescue | `+A1` | `passed` 2026-08-14 |
| SETUP-2 | Clean uninstall + install (wipes `mls.bin`) - `install -r` keeps the store instead, and avoids re-paying SETUP-4's 2FA | `+A1` | `skipped` - deliberate |
| SETUP-3 | Start logcat | `+A1` | re-run each session |
| SETUP-4 | W1: log in as owner, enrol the device, set the PIN | `+user` | `passed` 2026-08-14 |
| SETUP-5 | W2: log in as peer, set the PIN | `W1 W2` | `passed` 2026-08-14 |
| SETUP-6 | A1: log in as owner, decline biometrics | `+A1` `+user` | `passed` 2026-08-14 |
| SETUP-7 | Discovery pass over the real at-rest artefacts | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-8 | Baseline snapshot of intact Android app data | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-9 | The dedicated venue for channel traffic, recreated through the UI after the 2026-08-17 purge | `W1 W2` | `passed` 2026-08-19 |

## 1 - MSG - the plain path

`226fe755`, 2026-08-16: 12 verdicts, 12 `PASS`, every client clean, server clean over the run's own
window. Earlier x5 series on `8a3edbdd`, `e62c21f1` and `25376b86` all read 13/13.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `W1 W2` | `PASS` - 325 ms |
| MSG-1-cold | Same, after a reload | `W1 W2` | `PASS` - 326 ms |
| MSG-1b | Delivery DURING a history load | `W1 W2` | `PASS` - 3 ms |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `+A1` | `PASS` - 578 ms. **`a1Build` owed** |
| MSG-3 | Reply renders with its quoted parent on both sides | `W1 W2` | `PASS` - 303 ms |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver decodes | `W1 W2` | `PASS` |
| MSG-5 | Channel message converges on all three; no `masterSecret` in any payload | `+A1` | `PASS`. **`a1Build` owed** |
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

`25376b86` x5 on runner `2c2b83d1b748`: 8 of 8 runnable `PASS` on every pass, 40 of 40 clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the badge on W1 and marks it read for the sender | `W1 W2` | `PASS` 5/5 |
| READ-2 | The SAME user's other device also clears | `+A1` | `PASS` 5/5 |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible | `W1 W2` | `PASS` 5/5 |
| READ-4 | The 2 s debounce batches: twenty messages send ONE watermark | `W1 W2` | `PASS` 5/5 |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three - the watermark is per USER, so it needs FOUR readers where the estate has TWO accounts | `+user` | `SKIPPED`, TERMINAL (user, 2026-08-23) |
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
| SEARCH-2 | A term only in OLD history: does `searchLimitedToLoaded` tell the truth? | `W1 W2` | `PASS` 5/5 - one `ERROR` in the six, [known intermittent](testing-methodology.md) |
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

`feecfaf5` x4: 9 `PASS`, 1 `PASS-DIRTY`, both P2s in [backlog](backlog.md). The first rung that
moves an MLS epoch, and the rung that proved a third device changes what a two-device check measures:
GRP-4's evictions were committed by an undriven fleet member, not by either driven browser.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GRP-1 | Create a group, add a member, both sides see the roster and the Add commit merges | `W1 W2` | **`PASS`** - `feecfaf5` x4 |
| GRP-2 | The picker must not offer existing members or yourself, and a no-op submission must not report success | `W1 W2` | **`PASS`** |
| GRP-3 | Remove a member: the Remove commit, and what the removed device can still read | `W1 W2` | **`PASS`** - `feecfaf5` x4; an earlier `PASS-DIRTY` is P2 in [backlog](backlog.md) |
| GRP-4 | The group invitation LINK: generate, open it on the other account | `W1 W2` | **`PASS`** - `feecfaf5` x4 after `e027679a` |
| GRP-5 | Rename a group, seen on the other side | `W1 W2` | **`PASS`** |
| GRP-6 | Leave a group - which deliberately commits nothing | `W1 W2` | **`PASS`** |
| GRP-7 | Add a member who is offline; they join on their next connection | `W1 W2` | **`PASS`** |
| GRP-8 | Add and remove the same member twice in a row, fast | `W1 W2` | `PASS-DIRTY` - `feecfaf5` x4, deterministic. P2 in [backlog](backlog.md) |
| GRP-9 | A member row rendering a raw user id instead of a display name | `W1 W2` | **`PASS`** - not reproduced |
| GRP-10 | The invitation link of one group must not appear in another group's panel | `W1 W2` | **`PASS`** |

## 9 - COMM - communities, channels, roles

`0c31be5d`, 2026-08-27, A1 `0c31be5d`: 25 rows, 19 `PASS`, 6 `PASS-DIRTY`, no `FAIL` and no
`VACUOUS`. COMM-12 and COMM-22 carry `66639621`; COMM-9 and COMM-10 share one verdict, `COMM-9/10`;
COMM-23 and COMM-24 share `comm2324.mjs`. A community is a `Workspace`, and **its membership is not
MLS membership**. Every row is read against MSG-5's standing assertion: no `masterSecret` in any
payload, ever.

**Owed:** COMM-23's 403 to the OWNER of a group it had just minted, unexplained; and WP-REGRANT-2's
proof, COMM-8 passing with `seedAfterTheGrant: repaired`, not `true`. Run history, the amplifier fix
and COMM-18's four defects: [cross-client-campaign](cross-client-campaign.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `PASS` |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `PASS` |
| COMM-3 | An expired link, a `maxUses`-exhausted one, a REVOKED one and one to a deleted community all refused, and the rotation's new link accepted as the positive control | `W1 W2` | `PASS` |
| COMM-4 | The `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `PASS` |
| COMM-5 | Promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `PASS` |
| COMM-6 | SIX enforced permissions and no seventh, the three default roles as documented, and a toggle reaching the column a decision reads | `W1` | `PASS` |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `PASS` |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** | `W1 W2` | `PASS` - **`seedAfterTheGrant: repaired`, not `true`**, so WP-REGRANT-2 is owed |
| COMM-9 | Removed from a salon: routing rows dropped (`evicted=true`), the next message sealed under a session they do not hold | `W1 W2` | `PASS-DIRTY`, as `COMM-9/10` - a publish race that heals |
| COMM-10 | Removed from a salon: what they ALREADY hold stays readable - Graine retains seeds on purpose | `W1 W2` | `PASS-DIRTY` - shared with COMM-9 |
| COMM-11 | Kicked from the COMMUNITY: the workspace purged and every private salon group left | `W1 W2` | `PASS` |
| COMM-12 | Re-invited after a removal: sessions minted from now on, and the past only as `history_visibility` allows | `W1 W2` | `PASS-DIRTY` on `66639621`, after a rail sweep |
| COMM-13 | An admin JOINS a salon: 403 before and 200 after, the member list gains them, the transcript gains NOTHING | `W1 W2` | `PASS` |
| COMM-14 | Channel notification levels enforced server-side | `+push` | `PASS` |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `PASS` |
| COMM-16 | Delete a channel, then a community by typing its name: the rows really gone, the slug free again | `W1 W2` | `PASS` |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `PASS` |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `PASS-DIRTY` - 153 ms; dirt is a designed dedupe line |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `PASS` |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `PASS` |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `PASS-DIRTY` - the `peerWroteBefore` signature |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `PASS` on `66639621`, clean - 12 sessions, 12/12 warm and cold |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `PASS-DIRTY` - **a 403 to the OWNER, unexplained** |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `PASS` |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `PASS` |

## 10 - DEL - deleting a conversation, crossed

`0c31be5d`, 2026-08-27: 10 rows, 4 `PASS`, 6 `PASS-DIRTY`, no `FAIL` and no `VACUOUS` - the rung is
answered end to end. Deletion removes state while OTHER state keeps pointing at it, so each row pairs
it with something mid-flight. All ten have a runner - `del1.mjs` for DEL-1, `del.mjs --only N` for the
rest, the phase order and the phone row justified in `checks.mjs`. The three harness faults DEL-7 and
DEL-9 cost are on [testing-methodology](testing-methodology.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `PASS-DIRTY 1/1` - armed at last, 4/4 |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `PASS 1/1` |
| DEL-3 | Both peers delete the same conversation within a second | `W1 W2` | `PASS-DIRTY 1/1` |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `PASS-DIRTY 1/1` |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `PASS 1/1` |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `PASS-DIRTY 1/1` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `PASS 1/1` - 147 ms, one `[READD]` |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `PASS 1/1` - first run ever. **RUNS LAST of the phase** |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | `PASS-DIRTY` on `66639621` - 4/4; dirt is one debug line |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | `PASS-DIRTY 1/1` - **it CONTRADICTS the `FAIL` on `2a4297cb`**, and the P2 stays open |

## 11 - TAB - tabs and windows

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TAB-1 | Backgrounded tab receives; title/badge updates - RE-SCOPED 2026-08-24 onto the web `Notification`, the only out-of-page signal the product has, and the gap it cannot assert is P3 in [backlog](backlog.md) | `W1 W2` | `pending` |
| TAB-2 | Tab closed, message arrives, tab reopened: present exactly once | `W1 W2` | `pending` |
| TAB-3 | Whole browser killed and relaunched: all arrive, no re-login | `W1 W2` | `pending` |
| TAB-3b | Cold-start timing, five runs | `W1 W2` | `pending` - one unexplained 77.7 s run |
| TAB-4 | Two tabs of the SAME account: no double-send, no epoch fight | `W1 W2` | `pending` |
| TAB-5 | Reload fired under 100 ms after submit: sent once or clearly queued, never lost | `W1 W2` | `pending` |
| TAB-6 | Delete the refresh cookie, then act: clean re-login, not a silent empty list | `+user` | `pending` - the re-login costs the 2FA |
| TAB-7 | Offline -> act -> online, tab never reloaded | `W1 W2` | `pending` - written 2026-08-24, never run |

## 12 - MULTI - one user, two devices

`0c31be5d`: 10 rows. Opens by sweeping every `+A1` row left behind in tiers B and C. Rows 7-10 were
written 2026-08-28 against the placeholder-membership P1 (`roster.mjs --row N`); why nothing else on
this board could have caught it is on
[cross-client-campaign](cross-client-campaign.md), the account of the defect in [backlog](backlog.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `+A1` | `PASS 1/1` |
| MULTI-2 | Read on A1: read state reflected on W1 | `+A1` | `VACUOUS` - fixture debt, undiagnosed |
| MULTI-3 | A1 enrolled AFTER W1 has history | `+A1` | `SKIPPED`, **the reason RETIRED** - simply owed |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= device check L) | `+A1` | `SKIPPED` - DESTRUCTIVE, runs LAST of the phone rows |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `+A1` | **`ERROR`** - runner debt, the PIN gate suspected |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `+A1` | `PASS-DIRTY 1/1` |
| MULTI-7 | Every device of both users reaches `active` in `dm_device_group_memberships`, and **no row names a placeholder identity** | `W1 W2` | `INVALID` - no venue, nothing read |
| MULTI-8 | A second device enrolled while the peer is OFFLINE reaches `active` within the budget, **without a reinstall** | `W1 W2` `+W3` | `INVALID` - same venue fault, untried |
| MULTI-9 | With one device `pending`, the peer's messages are **still delivered once it activates** - and the sender is not told they were | `W1 W2` `+W3` | `INVALID` - same venue fault, untried |
| MULTI-10 | **Whole-population invariant**: no membership `pending` past the budget and none under a placeholder identity, ACROSS THE DATABASE | none | `FAIL` on `e731b5b8` - one placeholder row; needs one `DELETE` on prod |

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
| NOTIF-2 | App killed, a **commit** pushed, then a message - a generic fallback is CORRECT, and opening the app must recover | `+push` | `pending` |
| NOTIF-3 | The same, message several epochs later | `+push` | `pending` |
| NOTIF-4 | Read on W1 while A1 is killed, W1 arriving at the salon AFTERWARDS: notification dismissed on A1 | `+push` | `PASS-DIRTY` on `1f396ac7` - re-run owed, the runner changed |
| NOTIF-4b | The same, W1 holding the salon ALREADY OPEN when the message lands - the case an unread counter cannot see | `+push` | `pending` |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `+push` | `pending` |
| NOTIF-6 | Quick reply from the shade (= device check K) | `+push` | `pending` - reported broken on an old APK |
| NOTIF-6b | "Marquer comme lu" from the shade: the banner goes AND the salon is read on the other devices - never verified either way | `+push` | `pending` |
| NOTIF-7 | Tap -> deep link into the conversation, **backgrounded** | `+push` | `pending` |
| NOTIF-7b | The same with the app **KILLED** | `+push` | `pending` |
| NOTIF-7c | Tap -> deep link into a CHANNEL, **backgrounded**: the salon is on screen and holds the marker - 7/7b are the DM only | `+push` | `pending` |
| NOTIF-7d | The same into a CHANNEL with the app **KILLED**, so the PIN gate mounts first - the case most likely to lose a pending deep link | `+push` | `pending` |
| NOTIF-8 | Doze + message: delivered, or on wake - record which | `+push` | `pending` |
| NOTIF-9 | Two devices of one user: exactly one notification surface behaves | `+push` | `pending` |
| NOTIF-10 | Airplane mode 10 min, 5 messages, then reconnect: all five survive | `+push` | `pending` |
| NOTIF-11 | Three messages into one salon: ONE notification carrying three stacked lines, not three notifications | `+push` | `pending` |
| NOTIF-12 | Who each stacked line is attributed to inside a salon - RECORDED, not asserted | `+push` | `pending` |
| NOTIF-13 | The BODY is readable: a mention renders as a name, never as its `@[uuid]` token | `+push` | `pending` - expected to `FAIL` until the P2 ships |
| NOTIF-14 | The TITLE names its conversation: community and salon for a channel, the sender's resolved display name for a DM | `+push` | `pending` |
| NOTIF-15 | A REACTION to one of my messages notifies me on a killed device, carrying the emoji and who reacted, and no message text - MUT-13 asserts the in-app half and defers the push half here | `+push` | `pending` |
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

Thirty-three rows, three groups, four runners (`heal.mjs`, `healrevoke.mjs --row N`, `heal-a1.mjs`,
`healnew.mjs --row N`): `HEAL-*` breaks a device that already held the group, `HEAL-REVOKE-*` asserts
that revocation is a WIPE, `HEAL-NEW-*` asks what a device the server has never seen can recover.
Every row that mints a device is `+user`. The break is a restored snapshot of the web MLS database,
which **rewinds W1's ratchet in EVERY group it holds, so no rung may follow without a teardown that
restores the invariant, never a snapshot**; every run needs `reload.mjs` first and a record of which
device answered.

**Six cells share ONE cause, the INSTRUMENT's, fixed 2026-08-28: the account sat at the server's
15-device cap, `register-device` answered 400 and no KeyPackage was ever published, so nothing could
be enrolled or revoked.** Re-runs owed, not findings. **And a responder can only serve a group it is
a MEMBER of** - the owner holds 11 active groups where the peer shares 2, so the peer-responder rows
assert the `servableSubset`, measured at 1 row of 10 on 2026-08-29.

Row-by-row design and cost:
[cross-client-campaign](cross-client-campaign.md#16-heal---what-the-rows-are-and-what-they-cost). The
four wipe defects found by hand:
[device-verification](device-verification.md#the-revocation-wipe-read-off-both-devices-by-hand).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send - a `healed` verdict after applying ZERO commits is a regression | `+snapshot` | `pending` |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `FAIL` of 2026-08-11, **which is NOT current** |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch - `TooDistantInTheFuture` must beat `GAP_QUEUED` | `+snapshot` | `pending` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role - no prior art on either client | `+snapshot` | `pending` |
| HEAL-repair | Does the history diff repair a rewound sender end to end? Quantitative | `+snapshot` | `pending` |
| HEAL-A1 | HEAL-repair mirrored onto the phone: **W2** is rewound and **A1** must detect and repair, W1 parked so W2 is the only possible responder | `+A1` `+snapshot` | `pending` |
| HEAL-NEXT | After an escalation has ALREADY happened, does the next message arrive? The escalating frame is unrecoverable by construction | `+A1` `+snapshot` | `pending` |
| HEAL-REVOKE-1 | A device revoked through the connected-devices UI: is its local store actually gone? The user found one that kept everything, P1 in [backlog](backlog.md) | `W1 W2` | `pending` |
| HEAL-REVOKE-2 | The revoked device reconnects: is it like-new, holding nothing from before? The blacklist can make this row pass while HEAL-REVOKE-1 fails | `W1 W2` | `pending` |
| HEAL-REVOKE-3 | First reconnection after revocation resynchronises as a NEW device would, history included - a shortfall must be REPORTED, not silently partial | `W1 W2` | `pending` |
| HEAL-REVOKE-4 | The heal-on-diff mechanism catches up what the first reconnection missed, and the TRIGGER CONDITIONS are part of the assertion | `W1 W2` | `pending` |
| HEAL-REVOKE-5 | Revoked, then the account CHANGES a lot while it is away, then it returns | `W1 W2` `+user` | `PASS-DIRTY` on `0044a041` - back 23/23 in 8.0s, reference 23/23, gap empty |
| HEAL-REVOKE-6 | The same, where the revoked device is **the phone** - A1's store is SQLite behind the native layer, not the WebView IndexedDB the web wipe clears, so "the wipe ran" is a different claim and must be read from the native store | `+A1` `+user` | `pending` - the instrument is in, the victim must be A1 |
| HEAL-REVOKE-7 | The **ORDER** of the return: back BEFORE the other devices are online, and back AFTER | `W1 W2` `+user` | `FAIL` on `0f06a4b3` - **the pair is ADJUDICATED: both orders EQUAL**, `equalityGap: []` in each (campaign page). `last` failed on a new group that reached NEITHER device - a P1 this row found, fixed in `edb8d7ab`; half B owes a re-run on the deployed fix |
| HEAL-REVOKE-8 | A group **DELETED while the device was revoked** must not return as a Sync row | `W1 W2` `+user` | `PASS-DIRTY` on `0044a041` - 24/24 both, the deleted group absent from BOTH |
| HEAL-REVOKE-9 | Revoked while **OFFLINE**: the wipe is DEFERRED, not lost, and must not fire while the server is unreachable | `W1 W2` | `pending` - written 2026-08-28 |
| HEAL-NEW-0 | The rig can mint a device the server has never seen, repeatably, on ONE 2FA | `+user` | **`PASS-DIRTY` on `48b65d08`** - a newer ledger `FAIL` is dirt only, P3 |
| HEAL-NEW-1 | Fresh device, **nothing else online** - external join is the only path there is | `+user` | **`PASS` on `48b65d08`** - isolation real, ten amber for 600 s |
| HEAL-NEW-2 | Fresh device, **the PEER online** - a responder that is not us | `+user` | **`PASS-DIRTY` on `038c7e8d`** - the servable row healed in 552 ms, 1 of 10 |
| HEAL-NEW-3 | Fresh device, **another device of the SAME user online** (W1) | `+user` | **`PASS`** on `ebef7f3c` - 10/10 ready; ungated, re-run owed |
| HEAL-NEW-4 | Fresh device, the only possible responder is **the phone, foreground** | `+A1` `+user` | `pending` |
| HEAL-NEW-5 | The same, **phone BACKGROUNDED** - a responder that cannot answer must not leave a group on Sync with nothing owed, which is what says whether the ladder terminates on a PROOF or on a clock | `+A1` `+user` | `pending` |
| HEAL-NEW-5b | The same with the phone **KILLED**, not backgrounded - the case a user actually creates, and the one no row asked about before 2026-08-30. A responder that is not merely slow but ABSENT must still leave every group either served or explicitly owed, never amber for ever | `+A1` `+user` | `pending` - written 2026-08-30 |
| HEAL-NEW-6 | **The new device IS the phone**, enrolled after the account has history - this is MULTI-3, and it stops being `SKIPPED` the moment a 2FA is being paid anyway | `+A1` `+user` | `pending` |
| HEAL-NEW-7 | **A DELETED conversation must not come back as a Sync row** - three causes to tell apart, and only two are visible to a new device | `+user` | `pending` |
| HEAL-NEW-8 | **N conversations at once: do they ALL repair?** The assertion is a COUNT plus the identity of every laggard, never a sample | `+user` | `pending` |
| HEAL-NEW-9 | After repair, does the new device get the HISTORY? Separates "no history" from "no history YET" | `+user` | `pending` |
| HEAL-NEW-10 | Two fresh devices enrolling **at the same time** - the add-lock under two concurrent enumerations. Costs a second 2FA | `+user` | `pending` |
| HEAL-NEW-11 | The responder is our own **W1, arriving LATE** | `+user` | **`PASS`** on `ebef7f3c` - 10/10 ready, settled 4.0 s after W1 arrived |
| HEAL-NEW-12 | The responder is the **PEER W2, arriving LATE** | `+user` | **`PASS-DIRTY` on `038c7e8d`** - 10 amber alone, then the same row ready in 2.6 s |
| HEAL-NEW-13 | The responder is **the phone, arriving LATE** - says whether the retry is driven by OUR reconnect or the RESPONDER's. Read with HEAL-NEW-5, whose responder can never answer | `+A1` `+user` | `pending` |
| HEAL-NEW-14 | **The heal is INTERRUPTED** - a reload, then a link cut and restored, while rows are still amber. A reload must not restart the ladder from zero, and a cut must not leave a row amber with nothing owed | `+user` | `pending` |
| HEAL-NEW-15 | **Is the app usable while it heals?** N rows amber, and the user navigates and sends | `+user` | **`PASS-DIRTY` on `038c7e8d`** - 10 amber, the click answered in 26 ms |

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
| PIN-7 | A wrong PIN, N times - a clean refusal is the expected result | `W1 W2` | `pending` |
| PIN-8 | The PIN gate while the server is unreachable - a transport failure must NOT log the user out | `W1 W2` | `pending` |
| PIN-9 | "Stay signed in", browser closed and reopened: vault path, no server round trip | `W1 W2` | `pending` |
| PIN-10 | A PIN change while a message is in flight - explicit failure, never a silent wrong-key state | `+snapshot` | `pending` |

## 18 - CORRUPT - deliberate store damage

**Runs last.** SETUP-8's archive is the only way back that does not cost a full re-enrolment.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CORRUPT-1 | Truncate the MLS store - explicit failure and recovery, never a silent empty history | `+snapshot` | `pending` |
| CORRUPT-2 | Flip one byte inside the ciphertext | `+snapshot` | `pending` - the AEAD tag must fail |
| CORRUPT-3 | Web vault blob replaced with valid base64 of garbage | `+snapshot` | `pending` - must surface, not hang |
| CORRUPT-4 | Zero-length MLS state | `+snapshot` | `pending` - treated as absent, clean re-enrolment |
| CORRUPT-5 | A store written by an older format version - keep a copy from before every format change | `+snapshot` | `pending` |
| CORRUPT-6 | A key vault entry damaged - recover or fail loudly, never a decrypt loop | `+push` `+snapshot` | `pending` |
| CORRUPT-7 | Drop an object store from the web message store mid-session | `+snapshot` | `pending` |
| CORRUPT-8 | The store replaced by another device s - **a pass that "works" is a finding** | `+snapshot` | `pending` |
| CORRUPT-9 | Fill the data dir until writes fail, then receive | `+A1` `+snapshot` | `pending` - no half-written save |
| CORRUPT-10 | A write interrupted mid-flush - never a half-file read as valid | `+A1` `+snapshot` | `pending` |
