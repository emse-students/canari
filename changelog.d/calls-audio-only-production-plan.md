### Changed - calls: video stays dev-only when calls reach production, and the call log no longer prints key bytes

The first production calls are audio 1:1 only (owner, 2026-10-21), so the video switch no longer follows `CALLS_COMPILED`; the `fp=` log line is now a SHA-256 fingerprint of the call key. The blockers and the order for turning calls on are on [calls](docs/wiki/frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21).
