### Changed - the replica-reload reading closed in production; the edge's three resets traced to the gateway's `disconnect`

The `v1.6.12` deploy logged 0 `no live upstreams` at the edge ([cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)).
The resets of 2026-11-13 are not a keepalive race - neither proxy pools an idle connection; the one
readable was a WebSocket the gateway ended before reading the client's Close ([backlog](docs/wiki/backlog.d/p3-the-edge-logs-a-reset-when-the-gateway-ends-a-socket-on-disconnect.md)).
media-service's volumes were measured root-owned on both estates, and the non-root plan written ([backlog](docs/wiki/backlog.d/p3-two-service-images-still-run-as-root.md)).
