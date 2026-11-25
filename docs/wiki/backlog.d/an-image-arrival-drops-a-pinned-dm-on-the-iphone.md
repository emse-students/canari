## P2 - an image arriving at a pinned DM drops the pane 150-230 px on the iPhone (iOS 27)

target: 1.8.2

**Defect.** On the iPhone 12 (iOS 27.0.1, store build 1.8.2-alpha.1), a DM open and pinned at its end:
an IMAGE arriving makes the pane fall 150-230 px below the last placed `scrollTop` 45-70 ms after the
row is added, with the reach unchanged; the INFO line `left the bottom with no finger on the pane`
fires, and the pane later returns. Measured on the phone: image arrivals with Reduce Motion OFF fall
6 of 6, Reduce Motion ON 0 of 2, a short text 0 of 3, a 12-line text 0 of 3. So the arrival glide (or a
row animation) is necessary, and so is an image row.

**Unproved hypothesis.** An image arrival gets a second `follow()` pass (the child `ResizeObserver`,
cause `box`, as the image takes its size) inside the running glide: `suspend` cancels the transforms,
the pin writes or not, then `play(held.px, held.time)` replays. What lowers `scrollTop` is one of
(a) iOS 27 WebKit's native scroll anchoring reacting to the transform cancel and re-creation (the code
relies on `overflow-anchor: none`), (b) the UI process clamping against a transient content size while
the animations restart, (c) the previous `held.px` replayed after the pass measured another height.
Reading alone does not prove (c): the replay is a transform on the rows and writes no `scrollTop`, so
it cannot lower the pane, only draw rows offset. No fix is guessed.

**The trace (INFO, so the exported log of a store build holds it).** Written only while a glide runs,
at most 8 lines per glide, nothing on steady scrolling: one `[threadGrowth] glide pass N (rows|box,
+Tms): top/height/box before ..., suspended ..., pinned ...; held Xpx with Ypx left; <response>, new
travel Zpx, replay Wpx at Tms` per `follow()` pass, and ONE `[ChatArea] the fall came inside a glide
of ...` line next to the fall line, carrying the numbers now and the last pass. Reading it: top moving
at `suspended` is (a) or (b) (a shrunk `height` at `suspended` is (b)); top moving only at `pinned`
or after, with `replay` differing from the layout, is (c). See
[chat](../frontend/modules/chat.md#the-trace-of-the-passes-inside-a-glide-2026-11-25).

**Reading owed (iPhone 12, Reduce Motion OFF, the first alpha carrying the trace):** with a DM open and
pinned, have an image sent to it three times and export the in-app log. The entry closes with the
cause named from those lines and a fix pinned by a test, or with the glide's difference (Reduce Motion)
explained.
