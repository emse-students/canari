### Fixed - a deferred App Store submission is now completed by the daily store check

The `1.8.1` stable deferred on a held version slot and nothing ever retried, so the App Store had no `1.8.1` while Play did. The `stores` job of `scheduled.yml` now submits the latest stable through `submit.mjs --catch-up` once the slot is free, skipping stale stables and never touching a version Apple is reviewing ([App Store README](tools/app-store/README.md#a-deferred-submission-completes-itself---catch-up-2026-11-25)).
