## Reading owed - the `ENTITLEMENT UNANSWERED` (503) rate of the key-group join gate

target: 1.7.0

A key-group external commit and a key group's Welcome target are now asked of social-service
(`POST /internal/distribution-groups/entitlement`) before the epoch moves and before any activation;
an unanswered call is a `503 entitlement_unavailable`, never an acceptance
([channel-encryption](../protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Shipped in `v1.4.0` (#2241). Owed: the rate of `[ENTITLEMENT] UNANSWERED` lines on dev, then production,
against the ~77 key-group joins/day. Re-read 2026-11-11: the gate is unchanged in code; the rate is
a log read on the hosts, not taken by the triage. Re-read again 2026-12-11.
