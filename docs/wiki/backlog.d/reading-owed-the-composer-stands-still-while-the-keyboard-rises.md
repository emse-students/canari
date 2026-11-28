## P3 - on the iPhone the native "+" jumps and the web composer hides while the keyboard rises (the Mi 9T half passed)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**What is built:** the composer stands still while the keyboard rises (2026-10-09, Android double report and iOS stale inset, unit-proven only)

**The reading that closes it:** the Mi 9T half PASSED on 2026-10-13 (869.5 -> 524 in one frame, 5 of 5, [check W](../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)); owed: the iPhone, on a build newer than `1.2.3-alpha.5`. **iPhone 12, 2026-10-11: no 465 plateau any more, but a NEW defect, 3 of 3 rises**: the native "+" twin jumps to 487 pt at once while the web layer is drawn a keyboard height lower and slides up over ~250 ms, so the web composer is hidden and the "+" floats alone (an OPEN P3, cause not looked at)

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`): still not clean.** MJPEG at 9.5 frames/s shows one frame with the native "+" raised and no web composer, then everything settled. Shorter than 2026-10-11, same shape.

**iPhone 12, 2026-11-23 (`1.8.0-alpha.4`, [sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha4-iphone-12-the-bell-after-a-re-follow-the-dm-thread-the-communication-banners-the-focus-rows-the-voice-note-the-composer)): STILL PRESENT, same shape, in 2 of 4 rises.** The WebDriverAgent screen stream (about 10 frames per second, four rises in a DM) shows, in two rises, one frame where the native "+" is already raised and the web composer is missing or a row lower, then everything settled; the two other rises show one or two transition frames with the "+" and the field level (at this frame rate a 100 ms jump can fall between two frames). No plateau, no hidden composer after the rise. The entry stays open as the defect it describes.

**iPhone 12, 2026-11-24 (`1.8.0-alpha.6`, [sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)): STILL PRESENT.** In the one rise the stream caught, three consecutive frames (about 300 ms) show the native "+" raised to mid-screen with the web layer unpainted, then everything lands. In the same sitting the page twice read a doubled keyboard inset (602 px) and stayed blank with the "+" stranded until the keyboard was hidden: that is a defect of its own, [P2 - the page reads a doubled keyboard inset and stops painting](p2-the-iphone-page-reads-a-doubled-keyboard-inset-and-stops-painting.md). This entry stays for the short jump.

**2026-11-24: the cause of the jumping "+" is named and fixed, unread** ([the doubled-inset entry](p2-the-iphone-page-reads-a-doubled-keyboard-inset-and-stops-painting.md)): WebKit's own keyboard inset scrolled the document 301 pt on nearly every rise, and the native "+" followed the page's coordinates. `fix/ios-keyboard-reveal-and-inset` detaches it; the doubled-inset entry's ten streamed rises are this entry's reading too.
