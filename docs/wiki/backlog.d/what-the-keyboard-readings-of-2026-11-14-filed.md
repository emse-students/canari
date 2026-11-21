## P3 - what the keyboard readings of 2026-11-14 left open: the composer steps 12 CSS px down one frame before every close

target: 1.7.3

Read on the owner's Pixel 6a (Android 17, 60 Hz), Canari `1.6.12`, screen-recorded and read frame by
frame ([the motion study](keyboard-motion-like-android-messages.md)). Of the four findings of that
session, three are closed: the photo DM that landed on older messages
([the flag is only ever the reader's](../frontend/modules/chat.md#the-flag-is-only-ever-the-readers-2026-11-21)),
the short DM's history spinner and double jump, and the short DM sitting at the top (both
[a short thread sits at the bottom](../frontend/modules/chat.md#a-short-thread-sits-at-the-bottom-and-asks-for-its-past-at-entry-2026-11-14)).

**What is left.** In every DM, one frame after Back and before the keyboard moves, the composer moves
30-32 physical px (12 CSS px at 2.625) down: the footer's resting `0.75rem` changing as the keyboard
state flips, ahead of the layout. Small, seen in all five DMs. Read on `1.6.12`, which resizes the
WebView for the keyboard; **the Android app has not resized it since #3556**, so the first thing to
establish is whether the step is still there on a `1.7.x` build (the Mi 9T 90 px reading of
2026-11-14 found the padding change in the SAME frame as the resize, [chat](../frontend/modules/chat.md#a-picture-keeps-its-height-when-the-keyboard-opens-2026-11-13)).
