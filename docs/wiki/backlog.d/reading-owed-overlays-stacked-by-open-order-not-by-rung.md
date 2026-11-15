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
