## P2 - the slow-link chantier: no screen waits for the network to draw (owner, 2026-11-10; starts right after 1.6.10)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._
_The same day the owner moved the community-open **200 ms budget** here: the community entry
(F1-F7 built, deleted 2026-11-20 once its list was moved below) closed for `1.7.0` on #3769's reading
([community-open-budget](../frontend/community-open-budget.md))._

**Decision.** The owner, 2026-11-10: *"a slow connection is common and a real plague"*. The chantier
starts right after `1.6.10` and is carried to the end, not abandoned at the first improvement.

**Goal.** On a slow link no screen waits for the network to draw. Every screen renders from local
state first, then revalidates ([local-first-ui](../frontend/local-first-ui.md)).

**Known gaps**, from the owner's logs `canari-log-1.6.9-20261110-2059.txt` and
`canari-log-1.6.9-20261110-1810.txt`:

1. The session refresh (4 s at the 20:58 boot, server 17 ms) gates the first reads: the feed,
   the announcement, help-seen and the birthday. **Built 2026-11-11**: the reads still queue behind
   the token (they must), the screens no longer do - first paint with the network answering nothing
   went from never to 0 RTT for the feed on a hardware-held phone, the announcement, the help-seen
   set and the "birthday entered" fact; the feed on a vault/web unlock was already 0 RTT
   ([local-first-ui](../frontend/local-first-ui.md#4bis-the-session-refresh-no-longer-gates-the-boot-paths-first-paint-2026-11-11)).
   Left: today's celebrants stay network-only (memory-only by the birthdays decision); the dev cold
   boot re-read under DevTools throttling and the Mi 9T first-paint reading are owed.
2. Some screens have no local copy: Pour toi, the bell, profiles already seen. **Built 2026-11-11
   (draft PR)**: Pour toi already had its stored first page (`feed:foryou`, the same store as the
   other tabs; one more first-paint test pins it). The bell (newest 50) and the profiles opened (last
   12, LRU) now each keep a sealed slot in the account's `feed_pages` store, on the peer-name
   directory's epoch (ended at a sign-out or an account change), and paint at once then revalidate;
   a failed revalidation keeps the copy; a profile drawn from the copy disables follow and block
   until the answer. First paint with the network answering nothing: 0 requests on both, before
   never (vitest model, not a clock)
   ([local-first-ui](../frontend/local-first-ui.md#4ter-the-bell-and-profiles-already-opened-have-a-local-copy-2026-11-11)).
   Owed: a DevTools-throttled dev read and the Mi 9T / iPhone cold-start readings on a shaped link;
   nothing else (the typed extras and the feed-only delete scope landed with the review).
3. Media seen once is not kept, within a size budget. (The CanaReels look-ahead of 2026-11-11 does
   not build this store: its heads live only while held, its pictures in the existing pool -
   [reels](../frontend/modules/reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31).)
4. Per-community triplet reads: 27 calls for 9 communities.
5. Duplicate `users/batch`, follow-statuses x8 and `devices/self` x3
   ([audit](../frontend/weak-network-audit-2026-11-10.md), section 4).

6. **Video on a link slower than the media.** On the owner's link (about 262 KB/s) a reel plays at
   about 318 KB/s: the buffer never grows past the 2-segment head, the old 10 s lookahead rule never
   held on that reel, and the stalls total about size/link minus duration whatever the lookahead.
   Draft [#3322](https://github.com/emse-students/canari/pull/3322) (adaptive lookahead) does NOT fix
   it and is not a fix; it is only a starting point (its rate measurement and its fake-fetch tests).
   The real fix:
   - when link < media, do not start, and after a `waiting` do not resume, until buffered-ahead >=
     remaining x (1 - link/media), capped: one honest load instead of 29 micro-stalls. The other
     route is a lower-bitrate rendition;
   - measure the rate inside `httpRangeSource.read`, after the request gate grants the slot (not
     around the feed, which includes the queue wait);
   - hysteresis at the threshold, so a rate hovering around it does not flap between playing and
     buffering;
   - fix the backwards 0.8 / 1.25 wording in #3322 (the sustain test compares the media rate to the
     link rate, and its comments read the ratio the wrong way round);
   - tests with an element model whose buffer grows and whose playhead advances on a fake clock,
     counting stalls before and after.

   **Built 2026-11-11** (the hold, the measure after the gate, the hysteresis; #3322 closed). The
   owner decided on 2026-11-11 that the hold is invisible: no label, no percent, no control. 29
   stalls become 1 in the model
   ([video-player](../frontend/modules/video-player.md#a-link-slower-than-the-video-one-honest-load-2026-11-11)).
   Left: the throttled-link reading on both phones, and the lower-bitrate rendition (not built).

**Gaps 4 and 5, built (2026-11-11, draft PR).** Gap 4: nine communities cost 27 requests at a load,
now 19 - one batched `GET /api/channels/workspaces/boot-reads` for the salon listings only (database
reads, the rows no longer wait on chat-delivery); the key-group reference and the roster stay per
community on purpose (the reference carries a device roster that is unsafe to read before MLS is
ready, review of #3332). Gap 5: `follow-statuses` 8 -> 2 for
eight card ticks (one round in flight); `users/batch` has no identical request left to remove and
`devices/self` x3 are three different URLs (C4). Numbers, causes and what was left:
[audit section 4.5](../frontend/weak-network-audit-2026-11-10.md#4-the-leads-field-evidence-owners-android-169-log-production-nginx-read-against-the-code).
Owed: the same count on a real boot of the owner's account, and the batched route on dev.

**Method.** Measure every screen on a simulated slow link before and after, as in the audit
([method](../frontend/weak-network-audit-2026-11-10.md#1-method-and-what-it-cannot-see)); the number
that closes a screen is its first paint with the network answering nothing.

Already cut on the way (PR for `1.6.10`): today's birthdays read once per Paris day, the no-op
retries silent ([birthdays](../birthdays.md)).

**Carried from the first weak-network audit (2026-10-09, its P1 entry closed into this one on
2026-11-11).** Its 103 s Slow 3G cold start is history: origin compression (WP-W1) and the WASM
fetched beside the JS (WP-W2) shipped, the salon draft is never destroyed (WP-OFF-1), and the native
apps embed their frontend. What is still real joins this chantier: the conversation list waits for
the WASM by ORDER, not by data (WP-W3, diagnosed, not built,
[offline-and-weak-network section 10.3](../frontend/offline-and-weak-network.md#103-wp-w3-the-first-list-render-depends-on-the-wasm-only-by-order-and-the-order-is-the-session));
and the runs its section 8 still owes - delivery at the peer, and the Android and iPhone send, kill
and relaunch rows on a shaped link
([section 8](../frontend/offline-and-weak-network.md#8-not-measured-and-owed)).
Re-measured 2026-11-09 ([section 23](../frontend/offline-and-weak-network.md#23-the-engine-is-preloaded-only-where-the-first-screen-waits-for-it-2026-11-09)):
the WASM preload took 12-13 s of the JavaScript's bandwidth on Slow 3G, so it now runs only on `/chat`
and `/communities` and a cold `/` boots at 33.1 s instead of 46.1 s; owed, the real-phone reading of
a cold `/` on a throttled link (the route list re-checked against `main` on 2026-11-14, no other route waits on the engine for its first screen); next there, a bundle budget (WP-W5) and the on-demand features.

**Carried from the attachment-path audit (2026-10-10, its entry closed into this one on
2026-11-11).** The upload bubble, the 8 MiB body budget, navigation never waiting on a post and
the upload outside the send lane shipped, and the file's bytes left the outbox row (section 13.7).
Still real: a CHAT attachment restarts at byte 0 after a failure - only a chat reel (RC-5) and a feed
post resume, the general writer is S2 of [media-streaming-upload](../services/media-streaming-upload.md)
([section 13](../frontend/offline-and-weak-network.md#13-audit-of-2026-10-10-a-13-mb-attachment-on-a-poor-link-and-what-navigation-waits-for));
and a salon poll is not queued while the link is down.

**The community-open 200 ms budget** (moved here from the deleted community entry, 2026-11-20). The goal
(user, 2026-10-14): on a slow network and a poor phone, opening a community is almost instantaneous -
rail, salons and a salon opened before **<= 200 ms from local state, with 0 request on the path**.
F1-F7 are built; the last Mi 9T reading (`1.7.0-alpha.8`, 2026-11-17, cold medians) is tap to rail and
salons 915 ms, salon to pane 433, salon to messages 865, cached reopen 354, 49 API calls, so the budget
is met on no row ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)).
What is left, in order:

1. **The Mi 9T `--profile-salon` and `--chain` reading** on the cold first open, to name the time before
   the pane and the long tasks (one bench sitting, half a day). It decides step 3.
2. **The `Icon` count and cost** - count the `@lucide/svelte` icons a first open mounts, then draw the
   per-bubble and per-row ones as plain inline SVG if the count says so (one to two days, desktop
   bench first).
3. **Whatever the chain names** - the layout of the first frame (111 of 279 ms on the bench, text
   shaping) and the cold open's 49 API calls are the two candidates; neither is sized until step 1.
4. **The [section 7](../frontend/community-open-budget.md#7-not-measured-and-owed) readings** - the warm
   resume at 4x and the iOS protocol (a day each).

The 200 ms on every row is several weeks beyond these steps, not one pull request.
