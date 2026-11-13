## Reading owed - the commit rate per user on production against the limit

target: 1.7.0

`POST /mls/commit` is limited to 600 commits per user per minute since 2026-10-22, and a refusal
carries its wait (`RATE_LIMITED`, `retryAfterMs`) so the client's sweeps stop on it
([channel-encryption](../protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
The push-triggered key-group joins of #2266 go through `POST /mls/push/key-group-join` (PushSecret),
which has no throttler, so they do NOT count against this per-user quota. Owed: the production
maximum per user and minute over 30 days (`mls_commit_log` joined to its sender device's user,
grouped by minute), and the count of `[THROTTLE] REFUSED MessagingController.validateCommit` lines
on dev then production, expected 0. Re-read 2026-11-11: `MLS_COMMIT_LIMIT_PER_MINUTE` is still 600;
the production read is owed, not taken by the triage. Re-read again 2026-12-11.
