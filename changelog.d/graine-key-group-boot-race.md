### Fixed - a community's salon stayed blank on a device whose key group was classified after the boot drain

The key-group registry is now stored on the device and restored before the first drain, and registering a key group re-fetches the frames refused for it; measured on production with 51 frames refused on every load ([channel-encryption](docs/wiki/protocols/channel-encryption.md#22-a-key-groups-backlog-was-refused-on-every-load---the-classification-is-device-state---fixed-2026-09-28)).
