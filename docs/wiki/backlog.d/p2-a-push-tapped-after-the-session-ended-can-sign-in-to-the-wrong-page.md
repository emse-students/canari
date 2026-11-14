## P2 - a push tapped after the session ended can sign in to the wrong page: a bare `/login` on a cold start, a stale `returnTo` on a mounted login page (Mi 9T, 2026-11-15)

target: 1.7.0

**Replaces the reading of check H step 4** ([device-verification](../device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android)). It was run on 2026-11-15 on the Mi 9T against dev (`1.6.12-alpha.2`, build 100601202, the alpha account, replies from the beta web seat). The session was ended server-side AFTER the banner had arrived, because ending a session also ends that device's push delivery. Four taps were read. Two passed and two lost the target, so the reading is not passed.

- **Killed, run 1 - pass:** the tap landed on `/login?returnTo=/posts/ec6705ba...?comment=af13931a...`. After the sign-in it opened that comment.
- **Backgrounded, run 2 - pass:** the tap landed on `/login?returnTo=...comment=9ee27dff...`, and the sign-in returned there. The navigation record shows `[notifNav] deep link received` -> `pushState` the post -> 401 -> `replaceState /login?returnTo=` the post -> `[callback] goto ->` the post.
- **Killed, run 2 - FAIL:** the tap landed on a bare `/login`, and the sign-in opened `/posts`.
- **Backgrounded, run 1 - FAIL:** the tap landed on `/login?returnTo=` the NEW comment (ca76676e), but the sign-in opened the PREVIOUS one (af13931a).

Both failures were read from the app's own console ring (`CanariDBLog`, read over CDP). They are two separate mechanisms.

1. **Cold start: the verdict comes before its handler, and the fallback drops the target.** `[hooks] Processing URL` and `[notifNav] deep link received` ran at once, so the intent DID reach the JS. Then the ring shows these lines in order:
   - `[A] session dead → logout`;
   - `no session-expired handler registered - redirecting directly`;
   - `session-expired handler registered after the verdict - replaying it`;
   - `[AUTH] Session expired - logging out and redirecting to /login.`, with no query.

   The fallback in `notifySessionExpired` (`lib/stores/auth.ts`) does a bare `goto('/login')`. The handler registered later (`ChatBackgroundService.svelte`) builds `loginAfterSessionExpiry(navigating.to ?? location)` from a location that is already `/login`, which `isSignedOutPath` maps to a bare `/login`. Whether the handler is registered before the first refresh answers is a race: killed run 1 won it and killed run 2 lost it. A race that heals is still a defect. The fix is to capture the target at the verdict, where it is known, and not let the fallback navigate on its own.
2. **A login page already mounted keeps its first `returnTo`.** In backgrounded run 1 the app had been signed out about a minute before the tap, on `/login?returnTo=` the page it was showing (af13931a). The tap pushed the new post, which the guard bounced to `/login?returnTo=` the new comment. That is the same route, so SvelteKit reused the mounted `LoginPage.svelte`. That component reads `returnTo` only in `onMount` (`requestedReturnTo`). The ring line `[A] login returnTo=/posts/ec6705ba...?[query]` then went out with the stale query, and the sign-in opened af13931a. The fix is to derive the target from `page.url` reactively, not once.

The test that would lift it:
- a unit test that a verdict reached with no handler wired still yields `/login?returnTo=` the page in flight;
- a component test that `LoginPage` follows a change of `?returnTo=` while mounted;
- then the same four taps on the Mi 9T.
