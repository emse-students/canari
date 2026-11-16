## P3 - the feed offset restored after a Back from an association lands about 226 px lower than it was left (Mi 9T, `1.7.0-alpha.2`)

target: 1.7.0

**Found by:** the `1.7.0-alpha.2` reading of #3648 ([device-verification](../device-verification.md#170-alpha2)). On the Mi 9T, feed scrolled to 1500 css px, a profile opened from a post, an association opened from that profile, then the hardware Back twice: the app returned to the feed with the page scroll box at 1726 css px, so the posts sit about 226 px (a quarter of the screen) lower in the viewport than where the reader left them. The route is right; the offset is not exact. The iPhone 12 read the same restore as exact on the Organisations tab.

**Fixed in the next pre-release (fix, not yet read on a phone):** the entry records an anchor post and its distance from the top beside the offset, and the restore aligns the post, not the number, following the page until it is quiet ([section-navigation](../frontend/section-navigation.md)). The cause stays an unverified hypothesis; Pour toi and Organisations are both feed tabs, so both are covered, and the directory keeps the raw offset. The reading below stays owed on the Mi 9T, and the entry is deleted when it passes.

**What is not known:** whether the shift comes from the feed's placeholders being replaced by taller content after the restore (the restore waits for placeholders, #3648), or from autoplaying videos changing height. One run, one phone.

**The reading that closes it:** on the Mi 9T, repeat the route on the Pour toi tab and on Organisations, record the page scroll box's `scrollTop` before leaving and after the Back, three runs each; the fix owes a test that restores to the stored offset when the content above it changes height.
