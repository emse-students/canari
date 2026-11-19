## P2 - a tap on a shared CanaReel's card opens the post page, not the reels viewer

target: 1.8.0

**Found** in sitting [S10](../device-verification.md#the-phone-readings-of-2026-11-19-s10-171-alpha3) on
`1.7.1-alpha.3`, on both phones: `gamma` sent the link of its CanaReel into its DM with `alpha`; the card
drew (9:16, "CanaReel" chip, caption), and a tap on it, after the card had read its post, landed on
`/posts/<id>` on the Mi 9T and on the iPhone 12. [sharing](../frontend/sharing.md) says the opposite: "a
shared reel's card opens the reel in the reels viewer", BUILT in `1.6.9` (#3283). It is not a `1.7.1`
regression, so it does not block the `1.7.1` stable. It is planned for `1.8.0` because the `1.7.2` tier
did not exist on `main` when it was filed.

**What the Mi's console shows.** The tap logs `[appLink] In-app navigation -> /posts/<id>`, then
`[historyOverlay] a navigation closes 1 open overlay(s)`. The card's own handler (`SharedPostCard.svelte`,
`handleClick`: `openReel` when `ready?.reelPost`) is not the only listener. `installAppLinkClickHandler()`
(`lib/utils/openExternal.ts`) puts `handleAppLinkClick` on `document` in the CAPTURE phase. It finds the
card's `a[href]`, reads an in-app path and navigates. The card's `preventDefault` comes too late to stop
it. Two owners decide the same click, so this is the "two paths overlap" rule of CLAUDE.md. The fix
removes the overlap: one place decides. For example, the card's anchor carries an attribute
`handleAppLinkClick` steps aside for, as it already does for `ECOSYSTEM_SITE_ATTRIBUTE`. A guard that
re-opens the viewer after the navigation would be a heal. The fix comes with a test that clicks a reel
card through the document listener.

**The reading that closes it, on both phones:** a reel's link received in a conversation, after its
card has drawn: a tap opens the reels viewer on that reel (no `/posts/` navigation in the log), the
next reels follow, and closing it returns to the conversation. This is also row 4 of the
[overlay reading](reading-owed-reel-overlay-tap-and-playback-bar.md): the line is fixed from the first frame.
