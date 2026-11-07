### Added - a server switch lets a drain that only received messages defer its MLS checkpoint, off everywhere

`platform_config.checkpoint_skip_mode` (core migration 020, `/admin/platform`, published by `/api/version`) turns on WP-CHECKPOINT-SKIP with K = 100 deferred receive generations; it stays `off` until two dev readings pass on both bench phones ([the decision](docs/wiki/open-questions.md#decided-2026-11-07-lead-owners-delegation-build-with-k100-behind-checkpoint_skip_mode-off-flip-after-the-dev-readings-below)).
