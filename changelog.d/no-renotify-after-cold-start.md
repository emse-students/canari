### Fixed - an iPhone no longer re-announces a message its notification extension already showed

A cold start or a resume redelivered messages the extension had presented and the app raised them
again; "already notified" is now a durable record keyed by message id, fed by the app and by the
push-cache entries the system actually presented. The login also seeds its conversation rows before
any frame is let in, and a foreground iPhone banner is titled by its group
([mobile](docs/wiki/frontend/mobile.md#the-ios-half-a-message-is-announced-once-by-id-2026-11-01)).
Out of front, the server announces: an inactive iPhone consumes no queued frame, so the extension
decrypts the push first and shows its content, once; a salon is not announced twice
([mobile](docs/wiki/frontend/mobile.md#out-of-front-the-server-announces-2026-11-01)).
