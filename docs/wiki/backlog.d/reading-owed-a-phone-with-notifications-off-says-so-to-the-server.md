## Reading owed - a phone with notifications switched off states it, and the daily count shows it

target: 1.8.1

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_The owner asked for 1.8.0 (2026-11-21); a reading may only target the earliest tier
([plan](../../../tools/backlog-plan/plan.mjs)), so it sits in 1.7.3 and is read on the pre-release that carries migration 055._

**What is built.** `register-device` carries the OS notification state (`notificationState`), stored on
the device's `key_package` row (migration 055); the daily `[PUSH_COVERAGE]` counts installed-app
devices only and counts "registered but the OS will not show it" apart (`[PUSH_PERMISSION_OFF]`);
mobile-browser-only members are one information line; the page reads the state through
`notification_delivery_state`. Mechanism:
[chat-delivery](../services/chat-delivery.md#registered-is-not-permitted-2026-11-21).

**The reading that closes it**, on the dev pre-release, each phone in turn (Mi 9T and iPhone 12):

1. Android: deny the notification permission in the system settings, open the app, wait for the next
   unlock or key-package renewal, then read the device's row on dev: `notificationState = off`. Turn
   the messages channel off (importance none) instead: `channel-off`, `notificationChannels` shows
   `messages=none`. Turn everything back on: `on`.
2. iOS: switch notifications off in Settings, reopen the app: `off` (or `not-asked` on a fresh install
   before the dialog). Allow notifications but disable alerts: `alerts-off`.
3. The next `[PUSH_COVERAGE]` line on dev counts the phone under `[PUSH_PERMISSION_OFF]` while it
   holds its push row, and no `web-` device appears in the `[PUSH_MISSING]` or WARN lines.
4. An old build (no state) leaves the column NULL.
5. Without unlocking again: grant the permission that was denied (or fresh install: answer the dialog) and
   come back to the app; the row follows within the foreground (`[DEVICE_METADATA] ... notificationState=`
   on dev), not at the next unlock.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Migration 055 shipped in `1.7.3`: takeable now on both phones, on dev. Production, read-only, the same day: the column is still empty for all but one of 1053 key packages (the stores had not yet been adopted) and the daily line counts 0 `[PUSH_PERMISSION_OFF]`; re-read it on production once the stores are adopted.

**2026-11-23, `1.8.0-alpha.3` (Mi 9T): the client half of row 1 read, the server row UNREAD.** With `POST_NOTIFICATIONS` revoked by `adb`, the page's `notification_delivery_state` answered `notificationsEnabled:false, postNotificationsGranted:false` (channels `messages=high`, `posts=default`), so the state to report is "off" and not "unknown". The permission was granted back afterwards. The server row (`notificationState = off`) and the `[DEVICE_METADATA]` line are not readable from the bench (no database or dev log access), and the metadata `PATCH` was not captured: a fetch wrapper installed after the relaunch saw no call on a background and foreground return. **Left, for whoever can read dev's `key_package` row:** rows 1 (server side), 3, 5, and the iPhone rows.

**2026-11-24, [`1.8.0-alpha.5`](../device-verification.md#the-readings-of-2026-11-24-180-alpha5-mi-9t-sign-out-and-sign-in-the-comment-push-the-hidden-tab-the-notification-state-the-keyboard-gif-the-voice-note-under-a-banner) (Mi 9T): rows 1 and 5 READ on dev, PASS.** Device row `on` -> `off` (permission revoked, 12 s in the foreground, no unlock) -> `on` (granted back, no unlock); messages channel switched off -> `channel-off` with `messages=none`, back -> `on`. **Left:** row 2 (iPhone), row 3 (the next daily `[PUSH_COVERAGE]` line on dev), row 4 (an old build, needs one).

**2026-11-24, `1.8.0-alpha.6` (Mi 9T): nothing new takeable.** Row 3 still needs dev's daily `[PUSH_COVERAGE]` line (no dev log access from the bench), row 4 needs an older APK, which cannot be installed over this one without an uninstall (it costs the bench account its enrolled device), and row 2 is the iPhone.

**2026-11-25, `1.8.1-alpha.1` (iPhone 12): row 2 PASS, and row 5 on the iPhone.** Read on dev's `key_package` row of the phone's device (read-only): `on` -> Allow Notifications OFF, app brought to the foreground with no unlock -> `off`; Allow ON with the Lock Screen, Notification Centre and Banners all unticked -> `alerts-off`; everything back on -> `on`. Each state was on the row within about 14 s of the foreground, with no unlock. **Still owed:** row 3, the next daily `[PUSH_COVERAGE]` line on dev counting the phone under `[PUSH_PERMISSION_OFF]` (the last line predated the sitting; the phone was restored to `on`, so the line is read by whoever reads the dev log); `not-asked`, which needs a fresh install before the dialog (it costs the bench account its enrolled device); row 4, an old build.

**2026-11-25, `1.8.1-alpha.2` (Mi 9T): rows 1 and 5 PASS again.** `on` -> `off` -> `on` by the permission, and `channel-off` with `messages=none` by the channel, each following the foreground return. **Still owed:** row 3 (the daily `[PUSH_COVERAGE]` line, read tomorrow; the one read predated the sitting) and row 4 (an old build, not made on the Mi).
