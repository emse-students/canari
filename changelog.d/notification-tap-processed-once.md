### Fixed - a notification tap is processed once

A tap on a backgrounded app no longer reaches the deep-link handler twice, and a killed start waits
for the community load already running instead of starting a second one
([mobile](docs/wiki/frontend/mobile.md#a-backgrounded-tap-reached-both-paths-and-the-live-one-now-writes-the-claim-2026-10-01)).
