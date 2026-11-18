## P3 - the share targets are republished twenty-three times during an account's first sync

target: 1.7.1

**Found by:** the sharing reading's Mi half, sitting S6 on `1.7.0-alpha.12`, Mi 9T, dev
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).
After a sign-out and a sign-in of a second test account on the install, logcat showed 23
`GalleryPlugin: publishShareTargets: 5 target(s)` calls in about 27 s, each followed by
`ShareTargets: publish: 5 of 5 present, N removed, 0 left to remove`, with N alternating between 1 and 0:

```
08:20:04.834 D/GalleryPlugin: publishShareTargets: 5 target(s)
08:20:04.868 I/ShareTargets: publish: 5 of 5 present, 1 removed, 0 left to remove
08:20:05.255 D/GalleryPlugin: publishShareTargets: 5 target(s)
08:20:05.286 I/ShareTargets: publish: 5 of 5 present, 1 removed, 0 left to remove
```

`syncShareTargets` (`src/lib/sharing/shareTargets.ts`) republishes whenever the top five of the
conversation list change, with no debounce and no clock, on purpose. During a first sync the list
reorders as each conversation's history lands, so some republishing is expected. But "1 removed" on
most calls suggests a target that leaves and comes back again and again, and each call is a write to
the system's shortcut store. The ids were not read, so whether the set flaps between two lists or
only walks forward is not known. Not shown a regression since `v1.6.12`.

**The fix:** first read which target goes and comes back (log the ids removed and added on each
publish). If it flaps, the list's order during the sync is not a stable function of what has
arrived, and the order is what to fix. If it only walks forward, publish from a settled list: the
sync's own end, a fact the sync already knows, never a timer. A unit test: one sync replaying N
conversations publishes a number of times bounded by the changes of the final top five.
