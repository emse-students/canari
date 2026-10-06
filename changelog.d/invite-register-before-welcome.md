### Fixed - an invited member is registered with the server before its Welcome is sent

Inviting someone to a group delivered the Welcome and only then registered the joiner, so an inviter dying in between left a member in the MLS tree the delivery service did not know. The order is inverted; see [mls-protocol](docs/wiki/protocols/mls-protocol.md).
