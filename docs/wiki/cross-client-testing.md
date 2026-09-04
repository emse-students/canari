# Cross-client testing - the board

**STATE ONLY, AND IN AS FEW WORDS AS THE STATE ALLOWS.** A cell is a verdict, a count, and a time if
the time means anything. Everything else lives elsewhere and is never restated here:
[cross-client-campaign](cross-client-campaign.md) is the campaign's shape and what a run cost,
[testing-methodology](testing-methodology.md) is how a result earns belief and how a cell is written,
[`the README`](../../tools/cross-client-harness/README.md) is the instrument, `CHANGELOG.md` is every
defect, `CLAUDE.md` is what is open.

Two accounts, **owner** (W1, W3, A1) and **peer** (W2). **Target is the LOCAL estate.** **Run order
is the numbered ladder below, top to bottom - the only copy of that order.**

**THE BOARD WAS RESET TO ZERO ON 2026-09-03, AND EVERY CELL BELOW IS `pending` FOR THAT REASON AND
NOT BECAUSE NOBODY GOT TO IT.** Decision 12 of the
[workflow migration](workflow-migration.md#2-the-twelve-decisions---decided-not-to-be-relitigated).
The rig that produced the previous verdicts was collected without `-WithRig` when this machine was
reconstituted, so `results.ndjson`, both Chrome profiles and the phone baseline are gone - **the
ledger behind every cell is lost, and a verdict whose run cannot be read is a claim with nothing
behind it.** The old board is kept verbatim at
[cross-client-testing-archive](cross-client-testing-archive.md), which also records the two changes
that would have invalidated much of it anyway: the target moved from production to LOCAL, and the
accounts changed.

**Three things about this reset that a later session will otherwise get wrong.**

- **`skipped` was not carried over either.** Two of the deliberate skips were justified by facts
  that are gone - the 2FA a re-enrolment used to cost, and the production target - so each has to be
  re-decided on this rig rather than inherited.
- **A `pending` cell that carries a note after it keeps the note.** Those are EXPECTATIONS written
  with the row ("the AEAD tag must fail"), not verdicts, and they are what the row is for.
- **The archive is where to look FIRST when a re-run disagrees with itself**, and nowhere else. It
  says which mechanisms held once, on which build. It is worth exactly nothing as a gate.

## Standing

| Phase | Scripts | Last build | State |
| --- | --- | --- | --- |
| 0 SETUP | - | - | `pending` - the whole rig is new |
| 1 MSG | 12 | - | `pending` |
| 2 TYPE | 5 | - | `pending` |
| 3 READ | 10 | - | `pending` |
| 4 MUT | 21 | - | `pending` |
| 5 SEARCH | 6 | - | `pending` |
| 6 MENTION | 6 | - | `pending` |
| 7 FWD | 6 | - | `pending` |
| 8 GRP | 10 | - | `pending` |
| 9 COMM | 25 | - | `pending` |
| 10 DEL | 10 | - | `pending` |
| 11 TAB | 8 | - | `pending` |
| 12 MULTI | 10 | - | `pending` |
| 13 LIFE | 8 | - | `pending` |
| 14 NOTIF | 21 | - | `pending` |
| 15 CALL | 20 | - | `pending` - no runner exists, and `CALLS_ENABLED` is false |
| 16 HEAL | 33 | - | `pending` |
| 17 PIN | 10 | - | `pending` - no runner exists |
| 18 CORRUPT | 10 | - | `pending` - no runner exists |

| State | Meaning |
| --- | --- |
| `PASS` / `passed` | ran, assertions held, run was clean - and the row names the build |
| `PASS-DIRTY` | ran, assertions held, and a client logged something no rule classifies - `gate()` demotes it, and the row NAMES the line. Not a pass: the campaign ends green or it does not end |
| `VACUOUS` | ran and proved nothing - never armed, the target was redeployed under it (`deploy.mjs`), or a client was still executing a bundle the deployment had replaced (`bundle.mjs`). **On a LOCAL target the first arm of that is a `bun run dev` reload rather than a CD run**, which is more frequent and less visible, so `bundle.mjs` matters more here than it did against production, not less |
| `pending` | not run against the current build |
| `FAIL` | ran and did not hold - paired with a Work Package carrying the log, or with a fixed commit |
| `SKIPPED` | cannot be armed with two accounts, or needs `--destructive` |
| `BLOCKED` | cannot run until something outside the campaign happens |

## 0 - SETUP

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| SETUP-1 | Build the debug APK, plus the jniLibs `.so` rescue | `+A1` | `pending` |
| SETUP-2 | Clean uninstall + install (wipes `mls.bin`) - `install -r` keeps the store instead, and avoids re-paying SETUP-4's 2FA | `+A1` | `pending` |
| SETUP-3 | Start logcat | `+A1` | `pending` |
| SETUP-4 | W1: log in as owner, enrol the device, set the PIN | `+user` | `pending` |
| SETUP-5 | W2: log in as peer, set the PIN | `W1 W2` | `pending` |
| SETUP-6 | A1: log in as owner, decline biometrics | `+A1` `+user` | `pending` |
| SETUP-7 | Discovery pass over the real at-rest artefacts | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-8 | Baseline snapshot of intact Android app data | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-9 | The dedicated venue for channel traffic, recreated through the UI after the 2026-08-17 purge | `W1 W2` | BUILT 2026-09-04 19:30 on 0.16.3 by `bun venue.mjs`, through the product on W1 and W2 - community + public `general`, both accounts members AND both devices `active` on the community's distribution group (epoch 0 -> 1). Not a recorded verdict: `venue.mjs` is the fixture builder, and the row it answers is asserted from the tables on every run. The venue was RENAMED this day - the old name resolved to a real community on the prod-copy estate ([durable-rules](durable-rules.md)) |

## 1 - MSG - the plain path

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `W1 W2` | `PASS` 2026-09-04 19:41 on 0.16.3 - 252 ms against a 1 s budget, one copy each side, no disappearance over 16 samples. **The first run of this row was PASS-DIRTY on the WRONG CONVERSATION**: `openConversation` matched the peer's name in a group's message PREVIEW and broke the tie by shortest text, so the check sent into `Repro Gamma` and reported on a DM it never opened. Fixed at the instrument, then re-run |
| MSG-1-cold | Same, after a reload | `W1 W2` | `PASS` 2026-09-04 19:43 on 0.16.3 - 253 ms against the 3 s cold budget, one copy each side. The historical cold cost (2142 ms, prod 2026-08-13) does not reproduce on the local estate, so the two budgets are no longer telling the two modes apart here |
| MSG-1b | Delivery DURING a history load | `W1 W2` | `PASS` 2026-09-04 19:43 on 0.16.3 - 1 ms, one copy of the marker AND one of the primer on the receiver, so the message that landed mid-load was neither lost behind the history nor duplicated by it |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `+A1` | `pending` - BLOCKED on the precondition, not on the product: A1 is signed out on the local estate. It used to die inside `realClick` as `no stable element for selector: text=Discussions`, recording NO verdict; `ensureChat` now refuses first and names which of signed-out / PIN-locked it is, and the command that lifts it (2026-09-04) |
| MSG-3 | Reply renders with its quoted parent on both sides | `W1 W2` | `PASS` 2026-09-04 19:44 on 0.16.3 - 111 ms, parent and reply both rendered, the `Repondre` action addressed by its accessible name |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver decodes | `W1 W2` | `PASS` 2026-09-04 19:54 on 0.16.3 - image arrived in 470 ms and DECODED at 32x32 on the receiver (not merely a `blob:` src), PDF rendered by name, both clean. **The fixture it uploads did not exist**: `.gitignore`'s `*.png` had made `fixtures/msg4-image.png` uncommittable, and `./fixtures/` resolved against `archive/` after the runners moved - so CDP staged a file with no bytes and the check hung 30 s on `EN ATTENTE` with no verdict. Fixture committed, `fixtures.mjs` resolves from the harness root |
| MSG-5 | Channel message converges on all three; no `masterSecret` in any payload | `+A1` | `pending` |
| MSG-6 | Link preview served through the proxy, never a third-party `<img src>` | `W1 W2` | `PASS` 2026-09-04 19:54 on 0.16.3 - preview rendered in 24 ms, `foreign: []` so no image was fetched from a third party. A first run read PASS-DIRTY on `Erreur envoi media` - that was MSG-4's crashed run leaving a file staged in the composer, and it cleared once MSG-4 stopped dying mid-gesture |
| MSG-7 | 30 rapid sends: order preserved, no gap, no duplicate | `W1 W2` | `PASS` 2026-09-04 19:54 on 0.16.3 - 30 sent, 30 received, no gap, no duplicate, order settled, 1750 ms end to end. Repeated twice with the same result |
| MSG-8 | Send to a BACKGROUNDED tab | `W1 W2` `+A1` | `pending` |
| MSG-8b | Same, receiver on another page: badge and unread count | `W1 W2` `+A1` | `pending` |
| MSG-9 | **Receiver** offline at the GATEWAY, then restored: lands once on reconnect | `W1 W2` | `pending` |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `W1 W2` | `pending` |

## 2 - TYPE - typing indicators

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `W1 W2` | `pending` |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `W1 W2` | `pending` |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `W1 W2` | `pending` |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `W1 W2` | `pending` |
| TYPE-5 | Channel typing, a different transport entirely (REST, not WS) | `W1 W2` | `pending` |

## 3 - READ - receipts and unread counts

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the badge on W1 and marks it read for the sender | `W1 W2` | `pending` |
| READ-2 | The SAME user's other device also clears | `+A1` | `pending` |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible | `W1 W2` | `pending` |
| READ-4 | The 2 s debounce batches: twenty messages send ONE watermark | `W1 W2` | `pending` |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three - the watermark is per USER, so it needs FOUR readers where the estate has TWO accounts | `+user` | `pending` |
| READ-6 | Channels send no receipts at all; read state comes from the server tally | `W1 W2` | `pending` |
| READ-7 | Unread count after a reload, with the receipt still in flight | `W1 W2` | `pending` |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `W1 W2` | `pending` |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `+A1` | `pending` |
| READ-10 | Reading a conversation whose peer has deleted it | `+A1` | `pending` |

## 4 - MUT - editing, deleting, reacting, pinning

All four are MLS system events in a DM or group and REST calls in a channel, so **every row whose
cell says both runs twice**, once in the owner-peer DM and once in `Canari Test Venue`.

21 checks, four of which run in both venues, for 25 verdict rows.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MUT-1 | **DM.** Edit a text message: both sides show the new text and an edited marker | `W1 W2` | `pending` |
| MUT-2 | **DM.** Edit clears `readBy` - the receipt restarts | `W1 W2` | `pending` |
| MUT-3 | **DM.** Edit refused on a message with media, and on someone else's | `W1 W2` | `pending` |
| MUT-4 | **DM.** Edit a message the peer has NOT yet received | `W1 W2` | `pending` |
| MUT-5 | **Channel.** Edit is absent by design - assert the control is not offered | `W1 W2` | `pending` |
| MUT-6 | **DM.** Delete a message: both sides show the tombstone, not a gap | `W1 W2` | `pending` |
| MUT-7 | **DM.** The tombstone WINS over a body on merge | `W1 W2` | `pending` |
| MUT-8 | **Channel.** Delete is a HARD row delete, no tombstone | `W1 W2` | `pending` |
| MUT-9 | **Channel.** A moderator deletes another user's message | `W1 W2` | `pending` |
| MUT-10 | **DM.** The toolbar offers Delete to a moderator, where the handler refuses it | `W1 W2` | `pending` |
| MUT-11 | **Both.** React, un-react, re-react; two users; several emoji | `W1 W2` | `pending` |
| MUT-12 | **Both.** The 15-distinct-emoji cap, on both transports | `W1 W2` | `pending` |
| MUT-13 | **Both.** A reaction notifies the author only, never the reactor | `W1 W2` | `pending` |
| MUT-14 | **Both.** Pin and unpin, seen on the OTHER device | `+A1` | `pending` |
| MUT-15 | **DM.** A pin reaches a device that was OFFLINE when it was placed | `+A1` | `pending` |
| MUT-16 | **Channel.** A pin DOES survive, re-hydrated from the server | `+A1` | `pending` |
| MUT-17 | **DM.** Edit, then delete, then react to the deleted message | `W1 W2` | `pending` |
| MUT-18 | **DM.** Two devices of the SAME user edit the same message at once | `+A1` | `pending` |
| MUT-19 | **DM.** Delete a message still in the outbox: no peer sees it, and the sender keeps no row | `W1 W2` | `pending` |
| MUT-20 | **DM.** Mutate a message older than the 90-day retention window | `W1 W2` | `pending` |
| MUT-21 | **DM.** The hover action bar stays inside the pane and takes its own clicks | `W1 W2` | `pending` |

## 5 - SEARCH - finding a message

Client-side, in-conversation, substring-only: no server index, no global search.

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
| MENTION-2 | In a CHANNEL at level `mentions`, the mention REACHES the receiver's phone | `+A1` | `pending` |
| MENTION-3 | At level `none` it reaches nothing - carrying its own positive control | `+A1` | `pending` |
| MENTION-4 | In a DM or group a mention triggers NOTHING extra | `W1 W2` | `pending` |
| MENTION-5 | Mention a user who is not a member of the channel | `W1 W2` | `pending` |
| MENTION-6 | The channel path sends `mentionedUserIds` in CLEARTEXT - confirm the documented leak and nothing more | `W1 W2` | `pending` |

## 7 - FWD - forwarding

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| FWD-1 | Channel -> DM forward, the exact shape of the reported prod loss | `W1 W2` | `pending` |
| FWD-2 | The same, 25 times in a loop - any single miss is the bug | `W1 W2` | `pending` |
| FWD-3 | Forward while the sender goes offline mid-send | `W1 W2` | `pending` |
| FWD-4 | Forward from A1, backgrounded 200 ms later | `+A1` | `pending` |
| FWD-5 | Forward into a conversation not opened this session | `W1 W2` | `pending` |
| FWD-5-repeat | The same shape N rounds from a FRESH session each - the volume FWD-5 cannot carry alone | `W1 W2` | `pending` |

## 8 - GRP - group membership and invitations

The first rung that moves an MLS epoch, **and the rung that proved a third device changes what a
two-device check measures**: on the LITHIUM rig, GRP-4's evictions were committed by an undriven
fleet member rather than by either driven browser. That finding outlives its ledger - it is a
statement about the system, not a verdict - and it is why the fleet has to be enumerated before this
rung is believed.

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
| GRP-9 | A member row rendering a raw user id instead of a display name | `W1 W2` | `pending` |
| GRP-10 | The invitation link of one group must not appear in another group's panel | `W1 W2` | `pending` |

## 9 - COMM - communities, channels, roles

COMM-9 and COMM-10 share one verdict, `COMM-9/10`; COMM-23 and COMM-24 share `comm2324.mjs`. A
community is a `Workspace`, and **its membership is not MLS membership**. Every row is read against
MSG-5's standing assertion: no `masterSecret` in any payload, ever.

**Owed:** COMM-23's 403 to the OWNER of a group it had just minted, unexplained; and WP-REGRANT-2's
proof, COMM-8 passing with `seedAfterTheGrant: repaired`, not `true`. Run history, the amplifier fix
and COMM-18's four defects: [cross-client-campaign](cross-client-campaign.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `pending` |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `pending` |
| COMM-3 | An expired link, a `maxUses`-exhausted one, a REVOKED one and one to a deleted community all refused, and the rotation's new link accepted as the positive control | `W1 W2` | `pending` |
| COMM-4 | The `channel_invitation` card appears in the DM on both sides, deduped | `W1 W2` | `pending` |
| COMM-5 | Promote to moderator, then admin; the grid takes effect immediately | `W1 W2` | `pending` |
| COMM-6 | SIX enforced permissions and no seventh, the three default roles as documented, and a toggle reaching the column a decision reads | `W1` | `pending` |
| COMM-7 | `writePolicy` = admins only: refused server-side as well as in the UI | `W1 W2` | `pending` |
| COMM-8 | A private salon: a non-member cannot see it, cannot fetch it by id, and **is never sent its seed** | `W1 W2` | `pending` |
| COMM-9 | Removed from a salon: routing rows dropped (`evicted=true`), the next message sealed under a session they do not hold | `W1 W2` | `pending` |
| COMM-10 | Removed from a salon: what they ALREADY hold stays readable - Graine retains seeds on purpose | `W1 W2` | `pending` |
| COMM-11 | Kicked from the COMMUNITY: the workspace purged and every private salon group left | `W1 W2` | `pending` |
| COMM-12 | Re-invited after a removal: sessions minted from now on, and the past only as `history_visibility` allows | `W1 W2` | `pending` |
| COMM-13 | An admin JOINS a salon: 403 before and 200 after, the member list gains them, the transcript gains NOTHING | `W1 W2` | `pending` |
| COMM-14 | Channel notification levels enforced server-side | `+push` | `pending` |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `pending` |
| COMM-16 | Delete a channel, then a community by typing its name: the rows really gone, the slug free again | `W1 W2` | `pending` |
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `pending` |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `pending` |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `pending` |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `pending` |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `pending` |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `pending` |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `pending` |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `pending` |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 A1` | `pending` |

## 10 - DEL - deleting a conversation, crossed

Deletion removes state while OTHER state keeps pointing at it, so each row pairs it with something
mid-flight. All ten have a runner - `del1.mjs` for DEL-1, `del.mjs --only N` for the rest, the phase
order and the phone row justified in `checks.mjs`. The three harness faults DEL-7 and DEL-9 cost are
on [testing-methodology](testing-methodology.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `pending` |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `pending` |
| DEL-3 | Both peers delete the same conversation within a second | `W1 W2` | `pending` |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `pending` |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `pending` |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `pending` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `pending` |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `pending` |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | `pending` |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | `pending` |

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
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `+A1` | `pending` |
| MULTI-2 | Read on A1: read state reflected on W1 | `+A1` | `pending` |
| MULTI-3 | A1 enrolled AFTER W1 has history | `+A1` | `pending` |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= device check L) | `+A1` | `pending` |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `+A1` | `pending` |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `+A1` | `pending` |
| MULTI-7 | Every device of both users reaches `active` in `dm_device_group_memberships`, and **no row names a placeholder identity** | `W1 W2` | `pending` |
| MULTI-8 | A second device enrolled while the peer is OFFLINE reaches `active` within the budget, **without a reinstall** | `W1 W2` `+W3` | `pending` |
| MULTI-9 | With one device `pending`, the peer's messages are **still delivered once it activates** - and the sender is not told they were | `W1 W2` `+W3` | `pending` |
| MULTI-10 | **Whole-population invariant**: no membership `pending` past the budget and none under a placeholder identity, ACROSS THE DATABASE | none | `pending` |

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
| NOTIF-4 | Read on W1 while A1 is killed, W1 arriving at the salon AFTERWARDS: notification dismissed on A1 | `+push` | `pending` |
| NOTIF-4b | The same, W1 holding the salon ALREADY OPEN when the message lands - the case an unread counter cannot see | `+push` | `pending` |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `+push` | `pending` |
| NOTIF-6 | Quick reply from the shade, app **KILLED** (= device check K) | `+push` | `pending` - MEASURED by hand on 0.14.12, works; not a campaign verdict (no gate, no ledger row). See [check K](device-verification.md) |
| NOTIF-6c | Quick reply from the shade, app **BACKGROUNDED** - the branch that does NOT restart the process | `+push` | `pending` - **FAILED `HTTP 403` on 0.14.12, P1 found and fixed 2026-08-30; the fix is installed on A1 and NOT yet re-measured** |
| NOTIF-6d | A quick reply that FAILS to send: the shade's spinner must end, both actions must come back, and a retry must be scheduled | `+push` | `pending` - no runner; the defect it names is fixed and unproven |
| NOTIF-6b | "Marquer comme lu" from the shade: the banner goes, the conversation is read on the OTHER devices, and it is still read when THIS app is opened. Then the same from a quick REPLY, which since 2026-08-31 means the same thing | `+push` | `pending` - the 2026-08-30 hand measurement is VOID: it ran the id-based `read_receipt`, which is deleted. What it found is fixed (2026-08-31) and unproven - the cache lookup is gone, the instant rides the action intent, and `read_watermarks.ndjson` closes the acting device's own badge. Expect `sendReadWatermark: queued+drained at=<ms>` carrying the SENDER's instant, never one near `now` |
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

> **EVERY ROW BELOW NEEDS `CALLS_ENABLED = true` BEFORE IT CAN RUN** (held off since 0.14.15 -
> [calls](frontend/modules/calls.md)). This is not a change of state: all of them were already
> `pending` and none had ever been executed. It is a change of PRECONDITION - a run against a
> shipped build now measures the hold, not the feature, and would read as a false `FAIL`. The order
> is: flip the switch on a build, run these rows plus CALL-13, then ship the flip.

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
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch - `TooDistantInTheFuture` must beat `GAP_QUEUED` | `+snapshot` | `pending` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role - no prior art on either client | `+snapshot` | `pending` |
| HEAL-repair | Does the history diff repair a rewound sender end to end? Quantitative | `+snapshot` | `pending` |
| HEAL-A1 | HEAL-repair mirrored onto the phone: **W2** is rewound and **A1** must detect and repair, W1 parked so W2 is the only possible responder | `+A1` `+snapshot` | `pending` |
| HEAL-NEXT | After an escalation has ALREADY happened, does the next message arrive? The escalating frame is unrecoverable by construction | `+A1` `+snapshot` | `pending` |
| HEAL-REVOKE-1 | A device revoked through the connected-devices UI: is its local store actually gone? The user found one that kept everything, P1 in [backlog](backlog.md) | `W1 W2` | `pending` |
| HEAL-REVOKE-2 | The revoked device reconnects: is it like-new, holding nothing from before? The blacklist can make this row pass while HEAL-REVOKE-1 fails | `W1 W2` | `pending` |
| HEAL-REVOKE-3 | First reconnection after revocation resynchronises as a NEW device would, history included - a shortfall must be REPORTED, not silently partial | `W1 W2` | `pending` |
| HEAL-REVOKE-4 | The heal-on-diff mechanism catches up what the first reconnection missed, and the TRIGGER CONDITIONS are part of the assertion | `W1 W2` | `pending` |
| HEAL-REVOKE-5 | Revoked, then the account CHANGES a lot while it is away, then it returns | `W1 W2` `+user` | `pending` |
| HEAL-REVOKE-6 | The same, where the revoked device is **the phone** - A1's store is SQLite behind the native layer, not the WebView IndexedDB the web wipe clears, so "the wipe ran" is a different claim and must be read from the native store | `+A1` `+user` | `pending` - the instrument is in, the victim must be A1 |
| HEAL-REVOKE-7 | The **ORDER** of the return: back BEFORE the other devices are online, and back AFTER | `W1 W2` `+user` | `pending` |
| HEAL-REVOKE-8 | A group **DELETED while the device was revoked** must not return as a Sync row | `W1 W2` `+user` | `pending` |
| HEAL-REVOKE-9 | Revoked while **OFFLINE**: the wipe is DEFERRED, not lost, and must not fire while the server is unreachable | `W1 W2` | `pending` |
| HEAL-NEW-0 | The rig can mint a device the server has never seen, repeatably, on ONE 2FA | `+user` | `PASS-DIRTY` 2026-09-04 19:12 on 0.16.3 - every assertion held (wipe, loggedOut, noHumanStep, freshId, neverSeen, sameAccount, registered, addressable) and the re-minted device rejoined FOUR groups by external commit inside one second. **The dirt is 100% the ESTATE**: 20 media 404s from a database copied without its object store, [backlog](backlog.md). Not PASS until that is fixed - it is not this row's to disposition. |
| HEAL-NEW-1 | Fresh device, **nothing else online** - external join is the only path there is | `+user` | `pending` |
| HEAL-NEW-2 | Fresh device, **the PEER online** - a responder that is not us | `+user` | `pending` |
| HEAL-NEW-3 | Fresh device, **another device of the SAME user online** (W1) | `+user` | `pending` |
| HEAL-NEW-4 | Fresh device, the only possible responder is **the phone, foreground** | `+A1` `+user` | `pending` |
| HEAL-NEW-5 | The same, **phone BACKGROUNDED** - a responder that cannot answer must not leave a group on Sync with nothing owed, which is what says whether the ladder terminates on a PROOF or on a clock | `+A1` `+user` | `pending` |
| HEAL-NEW-5b | The same with the phone **KILLED**, not backgrounded - the case a user actually creates, and the one no row asked about before 2026-08-30. A responder that is not merely slow but ABSENT must still leave every group either served or explicitly owed, never amber for ever | `+A1` `+user` | `pending` - written 2026-08-30 |
| HEAL-NEW-6 | **The new device IS the phone**, enrolled after the account has history - this is MULTI-3, and it stops being `SKIPPED` the moment a 2FA is being paid anyway | `+A1` `+user` | `pending` |
| HEAL-NEW-7 | **A DELETED conversation must not come back as a Sync row** - three causes to tell apart, and only two are visible to a new device | `+user` | `pending` |
| HEAL-NEW-8 | **N conversations at once: do they ALL repair?** The assertion is a COUNT plus the identity of every laggard, never a sample | `+user` | `pending` |
| HEAL-NEW-9 | After repair, does the new device get the HISTORY? Separates "no history" from "no history YET" | `+user` | `pending` |
| HEAL-NEW-10 | Two fresh devices enrolling **at the same time** - the add-lock under two concurrent enumerations. Costs a second 2FA | `+user` | `pending` |
| HEAL-NEW-11 | The responder is our own **W1, arriving LATE** | `+user` | `pending` |
| HEAL-NEW-12 | The responder is the **PEER W2, arriving LATE** | `+user` | `pending` |
| HEAL-NEW-13 | The responder is **the phone, arriving LATE** - says whether the retry is driven by OUR reconnect or the RESPONDER's. Read with HEAL-NEW-5, whose responder can never answer | `+A1` `+user` | `pending` |
| HEAL-NEW-14 | **The heal is INTERRUPTED** - a reload, then a link cut and restored, while rows are still amber. A reload must not restart the ladder from zero, and a cut must not leave a row amber with nothing owed | `+user` | `pending` |
| HEAL-NEW-15 | **Is the app usable while it heals?** N rows amber, and the user navigates and sends | `+user` | `pending` |

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
