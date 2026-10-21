### Added - calls: a server kill switch, `off` by default in production

`platform_config.calls_mode` (`off` / `audio` / `audio_video`, migration 014) is set at `/admin/platform`, refused by chat-delivery-service on every call request and published by `/api/version` so the app hides what it would refuse ([calls](docs/wiki/frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
