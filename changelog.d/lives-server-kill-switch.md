### Added - lives: a runtime server kill switch, `off` by default on every estate

`platform_config.lives_mode` (`off` / `on`, core migration 015) is set at `/admin/platform`, ANDed with `LIVE_ENABLED` on every live route and both media segment routes, and published by `/api/version` so the app hides the live card and chip ([lives](docs/wiki/services/lives.md#the-two-switches-live_enabled-and-lives_mode)).
