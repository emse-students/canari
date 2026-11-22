## Reading owed - a phone with notifications switched off states it, and the daily count shows it

target: 1.7.3

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
