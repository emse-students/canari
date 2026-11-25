## P2 - an image arriving at a pinned DM drops the pane 150-230 px on the iPhone (iOS 27)

target: 1.8.2

**Defect.** On the iPhone 12 (iOS 27.0.1, store build 1.8.2-alpha.1), a DM open and pinned at its end:
an IMAGE arriving makes the pane fall 150-230 px below the last placed `scrollTop` 45-70 ms after the
row is added, with the reach unchanged; the INFO line `left the bottom with no finger on the pane`
fires, and the pane later returns. Measured on the phone: image arrivals with Reduce Motion OFF fall
6 of 6, Reduce Motion ON 0 of 2, a short text 0 of 3, a 12-line text 0 of 3. So the arrival glide (or a
row animation) is necessary, and so is an image row.

**Cause found (1.8.2-alpha.3 trace, 2026-11-25): a second writer pinned inside the glide.** The
arrival's `rows` pass pinned the layout end and started the glide; a tick later the new-message
effect's own `scrollToBottom()` wrote `scrollTop = scrollHeight` with the transforms ON the rows,
whose overflow counts `max(0, offset - padding-bottom)` (composer padding 86 px): an image row's
travel of ~250-300 px overshot by ~160-210 px, the falls measured. The image's `box` pass took the
transforms off, the engine clamped back to the layout end, and the pane read that clamp as a fall
below the last placed value. Only a travel over ~206 px crosses the 120 px slack, hence intermittent
and never with text or Reduce Motion. Hypotheses (a), (b) and (c) below are retired. **Fix**
(`pinThreadToEnd`: every pane pin takes the glide off, writes the layout end and replays it; the
write is in the trace): see
[chat](../frontend/modules/chat.md#the-cause-a-second-writer-pinned-inside-the-glide-2026-11-25).

**Reading owed (iPhone 12, Reduce Motion OFF, the first alpha carrying the fix):** with a DM open and
pinned, have an image sent to it three times and export the in-app log: no `left the bottom` line, no
arrow flash. The entry closes on that reading.

**The trace stays** (below), now with the pins made outside `follow()` merged in recording order.

**The hypotheses before the trace (retired).** An image arrival gets a second `follow()` pass (the child `ResizeObserver`,
cause `box`, as the image takes its size) inside the running glide: `suspend` cancels the transforms,
the pin writes or not, then `play(held.px, held.time)` replays. What lowers `scrollTop` is one of
(a) iOS 27 WebKit's native scroll anchoring reacting to the transform cancel and re-creation (the code
relies on `overflow-anchor: none`), (b) the UI process clamping against a transient content size while
the animations restart, (c) the previous `held.px` replayed after the pass measured another height.
Reading alone does not prove (c): the replay is a transform on the rows and writes no `scrollTop`, so
it cannot lower the pane, only draw rows offset. No fix is guessed.

**The trace (silent until a fall).** Nothing is written at pass time: every ordinary message makes a
glide, so a line per pass would be noise on every device. Each `follow()` pass that starts or finds
a glide is kept in memory (a ring of 8, older ones counted), together with the `scroll` moves that
follow the last pass (a listener armed for the glide only, timestamp = ms into the glide, `scrollTop`
delta, no forced layout), and the pane's fall measurement prints them at INFO next to the `left the
bottom` line: `[ChatArea] the fall came inside a glide of Xpx, Tms in; N follow pass(es) and M scroll
move(s)`, then `glide pass N (rows|box, +Tms): top/height/box previous end ..., suspended ..., pinned
...; held ...; <response>, new travel ..., replay ...` and `glide scroll move +Tms: top T (-D)`. The
numbers are read where the layout is already clean (`suspended`: transforms cancelled, before any
write; `pinned`: right after the pin and BEFORE the replay), never with a transform on the rows.
Reading it: (a) native anchoring moves `top` at `suspended` with the height UNCHANGED; (b) a clamp
moves it with a height that shrank; stable in-pass numbers followed by a scroll move 45-70 ms later
are (b) or an engine move outside the passes (the async case), NOT "nothing found"; (c) a stale
replay is only a visual offset of the rows and cannot be a `scrollTop` cause. The fall line carries no "now top/height/box": the scroll-move lines carry the top. See
[chat](../frontend/modules/chat.md#the-trace-of-the-passes-inside-a-glide-2026-11-25).
