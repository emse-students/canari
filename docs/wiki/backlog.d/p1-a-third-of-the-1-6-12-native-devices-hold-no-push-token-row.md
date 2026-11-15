## P1 - a third of the `1.6.12` native devices hold no push token row: no push can reach them (production, 2026-11-15)

target: 1.7.0

**Status (2026-11-15): fixed in the `1.7.0` pre-release work, reading owed.** The measurement was re-taken with a predicate keyed on the launch (`key_package.createdAt`) rather than the sticky row: every older build reads 0, `1.6.12` reads 14 of 38 Android and 10 of 20 iOS; 21 of the 24 launched and sent no registration and no report. `register-device` now answers whether the row is held, the phone re-registers on `false` and states its last outcome, and `[PUSH_MISSING]` and a daily `[PUSH_COVERAGE]` name such phones per build ([chat-delivery](../services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15)). The sub-branch that went silent is still not proven; the `last=` term on `[PUSH_MISSING]` names it on the first `1.7.0` phone it happens to. **What still closes it**: the `[PUSH_COVERAGE]` WARN lines reading zero for the builds from `1.7.0` on.

**Measured 2026-11-15 on production, read-only, aggregates only** (19:06 UTC, one day after the `v1.6.12` deploy). Population: the native devices (`key_package.deviceOs` android or ios, not revoked) that used a session in the last 24 hours; their build is the one their LATEST key package states; "holds a token" is a `push_token` row for the same `deviceId`.

| build | active devices | with no `push_token` row |
| --- | --- | --- |
| every build older than `1.6.12` (Android and iOS, `1.6.0` to `1.6.11`) | 209 | **0** |
| `1.6.12` Android | 43 | **14** |
| `1.6.12` iOS | 22 | **11** |

- It is not the registration ladder still running: the 25 key packages are 0 to 24 hours old, the ladder lasts four minutes.
- 14 of the 25 belong to an account that also holds a token on another device (9 of the 11 iOS ones on an older build); 11 belong to an account with no token at all.
- The earlier readings of [the tokenless-device entry](reading-owed-a-device-with-no-push-token-now-says-so.md) (2 of 194 on 2026-11-14, 1 of 84 the day before) were taken when most devices still ran an older build; the share moves with the `1.6.12` adoption, which is why it reads as a population only now.

**What is NOT established.** The cause. A candidate to check first, from the diff between `v1.6.11` and `v1.6.12`: #3464 ("the registration obeys a refusal") ends the retry ladder with NO report on a 401 that one renewal did not lift or on a session with no token (`PushRegistrationUnauthorizedError`), and ends it as `refused` on any other 4xx - exactly the shape "a device that stays without a token and prints nothing". It is a hypothesis: it has not been reproduced, and a stale row cannot be ruled out as a second cause (the server also deletes a row on a terminal send error, on a session end bound to it, and by the 90-day cron).

**What closes it:** reproduce the shape on dev with a bench phone on the `1.7.0` pre-release (the registration path run with a session whose first call answers 401 and with a refused answer), read the device's own `[Push]` lines, make every branch that ends the ladder without a token LOUD (a report the server prints as `[PUSH_UNAVAILABLE]`, never silence), fix the cause, and re-run the three queries above after the stable that carries it: the `1.6.12`-and-later rows must read 0 tokenless beyond the ladder's four minutes. Charter: principle 1 (your messages are yours - a message that cannot ring is a message lost to the phone), and "a fallback is a signal" - this is the signal.
