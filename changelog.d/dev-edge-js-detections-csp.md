### Changed - the CSP refusal on every dev page is Cloudflare's injected script

The one console error on every `dev.canari-emse.fr` page is the dev zone's JavaScript detections script, refused by the page policy; production is not behind Cloudflare and is unaffected, and turning the detections off is owed to the owner
([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22)).
