## P3 - on the iPhone the native "+" jumps and the web composer hides while the keyboard rises (the Mi 9T half passed)

target: 1.8.0

**What is built:** the composer stands still while the keyboard rises (2026-10-09, Android double report and iOS stale inset, unit-proven only)

**The reading that closes it:** the Mi 9T half PASSED on 2026-10-13 (869.5 -> 524 in one frame, 5 of 5, [check W](../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)); owed: the iPhone, on a build newer than `1.2.3-alpha.5`. **iPhone 12, 2026-10-11: no 465 plateau any more, but a NEW defect, 3 of 3 rises**: the native "+" twin jumps to 487 pt at once while the web layer is drawn a keyboard height lower and slides up over ~250 ms, so the web composer is hidden and the "+" floats alone (an OPEN P3, cause not looked at)
