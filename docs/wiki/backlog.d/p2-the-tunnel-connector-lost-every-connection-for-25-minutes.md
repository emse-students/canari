## P2 - the canari box's tunnel connector lost every connection from 10:31 to 10:56 UTC on 2026-11-05, and nothing alerted

QUIC "timeout: no recent network activity" on all four connections of the connector. TCP stayed up
(the GitHub runner on the same box stayed online), and the connector recovered by itself. A sibling
VM's L2 showed periodic unicast loss at the same time, so the probable cause is an upstream network
fault. Dev and the old domain answered Cloudflare 1033 for 25 minutes and nothing reported it.
Production was NOT affected: it is not behind this tunnel.

Owed:

- A report that counts tunnel connector loss, so the next one is seen the minute it starts rather than found by hand.
- A decision on the transport: run the connector with `--protocol http2` (TCP, which survived), or keep auto with a fallback. Weigh both: http2 gives up QUIC's behaviour on a lossy path but is the transport that stayed up here; auto keeps the default but needs the fallback to be real, not assumed.

The edge is described in [cloudflare-edge](../infrastructure/cloudflare-edge.md).
