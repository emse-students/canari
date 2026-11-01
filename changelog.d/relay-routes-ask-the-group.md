### Security - the history, base-refresh, welcome and reaction relays answer only a seat in the conversation

`mls/history-request`, `mls/base-refresh-request` and `mls/notify-reaction` now go through the
membership gate the group routes share; `mls/welcome-request` relays any roster seat, a waiting one
included, and re-checks its stored asks at the drain; a salon reaction asks social-service whether the
caller reads the salon, and the client reads a refusal as an answer
([chat-delivery](docs/wiki/services/chat-delivery.md#the-relay-routes-ask-the-group-2026-11-01)). The
gateway's WebSocket `welcome_request` frame is retired and its `typing` frame needs a seat
([chat-gateway](docs/wiki/services/chat-gateway.md#inbound-frames-typing-is-seat-checked-welcome_request-is-retired-2026-11-01)).
