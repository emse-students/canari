## P3 - the WebSocket credential moves out of the URL (design improvement, 2026-11-13)

`/api/ws` and the call socket (`/api/call`) carry their short-lived credential in the query string,
because a client that cannot keep the `canari_ws_token` cookie has no other place to put it on an
upgrade request. Every log that prints a request line must therefore be redacted on its own: the
access log has its map (`$logged_request_uri`), and the error log of those two locations is set to
`crit` so it records no request line ([logging](../infrastructure/logging.md#the-error-log-of-a-websocket-location-2026-11-13)).
A level is a per-location setting, so it is a guard to keep, not a property of the design.

**The improvement: no credential in a URL at all**, so no log at any level and no proxy in between
can carry one. Two shapes, to be chosen with a measurement on both phones:

- **A single-use socket ticket.** The client asks an authenticated `POST` for an opaque ticket
  (seconds of life, one use, bound to the user and device) and opens the socket with it; the gateway
  redeems it once. The query then names something already spent.
- **`Sec-WebSocket-Protocol`.** The token travels as a subprotocol value, a header no access or
  error log prints. Needs the gateway and the call service to echo the protocol they accept, and a
  check that every WebView in use sends it on the upgrade.

Done when both sockets authenticate without a query credential, the query path is refused by the
gateway, and the `crit` level on the two locations can return to the server default.
