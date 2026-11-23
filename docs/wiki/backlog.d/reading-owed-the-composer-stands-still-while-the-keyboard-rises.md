## P3 - on the iPhone the native "+" jumps and the web composer hides while the keyboard rises (the Mi 9T half passed)

target: 1.8.0

**What is built:** the composer stands still while the keyboard rises (2026-10-09, Android double report and iOS stale inset, unit-proven only)

**The reading that closes it:** the Mi 9T half PASSED on 2026-10-13 (869.5 -> 524 in one frame, 5 of 5, [check W](../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)); owed: the iPhone, on a build newer than `1.2.3-alpha.5`. **iPhone 12, 2026-10-11: no 465 plateau any more, but a NEW defect, 3 of 3 rises**: the native "+" twin jumps to 487 pt at once while the web layer is drawn a keyboard height lower and slides up over ~250 ms, so the web composer is hidden and the "+" floats alone (an OPEN P3, cause not looked at)

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`): still not clean.** MJPEG at 9.5 frames/s shows one frame with the native "+" raised and no web composer, then everything settled. Shorter than 2026-10-11, same shape.

**iPhone 12, 2026-11-23 (`1.8.0-alpha.4`, [sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha4-iphone-12-the-bell-after-a-re-follow-the-dm-thread-the-communication-banners-the-focus-rows-the-voice-note-the-composer)): STILL PRESENT, same shape, in 2 of 4 rises.** The WebDriverAgent screen stream (about 10 frames per second, four rises in a DM) shows, in two rises, one frame where the native "+" is already raised and the web composer is missing or a row lower, then everything settled; the two other rises show one or two transition frames with the "+" and the field level (at this frame rate a 100 ms jump can fall between two frames). No plateau, no hidden composer after the rise. The entry stays open as the defect it describes.
