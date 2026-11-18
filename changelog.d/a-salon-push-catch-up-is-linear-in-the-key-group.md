### Fixed - a shut phone's salon push no longer spends seconds per key-group commit it replays

Every merged commit compared each leaf with each other one in the device-trust record, so a phone a month behind production's largest community spent most of a salon push re-reading the tree; it is now linear, measured on a bench of production size ([channel-encryption section 28](docs/wiki/protocols/channel-encryption.md#28-a-salon-pushs-catch-up-against-a-key-group-of-production-size---measured-2026-11-17)).
