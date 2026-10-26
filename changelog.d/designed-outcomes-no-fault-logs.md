### Fixed - three designed outcomes no longer log as faults

A revoked device's pending fetch ends with one info line instead of an error claiming the backlog stays queued, a revoked device signs out once instead of twice, and a Decline that wins the race against an Add is an info line instead of a warning. See [sessions](docs/wiki/sessions.md).
