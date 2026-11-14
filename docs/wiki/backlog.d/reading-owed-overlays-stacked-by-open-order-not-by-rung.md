## Reading owed - overlays stacked by open order, not by rung

target: 1.7.0

**What is built:** overlays stacked by open order, not by rung ([design-reference](../frontend/design-reference.md#the-overlay-stack---what-is-on-top-is-what-opened-last-2026-11-13))

**The reading that closes it:** on a pre-release, on both phones: a dialog opened from a reel viewer (the comment report, the GIF picker) is above the viewer; a picker opened from a sheet and a dropdown (a person field, a picker) inside a nested dialog are above their dialog; the message-actions sheet and an emoji picker open over a reel; a confirmation raised from a modal covers it; the guided help over a quiet app; the toast still over all of them; closing the top one reveals the one beneath unchanged
