### Fixed - an invitation kept across a lost connection is re-planned, or the member is told

An Add whose answer was lost and which then did not land is made again at the new epoch under the same premises (never re-adding a person removed, declined or departed meanwhile), and the member is told whenever it does not complete ([mls-protocol](docs/wiki/protocols/mls-protocol.md#an-invitation-whose-kept-commit-did-not-land-is-re-planned-or-the-member-is-told-2026-10-25)).

The add lock now carries a token per acquisition, so a late release never frees a live lock (the Android background service's included), and a refusal states when the lock ends. This server half ships with the stable.
