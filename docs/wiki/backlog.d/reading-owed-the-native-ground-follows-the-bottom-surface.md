## Reading owed - P2 - the strip under the tab bar matches the bar after a conversation's keyboard

target: 1.8.2

Built: the ground the Android shell paints under the WebView (`canariTheme.setGround`) is re-read
from the bottom edge on every change of the bottom surface (route settled, theme applied, tab bar
mounted or unmounted, boot gate lifted, splash dismissed, keyboard rise) and posted only when it
changed ([keyboard-and-send-motion](../frontend/keyboard-and-send-motion.md)). Before, a
conversation's grey posted on a keyboard rise stayed under the feed's white bar until a cold restart.

The reading that closes it, on the Mi 9T (never on the Pixel 6a): open a conversation, raise the
keyboard, go back to the feed (`/posts`); the strip under the tab bar matches the bar, in light AND
in dark. The logcat shows one `[nativeGround] ground ... -> ... (navigation)` or `(bottom-bar)` line
per change, and none for a surface that did not change.
