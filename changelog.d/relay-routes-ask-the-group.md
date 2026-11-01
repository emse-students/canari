### Security - the history, base-refresh and reaction relays answer only a member of the conversation

`mls/history-request`, `mls/base-refresh-request` and `mls/notify-reaction` now go through the
membership gate the group routes share (403 `NOT_A_MEMBER`, 409 for a seat awaiting admission); a
salon reaction asks social-service whether the caller reads the salon
([chat-delivery](docs/wiki/services/chat-delivery.md#the-relay-routes-ask-the-group-2026-11-01)).
