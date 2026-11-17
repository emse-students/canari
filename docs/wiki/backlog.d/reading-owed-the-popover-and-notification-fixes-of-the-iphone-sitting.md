## Reading owed - a menu ends above the iOS tab bar, and a group notification keeps its title (2026-11-16)

target: 1.7.0

**What is built:** the floating panels (`PostActionsMenu`, the profile overflow menu, every
`bindFixedPopover` user) subtract the native tab bar's band (`currentNativeTabBarInset`), proven by
unit tests on the geometry only. A message notification raised by the plain plugin or the web API
titles a group by its name with the speaker in the body (`composePlainNotificationText`), proven by
unit tests in both locales. Android keeps its DOM bar and its native builder, unchanged.

**The reading that closes it, on the iPhone 12 (and a glance on the Mi 9T):** open the menu of a
post low in the feed and the profile's menu: the last item ("Supprimer le post", the profile's last
action) is fully visible and tappable above the bar, scrolling inside the panel if needed. Then, with
the app backgrounded but alive and the language switched to English, a media message from a group
reads the group name as the title and "Sender: [Media]" as the body; the same in French. A FAIL is
a last row under the bar or a group notification titled by the sender alone.

**iPhone 12, 2026-11-17 (`1.7.0-alpha.7`, [readings](../device-verification.md#ninth-sitting-continued-the-alpha7-code-the-institution-form-the-live-bars-trends-rotation-frame-timing)): the post menu and the notification title `PASS`.** A post menu opened low in the feed ends above the tab bar (bottom about 752 pt, bar at 761) and scrolls inside, "Supprimer le post" whole and tappable; a group photo with the app backgrounded titles the notification "IPA7G1" (sender in the body), in French and in English. **Left: the profile's own overflow menu on the iPhone, and the Mi 9T glance.**
