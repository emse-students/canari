### Added - a daily count of orphan devices, and the hand procedure that cleans them

The delivery service logs `[ORPHAN_DEVICES]` once a day: devices with queued rows, no session, no push
token, no ban and no life in 7 days - the same predicate the hand procedure's allowlist uses. The
scheduled reaper (#2880) was closed instead; the 90-day GC stays
([chat-delivery](docs/wiki/services/chat-delivery.md#orphan-devices-the-gcs-blind-spot-counted-daily-cleaned-by-hand)).
`env-from-prod.sh` now classifies `LIVE_ENABLED`, `LYDIA_RECONCILE_ENABLED` and
`ANDROID_APP_LINK_SHA256`, and its test reads the deploy manifest so an unclassified variable fails.
