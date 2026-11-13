## P3 - the iOS native push refresh re-sends an unchanged token 3-4 times per launch: 3 084 `[PUSH_REFRESH]` a day from 182 devices (production sweep, 2026-11-13)

**What the sweep read.** 3 084 `[PUSH_REFRESH] user= device= fcm= voip=` lines a day
(`controllers/push.controller.ts`) from 182 devices - about 17 per device per day, 3-4 per launch.
The token almost never changes; each line is a `POST /api/mls/push/refresh-token` carrying the token
the server already holds.

**Where they come from** (`frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm`):
`CanariPersistFcmToken` refreshes on the backend EVERY time it runs, and it runs from the FCM
delegate (`didReceiveRegistrationToken` - documented as firing on a change, but the count says
it or its siblings fire on unchanged tokens; which one is what the reading below separates), from the launch-time `tokenWithCompletion` fetch (deliberately, to cover a token
that rotated while the app was killed), and after the account-switch deletion; `CanariPersistVoipToken`
does the same for every PushKit `didUpdatePushCredentials`. Nothing compares the token with the last
value the server CONFIRMED, so every path that sees a token sends it.

**What would close it.** Send only when the token differs from the last value the server confirmed:
write `fcm_token_confirmed.txt` / `voip_token_confirmed.txt` (beside `fcm_token.txt`, same data dir)
ONLY on a 2xx of `refresh-token` or `/register`, and skip the call when the fresh token equals it.
Durable state, never a clock; it answers exactly "does the server already hold this token" and nothing
else - a sign-out or an account switch must delete it with the push context, so the next account's
registration is never skipped. The launch fetch stays (it is the only cover for a token rotated while
killed) and becomes a no-op when nothing changed.

**Needs an iPhone reading** (the bench iPhone 12, a pre-release): one cold launch, one resume, one
foreground-kill and relaunch each produce at most ONE `[PUSH_REFRESH]` for that device when the token
did not change, and exactly one when it did (force it by deleting the FCM token). Then a production
count after the stable: `[PUSH_REFRESH]` per iOS device per day falls from ~17 to the rotation rate.
