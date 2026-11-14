## Reading owed - the tab swipe to the camera on a slow start: the 8 px lock

target: 1.7.0

**What is built:** the tab swipe to the camera on a slow start: the 8 px lock (#2179) and the left-edge exclusion (#2184, widened by #2369), `v1.4.0` ([design-reference](../frontend/design-reference.md#the-swipe-to-the-camera-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-21))

**The reading that closes it:** slow real-finger swipes to the camera on the Mi 9T, every one taken; class A (the lock) read on the iPhone 12, where it is unproven

**Mi 9T half read 2026-11-14 (`1.6.12`, `adb input swipe`, the shell may not write the touch device, so not a finger):** swipes to the camera from x = 20, 50 and 60 px at y = 1000, 1300 and 1420, on `/posts`: 9 of 9 at 200 ms, 9 of 9 at 900 ms, 9 of 9 at 1800 ms. **Left, for the both-phones sitting: class A (the lock) on the iPhone 12.**
