### Added - call-service's SFU carries a group call, chosen by one server setting

`platform_config.call_relay` (`none` in production) can route a group call through our SFU from the start, with an atomic seat cap, the sender's user id on every forwarded track and E2E transforms throughout; a 5-party encrypted call through the SFU runs in CI ([call-service](docs/wiki/services/call-service.md#the-relay-for-a-group-call-wp-gc4-2026-11-13)).
