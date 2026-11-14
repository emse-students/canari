### Security - a socket to the gateway sends frames of at most 4096 bytes, at most 240 frames of any kind a minute

Both are server variables with those defaults, sized from what the socket carries and checked against production's counts; past either the gateway logs `[WS LIMIT]` and ends the socket ([chat-gateway](docs/wiki/services/chat-gateway.md#what-one-connection-may-send-2026-11-14)).
