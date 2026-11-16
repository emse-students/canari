## Reading owed - a banner in the composer's place clears the Android navigation bar (2026-11-16)

target: 1.7.0

**What is built:** the three banners that replace the composer in the chat pane (a deleted
conversation, one unopenable on this device, a salon this person may not write in) are one class,
`.chat-docked-banner`, padded at the bottom by the composer's own floor, `--chat-composer-floor`
([keyboard-and-send-motion](../frontend/keyboard-and-send-motion.md#7-a-banner-in-the-composers-place-stands-on-its-floor-2026-11-16)).
Proven by a source test only (`composerBand.test.ts`); nothing renders the safe area off a phone.

**The reading that closes it:** on the Mi 9T with 3-button navigation (Settings, then gestures off),
open a conversation the peer deleted: the "Supprimer localement" button sits wholly above the
navigation bar and taps; then a read-only salon (its policy line above the bar) and, on the iPhone 12,
the same deleted conversation above the home indicator. In a browser at desktop width, the banner
keeps its 12 px bottom padding. Any part of the button under the bar is a FAIL.
