## P3 - the emoji picker's pictures appear late or grow in (owner, 2026-11-08, iOS app)

Opening the picker (reaction "+" in a conversation) on the iPhone: many cells of "Smileys et émotions" are blank for a moment, others appear small then grow to full size; the "Récents" row shows empty tiles; the category tab bar shows one stray emoji and no icons until loaded. The owner wants the grid drawn at once.

Known from [emoji](../frontend/emoji.md): the picker is our own grid of Noto pictures (`img`), lazily loaded (697 of 1914 fetched on first open in the 2026-09-25 measurement).

Candidates to measure before choosing: `loading="lazy"` on cells in view, no width/height on the `img` so it lays out at 0 then grows, a CSS transition/animation on the cell, a cold HTTP cache in the WebView vs a sprite sheet or preloading the first category and the recents when the composer mounts. Fix at the cause, measured on the iPhone (first-open time to all visible cells painted), no placeholder trick.
