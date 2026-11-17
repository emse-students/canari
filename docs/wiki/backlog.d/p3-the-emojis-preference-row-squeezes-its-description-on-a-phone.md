## Reading owed - the Emojis preference row and its neighbours at 390 pt, on a phone

target: 1.7.0

The Emojis row of `SettingsPreferencesSection.svelte` now takes the Theme row's shape: its two-segment
control sits UNDER the text on a narrow width (`w-full`) and beside it from `sm` (`sm:w-44`), so the
description reads at full width instead of a one-to-three-word column eleven lines tall (iPhone 12,
390 pt, 2026-11-15). The Activity-sharing, repost and infinite-reels rows pair their text with a 48 px
switch, not a fixed 11 rem control, so they were not squeezed and are unchanged. Guard:
`SettingsPreferencesSection.emojiStyle.svelte.test.ts` (the classes are the contract; happy-dom has no
layout). Charter: principle 7 (a setting reads at a glance).

**What a reading must show**, on the iPhone 12 or any phone at 390 pt, Settings > Preferences, and
again at a doubled root font ([design-reference](../frontend/design-reference.md)): the Emojis
description runs in two or three lines at the full card width with the "Systeme / Canari" control below
it, and no row of the page keeps a text column narrower than half the card. A screenshot at 390 pt is the
closing reading; the entry is then deleted.

**Mi 9T, 2026-11-17 (`1.7.0-alpha.6`, 390 css px, [readings](../device-verification.md#the-mi-9t-night-readings-of-2026-11-17-170-alpha6)): the Emojis row `PASS`, its neighbours `FAIL`.** At the normal root font and at `font_scale` 2.0 the Emojis description sits at 255 of 358 css px with the control below it. At 2.0 "Langue" reads one word per line and the "Visite guidee" row keeps a 0.41 text column with its button cut off at the screen edge: [filed](p3-settings-preferences-rows-clip-at-a-doubled-root-font.md). This entry stays until that is fixed and read.
