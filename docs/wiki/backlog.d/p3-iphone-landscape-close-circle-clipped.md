## P3 - on the iPhone in landscape, the close circle looks clipped at the right edge

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Seen at the iPhone 12 sitting on `1.7.0-alpha.7` (2026-11-17, the interim readings of #3756): with a
full-screen viewer turned to landscape, the round close control looks cut at its right edge. Not
measured: which screen (the lightbox, the reel pager or the live viewer - the rotation readings name
the close control of each at x 55-59 pt on the LEFT, so a control on the right is another one), and
whether `1.6.12` draws it the same. Cosmetic: the control taps.

**What closes it:** name the screen and the element, read its box against the safe area
(`env(safe-area-inset-right)`, 47 pt in landscape on this phone) in landscape both ways, fix the
inset it ignores, and re-read on the iPhone 12. If `1.6.12` draws it whole, it is a regression of
`1.7.0` and comes back to that version. Mechanism of the turned screens:
[screen-orientation](../frontend/screen-orientation.md).
