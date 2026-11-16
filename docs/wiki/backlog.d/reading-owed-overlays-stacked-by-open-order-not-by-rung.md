## Reading owed - overlays stacked by open order, not by rung

target: 1.7.0

**What is built:** overlays stacked by open order, not by rung ([design-reference](../frontend/design-reference.md#the-overlay-stack---what-is-on-top-is-what-opened-last-2026-11-13))

**The reading that closes it:** on a pre-release, on both phones: a dialog opened from a reel viewer (the comment report, the GIF picker) is above the viewer; a picker opened from a sheet and a dropdown (a person field, a picker) inside a nested dialog are above their dialog; the message-actions sheet and an emoji picker open over a reel; a confirmation raised from a modal covers it; the guided help over a quiet app; the toast still over all of them; closing the top one reveals the one beneath unchanged

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (shipped, in `v1.6.12`).

**Mi 9T half, READ in part 2026-11-15 on dev (`1.6.12-alpha.2`, build 100601202, the alpha account):**
- a reel viewer, its comments drawer over it, and the GIF picker over the drawer: the GIF panel drew above both, and a hit test at the screen centre returned the GIF image;
- the message-actions sheet opened by a long press, then the full emoji picker from it: the picker drew above the sheet;
- the contact search of "Nouvelle discussion" (a dropdown inside a dialog): the listbox reads z-index 202 over the dialog's 200 and the four names were tappable.

**Left: the comment REPORT dialog over a viewer (the reel had no comment), a confirmation raised from a modal, the guided help over a quiet app and the toast over all of them, on the Mi 9T; and the whole iPhone half.**

**iPhone 12 half, partly read 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev, gamma): in a CanaReel viewer opened from the feed, the comment sheet opens over the viewer; the GIF picker opened from that sheet is above both and closing it leaves the sheet and the viewer as they were; the delete confirmation raised from the sheet covers the sheet; the share sheet opened from the viewer's Partager is above the viewer. **Not reached, left for the pre-release sitting:** the comment REPORT dialog (a reel with a comment by ANOTHER account on it: the bench reels carry none, and the reader cannot report their own), the message-actions sheet and an emoji picker over a reel (CanaReels in chats are not flipped yet), a dropdown inside a nested dialog, the guided help over a quiet app, and the toast over the stack.

**Left, counting both sittings above:** the comment REPORT dialog over a viewer, a confirmation raised from a modal, the guided help over a quiet app and the toast over the stack, on both phones; on the iPhone, the message-actions sheet and an emoji picker over a reel, and a dropdown inside a nested dialog.

**Mi 9T half, PARTLY READ 2026-11-15** (`1.7.0-alpha.1`, dev, alpha; a comment of beta's put on one of alpha's reels so a reader can report it): in the CanaReel viewer the comment sheet opens over it; the GIF picker opened from the sheet is above both and closing it leaves the sheet and the viewer as they were; the comment REPORT dialog ("Signaler ce commentaire", a comment by ANOTHER account) is above the sheet and the viewer (the three layers read z-index 200, 200 and 202 in the page, the dialog drawn whole over the sheet). Cancel closed the dialog only. The comment was deleted afterwards. **Not reached on the Mi:** the message-actions sheet and an emoji picker over a reel (CanaReels in chats are not flipped), a dropdown inside a nested dialog, the confirmation raised from a modal, the guided help over a quiet app, and the toast over the stack.

**iPhone 12, second sitting 2026-11-16:** not reached (signed out before it); the comment REPORT dialog on a POST comment and the "Nouvelle discussion" dropdown are still unread on the iPhone. Seen in passing only: the floating tab bar draws over the lower items of a long card menu.
