### Fixed - a link ask reaches every online member at once, and a declined joiner's row goes

The ask and its outcome (admitted, declined, expired or withdrawn) are announced by the server to every online admitted member whose client routes them, and settled by the ask's identity, so a member sees another's answer without a refresh and a late read never brings a settled ask back; a conversation the joiner was never admitted to no longer reads as an established channel and leaves the sidebar once declined ([mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
