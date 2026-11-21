### Fixed - the Android background outbox retry no longer gives up after three minutes

It ended after three failed drains, so a short backend outage left a reply waiting for the app to be
opened; it now retries while every queued message can still go, and gives up only on a refusal the
server made for good ([mobile](docs/wiki/frontend/mobile.md#the-retry-ends-on-durable-state-never-on-a-count-173)).
