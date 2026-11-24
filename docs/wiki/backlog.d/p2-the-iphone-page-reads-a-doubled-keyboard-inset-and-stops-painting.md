## P2 - on the iPhone the page twice read a doubled keyboard inset (602 px) after a rise and stopped painting, the native "+" stranded mid-screen (2026-11-24)

target: 1.8.0

**Found while reading [the composer stands still while the keyboard rises](reading-owed-the-composer-stands-still-while-the-keyboard-rises.md) on the iPhone 12, `1.8.0-alpha.6`** ([sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)). Not fixed here. A defect of its own, in a DM, with the keyboard raised by tapping the composer.

**What was seen.**

1. The page's `[CHAT_VIEW]` line reads the keyboard at 301 px everywhere (`keyboard open 301px ... clientHeight 496`), except twice: transition #28 (08:58:08, during the return cycles) and transition #38 (09:03:16, the first streamed rise), at rest: `scrollTop 6695 scrollHeight 6890 clientHeight 195 ... keyboard open 602px`. 602 is exactly twice 301, and `797 - 602 = 195`, the page's `clientHeight`.
2. After #38 the screen was left in this state for minutes: the web view (390 x 543 pt, correct for a keyboard of 301 pt) was BLANK - no thread, no composer - while the page's accessibility tree was still there (`Back to menu`, the contact name, `Add`), the native glass header still drawn and **the native "+" stranded at y 188 pt**, where the composer of a 195 px-high page would sit. A tap in the thread and a later tap did not bring the page back; the state ended with the keyboard hiding (#39, 09:09:21, `keyboard closed`, `clientHeight 797`).
3. In the stream of a rise that did NOT stay stuck, the same symptom lasts three frames (about 300 ms): the native "+" jumps to the middle of the screen and the web layer is unpainted, then everything lands. That is the reading entry's "jumping +" and it looks like the same fault with a short life.

**Hypothesis.** The page sums the inset of two keyboard notifications instead of replacing it (the did-show relay's `keyboard open` and the frame-change one, for a native view that is already resized to 543 pt), so a rise delivered while a transition is in flight is applied twice; the layout box is then 195 px high and the compositor paints nothing outside it. The page's single source for the inset is the place to look, and the `alpha.6` pane line already logs it.

**To close it.** A rise on the iPhone 12, ten times, never logs a `keyboard open` other than the keyboard's own height, and the native "+" and the web composer move together.
