## Reading owed - overlays stacked by open order, not by rung

target: 1.7.0

**What is built:** overlays stacked by open order, not by rung ([design-reference](../frontend/design-reference.md#the-overlay-stack---what-is-on-top-is-what-opened-last-2026-11-13))

**The reading that closes it:** on a pre-release, on both phones: a dialog opened from a reel viewer (the comment report, the GIF picker) is above the viewer; a picker opened from a sheet and a dropdown (a person field, a picker) inside a nested dialog are above their dialog; the message-actions sheet and an emoji picker open over a reel; a confirmation raised from a modal covers it; the guided help over a quiet app; the toast still over all of them; closing the top one reveals the one beneath unchanged

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (shipped, in `v1.6.12`).

**iPhone 12 half, partly read 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev, gamma): in a CanaReel viewer opened from the feed, the comment sheet opens over the viewer; the GIF picker opened from that sheet is above both and closing it leaves the sheet and the viewer as they were; the delete confirmation raised from the sheet covers the sheet; the share sheet opened from the viewer's Partager is above the viewer. **Not reached, left for the pre-release sitting:** the comment REPORT dialog (a reel with a comment by ANOTHER account on it: the bench reels carry none, and the reader cannot report their own), the message-actions sheet and an emoji picker over a reel (CanaReels in chats are not flipped yet), a dropdown inside a nested dialog, the guided help over a quiet app, and the toast over the stack.
