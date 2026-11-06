## P2 - the canari box's tunnel connector lost every connection from 10:31 to 10:56 UTC on 2026-11-05, and nothing alerted

QUIC "timeout: no recent network activity" on all four connections of the connector. TCP stayed up
(the GitHub runner on the same box stayed online), and the connector recovered by itself. A sibling
VM's L2 showed periodic unicast loss at the same time, so the probable cause is an upstream network
fault. Dev and the old domain answered Cloudflare 1033 for 25 minutes and nothing reported it.
Production was NOT affected: it is not behind this tunnel.

**Built 2026-11-06:** the report (the `upstream` job of `scheduled.yml`, every 15 minutes, classing a `1033` as
`tunnel-down`) and the transport analysis, with its recommendation:
[upstream-reachability](../infrastructure/upstream-reachability.md#the-transport-decision---protocol-http2-for-the-dev-connector).

**Owed, a host action for the owner or the DSI (an agent changes no unit on the host):**

1. Run the dev and legacy-name connector with `--protocol http2` (the flag on its `ExecStart`, or
   `protocol: http2` in its config), restart it detached with a verdict left in a log, and check the journal
   shows four `protocol=http2` connections. Reversible: remove the flag.
2. Read the 15-minute report for a week. A `tunnel-down` under http2 refutes the transport as the cause.

The edge is described in [cloudflare-edge](../infrastructure/cloudflare-edge.md).
