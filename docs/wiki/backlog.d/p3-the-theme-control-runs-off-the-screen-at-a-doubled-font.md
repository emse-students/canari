## P3 - READ ON THE NEXT 1.7.1 PRE-RELEASE: the Thème control fits a doubled font

target: 1.7.1

**Fixed in code.** The Thème row's radiogroup kept its natural width (`shrink-0`, unlike the Langue row's); it is now `w-full sm:w-auto` like Langue, its segments `min-w-0 flex-1` with the icon above the label that may wrap on a phone ([readings](../device-verification.md#the-phone-readings-of-2026-11-18-m1-and-i1-170-alpha11)).

**The reading that closes it:** Settings > Préférences at `font_scale` 2.0 on the Mi 9T, all three segments inside the screen and tappable.
