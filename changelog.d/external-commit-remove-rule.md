### Security - receivers enforce the RFC 9420 external-commit rule

An external commit may remove only the joiner's own prior leaf; every member now refuses one that removes any other leaf before merging it, and the delivery service refuses it at the commit gate ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-base-travels-inside-every-commit-submission-comm-22)).
