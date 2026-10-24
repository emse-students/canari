### Changed - a key-group frame's sending device is checked against its MLS credential

A device can no longer answer in a sibling's name on a community key group. Production's pre-stable evidence is indirect (zero device mismatches on the live path, same envelope field); `[SENDER_MISMATCH] path=distribution` is read on dev after the alpha and on production after the stable ([channel-encryption](docs/wiki/protocols/channel-encryption.md#211-the-verified-sender-measured-then-refused-wp-g2-1-g2-1b)).
