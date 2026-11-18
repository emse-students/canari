## P3 - the Thème control runs off the screen at a doubled font

target: 1.7.1

**Seen 2026-11-18 (Mi 9T, `1.7.0-alpha.11`, dev, `font_scale` 2.0, 436 CSS px, [readings](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)):** in Settings > Préférences, the Thème row's three-segment control (Automatique / Clair / Sombre) sits under its text, as it should, but its segments keep their natural width: "Sombre" spans 345-478 CSS px on a 436 px screen and is cut at the edge. The two-segment rows (Langue, Emojis) fit. Not a regression: the Thème row and `SegmentedControl` have the same layout as in `v1.6.12`.

**The fix it asks for:** the segments share the control's width (or wrap) instead of overflowing it, at any root font. Charter: principle 7 (a setting reads at a glance).

**The reading that closes it:** the same page at `font_scale` 2.0 on the Mi 9T, every segment inside the screen and tappable.
