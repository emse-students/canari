## P3 - the Thème control's "Automatique" label spills out of its segment at a doubled font

target: 1.8.0

**Seen** on `1.7.1-alpha.3`, Mi 9T, Settings > Préférences at `font_scale` 2.0
([S9](../device-verification.md#the-phone-readings-of-2026-11-19-s9-171-alpha3)). The fix this
reading closed holds - the three segments sit inside the screen and each tap switches the theme - but the
third label, "Automatique", is one word wider than its third of the row: it does not wrap, and its text runs
past its segment's edges and past the group's left edge, over "Sombre".

**Where.** `SettingsPreferencesSection.svelte`, the Thème radiogroup: each segment is
`min-w-0 flex-1`, its label `<span class="min-w-0 break-words">`. `break-words` (`overflow-wrap:
break-word`) does not split a single word whose min-content width the flex item has already been
given; the label needs either `overflow-wrap: anywhere`, a hyphenation hint, or a shorter label at
this width ("Auto"), chosen so the Langue row stays aligned.

**Seen at the same scale, same sitting:** the feed's tab row (Organisations / Pour toi / Campus)
pushes "Campus" past the right edge of the screen. Same family - a row of fixed labels that does
not fit a doubled font - and read in the same pass.

**The reading that closes it:** the same screen at `font_scale` 2.0 on the Mi 9T, every label inside
its own segment, and the feed's three tabs inside the screen.
