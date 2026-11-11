## P2 - the slow-link chantier: no screen waits for the network to draw (owner, 2026-11-10; starts right after 1.6.10)

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
2. Some screens have no local copy: Pour toi, the bell, profiles already seen.
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
