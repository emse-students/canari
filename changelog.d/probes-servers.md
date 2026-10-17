### Documentation - server probes for calls and live without the DSI

The host's own firewall allows only 22/80/443 and drops no UDP itself (the School border does), the old VM receives nothing from outside and uploads ~4 Mb/s per flow, and live segments must be served direct (~100 Mb/s) rather than through the tunnel (~19 Mb/s) ([realtime-media-feasibility](docs/wiki/infrastructure/realtime-media-feasibility.md#9-probes-of-2026-10-16-servers)).
