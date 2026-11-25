## Reading owed - a campus trend for a post this device already displayed shows nothing, on both phones (2026-11-24)

target: 1.8.1

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

**Built and compiled, never run on a device** ([engagement](../engagement.md#a-campus-trend-for-a-post-this-device-already-displayed-shows-nothing-2026-11-24); owner decision of 2026-11-24, [decisions](../decisions/owner-decisions-of-2026-11-24.md); charter principles 1 and 3). The web and the bell are covered by tests; the Rust writer and the Kotlin rule run their tests in CI; **the Kotlin service hook, the iOS extension, `canari_push.mm` and the iOS App Group copy are verified by COMPILING only, which proves nothing about running.** What is owed is the reading below on BOTH bench phones, on a build carrying this change.

**What to read, per phone** (a post of the bench account's space that reaches the trend threshold; a second reader of the same space on the other device, or a dev-side trend row, supplies the push):

1. **The post displayed, then the trend.** On the phone, scroll the feed until the post's card is on screen (most of it visible), background the app, then let the trend push arrive. Expected: NO banner, NO sound, NO screen wake, and NO "Suggestion" row in the bell. The exported log carries one `[SEEN_TREND] ... withheld` line (Android: a recorded info line; iOS: the extension's `[CanariNSE] [SEEN_TREND]` notice and a `[NSE_OUTCOME]` of `seen-trend`) and NO post id.
2. **The post never displayed, then the trend.** Same trend for a post the phone never drew (kill the app first, or use a second post): the banner and the bell row appear exactly as before. This is the control: it proves the rule does not swallow every trend.
3. **The post opened from a link** (never scrolled past in the feed), then its trend: withheld too.
4. **iOS only: the blank row is cleaned up.** The extension cannot drop an alert push (no filtering entitlement), so the trend is delivered blank and passive, stamped `canariWithheld`; the app removes the stamped rows at every foreground and when its process runs for a push. Read that a **blank row never stays in the notification centre**: gone after a FOREGROUND (check in the notification centre after opening the app), and gone when the app ran for a silent frame (and, with the app running in the foreground, that none appears for a trend whose post this session displayed), and that the log carries `blank notification(s) of withheld trends removed`.
7. **A post displayed in the open session, then its trend, with the app in the FOREGROUND**: nothing is shown (the native file is written at the note, not at the background; review of #4065).
8. **The bell keeps what the reader saw**: a trend already shown in the bell, or tapped from a shown push, is still listed after its post is displayed; and a withheld row stays out of the list and the badge after more than a day (the post aged out of the record).
5. **Sign-out erases it.** Sign out, sign in as another account, let the first account's trend push arrive for a post the first account displayed: it must NOT be withheld for the second (`seen_posts.json` names its owner and the sign-out removed it).
6. **A post seen on another device is not recognised** (the accepted limit): confirm the trend still shows on a phone that never displayed the post.

**What closes it**: items 1, 2 and 5 pass on the Mi 9T AND the iPhone 12; item 4 is answered. A failure names the surface that did not obey (the service hook, the extension's file read, the App Group copy, or the writer's flush at background).

**2026-11-25, `1.8.1-alpha.2` (Mi 9T): still deferred, it needs a dev trend fixture.** The fixture: a post over the trend threshold, followed likers, a reader under the daily and weekly caps, a control post, and a second account (for the sign-out check).
