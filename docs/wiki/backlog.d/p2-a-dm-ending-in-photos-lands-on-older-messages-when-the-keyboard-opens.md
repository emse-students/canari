## P2 - a DM ending in photos and a video lands on OLDER messages when the keyboard opens (`1.6.12`, Pixel 6a, 2026-11-14) - a defect, the 2026-10-30 fix does not hold
target: 1.7.0

**The defect.** A reader at the bottom of a long DM whose last rows hold a photo, a video and a
screenshot taps the composer. The keyboard rises normally, the thread follows it rigidly, and
**~50 ms after the keyboard settles the thread jumps several screens up** to older rows, the
scroll-down arrow showing. Putting the keyboard away leaves them there. The photo nearest the end had
stayed a blurred placeholder for ~3 s after the DM opened, and finished loading in the frame the
keyboard started.

**It is the defect of 2026-10-30, not a new one** ([a reader at the bottom is anchored to the
bottom](../frontend/modules/chat.md#a-reader-at-the-bottom-is-anchored-to-the-bottom-in-both-directions-2026-10-30)):
the same symptom, reported on `1.5.1` on the same phone. It was fixed by `threadGrowthResponse`
(`threadAnchor.ts`) and by the media ceiling holding while a keyboard is up
(`keyboardFreeViewportHeight`, 2026-11-13). Its owed Android reading, a DM with a portrait photo near
its end, is this one, and **it fails on `1.6.12`**, the current stable. How it was read, with the
other findings of the same session: [the readings of 2026-11-14](what-the-keyboard-readings-of-2026-11-14-filed.md).

**Why the 2026-10-30 analysis does not explain it.** That analysis had one mover: a `60svh`-capped
photo shrinking by 214 px, answered with `keep-row`. Here the jump is several screens, not 214 px,
and it lands after the rise, not during it. The two facts the old analysis did not have: **a medium
finishing its load during the rise**, and **a render window that is still being widened after the
entry** (`widenEntryWindow` brings the hidden groups AFTER the reveal, `ChatArea.svelte`).

### Candidate causes - each names what would refute it

| | candidate | refuted if |
| --- | --- | --- |
| H1 | the stick-to-bottom flag drops mid-rise: a `scroll` event measured by `measureScroll` finds the pane more than 120 px off the bottom AND `scrollTop` lower than last measured (a clamp when content shrank, the photo swapping boxes), so `stickToBottomAfterScroll` returns `false`, and every later change answers `keep-row` | `isNearBottom` reads `true` at every `follow` of the rise |
| H2 | the entry's window widening (`widenEntryWindow`) or a pagination prepends rows during the rise without `isLoadingOlder` set, and a `follow-bottom` aimed at a `scrollHeight` measured before the prepend lands short by the prepended height | no `chat.entry widening` line and no `loadOlderGroups` in the rise's window |
| H3 | the photo's placeholder box and its loaded box differ (the reserved ratio is wrong or unknown for this message), the growth runs under a glide (`createThreadGlide`, suspended and resumed), and the resumed glide is drawn from a stale offset | the photo's `MediaFrame` box is the same before and after the load |

### The hunt, in order

1. **On the web first, no phone needed**: a dev build in Chrome, a bench DM ending in a portrait
   photo and a video, network throttled so the photo arrives late, the window height cut by the
   keyboard's height at the moment the photo lands (a resize IS what the Android padding does to the
   WebView). Log every `follow` (cause, `previousReach`, `currentReach`, `wasNearBottom`, response,
   `scrollTop` before and after) and every `measureScroll`. If it reproduces, the cause is read there.
2. **If the web does not reproduce it**: the Mi 9T on a dev build with CDP attached, the same DM, the
   same log lines, a screen recording read with the instrument of
   [the motion study](keyboard-motion-like-android-messages.md).
3. **The fix comes with the test that fails without it**: `threadGrowthObserver.test.ts` replays
   the sequence the log shows (photo growth, box shrink, prepend, glide, in the order measured).
4. **Closed by a reading on the owner's Pixel 6a**, the same DM, on the pre-release carrying the
   fix.
