### Fixed - a web MLS state WebCrypto cannot read right now is re-read, never rotated

A WebCrypto refusal of a framed v2 state is no longer called altered: the state is re-read and kept, and `mls-core` alone gives the verdict, as a typed code. The v2 writer stays off until the production and web rollback floors reach this release ([mls-protocol](docs/wiki/protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)).
