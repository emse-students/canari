## P3 - the feed offset restored after a Back from an association lands about 226 px lower than it was left (Mi 9T, `1.7.0-alpha.2`)

target: 1.7.0

**Found by:** the `1.7.0-alpha.2` reading of #3648 ([device-verification](../device-verification.md#170-alpha2)). On the Mi 9T, feed scrolled to 1500 css px, a profile opened from a post, an association opened from that profile, then the hardware Back twice: the app returned to the feed with the page scroll box at 1726 css px, so the posts sit about 226 px (a quarter of the screen) lower in the viewport than where the reader left them. The route is right; the offset is not exact. The iPhone 12 read the same restore as exact on the Organisations tab.

**What is not known:** whether the shift comes from the feed's placeholders being replaced by taller content after the restore (the restore waits for placeholders, #3648), or from autoplaying videos changing height. One run, one phone.

**The reading that closes it:** on the Mi 9T, repeat the route on the Pour toi tab and on Organisations, record the page scroll box's `scrollTop` before leaving and after the Back, three runs each; the fix owes a test that restores to the stored offset when the content above it changes height.

**Mi 9T, 2026-11-16 (`1.7.0-alpha.2`), the route the entry was meant to read:** a post published as an association, feed scrolled to 500 css px, a tap on the association name in a card header, then the header arrow and, in a second run, the hardware Back: both landed on `/posts` at 474 px, 26 px above where the feed was left (not 226). So the large drift belongs to the profile route (profile, then an association from it), and the chip route drifts by a smaller amount that two runs repeated exactly ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-owed-rows-170-alpha2)).
