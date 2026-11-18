### Fixed - a tab that lost the lead can no longer hand out a salon message index already used

The outbound Graine reservation writes its count by compare-and-swap in the write's own transaction, so a tab resumed after another tab sent cannot roll the count back, whatever either believes about the lead ([channel-encryption, WP-30](docs/wiki/protocols/channel-encryption.md#wp-30-and-the-departure-nobody-records)).
