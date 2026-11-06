## P2 - a tunnel connector lost every connection from 10:31 to 10:56 UTC on 2026-11-05, and nothing alerted

QUIC "timeout: no recent network activity" on every connection of a tunnel connector, for 25 minutes, while TCP
on the same machine stayed up; the connector recovered by itself, and the probable cause is an upstream network
fault. Names behind that connector answered Cloudflare 1033 and nothing reported it.

**Built 2026-11-06:** the report (the `upstream` job of `scheduled.yml`, which opens one issue per outage and classes a `1033` as
`tunnel-down`) and the transport analysis, with its recommendation:
[upstream-reachability](../infrastructure/upstream-reachability.md#the-transport-decision---protocol-http2-for-a-tunnel-connector-that-loses-quic).

**Owed, a host action for the owner or the DSI (an agent changes no unit on the host):**

1. Run the connector that lost QUIC with `--protocol http2` (the flag on its `ExecStart`, or
   `protocol: http2` in its config), restart it detached with a verdict left in a log, and check the journal
   shows four `protocol=http2` connections. Reversible: remove the flag.
2. Watch the `upstream` issues for a week. A `tunnel-down` under http2 refutes the transport as the cause.

The edge is described in [cloudflare-edge](../infrastructure/cloudflare-edge.md).
