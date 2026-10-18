### Fixed - a community whose answerer holds nothing is no longer asked for its history at every launch

The answerer now says "I hold nothing" (`GraineBundleMsg.holds_nothing`, additive), and the requester records it per device for the key group's current tree, asking the next member until every device on the tree has answered ([channel-encryption section 24](docs/wiki/protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)).
