### Fixed - a seed whose storing failed is no longer lost, nor counted as a network loss

A key-group frame's plaintext is now kept in the MLS state by the decrypt that spends its generation,
and its handler is run again on the redelivery or at the next start until it succeeds
([mls-desync-prevention section 11](docs/wiki/protocols/mls-desync-prevention.md#11-client---a-key-group-frame-is-kept-until-its-handler-succeeds-2026-11-25)).
