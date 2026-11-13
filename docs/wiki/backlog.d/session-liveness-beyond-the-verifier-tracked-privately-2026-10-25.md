## Session liveness beyond the verifier, tracked privately (2026-10-25)

target: 1.9.0

Two follow-ups of [sessions](../sessions.md#an-access-token-is-only-as-alive-as-its-session-2026-10-25)
are in the private operations notes until each ships: token liveness for the services that verify
the access token themselves, and closing an open socket when its session ends (a separate pull
request).
