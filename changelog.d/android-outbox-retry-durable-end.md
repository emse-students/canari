### Fixed - the Android background outbox retry no longer gives up after three minutes

It ended after three failed drains, so a short backend outage left a reply waiting for the app to be
opened; it now retries while a queued message can still go, and a message refused for good is kept,
told and shown failed with its Retry, without holding the others back ([mobile](docs/wiki/frontend/mobile.md#the-retry-ends-on-durable-state-never-on-a-count-173)).
