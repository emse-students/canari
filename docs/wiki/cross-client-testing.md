# Cross-client testing - the board

**State only.** Each check, what it asks, what it needs, and the verdict with the commit it ran on.
No commentary: the campaign's shape is [cross-client-campaign](cross-client-campaign.md), how a result
earns belief is [testing-methodology](testing-methodology.md), the instrument is
[`tools/cross-client-harness/README.md`](../../tools/cross-client-harness/README.md), the story of
every defect is `CHANGELOG.md`, and what is still open is `CLAUDE.md`.

Two accounts, anonymised everywhere as **owner** (W1, A1) and **peer** (W2). Target is PRODUCTION.

## Standing

Updated after every run.

| Phase | Scripts | Last build | State |
| --- | --- | --- | --- |
| 0 SETUP | - | - | 5/9 `passed`; SETUP-2 skipped by decision, SETUP-7/8 owed before CORRUPT and PIN |
| 1 MSG | 12 | `226fe755` | **12/12 `PASS`, all clients clean, server clean** (2026-08-16) |
| 2 TYPE | 5 | `25376b86` | 5/5 `passed` x5 - 25 verdicts, 25 `PASS`; re-run owed on the current build |
| 3 READ | 10 | `25376b86` | 8/8 runnable `passed` x5 - 40 verdicts, 40 `PASS`; READ-5 and READ-10 `skipped` |
| 4 MUT | 21 | `25376b86` | 19/21 `PASS` x5; MUT-15 and MUT-19 fixed and rewritten - **re-run owed** |
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

**What the ladder actually costs, read off the table above:** MSG is the ONLY phase standing on a
current build; TYPE, READ, MUT and FWD all owe re-runs on an older one; and **twelve of the eighteen
have never run at all**. CALL is 20 checks with **zero scripts written**. Its
prerequisite is **IN as of 2026-08-19**: `call-service` writes one `[call] session end` line per
socket carrying the disposition, the duration, whether media ever flowed, and the per-direction
frame counts, and `chat-delivery-service` names the invite and the join token on the same room id
- the record and how to read it are on
[`call-service`](services/call-service.md#the-call-record), which is the only copy. **Every CALL row
must quote that line**: a call failure two clients each see half of is attributed from it or not at
all, which is exactly what caught the silent channel-push 404s.

**The whole community rework is verified by COMPILING and by unit tests only.** Nothing has run
against prod: no client has joined a distribution group on a real deploy, and no notification has
been decrypted from a Graine seed on hardware. Those are WP-62's rows and they run here.

| State | Meaning |
| --- | --- |
| `PASS` / `passed` | ran, assertions held, run was clean - and the row names the build |
| `pending` | not run against the current build |
| `FAIL` | ran and did not hold - paired with a Work Package carrying the log, or with a fixed commit |
| `SKIPPED` | cannot be armed with two accounts, or needs `--destructive` |
| `BLOCKED` | cannot run until something outside the campaign happens |

## The reconciled fleet this campaign starts from - established 2026-08-19

`recon.mjs` answers `LOSS` on the W1/W2 pair and **that verdict is expected until the number
changes**. Five message ids exist on W1 and on neither W2 nor A1, all created 2026-08-16 between
09:45 and 16:27 UTC.

They were never received by anyone because **they never left the sender**, which two independent
witnesses settle: W1 holds 6272 in the shared conversation, W2 holds 6267, A1 holds 6267 - the two
receivers agree at the message id, so nothing was dropped in reception. The server holds nothing for
them either (zero `queued_message` rows created that day) and W2's device has not been rotated since
2026-08-06, so this is not a fresh device without history. W1's `outbox` is EMPTY, so no retry will
ever be attempted: the optimistic row is the only trace, which is WP-ECHO-1's shape - the sender's
own render is its own message's only writer, since the fanout excludes the sender's devices and
OpenMLS refuses to decrypt its own frame.

**A failed send is also invisible after the fact**, and that is a live property of the current
build: the status indicator renders only for `isLastOwn` (`MessageMetadata.svelte`), so any message
sent after a failed one hides it for good.

**The send path itself is healthy on the current build** - MSG-10 exercised exactly this: queued
while offline, `Flush skipped - offline`, then `Flushing 2 queued entries` and both sent on
reconnect.

So the baseline is: **five, and only five.** A run whose recon reports a sixth has found something
new; a run reporting five has found nothing. Do not clear them - the divergence is the evidence.

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
| SETUP-9 | The dedicated venue for channel traffic | `W1 W2` | `passed` 2026-08-19 - **recreated**: `channel_workspaces` was EMPTY on prod, the venue included, after the delete-community rework and the 2026-08-17 purge. Creating it is the first exercise of that path against a real deploy: create -> distribution group row -> invite link -> join all worked through the UI |

## 1 - MSG - the plain path

`226fe755`, 2026-08-16: 12 verdicts, 12 `PASS`, every client clean, server clean over the run's own
window. Earlier x5 series on `8a3edbdd`, `e62c21f1` and `25376b86` all read 13/13.

**COMM-2 and COMM-16 have run on prod (2026-08-20, `bf2815c2`), both PASS and both clean.** COMM-2
proves the whole invite path end to end: one live link, stable across two reads, previewing the
community by name before joining, and a peer who becomes a member with the `member` role and no
other row. COMM-16 proves a salon and a community are really deleted, with no orphan in any table
and the slug free enough to be taken again by a second community.

**One observation from COMM-2 that is NOT a defect, recorded so it is not re-investigated.** Its
first clean run carried two 404s on W2 - `GET /api/channels/<id>/members` and `/pins` - for a channel
belonging to the PREVIOUS run's community, which the check itself had deleted while W2 was inside it.
Nothing was persisted (localStorage and every IndexedDB store were read: no row named it), the
landing's own abandon path exists, and a re-run came back clean on both clients. It is a live page
briefly outliving a community deleted underneath it, not a leak.

**COMM-3 added a fourth case the row did not name, and a positive control.** Revocation is not in
the row because there is no revoke control to name: regenerating IS the revocation, one live link at
a time being what makes a link enumerable. And every other case is a REFUSAL - a check made only of
refusals passes perfectly against a preview that is simply broken - so the rotated case previews both
tokens on the same client in the same run: the old one refused, the new one accepted.

**It also found a hole in the classifier, which is the second one this phase has produced.** The
`BENIGN` entry forgiving Graine's quiet reconciliation line stated that its loud sibling - a
departure being ENFORCED, leaves committed out of the tree - was "caught by the `re-?add|epoch` rule
in NOTABLE". It was not: the line reads *"N member(s) left but still hold a leaf - removing"*, which
contains none of those words, so the single loudest signal Graine emits went to `unexplained` and
nowhere else. It has its own NOTABLE entry now. **A rule that claims another rule covers something
must be checked against the TEXT, not against the intent.**

**COMM-19 asserts the refusal on the TABLE and on the SCREEN, and needed both.** A membership row
that survived proves the server refused; it says nothing about whether the person was told, and a
refusal nobody explains is a button that does nothing. Its first run recorded exactly that failure
about a working client - it read the console the instant the click returned, and the sentence lands
after the round trip that produces it. `awaitLine` now bounds the wait, on the campaign's own rule
that an absence is only a finding against a window a reader can argue with.

**COMM-11 confirms on prod that a community-level removal reaches a private salon's OWN group** -
membership row, routing rows on both groups, and `allowedUsers`, which is the one that matters most:
the roster reconciliation diffs the MLS tree against exactly that list, so a surviving name is a leaf
re-authorised at every pass, and the removal would be undone by its own enforcement.

**And it caught the classifier rule added one commit earlier being wrong in the same way.** That rule
was written `\S+ [0-9a-f]+:`, which matches `community <id>:` and NOT `salon <id> of <id>:` - the two
forms `scopeLabel` produces. A real member losing a real salon put the line straight back in
`unexplained`. The rule is now written against the FUNCTION, not against the sighting that prompted
it; its quiet sibling in BENIGN had used `.+` all along.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `W1 W2` | `PASS` - 261 ms |
| MSG-1-cold | Same, after a reload | `W1 W2` | `PASS` - 265 ms |
| MSG-1b | Delivery DURING a history load | `W1 W2` | `PASS` - 3 ms |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `+A1` | `PASS` - 274 ms |
| MSG-3 | Reply renders with its quoted parent on both sides | `W1 W2` | `PASS` - 196 ms |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver decodes | `W1 W2` | `PASS` |
| MSG-5 | Channel message converges on all three; no `masterSecret` in any payload | `+A1` | **`PASS-DIRTY` 2026-08-19 on `a232c070`** - 1 copy on each of W1/W2/A1, no `masterSecret`. Was `FAIL` on `231cee62`: nobody could send in a community at all, WP-GRAINE-1 - the sweep deleted the distribution group two seconds after the join, on every connection ([graine](../wiki/protocols/channel-encryption.md#the-distribution-group-is-not-a-conversation-and-two-sweeps-assumed-it-was)). The dirt is A1 rendering at 5 989 ms behind an ERROR line - its seed had not landed and the live route asked nobody, fixed in `89368eb0`. Re-run owed on that build |
| MSG-6 | Link preview served through the proxy, never a third-party `<img src>` | `W1 W2` | `PASS` |
| MSG-7 | 30 rapid sends: order preserved, no gap, no duplicate | `W1 W2` | `PASS` - 1 944 ms |
| MSG-8 | Send to a BACKGROUNDED tab | `W1 W2` `+A1` | `PASS` |
| MSG-8b | Same, receiver on another page: badge and unread count | `W1 W2` `+A1` | `PASS` |
| MSG-9 | **Receiver** offline at the GATEWAY, then restored: lands once on reconnect | `W1 W2` | `PASS` - 15.7 s, nearly all the deliberate outage |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `W1 W2` | `PASS` |

## 2 - TYPE - typing indicators

`25376b86` x5: 25 verdicts, 25 `PASS`, every server window clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `W1 W2` | `PASS` 5/5 - shown 70-90 ms, cleared 245-272 ms |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `W1 W2` | `PASS` 5/5 - expired 4 138-4 221 ms |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `W1 W2` | `PASS` 5/5 - cleared 6 138-6 181 ms |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `W1 W2` | `PASS` 5/5 - cut acted in 874-995 ms, back in 797-1 173 ms |
| TYPE-5 | Channel typing, a different transport entirely (REST, not WS) | `W1 W2` | `PASS` 5/5 - shown 53-72 ms, cleared 232-331 ms |

## 3 - READ - receipts and unread counts

`25376b86` x5: 8 of 8 runnable `PASS` on every pass, 40 of 40 clean.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the badge on W1 and marks it read for the sender | `W1 W2` | `PASS` 5/5 - clears 3-11 ms, read 1-4 ms |
| READ-2 | The SAME user's other device also clears | `+A1` | `PASS` 5/5 - A1 clears in ~2.2 s |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible | `W1 W2` | `PASS` 5/5 - silent 6 s hidden, ~2.1 s once restored |
| READ-4 | The 2 s debounce batches: twenty messages send ONE watermark | `W1 W2` | `PASS` 5/5 - 20 markers, one flip in 2-8 ms |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three | `W1 W2` | `SKIPPED` - needs a 4th reader |
| READ-6 | Channels send no receipts at all; read state comes from the server tally | `W1 W2` | `PASS` 5/5 - no receipt in a 4 s window |
| READ-7 | Unread count after a reload, with the receipt still in flight | `W1 W2` | `PASS` 5/5 |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `W1 W2` | `PASS` 5/5 - 3 of 3, ~215 ms after reconnect |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `+A1` | `PASS` 5/5 - clears live in ~2.1 s |
| READ-10 | Reading a conversation whose peer has deleted it | `W1 W2` | `SKIPPED` - `--destructive` only |

## 4 - MUT - editing, deleting, reacting, pinning

All four are MLS system events in a DM or group and REST calls in a channel, so **every row whose
cell says both runs twice**, once in the owner-peer DM and once in `Campagne de test`.

`25376b86` x5: 19 of 21 `PASS` on every pass. **Re-run owed**: MUT-15 and MUT-19 fixed and both
checks rewritten, and the mailbox-barrier fix touches the pipeline every row here measures.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MUT-1 | **DM.** Edit a text message: both sides show the new text and an edited marker | `W1 W2` | `PASS` 5/5 - 288-935 ms |
| MUT-2 | **DM.** Edit clears `readBy` - the receipt restarts | `W1 W2` | `PASS` 5/5 |
| MUT-3 | **DM.** Edit refused on a message with media, and on someone else's | `W1 W2` | `PASS` 5/5 |
| MUT-4 | **DM.** Edit a message the peer has NOT yet received | `W1 W2` | `PASS` 5/5 - 0 sightings of the original, 1 copy of the edit |
| MUT-5 | **Channel.** Edit is absent by design - assert the control is not offered | `W1 W2` | `PASS` 5/5 |
| MUT-6 | **DM.** Delete a message: both sides show the tombstone, not a gap | `W1 W2` | `PASS` 5/5 - converges in 2 ms |
| MUT-7 | **DM.** The tombstone WINS over a body on merge | `W1 W2` | `PASS` 5/5 - converged 308-318 ms, no resurrection |
| MUT-8 | **Channel.** Delete is a HARD row delete, no tombstone | `W1 W2` | `PASS` 5/5 |
| MUT-9 | **Channel.** A moderator deletes another user's message | `W1 W2` | `PASS` 4/5 - pass 3 could not see its own marker |
| MUT-10 | **DM.** The toolbar offers Delete to a moderator, where the handler refuses it | `W1 W2` | `PASS` 5/5 - does NOT reproduce as written |
| MUT-11 | **Both.** React, un-react, re-react; two users; several emoji | `W1 W2` | `PASS` 5/5 both venues - 152-171 ms |
| MUT-12 | **Both.** The 15-distinct-emoji cap, on both transports | `W1 W2` | `PASS` 5/5 DM, 4/5 channel |
| MUT-13 | **Both.** A reaction notifies the author only, never the reactor | `W1 W2` | `PASS` 5/5 both venues - author in ~157 ms |
| MUT-14 | **Both.** Pin and unpin, seen on the OTHER device | `+A1` | `PASS` 5/5 both venues - 313-329 ms |
| MUT-15 | **DM.** A pin reaches a device that was OFFLINE when it was placed | `+A1` | `FAIL` 5/5 on `25376b86`; fixed 2026-08-16, check re-architected - **re-run owed** |
| MUT-16 | **Channel.** A pin DOES survive, re-hydrated from the server | `+A1` | `PASS` 5/5 |
| MUT-17 | **DM.** Edit, then delete, then react to the deleted message | `W1 W2` | `PASS` 5/5 |
| MUT-18 | **DM.** Two devices of the SAME user edit the same message at once | `+A1` | `PASS` 5/5 on `25376b86`, `PASS` 1/1 on `e1d47951` with A1 on its APK bundle - converges in 12-44 ms, window clean on all three |
| MUT-19 | **DM.** Delete a message still in the outbox: no peer sees it, and the sender keeps no row | `W1 W2` | `PASS` 5/5 on the peer half; sender half added 2026-08-16 with its fix - **re-run owed** |
| MUT-20 | **DM.** Mutate a message older than the 90-day retention window | `W1 W2` | `SKIPPED` - unarmable until 2026-11-09 |
| MUT-21 | **DM.** The hover action bar stays inside the pane and takes its own clicks | `W1 W2` | `PASS` 5/5 |

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

**WP-GRAINE-2: CLOSED - both halves proven on production 2026-08-19.** Distribution group
`d70e8952-bc23-4ee8-bf63-fb829e278273`, community `b9d52032`. Mechanism and reasoning:
[graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19).

| Client half | Before | After |
| --- | --- | --- |
| `mls_group_info.baseEpoch` | **25**, `14:00:02.53775`, written by W1's **tauri** | **26**, `15:54:08.520527` |
| the tree | 3 leaves - `b78568a3` had left before the fix | **2 leaves**, both `d82cd226` |
| who committed it | - | W1's **web** device, `isCommit=true group=d70e8952` at `15:54:08` |
| a second pass | - | `distribution group agrees with its roster - 2 leaf/leaves`, `baseEpoch` still **26** |
| `dm_device_group_memberships` | 3 rows | **still 3** - the server half is below |

| Server half | What was read | Value |
| --- | --- | --- |
| W2 rejoins | roster / `mls_group_info.baseEpoch` | 1 -> **2** members, epoch 27 at `19:30:48` |
| the tree agrees again | W1's reconciliation | `agrees with its roster - 3 leaf/leaves` |
| W2 leaves | social-service | `[WORKSPACE] key distribution cut workspace=b9d52032 user=b78568a3 reason=left` |
| the server cut it | chat-delivery | `[DISTRIBUTION_GROUP] evict ... memberships=1 queued=0 routes=1` at `19:34:30` |
| `dm_device_group_memberships` | rows on the group | 3 -> **2**, both `d82cd226` |
| the client followed | W1's reconciliation | `1 member(s) left but still hold a leaf - removing (2 leaves stay)` |
| `mls_group_info.baseEpoch` | the server | 27 -> **28** at `19:35:26` |

**Twenty-five rows, nineteen runners** (`comm1` `comm2` `comm3` `comm4` `comm5` `comm6` `comm7`
`comm8` `comm910` `comm11` `comm12` `comm13` `comm15` `comm16` `comm19` `comm20` `comm21`
`comm2324`), sharing `comm.mjs`. Why the rows were rewritten on 2026-08-20 is in
[cross-client-campaign](cross-client-campaign.md#rows-that-named-a-mechanism-the-product-does-not-have).

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
| COMM-17 | Reorder communities by drag and drop; survives a reload, reaches the other device | `+A1` | `pending` |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `pending` |
| COMM-19 | The last admin tries to leave: refused, unless they are the last MEMBER, which deletes the community | `W1 W2` | `pending` |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `pending` |
| COMM-21 | A member is removed while composing a message in that salon | `W1 W2` | `pending` |
| COMM-22 | A salon carrying many Graine sessions: time the first render, and the repair when one seed is missing | `W1 W2` | `pending` |
| COMM-23 | Public -> private: a group is minted, and a reader outside `allowedUsers` stops being routed | `W1 W2` | `pending` |
| COMM-24 | Private -> public: the salon's group is tombstoned and the community's carries it again | `W1 W2` | `pending` |
| COMM-25 | An admin's SECOND device receives the salon's seeds after the join, without a second join | `W1 W2` | `pending` |

**Every row above is `pending` on purpose.** The campaign is paused until the last work package lands,
and a runner that PASSes while it is still proving itself is not a campaign verdict. What the
instrument has produced so far - latest verdict per check, all against production:

| Check | Date | Verdict | What it left |
| --- | --- | --- | --- |
| COMM-1 | - | no row recorded | the runner exists and has never completed a run |
| COMM-2 | 2026-08-20 | `PASS` clean | - |
| COMM-3 | 2026-08-20 | `PASS` clean | - |
| COMM-4 | 2026-08-20 | `FAIL` clean | the invitee is shown no card - OPEN, in `CLAUDE.md` |
| COMM-5 | 2026-08-20 | `PASS` clean `ce6ef963` | re-run under the tightened expectations: `liveWithoutReload` and `capabilityIsLive` are both true for the first time, so a role change now reaches an open client without a reload |
| COMM-6 | 2026-08-20 | `PASS` clean `ce6ef963` | re-run once the grid was derived from the announcement alone; the six offered are the six enforced, the administrator column is locked, a toggle reaches the column and comes back |
| COMM-7 | 2026-08-20 | `PASS-DIRTY` `ce6ef963` | two defects, both fixed, and all five assertions now hold. The dirt is one line: `Log.d` takes a TAG and a payload, and the read receipt passed its whole message as the tag, so it rendered `[[CHANNEL_READ] ...]` and matched no rule. Re-run owed on the deployed shape |
| COMM-8 | 2026-08-20 | `PASS` clean | - |
| COMM-9/10 | 2026-08-20 | `VACUOUS` | never re-run since the per-salon groups landed |
| COMM-11 | 2026-08-20 | `PASS` clean | - |
| COMM-12 | 2026-08-20 | `PASS-DIRTY` | re-run owed on a build where the watcher classifies its lines |
| COMM-13 | 2026-08-20 | `PASS` clean | - |
| COMM-15 | 2026-08-20 | `PASS` clean `939078aa` | first run; needed the native-dialog capability |
| COMM-16 | 2026-08-20 | `PASS` clean | - |
| COMM-19 | 2026-08-20 | `PASS` clean | - |
| COMM-20 | 2026-08-20 | `PASS` clean `ce6ef963` | five runs, four defects, each only visible once the one before it was fixed: the wire sent the whole list, the server read-modify-wrote the row, the announcement that would have corrected the loser was dropped, and the click applied its own answer. `outcome: "both edits applied"` and both grids agree with the column |
| COMM-21 | 2026-08-20 | `PASS` clean `939078aa` | first run; the draft is lost, recorded and not asserted |
| COMM-23/24 | 2026-08-20 | `PASS` clean | - |

**The build a verdict ran on is recorded from `60c33b92` onward and not before.** Nothing the web
client prints names its build, so `results.mjs` reads `/_app/version.json` from the deployment and
resolves it to the newest commit on `origin/main` at or before that stamp; every row now carries
`build` and `builtAt`. The two verdicts above that name a commit were dated by hand from the same
stamp.

## 10 - DEL - deleting a conversation, crossed

Deletion removes state while OTHER state keeps pointing at it, so each row pairs it with something
mid-flight.

| Id | The crossing | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `pending` - no banner, marker or retried solicitation may survive |
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

**NOTIF-12 records rather than asserts, because the product has not decided.** A salon's stacked
lines are attributed to the salon, not to whoever wrote each one: `handleChannelMessage` passes the
salon title as the `Person`, and the server sends only `senderId` - enough for the avatar, not for a
name. Naming the author would need either the name on the wire, which puts it through FCM and APNs,
or a `push/display-name/:userId` lookup beside the avatar one, which puts nothing new through
anybody. The second is the shape the avatar already proved; the choice is the user's and is in
[backlog](backlog.md).

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

| Id | How the group is broken | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `+snapshot` | `pending` - a `healed` verdict after applying ZERO commits is a regression |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` |
| HEAL-W3 | Freeze one client while the peer advances past 2 000 frames in one epoch | `+snapshot` | `pending` - `TooDistantInTheFuture` must beat `GAP_QUEUED` |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `+snapshot` | `pending` - no prior art on either client |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `+snapshot` | `pending` - quantitative: a run whose frame rate does not fall back to the ordinary send rate has found something |

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
