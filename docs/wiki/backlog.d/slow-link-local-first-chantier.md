## P2 - the slow-link chantier: no screen waits for the network to draw (owner, 2026-11-10; starts right after 1.6.10)

**Decision.** The owner, 2026-11-10: *"a slow connection is common and a real plague"*. The chantier
starts right after `1.6.10` and is carried to the end, not abandoned at the first improvement.

**Goal.** On a slow link no screen waits for the network to draw. Every screen renders from local
state first, then revalidates ([local-first-ui](../frontend/local-first-ui.md)).

**Known gaps**, from the owner's logs `canari-log-1.6.9-20261110-2059.txt` and
`canari-log-1.6.9-20261110-1810.txt`:

1. The session refresh (4 s at the 20:58 boot, server 17 ms) gates the first reads: the feed,
   the announcement, help-seen and the birthday.
2. Some screens have no local copy: Pour toi, the bell, profiles already seen.
3. Media seen once is not kept, within a size budget.
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

   **Built 2026-11-11** (the hold, the measure after the gate, the hysteresis, the progress label;
   #3322 closed): 29 stalls become 0 in the model
   ([video-player](../frontend/modules/video-player.md#a-link-slower-than-the-video-one-honest-load-2026-11-11)).
   Left: the throttled-link reading on both phones, and the lower-bitrate rendition (not built).

**Method.** Measure every screen on a simulated slow link before and after, as in the audit
([method](../frontend/weak-network-audit-2026-11-10.md#1-method-and-what-it-cannot-see)); the number
that closes a screen is its first paint with the network answering nothing.

Already cut on the way (PR for `1.6.10`): today's birthdays read once per Paris day, the no-op
retries silent ([birthdays](../birthdays.md)).
