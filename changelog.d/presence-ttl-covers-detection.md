### Fixed - the presence key no longer vanishes while its socket still looks connected

The gateway's `user:online` key lived 20 s but a dead socket is only closed after ~75 s, so the admin presence screen showed "WS connected, Redis empty"; the TTL is now 90 s, one constant asserted above the detection window ([chat-gateway](docs/wiki/services/chat-gateway.md)).
