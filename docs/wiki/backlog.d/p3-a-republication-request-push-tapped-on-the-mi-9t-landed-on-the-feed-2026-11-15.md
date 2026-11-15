## P3 - a republication-request push tapped on the Mi 9T landed on the feed, not the request inbox (found by the push reading, 2026-11-15)

target: 1.7.0

Found reading [the push of a request to republish a post](reading-owed-the-push-of-a-request-to-republish-a-post.md) on the Mi 9T (`1.6.12-alpha.2`, dev, the alpha account). What was tapped: the shade row "<association> demande a relayer votre publication <post>" (one of two grouped rows), raised by the native service with `deepLink=fr.emse.canari://republication-requests`. Where it landed: the app opened cold on the PIN gate and, after the unlock, on the FEED. Where the deep link points: `republication-requests` in `frontend/src/lib/mobile/deepLinkRoutes.ts`, which mirrors `notificationHref` (the request inbox). The app was killed at the tap (cold start), so the session was not alive: the destination was held across the PIN gate and lost.

[#3584](https://github.com/emse-students/canari/pull/3584) (a push tapped after the session ended signs in to the page it named) merged after this build and may cover it, since the session was dead at the tap. Re-tap on the first build carrying #3584 and DELETE this entry if it lands on the request inbox right; otherwise fix the cause (where the destination is dropped between the PIN gate and the route), never a timer.
