## P3 - Three loose ends of the reel camera's no-start-after-leave fix (review of #2647, 2026-10-28)

- **A picker that never answers leaves the camera stopped for good.** `deferOpen` is cleared when
  the gallery picker answers, including the file input's `cancel` event; an engine without that
  event (WebView or browser before Chromium 113, Safari before 16.4) or a native picker dismissal
  the plugin never settles leaves it set, and the screen stays on its "starting" spinner with no
  control to retry - the controls render only while live. Owed: a way out that is a gesture, not a
  timer (a tap on the stand-in clears the deferral, or a reopen control while stopped and deferred),
  and the WebView floor written down.
- **The clear of `leaving` is untested.** The `afterNavigate` that clears it while the screen stays
  mounted is mocked to a no-op in the tests, so deleting its body passes: capture the callback and
  assert drain, then `afterNavigate` while mounted, then the camera opens again.
- **`leaving` can outlive a navigation that does not happen** (theoretical): a non-shallow
  navigation that drains the take and is then cancelled, or a bfcache restore, leaves it set. No
  guard that cancels a navigation is mounted with the camera today.
