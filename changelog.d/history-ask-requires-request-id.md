### Removed - the shim for history asks with no request id

A history ask without a `requestId` is now refused where it is parsed. Every build since `v1.5.0` sends one, and both estates' floor is `1.6.6` ([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md), D211).
