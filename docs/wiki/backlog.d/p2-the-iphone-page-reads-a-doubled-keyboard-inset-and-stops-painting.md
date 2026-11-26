## P2 - on the iPhone the page twice read a doubled keyboard inset (602 px) after a rise and stopped painting, the native "+" stranded mid-screen (2026-11-24)

target: 1.8.3

_2026-11-26: moved to 1.8.3 when 1.8.2 shipped; nothing of it was reachable on the `1.8.2` sitting either._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**Found while reading [the composer stands still while the keyboard rises](reading-owed-the-composer-stands-still-while-the-keyboard-rises.md) on the iPhone 12, `1.8.0-alpha.6`** ([sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)). Fixed by `fix/ios-keyboard-reveal-and-inset` (below), unread on a phone. A defect of its own, in a DM, with the keyboard raised by tapping the composer.

**What was seen.**

1. The page's `[CHAT_VIEW]` line reads the keyboard at 301 px everywhere (`keyboard open 301px ... clientHeight 496`), except twice: transition #28 (08:58:08, during the return cycles) and transition #38 (09:03:16, the first streamed rise), at rest: `scrollTop 6695 scrollHeight 6890 clientHeight 195 ... keyboard open 602px`. 602 is exactly twice 301, and `797 - 602 = 195`, the page's `clientHeight`.
2. After #38 the screen was left in this state for minutes: the web view (390 x 543 pt, correct for a keyboard of 301 pt) was BLANK - no thread, no composer - while the page's accessibility tree was still there (`Back to menu`, the contact name, `Add`), the native glass header still drawn and **the native "+" stranded at y 188 pt**, where the composer of a 195 px-high page would sit. A tap in the thread and a later tap did not bring the page back; the state ended with the keyboard hiding (#39, 09:09:21, `keyboard closed`, `clientHeight 797`).
3. In the stream of a rise that did NOT stay stuck, the same symptom lasts three frames (about 300 ms): the native "+" jumps to the middle of the screen and the web layer is unpainted, then everything lands. That is the reading entry's "jumping +" and it looks like the same fault with a short life.

**Hypothesis.** The page sums the inset of two keyboard notifications instead of replacing it (the did-show relay's `keyboard open` and the frame-change one, for a native view that is already resized to 543 pt), so a rise delivered while a transition is in flight is applied twice; the layout box is then 195 px high and the compositor paints nothing outside it. The page's single source for the inset is the place to look, and the `alpha.6` pane line already logs it.

**To close it.** A rise on the iPhone 12, ten times, never logs a `keyboard open` other than the keyboard's own height, and the native "+" and the web composer move together.

**The cause, read in the syslog of the same sitting (2026-11-24).** The page does not sum two notifications: the second inset is WebKit's. WKWebView observes the keyboard's will-show, will-hide, will-change-frame and did-change-frame itself and, on each, insets and scrolls its own scroll view by the keyboard's overlap of its frame AT THAT MOMENT. The shell hands a rise to the page first and sets the frame only after the page's layout is on screen, so WebKit always measured the keyboard against the full-height frame. The trace: on nearly every rise of the sitting the document scrolled by 301 pt (`[nativeGlassPiece] chat-add compensating a document scroll: scrollY=301`, then `back to 0`), which is the native "+" placed one keyboard higher over a page not yet repainted - the ~300 ms of the streamed rise. At #28 and #38 the inset stayed: `keyboard settled: native offset=301.0 content=543.0 bounds=543.0` - an offset the shell's clamp (`CanariClampDocumentScroll`) left alone, so the scroll view's range carried a bottom inset of at least 301 - and the visual viewport was the 543 pt frame less 301 again (`keyboard open 602px`, `clientHeight 195`). The same 301 pt was seen on `v1.2.9-alpha.7` (`CanariReportSettledKeyboardGeometry`'s comment).

**The fix (`fix/ios-keyboard-reveal-and-inset`): the shell is the one authority over the keyboard's room.** `CanariDetachWebKitKeyboardInset` removes WebKit's four inset-and-scroll keyboard observers from the WebView (public `removeObserver:name:object:`, once per WebView, from the first activation and from every keyboard change), so the keyboard is taken off the page once, by the frame the shell sets. **WebKit's reveal of the focused field goes with them** (review of #4058: its `RevealFocusedElementDeferrer` waits for a will-show only the detached `_keyboardWillShow:` fulfils), so the page is the one reveal in the iOS shell: `scrollFocusedFieldIntoView` now covers every field there but the composer (`pageRevealsField`; outside the iOS shell `.app-layout` stays the engine's). A WebView that heard a keyboard before the detach logs an ERROR with its inset. The settled report gains `inset bottom=` (the scroll view's own bottom inset), 0 when the shell is alone. Verified by compiling only, which proves nothing about running; a text test (`iosKeyboardRiseHandoff.test.ts`) holds the four removals and the kept did-show.

**The reading that closes it, on the iPhone 12, on the first alpha that carries the fix.** Ten rises by tapping the composer of a DM, streamed: no frame with the native "+" away from the web composer or the web layer unpainted; every `[CHAT_VIEW]` line reads `keyboard open 301px` (never 602); every syslog `keyboard settled` line with the keyboard up reads `native offset=0.0` and `inset bottom=0.0`; no `[nativeGlassPiece] ... compensating a document scroll` line. The detach line reads `scroll view inset bottom 0.0`, never the `detached too late` ERROR. **And the reveal, now the page's alone:** a fresh focus of a field low in a scrollable form (an association form or a post's form, the field below the keyboard's top before the tap) ends with the field visible above the keyboard; the PIN change dialog's second and third fields end visible above the keyboard and its footer; a comment box and a field inside a modal likewise; a search field at the top of the main page does not jump. **And the main page holds under a reveal:** focus a field in an `.app-layout` sheet while it is still sliding in - the main page behind it does not shift, and the in-app log has no `the main page shifted: .page-scroll-wrap|.app-layout scrolled to N` WARN (the witness the page now keeps in the iOS shell). Then this entry is deleted, with the "+" half of [the composer entry](reading-owed-the-composer-stands-still-while-the-keyboard-rises.md).

**2026-11-25, `1.8.1-alpha.2` (iPhone 12): the inset half PASS, the reveal rows still owed.** Ten rises
by tapping the composer of a DM: every `[CHAT_VIEW]` line read `keyboard open 301px`, never 602; every
`keyboard settled` line read `native offset=0.0` and `inset bottom=0.0`; no `compensating a document
scroll` line; the detach line read `scroll view inset bottom 0.0`, no `detached too late`; a screenshot
mid-rise showed the "+" level with the composer and the web layer painted (a stream was not captured, so a
sub-100 ms jump is not excluded). **Still owed:** the field-reveal rows (a field low in a scrollable form,
the PIN change dialog, a comment box and a field in a modal, a field in an `.app-layout` sheet sliding in).

**2026-11-25, `1.8.1-alpha.2` part 2 (iPhone 12): the field-reveal rows PASS.** The PIN change dialog, a
comment box, a field low in a form and a field in the new-discussion modal each ended visible above the
keyboard: overlap 301 (328 for a secure field), never 602, settled inset 0.0, no document-scroll
compensation. **Still owed, alone:** a field focused in an `.app-layout` sheet while it is still sliding in
- the main page does not shift and no `the main page shifted` WARN is logged. Then this entry is deleted.

**2026-11-25, `1.8.1-alpha.3` (iPhone 12): the last row could not be reached with the driver.** Six
attempts to focus a field in a sheet (Messages > New discussion) while it was still sliding in: a
driver tap costs about 780 ms and the sheet has settled by then, and a compound touch sequence (tap the
button, pause 60 ms to 1.5 s, tap the field) landed every time on the row BEHIND the sheet, so it is not a
valid reproduction. Nothing was focused in a sheet: the syslog held four `keyboard settled` lines, all
`native offset=0.0` and `inset bottom=0.0`, no `overlap=602`, no `detached too late`, no
`compensating a document scroll`, and the in-app log no `the main page shifted` WARN. **Stays open:** a
human finger or a frame-stream capture is needed, and the owner is to be asked whether to close the row
as unreachable by tooling.
