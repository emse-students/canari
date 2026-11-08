## P2/P3 - what the bench readings of `v1.6.7-alpha.3` filed (2026-11-08)

Read on dev on the Mi 9T (sideloaded build) and the iPhone 12 (TestFlight build 100600703). Every
reading the release owed PASSED, and the stable ships on them:

- video calls both ways, E2E with `decrypt-failed=0` and `not-vp8=0` ([calls](../frontend/modules/calls.md));
- a push decrypted after sign-out, then sign-in, then the app killed, on both platforms. The Mi 9T
  was killed with HOME + `am kill`; a force-stop cancels FCM;
- the read mark sent at once ([read-receipt-privacy](../read-receipt-privacy.md));
- a `.txt` attached on both phones;
- the profile-photo card;
- a live's title, its feed preview, the push body, and the title edited on air.

The dark bench room made every frame black, so the PICTURE itself was not judged, only the media
path.

What they found. None of it is a regression, and none of it blocks:

- **P3 - sign-out and sign-in noise left after #3144** (read on `1.6.8-alpha.1`): the order is
  fixed (no `401` on the deregistration, a killed-app push still decrypts after a re-sign-in), but
  the Mi 9T still logs `pauseSocket: native disconnect failed` at sign-out, both phones log
  `refresh 401` about 100 ms after `logout 200`, and the iPhone logs six `[NativeTabBar] ... tab bar
  is not configured` during the sign-in callback.
- **P3 - `pauseSocket` on an already-closed socket** when the app goes to the background for the
  file picker. This is lifecycle noise next to "Reconnect request refused - paused".
- **P3 - iOS `[CALL-WAKE]`**: WKWebView refuses the screen wake lock (`NotAllowedError`), so the
  screen may dim during a call. The fix is native (`idleTimerDisabled` for the call's lifetime).
- **To watch:** the quality ladder drops 480p30 -> 180p15 four seconds into a call, while the
  bandwidth estimate is still ramping, and recovers within 30 s. One ICE restart followed the
  iPhone camera coming back, and it healed in 5.5 s.
