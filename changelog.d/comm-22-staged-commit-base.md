### Fixed - a staged add or remove publishes its join base with the commit

The GroupInfo OpenMLS already builds for a staged commit now rides inside the submission, so the base
for the new epoch can no longer be lost to a dropped follow-up. See
[mls-protocol](docs/wiki/protocols/mls-protocol.md#the-base-travels-inside-every-commit-submission-comm-22).
