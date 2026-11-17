## P3 - Settings > Preferences: at a doubled root font the "Langue" text is squeezed and the "Revoir la visite" button runs past the card (Mi 9T, 2026-11-17)

target: 1.7.0

**Seen** on the Mi 9T, `1.7.0-alpha.6`, `font_scale` 2.0 (root font 32 px) at 390 css px (`wm density 443`), Settings > Preferences
([readings](../device-verification.md#the-mi-9t-night-readings-of-2026-11-17-170-alpha6)). The Emojis row, which the
[Emojis entry](p3-the-emojis-preference-row-squeezes-its-description-on-a-phone.md) is about, is fixed (description at 255 of 358 css px,
the Systeme / Canari control below it). Its neighbours are not: the "Langue" description reads one word per line ("Langue / de /
l'interface") beside the FR / EN control, and the "Visite guidee" row keeps a 148 css px text column (0.41 of the card, 0.39 at the
normal root font, so below the entry's own "half the card" bar) while its "Revoir la visite" button runs past the right edge of the card
and the screen ("Revoir la v..."). Screenshots are outside the repository (harness `mi-night/`).

**The fix to make:** give those two rows the shape the Emojis row now has: the control under the text on a narrow width (`w-full`), beside
it from `sm`. The check is the same screenshot at 390 css px and `font_scale` 2.0. Charter: principle 7 (a setting reads at a glance).
