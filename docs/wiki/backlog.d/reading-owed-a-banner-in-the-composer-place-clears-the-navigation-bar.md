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

**Mi 9T, 2026-11-17 (`1.7.0-alpha.7`, dev, three-button navigation by the `threebutton` overlay), the deleted-conversation half READ, PASS** ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-17-170-alpha7-the-envoyer-a-retakes-on-section-22s-screens)): `beta` deleted a group `alpha` had just been added to; the banner "Cette conversation a ete supprimee." and "Supprimer localement" stood above the navigation bar (button bottom at 2218 px, the bar from about 2232 px of 2340) and the tap on it removed the conversation locally. **Left:** the read-only salon's policy line on the Mi (no salon the bench account may not write in was found), and the iPhone half.

**iPhone 12, 2026-11-17 (`1.7.0-alpha.10`, dev, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)): the deleted-conversation half READ, PASS.** "Cette conversation a été supprimée." and "Supprimer localement" at 777-810 pt of 844, the home indicator's 34 pt below it. **Left:** the read-only salon's policy line on the Mi 9T, and the desktop-width padding.
