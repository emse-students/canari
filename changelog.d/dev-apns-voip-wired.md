### Fixed - a locked iPhone on dev is rung: the dev compose forwards the APNs VoIP key to chat-delivery

The `DEV_APNS_VOIP_*` secrets were rendered but never passed to the service, so it logged `APNS_VOIP_* is not configured` and no VoIP push left; the compose-wiring allowlist hid it. Dev uses the production APNs gateway, as TestFlight builds are production-signed ([calls](docs/wiki/frontend/modules/calls.md)).
