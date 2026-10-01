### Changed - one function names the estate a baked backend URL belongs to, and `[BUFFER]` says "recovery started"

`build.yml`, `android.yml` and `ios.yml` now source `.github/scripts/lib/backend-url.sh` instead of three private lists (the web build also accepts the legacy apex now, like the native two), and the unknown-group line no longer claims a `welcome_request` that `requestReAdd` may never send ([cicd](docs/wiki/cicd.md), [chat-delivery](docs/wiki/services/chat-delivery.md)).
